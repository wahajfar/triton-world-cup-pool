// Survival standings — built from ESPN's FREE feed (no paid API).
//
// Replaces the Claude+web-search updater (update.mjs) as the standings source: ESPN's standings
// endpoint already gives full group tables AND a per-team qualification note ("Advance to Round of
// 32" / "Best 8 advance" / "Eliminated"), so survival status is a direct read — no model needed,
// no cost, and it isn't blocked by the Anthropic spend cap. Diffs against the previous
// standings.json to post Slack elimination/advancement alerts, then writes standings.json.
//
// Env: SLACK_WEBHOOK_URL (optional), DIGEST ("true" forces a digest), SITE_URL (optional).

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA = join(__dirname, "..", "data");
const SITE_URL = process.env.SITE_URL || "https://triton-world-cup.vercel.app";
const UA = { "User-Agent": "triton-wc/1.0" };

const STAGE_RANK = { group: 0, R32: 1, R16: 2, QF: 3, SF: 4, Final: 5, Champion: 6 };
const STAGE_NAME = { group: "Group stage", R32: "Round of 32", R16: "Round of 16", QF: "Quarter-finals", SF: "Semi-finals", Final: "the Final", Champion: "Champion" };
// ESPN season.slug → [stage key, display name]; NEXT = round a winner advances to.
const KO_ROUNDS = { "round-of-32": ["R32", "Round of 32"], "round-of-16": ["R16", "Round of 16"], "quarterfinals": ["QF", "Quarter-finals"], "quarter-finals": ["QF", "Quarter-finals"], "semifinals": ["SF", "Semi-finals"], "semi-finals": ["SF", "Semi-finals"], "final": ["Final", "Final"] };
const KO_NEXT = { R32: "R16", R16: "QF", QF: "SF", SF: "Final", Final: "Champion" };
const ROUND_DEFS = [["R32", "Round of 32", 16], ["R16", "Round of 16", 8], ["QF", "Quarter-finals", 4], ["SF", "Semi-finals", 2], ["Final", "Final", 1]];

// ---- team-name canonicalisation (mirrors live.mjs / matches.mjs) ----
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
const statVal = (entry, key) => { const s = (entry.stats || []).find((x) => x.name === key); return s ? Number(s.value ?? s.displayValue ?? 0) : 0; };

async function postSlack(text) {
  const url = process.env.SLACK_WEBHOOK_URL;
  if (!url) { console.log("[espn] no SLACK_WEBHOOK_URL — skipping post:\n" + text); return; }
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }) });
  if (!res.ok) console.error("[espn] slack post failed:", res.status, await res.text());
}

