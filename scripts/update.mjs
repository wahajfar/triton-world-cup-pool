// Triton World Cup 2026 — Survival Pool updater.
//
// Runs on a schedule (GitHub Actions). Steps:
//   1. Use the Claude API with web search to fetch current 2026 World Cup results
//      and each team's tournament status.
//   2. Map teams -> people, compute the survival standings.
//   3. Diff against the previous standings to find new eliminations / advancements.
//   4. Post Slack alerts (and a daily digest on the evening run) via an Incoming Webhook.
//   5. Write data/standings.json (the GitHub Action commits it; Vercel redeploys).
//
// Env: ANTHROPIC_API_KEY (required), SLACK_WEBHOOK_URL (optional), DIGEST ("true" forces a digest),
//      MODEL (optional, default claude-sonnet-4-6 — cheap; the task is extraction, not deep reasoning).

import Anthropic from "@anthropic-ai/sdk";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA = join(__dirname, "..", "data");
const MODEL = process.env.MODEL || "claude-sonnet-4-6";
const SITE_URL = process.env.SITE_URL || "https://triton-world-cup.vercel.app";

const STAGE_RANK = { group: 0, R32: 1, R16: 2, QF: 3, SF: 4, Final: 5, Champion: 6 };
const STAGE_NAME = { group: "Group stage", R32: "Round of 32", R16: "Round of 16", QF: "Quarter-finals", SF: "Semi-finals", Final: "the Final", Champion: "Champion" };

// ---------- helpers ----------
const norm = (s) => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z]/g, "");

// Alias -> canonical roster team name. Covers the variants Claude/feeds tend to use.
const ALIASES = {
  turkiye: "Turkey", turkey: "Turkey",
  czechia: "Czech Republic", czechrepublic: "Czech Republic",
  drcongo: "Congo DR", congodr: "Congo DR", democraticrepublicofthecongo: "Congo DR", congokinshasa: "Congo DR",
  southkorea: "Korea Republic", korearepublic: "Korea Republic", korea: "Korea Republic",
  usa: "United States", unitedstates: "United States", unitedstatesofamerica: "United States", us: "United States",
  ivorycoast: "Côte d'Ivoire", cotedivoire: "Côte d'Ivoire",
  bosnia: "Bosnia and Herzegovina", bosniaandherzegovina: "Bosnia and Herzegovina",
  capeverde: "Cape Verde", caboverde: "Cape Verde",
  saudiarabia: "Saudi Arabia",
  newzealand: "New Zealand", southafrica: "South Africa",
};

function canonicalTeam(name, rosterTeams) {
  const n = norm(name);
  if (ALIASES[n]) return ALIASES[n];
  const hit = rosterTeams.find((t) => norm(t) === n);
  return hit || name;
}

function extractJson(text) {
  // Prefer a fenced ```json block; else the largest balanced object.
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("No JSON object found in model output");
  return JSON.parse(candidate.slice(start, end + 1));
}

async function postSlack(text) {
  const url = process.env.SLACK_WEBHOOK_URL;
  if (!url) { console.log("[slack] no SLACK_WEBHOOK_URL set — skipping post:\n" + text); return; }
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }) });
  if (!res.ok) console.error("[slack] post failed:", res.status, await res.text());
  else console.log("[slack] posted.");
}

// Digest now posts ONLY on explicit request (DIGEST=true). Hourly scheduled runs refresh
// the site every hour but stay silent in Slack unless a team is eliminated/advances.
function isDigestRun() {
  return String(process.env.DIGEST).toLowerCase() === "true";
}

