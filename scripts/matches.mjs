// Match strip + recaps — sourced straight from ESPN's free feed every tick.
//
// Writes data/matches.json: today's LIVE / FINISHED / UPCOMING matches, each card carrying a
// full recap (goals + cards, tagged to the pool owner whose team it is) and — for finished games —
// a survival-impact line cross-referenced against data/standings.json (who got knocked out).
//
// This replaces the Claude-sourced match strip (which only refreshed hourly and had no event IDs):
// ESPN gives real event IDs, live scores, and a per-match summary endpoint with goal scorers + cards.

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA = join(__dirname, "..", "data");
const ESPN_BASE = "https://site.api.espn.com/apis/site/v2/sports/soccer";
const UA = { "User-Agent": "triton-wc/1.0" };

// ---- team-name canonicalisation (mirrors live.mjs / update.mjs) ----
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

// ---- date / time formatting in US Pacific ----
const PT = (opts) => new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", ...opts });
const fmtDate = (iso) => PT({ weekday: "short", month: "short", day: "numeric" }).format(new Date(iso));
const fmtTime = (iso) => PT({ hour: "numeric", minute: "2-digit", hour12: true }).format(new Date(iso)) + " PT";

// Classify an ESPN keyEvent. Returns {kind:'goal'|'card', ...} or null for noise (delays, kickoff…).
function classifyEvent(ev) {
  const type = ev.type?.text || "";
  const minute = String(ev.clock?.displayValue || "").trim();
  const players = (ev.participants || []).map((p) => p.athlete?.displayName).filter(Boolean);
  if (/goal/i.test(type) && !/(disallow|cancel|missed|saved)/i.test(type)) {
    return { kind: "goal", minute, team: ev.team?.displayName || "", scorer: players[0] || "", assist: players[1] || "", own: /own/i.test(type), penalty: /penalt/i.test(type) };
  }
  if (/penalt/i.test(type) && /scored/i.test(type)) {
    return { kind: "goal", minute, team: ev.team?.displayName || "", scorer: players[0] || "", assist: "", own: false, penalty: true };
  }
  if (/card/i.test(type)) {
    return { kind: "card", minute, team: ev.team?.displayName || "", player: players[0] || "", color: /red/i.test(type) ? "red" : "yellow" };
  }
  return null;
}

async function fetchRecap(league, id, sideOf) {
  try {
    const r = await fetch(`${ESPN_BASE}/${league}/summary?event=${id}`, { headers: UA });
    if (!r.ok) return { goals: [], cards: [] };
    const key = (await r.json()).keyEvents || [];
    const goals = [], cards = [];
    for (const raw of key) {
      const e = classifyEvent(raw);
      if (!e) continue;
      const side = sideOf(e.team);                 // 'a' (home) | 'b' (away) | null
      if (e.kind === "goal") goals.push({ minute: e.minute, side, scorer: e.scorer, assist: e.assist, own: e.own, penalty: e.penalty });
      else cards.push({ minute: e.minute, side, player: e.player, color: e.color });
    }
    return { goals, cards };
  } catch { return { goals: [], cards: [] }; }
}

async function main() {
  const cfg = JSON.parse(await readFile(join(DATA, "..", "config.json"), "utf8").catch(() => "{}"));
  const league = cfg.competition?.espnLeague || "fifa.world";
  const roster = JSON.parse(await readFile(join(DATA, "roster.json"), "utf8"));
  const teams = roster.people.map((p) => p.team);
  const owner = new Map(roster.people.map((p) => [canonical(p.team, teams), p]));

  // Who is already out (for the survival-impact line). Keyed by canonical team.
  let eliminated = new Map();
  try {
    const st = JSON.parse(await readFile(join(DATA, "standings.json"), "utf8"));
    for (const s of st.standings || []) if (s.status === "eliminated") eliminated.set(canonical(s.team, teams), s);
  } catch { /* standings not ready yet */ }

  const res = await fetch(`${ESPN_BASE}/${league}/scoreboard`, { headers: UA });
  if (!res.ok) { console.error("[matches] scoreboard fetch failed", res.status); process.exit(0); }
  const events = (await res.json()).events || [];
  console.log(`[matches] ${events.length} events today`);

  const live = [], recent = [], upcoming = [];

  for (const ev of events) {
    const comp = ev.competitions?.[0]; if (!comp) continue;
    const cs = comp.competitors || [];
    const home = cs.find((c) => c.homeAway === "home") || cs[0];
    const away = cs.find((c) => c.homeAway === "away") || cs[1];
    if (!home || !away) continue;

    const hName = home.team?.displayName || home.team?.name || "";
    const aName = away.team?.displayName || away.team?.name || "";
    const hCanon = canonical(hName, teams), aCanon = canonical(aName, teams);
    const hP = owner.get(hCanon), aP = owner.get(aCanon);
    const sideOf = (espnTeam) => { const c = canonical(espnTeam, teams); return c === hCanon ? "a" : c === aCanon ? "b" : null; };

    const headline = comp.notes?.[0]?.headline || comp.notes?.[0]?.type || "";
    const isKnockout = !!headline && !/group/i.test(headline);
    const grp = hP?.group || aP?.group || "";
    const compLabel = isKnockout
      ? headline.replace(/\s*-\s*Matchday.*$/i, "").trim()
      : grp ? `Group ${grp}` : "World Cup";

    const st = ev.status?.type || {};
    const state = st.state;                         // pre | in | post
    const side = (p, score) => ({
      team: p?.team || (p === hP ? hName : aName), flag: p?.flag || "",
      owner: p?.name || null, ownerSlackId: p?.slackId || null, score: Number(score ?? 0),
    });
    const a = side(hP, home.score), b = side(aP, away.score);

    const base = { id: ev.id, state, competition: compLabel, knockout: !!isKnockout, a, b };

    if (state === "pre") {
      upcoming.push({ ...base, date: fmtDate(ev.date), time: fmtTime(ev.date) });
      continue;
    }

    const recap = await fetchRecap(league, ev.id, sideOf);

    // Survival impact (finished games only): did this knock anyone out of the pool?
    let impact = null;
    if (state === "post") {
      const hS = a.score, aS = b.score;
      const out = [];
      const note = (p, loser) => {
        if (!p) return;
        if (eliminated.has(canonical(p.team, teams))) out.push(`${p.flag} ${p.team} are out — ${p.name} is eliminated`);
        else if (isKnockout && loser) out.push(`${p.flag} ${p.team} are knocked out — ${p.name} is eliminated`);
      };
      note(hP, hS < aS); note(aP, aS < hS);
      if (out.length) impact = "❌ " + out.join(" · ");
    }

    const card = { ...base, minute: String(ev.status?.displayClock || "").trim(), recap, impact };
    if (state === "in") live.push(card); else recent.push(card);
  }

  const out = {
    updatedAt: PT({ month: "short", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true }).format(new Date()) + " PT",
    live, recent, upcoming: upcoming.slice(0, 4),
  };
  await writeFile(join(DATA, "matches.json"), JSON.stringify(out, null, 2) + "\n");
  console.log(`[matches] wrote matches.json — ${live.length} live, ${recent.length} finished, ${upcoming.length} upcoming`);
}

main().catch((e) => { console.error("[matches] FAILED:", e); process.exit(1); });