async function main() {
  const cfg = JSON.parse(await readFile(join(DATA, "..", "config.json"), "utf8").catch(() => "{}"));
  const league = cfg.competition?.espnLeague || "fifa.world";
  const roster = JSON.parse(await readFile(join(DATA, "roster.json"), "utf8"));
  const prev = JSON.parse(await readFile(join(DATA, "standings.json"), "utf8").catch(() => "{}"));
  const teams = roster.people.map((p) => p.team);

  // ---- 1) group tables + qualification notes ----
  const sRes = await fetch(`https://site.api.espn.com/apis/v2/sports/soccer/${league}/standings`, { headers: UA });
  if (!sRes.ok) { console.error("[espn] standings fetch failed", sRes.status); process.exit(1); }
  const groups = (await sRes.json()).children || [];
  const td = new Map();                              // canonical team -> { played, points, gd, note, group }
  const groupDone = new Map();                        // group letter -> true once all 4 teams have played 3
  for (const g of groups) {
    const letter = String(g.name || "").replace(/group/i, "").trim();
    const ents = g.standings?.entries || [];
    groupDone.set(letter, ents.length > 0 && ents.every((e) => statVal(e, "gamesPlayed") >= 3));
    for (const e of ents) {
      const key = canonical(e.team?.displayName || "", teams);
      td.set(key, {
        played: statVal(e, "gamesPlayed"), points: statVal(e, "points"), gd: statVal(e, "pointDifferential"),
        note: e.note?.description || "", group: letter,
      });
    }
  }

  // ---- 2) results + per-team last-match form (whole tournament window) ----
  const scRes = await fetch(`https://site.api.espn.com/apis/site/v2/sports/soccer/${league}/scoreboard?dates=20260611-20260719`, { headers: UA });
  const events = scRes.ok ? ((await scRes.json()).events || []) : [];
  const form = new Map();                            // canonical team -> { form, label }
  const finished = [];
  for (const ev of events) {
    if ((ev.status?.type?.state) !== "post") continue;
    const comp = ev.competitions?.[0]; if (!comp) continue;
    const cs = comp.competitors || [];
    const h = cs.find((c) => c.homeAway === "home") || cs[0], a = cs.find((c) => c.homeAway === "away") || cs[1];
    if (!h || !a) continue;
    const hN = canonical(h.team?.displayName || "", teams), aN = canonical(a.team?.displayName || "", teams);
    const hs = Number(h.score ?? 0), as = Number(a.score ?? 0);
    finished.push({ date: ev.date || "", grp: td.get(hN)?.group || td.get(aN)?.group || "", hN, aN, hs, as });
    const res = (gf, ga) => (gf > ga ? "W" : gf < ga ? "L" : "D");
    form.set(hN, { form: res(hs, as), label: `${res(hs, as)} ${hs}–${as}` });
    form.set(aN, { form: res(as, hs), label: `${res(as, hs)} ${as}–${hs}` });
  }
  finished.sort((x, y) => String(x.date).localeCompare(String(y.date)));   // chronological → latest form wins
  for (const m of finished) {
    const res = (gf, ga) => (gf > ga ? "W" : gf < ga ? "L" : "D");
    form.set(m.hN, { form: res(m.hs, m.as), label: `${res(m.hs, m.as)} ${m.hs}–${m.as}` });
    form.set(m.aN, { form: res(m.as, m.hs), label: `${res(m.as, m.hs)} ${m.as}–${m.hs}` });
  }
  const recentResults = finished.slice(-16).reverse()
    .map((m) => `${m.grp ? `Group ${m.grp} — ` : ""}${m.hN} ${m.hs}-${m.as} ${m.aN}`);

  // ---- 2b) KNOCKOUTS: eliminate losers, advance winners, AND lay out the bracket in true
  //         bracket-position order. ESPN names each future fixture after its feeders — e.g. an R16
  //         match "Round of 32 1 Winner vs Round of 32 3 Winner" is fed by R32 matches #1 and #3 —
  //         so we reconstruct the exact tree instead of listing matches by kickoff time.
  const r32Teams = new Set();
  let koActiveOrder = -1;
  const KEY_NAME = {}; for (const s in KO_ROUNDS) KEY_NAME[KO_ROUNDS[s][0]] = KO_ROUNDS[s][1];
  const slotFor = (espnName, winner, played) => {
    const person = roster.people.find((x) => canonical(x.team, teams) === canonical(espnName, teams));
    if (!person) return null;                          // future-round placeholder → TBD
    return { team: person.team, flag: person.flag || "", person: person.name, win: played && winner === true, lose: played && winner === false };
  };
  const feederNum = (name) => { const m = String(name || "").match(/(\d+)\s+Winner\s*$/i); return m ? +m[1] : null; };

  // Collect knockout matches per round, sorted by event id (= FIFA match number within the round).
  const raw = {};
  for (const ev of events) {
    const r = KO_ROUNDS[ev.season?.slug || ""]; if (!r) continue;
    const comp = ev.competitions?.[0]; if (!comp) continue;
    const cs = comp.competitors || [];
    const h = cs.find((c) => c.homeAway === "home") || cs[0], a = cs.find((c) => c.homeAway === "away") || cs[1];
    if (!h || !a) continue;
    (raw[r[0]] ||= []).push({
      id: Number(ev.id) || 0, hN: h.team?.displayName || "", aN: a.team?.displayName || "",
      hWin: h.winner, aWin: a.winner, played: ev.status?.type?.state === "post", state: ev.status?.type?.state,
      hFeed: feederNum(h.team?.displayName), aFeed: feederNum(a.team?.displayName),
    });
  }
  for (const k of Object.keys(raw)) raw[k].sort((x, y) => x.id - y.id);

  // Eliminations / advancement / R32 field / furthest active round.
  const koByTeam = new Map();
  for (const [key, ms] of Object.entries(raw)) {
    const roundOrder = ROUND_DEFS.findIndex((d) => d[0] === key);
    for (const m of ms) {
      if (key === "R32") { r32Teams.add(canonical(m.hN, teams)); r32Teams.add(canonical(m.aN, teams)); }
      if (m.played || m.state === "in") koActiveOrder = Math.max(koActiveOrder, roundOrder);
      if (!m.played) continue;
      for (const [name, win] of [[m.hN, m.hWin], [m.aN, m.aWin]]) {
        const ct = canonical(name, teams), prev2 = koByTeam.get(ct);
        if (prev2 && prev2._order > roundOrder) continue;
        if (win === true) { const adv = KO_NEXT[key]; koByTeam.set(ct, { eliminated: false, eliminatedAt: null, stageReached: adv === "Champion" ? "Champion" : adv, champion: adv === "Champion", _order: roundOrder }); }
        else koByTeam.set(ct, { eliminated: true, eliminatedAt: KEY_NAME[key], stageReached: key, champion: false, _order: roundOrder });
      }
    }
  }

  // A feeder slot is named after its source match ("Round of 32 3 Winner" → 3). But once that match
  // is decided, ESPN shows the real team instead of the placeholder — so fall back to looking up
  // which match in the child round that team came from.
  const matchNumByTeam = {};
  for (const [key, ms] of Object.entries(raw)) {
    matchNumByTeam[key] = {};
    ms.forEach((m, i) => { for (const nm of [m.hN, m.aN]) { const c = canonical(nm, teams); if (roster.people.some((x) => canonical(x.team, teams) === c)) matchNumByTeam[key][c] = i + 1; } });
  }
  const feederOf = (name, childKey) => feederNum(name) ?? matchNumByTeam[childKey]?.[canonical(name, teams)] ?? null;

  // Reconstruct bracket-position order top→bottom: each round's order is its parent round's feeders
  // walked in the parent's order (Final → SF → QF → R16 → R32).
  const order = {};
  const chain = ["Final", "SF", "QF", "R16", "R32"];
  order.Final = (raw.Final || []).map((_, i) => i + 1);
  for (let i = 1; i < chain.length; i++) {
    const parent = chain[i - 1], child = chain[i];
    const pm = raw[parent] || [], po = order[parent]?.length ? order[parent] : pm.map((_, k) => k + 1);
    const co = [];
    for (const n of po) { const m = pm[n - 1]; if (!m) continue; const hf = feederOf(m.hN, child), af = feederOf(m.aN, child); if (hf) co.push(hf); if (af) co.push(af); }
    order[child] = co;
  }

  // Build the bracket columns in that order (fall back to id order if a round didn't resolve cleanly).
  const bracketByRound = new Map();
  for (const [key, ms] of Object.entries(raw)) {
    const ord = order[key]?.length === ms.length ? order[key] : ms.map((_, k) => k + 1);
    bracketByRound.set(key, ord.map((n) => { const m = ms[n - 1]; return m ? { a: slotFor(m.hN, m.hWin, m.played), b: slotFor(m.aN, m.aWin, m.played) } : { a: null, b: null }; }));
  }
  const inKnockouts = bracketByRound.size > 0;

  // ---- 3) per-person survival board ----
  let entries = roster.people.map((p) => {
    const cteam = canonical(p.team, teams);
    const t = td.get(cteam) || { played: 0, points: 0, gd: 0, note: "", group: p.group };
    const ko = koByTeam.get(cteam);
    const f = form.get(cteam) || { form: "-", label: "" };
    let status, stageReached, eliminatedAt, statusLabel;
    if (ko) {
      // Knockout result is definitive — it supersedes the group note.
      status = ko.eliminated ? "eliminated" : "alive";
      stageReached = ko.stageReached;
      eliminatedAt = ko.eliminated ? ko.eliminatedAt : null;
      statusLabel = ko.champion ? "🏆 Champion" : ko.eliminated ? `Out — ${ko.eliminatedAt}` : `Into the ${STAGE_NAME[ko.stageReached] || ko.stageReached}`;
    } else if (r32Teams.size > 0) {
      // R32 is drawn → group survival is DEFINITIVE: a team is through iff it's in the 32-team
      // field. (ESPN's "Best 8 advance" note marks all 12 third-placed teams, but only 8 go
      // through — so the bracket, not the note, is the source of truth.)
      const through = r32Teams.has(cteam);
      status = through ? "alive" : "eliminated";
      stageReached = through ? "R32" : "group";
      eliminatedAt = through ? null : "Group stage";
      statusLabel = through ? "✅ Through to R32" : (f.label || "Out");
    } else {
      // Pure group stage, R32 not drawn yet. ESPN's note is a live projection until the group
      // finishes; only the clinched top-2 ("Advance…") are through, the clinched-out ("Eliminated")
      // are out, and 3rd-placed ("Best 8 advance") stay alive/in-contention until the draw.
      const finalGroup = groupDone.get(t.group) === true;
      const eliminated = finalGroup && /eliminat/i.test(t.note);
      const advanced = finalGroup && /^advance/i.test(t.note);
      status = eliminated ? "eliminated" : "alive";
      stageReached = advanced ? "R32" : "group";
      eliminatedAt = eliminated ? "Group stage" : null;
      statusLabel = eliminated ? (f.label || "Out") : advanced ? "✅ Through to R32" : (f.label || "—");
    }
    return {
      name: p.name, team: p.team, group: p.group || t.group, flag: p.flag, photo: p.photo, slackId: p.slackId || null,
      status, stageReached, eliminatedAt, played: t.played, points: t.points, gd: t.gd,
      form: ["W", "D", "L"].includes(f.form) ? f.form : "-", statusLabel,
    };
  });

  entries.sort((a, b) => {
    if ((a.status === "alive") !== (b.status === "alive")) return a.status === "alive" ? -1 : 1;
    const sr = STAGE_RANK[b.stageReached] - STAGE_RANK[a.stageReached];
    if (sr) return sr;
    if (b.points !== a.points) return b.points - a.points;
    if (b.gd !== a.gd) return b.gd - a.gd;
    return a.name.localeCompare(b.name);
  });
  entries.forEach((e, i) => (e.rank = i + 1));

  // ---- 4) diff vs previous for Slack alerts ----
  const prevByName = new Map((prev.standings || []).map((p) => [p.name, p]));
  const eliminations = [], advancements = [];
  for (const e of entries) {
    const prior = prevByName.get(e.name);
    if (!prior) continue;
    if (prior.status !== "eliminated" && e.status === "eliminated") eliminations.push(e);
    else if (e.status === "alive" && STAGE_RANK[e.stageReached] > STAGE_RANK[prior.stageReached || "group"]) advancements.push(e);
  }

  const maxPlayed = Math.max(0, ...entries.map((e) => e.played));
  // Stage label: furthest knockout round actually being PLAYED (not just scheduled), else group.
  const stage = koActiveOrder >= 0
    ? ROUND_DEFS[koActiveOrder][1]
    : (maxPlayed >= 3 ? "Group Stage — Final round" : `Group Stage — Matchday ${maxPlayed || 1}`);
  // Bracket: every round that has fixtures, with a TBD skeleton for rounds not yet drawn.
  const bracket = inKnockouts
    ? { rounds: ROUND_DEFS.map(([key, name, n]) => { const ms = bracketByRound.get(key); return { name, matches: ms && ms.length ? ms : Array.from({ length: n }, () => ({ a: null, b: null })) }; }) }
    : (prev.bracket || null);
  const champ = entries.find((e) => e.stageReached === "Champion") || null;
  const out = {
    updatedAt: new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true }).format(new Date()) + " PT",
    stage,
    aliveCount: entries.filter((e) => e.status === "alive").length,
    eliminatedCount: entries.filter((e) => e.status === "eliminated").length,
    champion: champ ? { name: champ.name, team: champ.team, flag: champ.flag, slackId: champ.slackId || null } : null,
    recentResults,
    bracket,
    matches: prev.matches || null,                   // strip is driven by matches.json; keep prev here
    standings: entries,
  };
  await writeFile(join(DATA, "standings.json"), JSON.stringify(out, null, 2) + "\n");
  console.log(`[espn] wrote standings.json — ${out.aliveCount} alive, ${out.eliminatedCount} out; new: ${eliminations.length} elim, ${advancements.length} adv`);

  // ---- 5) Slack alerts ----
  const tag = (e) => (e && e.slackId ? `<@${e.slackId}>` : `*${e?.name || ""}*`);
  const lines = [];
  if (advancements.length) { lines.push("⬆️ *Through to the next round:*"); for (const e of advancements) lines.push(`   ${e.flag} ${e.team} advance — ${tag(e)} lives on! 🎉`); }
  if (eliminations.length) { if (lines.length) lines.push(""); lines.push("⚰️ *Eliminated:*"); for (const e of eliminations) lines.push(`   ${e.flag} ${e.team} are out (${e.eliminatedAt}). ${tag(e)} is knocked out of the pool. 🫡`); }
  if (lines.length) await postSlack(lines.join("\n"));

  if (String(process.env.DIGEST).toLowerCase() === "true") {
    const top = entries[0];
    await postSlack([
      `📰 *World Cup Pool — Daily Digest (${out.updatedAt})*`,
      `🟢 ${out.aliveCount} still alive · ⚰️ ${out.eliminatedCount} out · 📅 ${out.stage}`,
      top ? `Top of the board: ${top.flag} ${tag(top)} (${top.team})` : "",
      `Full standings & bracket → ${SITE_URL}`,
    ].filter(Boolean).join("\n"));
  }
}

main().catch((e) => { console.error("[espn] FAILED:", e); process.exit(1); });
