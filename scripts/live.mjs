// Live match watcher — posts KICKOFF / HALF TIME / FULL TIME to Slack from ESPN's free feed.
// No API key, no bot token: reads the public ESPN 2026 World Cup scoreboard, detects each
// match's transitions, and posts to the existing Slack webhook, tagging the owners.
// State (which events already announced) lives in data/live-state.json, committed by the Action.

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA = join(__dirname, "..", "data");
const ESPN = "https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard";

const norm = (s) => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z]/g, "");
const ALIASES = {
  turkiye: "Turkey", turkey: "Turkey",
  czechia: "Czech Republic", czechrepublic: "Czech Republic",
  drcongo: "Congo DR", congodr: "Congo DR", democraticrepublicofthecongo: "Congo DR", congo: "Congo DR",
  southkorea: "Korea Republic", korearepublic: "Korea Republic", korea: "Korea Republic",
  iriran: "Iran", iran: "Iran",
  usa: "United States", unitedstates: "United States", us: "United States",
  ivorycoast: "Côte d'Ivoire", cotedivoire: "Côte d'Ivoire",
  bosniaherzegovina: "Bosnia and Herzegovina", bosniaandherzegovina: "Bosnia and Herzegovina", bosnia: "Bosnia and Herzegovina",
  capeverde: "Cape Verde", caboverde: "Cape Verde",
  saudiarabia: "Saudi Arabia", newzealand: "New Zealand", southafrica: "South Africa",
};
const canonical = (name, teams) => { const n = norm(name); return ALIASES[n] || teams.find((t) => norm(t) === n) || name; };
const ref = (o) => (o ? (o.slackId ? `<@${o.slackId}>` : `*${o.name}*`) : "");

async function postSlack(text) {
  const url = process.env.SLACK_WEBHOOK_URL;
  if (!url) { console.log("[live] no SLACK_WEBHOOK_URL — would post:\n" + text); return; }
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }) });
  console.log(r.ok ? "[live] posted" : `[live] slack failed ${r.status} ${await r.text()}`);
}

async function main() {
  const roster = JSON.parse(await readFile(join(DATA, "roster.json"), "utf8"));
  const teams = roster.people.map((p) => p.team);
  const owner = new Map(roster.people.map((p) => [canonical(p.team, teams), p]));

  let state = {};
  try { state = JSON.parse(await readFile(join(DATA, "live-state.json"), "utf8")); } catch { /* first run */ }
  const firstRun = Object.keys(state).length === 0;

  const res = await fetch(ESPN, { headers: { "User-Agent": "triton-wc/1.0" } });
  if (!res.ok) { console.error("[live] ESPN fetch failed", res.status); process.exit(0); }
  const events = (await res.json()).events || [];
  console.log(`[live] ${events.length} events; firstRun=${firstRun}`);

  let changed = false;
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
    const hScore = home.score ?? "0", aScore = away.score ?? "0";
    const grp = hP?.group || aP?.group || "";

    const st = ev.status?.type || {};
    const stateStr = st.state;                                   // pre | in | post
    const desc = st.description || st.detail || st.shortDetail || "";
    const isHalf = /half.?time/i.test(desc);
    const isFull = st.completed || stateStr === "post";
    const period = ev.status?.period || 1;
    const clock = parseInt(String(ev.status?.displayClock || "0").replace(/[^0-9]/g, "")) || 0;

    const id = ev.id || `${canonical(hName, teams)}-${canonical(aName, teams)}-${ev.date}`;
    const s = state[id] || (state[id] = {});

    // First run ever: silently seed in-progress / finished matches so we never blast a late
    // KICKOFF or a stale FULL TIME on deploy. Only matches that start later get a real post.
    if (firstRun && stateStr !== "pre") {
      s.kickoff = true;
      s.half = period >= 2 || isHalf;
      s.full = isFull;
      changed = true;
      continue;
    }

    if (stateStr === "in" && !s.kickoff) {
      if (period === 1 && clock <= 18) {
        await postSlack(`⚽ *KICK OFF*${grp ? ` — Group ${grp}` : ""}\n${hFlag} ${hName}  vs  ${aName} ${aFlag}\nGood luck ${ref(hP)} & ${ref(aP)}! 🍀`);
      }
      s.kickoff = true; changed = true;            // mark done even if we joined late (no post)
    }
    if (isHalf && !s.half) {
      await postSlack(`⏸️ *HALF TIME* — ${hFlag} ${hName} *${hScore}–${aScore}* ${aName} ${aFlag}`);
      s.half = true; changed = true;
    }
    if (isFull && !s.full) {
      await postSlack(`🏁 *FULL TIME* — ${hFlag} ${hName} *${hScore}–${aScore}* ${aName} ${aFlag}\nGG ${ref(hP)} & ${ref(aP)}`);
      s.full = true; s.kickoff = true; s.half = true; changed = true;
    }
  }

  if (changed) { await writeFile(join(DATA, "live-state.json"), JSON.stringify(state, null, 2) + "\n"); console.log("[live] state updated"); }
  else console.log("[live] no changes");
}

main().catch((e) => { console.error("[live] FAILED:", e); process.exit(1); });