// ---------- model research ----------
async function fetchTournamentState(roster) {
  const client = new Anthropic(); // reads ANTHROPIC_API_KEY
  const teamLines = roster.people.map((p) => `- ${p.team} (Group ${p.group})`).join("\n");

  const prompt = `You are a precise sports-data assistant. Today's date is provided by the system. Use the web_search tool to get the CURRENT state of the 2026 FIFA World Cup (hosts USA/Canada/Mexico, June 11 – July 19, 2026). Cross-check at least two reputable sources (ESPN, FIFA.com, BBC Sport, Wikipedia "2026 FIFA World Cup"). Never invent results.

For EACH of these 48 teams, determine its current tournament status:
${teamLines}

Tournament format: 12 groups of 4. Top 2 of each group + the 8 best 3rd-placed teams advance to a Round of 32, then R16, Quarter-finals, Semi-finals, Final (July 19). A team is "eliminated" once it is mathematically out (finishes the group stage without advancing, or loses a knockout match).

Return ONLY a single JSON object (you may wrap it in a \`\`\`json fence) with this exact shape:
{
  "asOf": "YYYY-MM-DD",
  "stage": "short human label, e.g. 'Group Stage — Matchday 2' or 'Round of 16'",
  "teams": [
    {
      "team": "<team name exactly as listed above>",
      "status": "alive" | "eliminated",
      "stageReached": "group" | "R32" | "R16" | "QF" | "SF" | "Final" | "Champion",
      "eliminatedAt": "<stage where they were knocked out, e.g. 'Group stage', or null if alive>",
      "played": <group games played, integer>,
      "points": <current group points, integer; 0 once in knockouts>,
      "gd": <current group goal difference, integer; 0 once in knockouts>,
      "form": "W" | "D" | "L" | "-",
      "statusLabel": "<short note, e.g. 'Won 2-0', 'Drew 1-1', 'Through to R16', 'Out — 3rd in Group C'>"
    }
    // ... one entry for every team above
  ],
  "recentResults": ["<one line per recently completed match, e.g. 'Group A — Mexico 2-0 South Africa'>"],
  "bracket": {
    "rounds": [
      { "name": "Round of 32", "matches": [ { "a": { "team": "<team>", "win": true }, "b": { "team": "<team>", "win": false } } ] },
      { "name": "Round of 16", "matches": [] },
      { "name": "Quarter-finals", "matches": [] },
      { "name": "Semi-finals", "matches": [] },
      { "name": "Final", "matches": [] }
    ]
  },
  "matches": {
    "live": [ { "a": { "team": "<team>", "score": 2 }, "b": { "team": "<team>", "score": 1 }, "minute": "63'", "competition": "Group A" } ],
    "upcoming": [ { "a": { "team": "<team>" }, "b": { "team": "<team>" }, "date": "Mon Jun 15", "time": "9:00 AM PT", "competition": "Group H" } ]
  }
}

Rules:
- Include "bracket" ONLY once the Round of 32 draw is known (i.e. the knockout stage has been set or started). During the group stage, set "bracket" to null. Within each match, set "win": true on the team that won/advanced, false on the other, and omit "win" (or use false on both) if the match has not been played yet. Use the exact team names from the list above.
- For "matches": put any match CURRENTLY in progress in "live" (with the current score and the match minute, e.g. "63'"), and the next up to 5 upcoming fixtures in "upcoming" (chronological order), each with "date" (e.g. "Mon Jun 15") and the kickoff "time" in US Pacific time (e.g. "9:00 AM PT"). Use the exact team names above. If no match is live, use an empty "live" array.
- "stageReached" = the furthest round a team is currently in or has reached. For a team still in the group stage that has NOT yet clinched, use "group".
- Use "Champion" only for the team that has won the final.
- If a team has not played yet, status "alive", stageReached "group", form "-", played 0.
- Include every one of the 48 teams exactly once.`;

  const tools = [{ type: "web_search_20260209", name: "web_search", max_uses: 4 }];
  const messages = [{ role: "user", content: prompt }];
  // Cost controls: Sonnet + low effort + prompt caching. The web-search tool pauses the turn and
  // we re-send the growing history to resume; `cache_control` makes each re-send read the prior
  // turns from cache (~0.1x) instead of re-billing the whole accumulated context at full price.
  const base = { model: MODEL, max_tokens: 16000, thinking: { type: "adaptive" }, output_config: { effort: "low" }, tools, cache_control: { type: "ephemeral" } };

  let response = await client.messages.create({ ...base, messages });
  // Server-side web search may pause the turn; re-send to resume.
  let guard = 0;
  while (response.stop_reason === "pause_turn" && guard++ < 8) {
    messages.push({ role: "assistant", content: response.content });
    response = await client.messages.create({ ...base, messages });
  }

  const text = response.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
  return extractJson(text);
}

