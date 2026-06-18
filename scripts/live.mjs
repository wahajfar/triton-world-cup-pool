// Live match watcher — THREADED play-by-play via a Slack bot token.
// Per match: KICK OFF posts to the channel (thread parent) → live score changes post as thread
// replies → FULL TIME posts to the channel and reacts to the kickoff message with the winner's
// flag (🤝 on a draw). Falls back to top-level webhook posts if SLACK_BOT_TOKEN is absent.
// State (parent ts, last score, flags) lives in data/live-state.json, committed by the Action.

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA = join(__dirname, "..", "data");
const ESPN_BASE = "https://site.api.espn.com/apis/site/v2/sports/soccer";
const CHANNEL = process.env.SLACK_CHANNEL_ID || "C0BAAQN3X3M";
const BOT = process.env.SLACK_BOT_TOKEN;
const WEBHOOK = process.env.SLACK_WEBHOOK_URL;

const norm = (s) => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z]/g, "");
const ALIASES = {
  turkiye: "Turkey", turkey: "Turkey", czechia: "Czech Republic", czechrepublic: "Czech Republic",
  drcongo: "Congo DR", congodr: "Congo DR", democraticrepublicofthecongo: "Congo DR", congo: "Congo DR",
  southkorea: "Korea Republic", korearepublic: "Korea Republic", korea: "Korea Republic",
  iriran: "Iran", iran: "Iran", usa: "United States", unitedstates: "United States", us: "United States",
  ivorycoast: "Côte d'Ivoire", cotedivoire: "Côte d'Ivoire",
  bosniaherzegovina: "Bosnia and Herzegovina", bosniaandherzegovina: "Bosnia and Herzegovina", bosnia: "Bosnia and Herzegovina",
  capeverde: "Cape Verde", caboverde: "Cape Verde", saudiarabia: "Saudi Arabia", newzealand: "New Zealand", southafrica: "South Africa",
};
const canonical = (name, teams) => { const n = norm(name); return ALIASES[n] || teams.find((t) => norm(t) === n) || name; };
const ref = (o) => (o ? (o.slackId ? `<@${o.slackId}>` : `*${o.name}*`) : "");

// Map a flag emoji → Slack reaction emoji name (no colons).
const SHORT = { us: "us", jp: "jp", kr: "kr", de: "de", fr: "fr", it: "it", es: "es", ru: "ru", cn: "cn", gb: "gb" };
function reactionName(flag, team) {
  if (team === "England") return "flag-england";
  if (team === "Scotland") return "flag-scotland";
  const letters = [];
  for (const ch of flag || "") { const cp = ch.codePointAt(0); if (cp >= 0x1f1e6 && cp <= 0x1f1ff) letters.push(String.fromCharCode(cp - 0x1f1e6 + 97)); }
  if (letters.length !== 2) return null;
  const iso2 = letters.join("");
  return SHORT[iso2] || `flag-${iso2}`;
}

// Post to Slack. With a bot token: returns the message ts (and supports thread replies). Else webhook (top-level only).
async function slackPost(text, thread_ts) {
  if (BOT) {
    const r = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST", headers: { Authorization: `Bearer ${BOT}`, "Content-Type": "application/json" },
      body: JSON.stringify({ channel: CHANNEL, text, ...(thread_ts ? { thread_ts } : {}) }),
    });
    const j = await r.json();
    if (!j.ok) console.error("[live] post failed:", j.error);
    else console.log("[live] posted" + (thread_ts ? " (thread)" : ""));
    return j.ok ? j.ts : null;
  }
  if (WEBHOOK) {
    await fetch(WEBHOOK, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }) });
    console.log("[live] posted (webhook)");
  }
  return null;
}
async function slackReact(ts, name) {
  if (!BOT || !ts || !name) return;
  const r = await fetch("https://slack.com/api/reactions.add", {
    method: "POST", headers: { Authorization: `Bearer ${BOT}`, "Content-Type": "application/json" },
    body: JSON.stringify({ channel: CHANNEL, timestamp: ts, name }),
  });
  const j = await r.json();
  console.log(j.ok ? `[live] reacted :${name}:` : `[live] react failed (${j.error}) :${name}:`);
}

