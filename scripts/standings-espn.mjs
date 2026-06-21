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
  for (const g of groups) {
    const letter = String(g.name || "").replace(/group/i, "").trim();
    for (const e of g.standings?.entries || []) {
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

  // ---- 3) per-person survival board ----
  let entries = roster.people.map((p) => {
    const t = td.get(canonical(p.team, teams)) || { played: 0, points: 0, gd: 0, note: "", group: p.group };
    const eliminated = /eliminat/i.test(t.note);
    const advanced = /advance|best/i.test(t.note);
    const f = form.get(canonical(p.team, teams)) || { form: "-", label: "" };
    return {
      name: p.name, team: p.team, group: p.group || t.group, flag: p.flag, photo: p.photo, slackId: p.slackId || null,
      status: eliminated ? "eliminated" : "alive",
      stageReached: eliminated ? "group" : advanced ? "R32" : "group",
      eliminatedAt: eliminated ? "Group stage" : null,
      played: t.played, points: t.points, gd: t.gd,
      form: ["W", "D", "L"].includes(f.form) ? f.form : "-",
      statusLabel: eliminated ? (f.label || "Out") : advanced ? "Through to R32" : (f.label || "—"),
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
  const out = {
    updatedAt: new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true }).format(new Date()) + " PT",
    stage: maxPlayed >= 3 ? "Group Stage — Final round" : `Group Stage — Matchday ${maxPlayed || 1}`,
    aliveCount: entries.filter((e) => e.status === "alive").length,
    eliminatedCount: entries.filter((e) => e.status === "eliminated").length,
    champion: null,
    recentResults,
    bracket: prev.bracket || null,                   // group stage: keep whatever was there (usually null)
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