// ---------- standings computation ----------
function buildStandings(roster, prev, state) {
  const rosterTeams = roster.people.map((p) => p.team);
  const byTeam = new Map();
  for (const t of state.teams || []) byTeam.set(canonicalTeam(t.team, rosterTeams), t);

  const prevByName = new Map((prev.standings || []).map((p) => [p.name, p]));

  let entries = roster.people.map((p) => {
    const t = byTeam.get(p.team);
    if (!t) {
      // Team missing from model output — carry forward previous state rather than guess.
      const prior = prevByName.get(p.name);
      return { ...p, status: prior?.status || "alive", stageReached: prior?.stageReached || "group", eliminatedAt: prior?.eliminatedAt || null, played: prior?.played || 0, points: prior?.points || 0, gd: prior?.gd || 0, form: prior?.form || "-", statusLabel: prior?.statusLabel || "—" };
    }
    return {
      name: p.name, team: p.team, group: p.group, flag: p.flag, photo: p.photo, slackId: p.slackId || null,
      status: t.status === "eliminated" ? "eliminated" : "alive",
      stageReached: STAGE_RANK[t.stageReached] !== undefined ? t.stageReached : "group",
      eliminatedAt: t.status === "eliminated" ? (t.eliminatedAt || STAGE_NAME[t.stageReached] || "Group stage") : null,
      played: Number(t.played) || 0, points: Number(t.points) || 0, gd: Number(t.gd) || 0,
      form: ["W", "D", "L", "-"].includes(t.form) ? t.form : "-",
      statusLabel: t.statusLabel || "",
    };
  });

  // Sort: alive above eliminated; then by furthest stage, points, goal difference, name.
  entries.sort((a, b) => {
    if ((a.status === "alive") !== (b.status === "alive")) return a.status === "alive" ? -1 : 1;
    const sr = STAGE_RANK[b.stageReached] - STAGE_RANK[a.stageReached];
    if (sr) return sr;
    if (b.points !== a.points) return b.points - a.points;
    if (b.gd !== a.gd) return b.gd - a.gd;
    return a.name.localeCompare(b.name);
  });
  entries.forEach((e, i) => (e.rank = i + 1));

  // Diff vs previous run.
  const eliminations = [], advancements = [];
  for (const e of entries) {
    const prior = prevByName.get(e.name);
    if (!prior) continue;
    if (prior.status !== "eliminated" && e.status === "eliminated") eliminations.push(e);
    else if (e.status === "alive" && STAGE_RANK[e.stageReached] > STAGE_RANK[prior.stageReached || "group"]) advancements.push(e);
  }

  const champion = entries.find((e) => e.stageReached === "Champion") || null;

  // Enrich the knockout bracket (if the model returned one) with each slot's pool member.
  const teamToPerson = new Map(roster.people.map((p) => [canonicalTeam(p.team, rosterTeams), p]));
  function enrichSlot(slot) {
    if (!slot || !slot.team) return slot || null;
    const person = teamToPerson.get(canonicalTeam(slot.team, rosterTeams));
    return { team: person?.team || slot.team, flag: person?.flag || slot.flag || "", person: person?.name || null, win: slot.win === true, lose: slot.win === false };
  }
  let bracket = null;
  const srcBracket = state.bracket || prev.bracket;
  if (srcBracket && Array.isArray(srcBracket.rounds)) {
    bracket = { rounds: srcBracket.rounds.map((r) => ({ name: r.name, matches: (r.matches || []).map((m) => ({ a: enrichSlot(m.a), b: enrichSlot(m.b) })) })) };
  }

  // Live + upcoming matches, with flags attached from the roster.
  function enrichMatchTeam(slot) {
    if (!slot || !slot.team) return slot || null;
    const person = teamToPerson.get(canonicalTeam(slot.team, rosterTeams));
    return { team: person?.team || slot.team, flag: person?.flag || slot.flag || "", score: slot.score };
  }
  let matches = null;
  const srcMatches = state.matches || prev.matches;
  if (srcMatches) {
    matches = {
      live: (srcMatches.live || []).map((m) => ({ a: enrichMatchTeam(m.a), b: enrichMatchTeam(m.b), minute: m.minute || null, competition: m.competition || "" })),
      upcoming: (srcMatches.upcoming || []).map((m) => ({ a: enrichMatchTeam(m.a), b: enrichMatchTeam(m.b), date: m.date || "", time: m.time || "", competition: m.competition || "" })),
    };
  }

  const out = {
    updatedAt: new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true }).format(new Date()) + " PT",
    stage: state.stage || prev.stage || "Group Stage",
    aliveCount: entries.filter((e) => e.status === "alive").length,
    eliminatedCount: entries.filter((e) => e.status === "eliminated").length,
    champion: champion ? { name: champion.name, team: champion.team, flag: champion.flag, slackId: champion.slackId || null } : null,
    recentResults: Array.isArray(state.recentResults) ? state.recentResults.slice(0, 16) : (prev.recentResults || []),
    bracket,
    matches,
    standings: entries,
  };
  return { out, eliminations, advancements };
}