async function main() {
  const cfg = JSON.parse(await readFile(join(DATA, "..", "config.json"), "utf8").catch(() => "{}"));
  const ESPN = `${ESPN_BASE}/${cfg.competition?.espnLeague || "fifa.world"}/scoreboard`;
  const roster = JSON.parse(await readFile(join(DATA, "roster.json"), "utf8"));
  const teams = roster.people.map((p) => p.team);
  const owner = new Map(roster.people.map((p) => [canonical(p.team, teams), p]));

  let state = {};
  try { state = JSON.parse(await readFile(join(DATA, "live-state.json"), "utf8")); } catch { /* first run */ }
  const firstRun = Object.keys(state).length === 0;

  const res = await fetch(ESPN, { headers: { "User-Agent": "triton-wc/1.0" } });
  if (!res.ok) { console.error("[live] ESPN fetch failed", res.status); process.exit(0); }
  const events = (await res.json()).events || [];
  console.log(`[live] ${events.length} events; firstRun=${firstRun}; bot=${!!BOT}`);

  let changed = false;
  let ended = false;   // a match reached FULL TIME this run → flag a standings refresh
  for (const ev of events) {
    const comp = ev.competitions?.[0]; if (!comp) continue;
    const cs = comp.competitors || [];
    const home = cs.find((c) => c.homeAway === "home") || cs[0];
    const away = cs.find((c) => c.homeAway === "away") || cs[1];
    if (!home || !away) continue;

    const hName = home.team?.displayName || home.team?.name || "";
    const aName = away.team?.displayName || away.team?.name || "";
    const hP = owner.get(canonical(hName, teams)), aP = owner.get(canonical(aName, teams));
    const hFlag = hP?.flag || "", aFlag = aP?.flag || "";
    const hS = Number(home.score ?? 0), aS = Number(away.score ?? 0);
    const score = `${hS}-${aS}`;
    const grp = hP?.group || aP?.group || "";

    const st = ev.status?.type || {};
    const stateStr = st.state;                       // pre | in | post
    const isFull = st.completed || stateStr === "post";
    const period = ev.status?.period || 1;
    const clock = String(ev.status?.displayClock || "").trim();
    const clockN = parseInt(clock.replace(/[^0-9]/g, "")) || 0;

    const id = ev.id || `${canonical(hName, teams)}-${canonical(aName, teams)}-${ev.date}`;
    const s = state[id] || (state[id] = {});

    // First run: silently seed in-progress / finished matches so nothing stale is posted on deploy.
    if (firstRun && stateStr !== "pre") { s.kickoff = true; s.ts = ""; s.score = score; s.full = isFull; changed = true; continue; }

    // KICK OFF → thread parent in the channel. Only post inside the early window (≤18'); with
    // ~10-min ticks a real kickoff is always caught there. If we first see a match ALREADY past
    // that window with no recorded kickoff, we either missed it or lost state to a race — seed
    // silently instead of posting a second parent (the duplicate-thread bug). See tick.yml note.
    if (stateStr === "in" && !s.kickoff) {
      const early = period === 1 && clockN <= 18;
      if (early) {
        const text = `⚽ *KICK OFF*${grp ? ` — Group ${grp}` : ""}\n${hFlag} ${hName}  vs  ${aName} ${aFlag}\nGood luck ${ref(hP)} & ${ref(aP)}! 🍀  _Live updates in this thread_ 👇`;
        const ts = await slackPost(text);
        if (ts || !BOT) { s.kickoff = true; s.ts = ts || ""; s.score = score; changed = true; }
      } else {
        s.kickoff = true; s.ts = ""; s.score = score; changed = true;   // silent seed, no duplicate
      }
    }

    // SCORE CHANGE → reply in the match thread, tagging the side that scored.
    if (stateStr === "in" && s.kickoff && s.ts && score !== s.score) {
      const [oh, oa] = String(s.score || "0-0").split("-").map(Number);
      const homeScored = hS > oh;
      const sp = homeScored ? hP : aP, sFlag = homeScored ? hFlag : aFlag, sTeam = homeScored ? hName : aName;
      const rt = await slackPost(`⚽ *${clock || "GOAL"}* — ${sFlag} *${sTeam}* score!  ${hFlag} ${hName} *${hS}–${aS}* ${aName} ${aFlag}  ·  ${ref(sp)}`, s.ts);
      if (rt || !BOT) { s.score = score; changed = true; }
    }

    // FULL TIME → final to the channel + winner-flag reaction on the kickoff message.
    if (isFull && !s.full) {
      const ft = await slackPost(`🏁 *FULL TIME* — ${hFlag} ${hName} *${hS}–${aS}* ${aName} ${aFlag}\nGG ${ref(hP)} & ${ref(aP)}`);
      if (ft || !BOT) {
        const winName = hS > aS ? reactionName(hFlag, hName) : aS > hS ? reactionName(aFlag, aName) : "handshake";
        await slackReact(s.ts, winName);
        s.full = true; s.kickoff = true; changed = true; ended = true;
      }
    }
  }

  // Event-driven standings: write a trigger the standings job watches, so update.mjs (the only
  // paid API call) runs ONLY when a match finishes — not hourly. tick.yml compares this against
  // last_update and refreshes when it's newer.
  if (ended) {
    await writeFile(join(DATA, "standings-trigger.json"), JSON.stringify({ lastFullTime: Math.floor(Date.now() / 1000) }) + "\n");
    console.log("[live] a match finished — flagged a standings refresh");
  }

  if (changed) { await writeFile(join(DATA, "live-state.json"), JSON.stringify(state, null, 2) + "\n"); console.log("[live] state updated"); }
  else console.log("[live] no changes");
}

main().catch((e) => { console.error("[live] FAILED:", e); process.exit(1); });