// ---------- Slack composition ----------
async function notify({ out, eliminations, advancements }) {
  const tag = (e) => (e && e.slackId ? `<@${e.slackId}>` : `*${e?.name || ""}*`);
  const lines = [];
  if (advancements.length) {
    lines.push("⬆️ *Through to the next round:*");
    for (const e of advancements) lines.push(`   ${e.flag} ${e.team} advance — ${tag(e)} lives on! 🎉`);
  }
  if (eliminations.length) {
    if (lines.length) lines.push("");
    lines.push("⚰️ *Eliminated:*");
    for (const e of eliminations) lines.push(`   ${e.flag} ${e.team} are out (${e.eliminatedAt}). ${tag(e)} is knocked out of the pool. 🫡`);
  }
  if (lines.length) await postSlack(lines.join("\n"));

  if (out.champion) {
    await postSlack(`🏆 *FULL TIME — WE HAVE A CHAMPION!* ${out.champion.flag} ${out.champion.team} win the 2026 World Cup. ${tag(out.champion)} wins the Triton survival pool! 🥇🎉`);
    return;
  }

  if (isDigestRun()) {
    const top = out.standings[0];
    const digest = [
      `📰 *World Cup Pool — Daily Digest (${out.updatedAt})*`,
      `🟢 ${out.aliveCount} still alive · ⚰️ ${out.eliminatedCount} out · 📅 ${out.stage}`,
      eliminations.length ? `Knocked out today: ${eliminations.map((e) => `${e.flag} ${tag(e)}`).join(", ")}` : "No eliminations today.",
      top ? `Top of the board: ${top.flag} ${tag(top)} (${top.team})` : "",
      `Full standings & bracket → ${SITE_URL}`,
    ].filter(Boolean).join("\n");
    await postSlack(digest);
  }
}

// ---------- main ----------
async function main() {
  const roster = JSON.parse(await readFile(join(DATA, "roster.json"), "utf8"));
  const prev = JSON.parse(await readFile(join(DATA, "standings.json"), "utf8"));

  console.log("[wc] fetching tournament state via Claude + web search…");
  const state = await fetchTournamentState(roster);
  console.log(`[wc] model reports stage: ${state.stage}, ${state.teams?.length} teams`);

  const result = buildStandings(roster, prev, state);
  console.log(`[wc] alive ${result.out.aliveCount}, eliminated ${result.out.eliminatedCount}; new: ${result.eliminations.length} out, ${result.advancements.length} advanced`);

  await writeFile(join(DATA, "standings.json"), JSON.stringify(result.out, null, 2) + "\n");
  console.log("[wc] wrote data/standings.json");

  await notify(result);
  console.log("[wc] done.");
}

main().catch((e) => { console.error("[wc] FAILED:", e); process.exit(1); });
