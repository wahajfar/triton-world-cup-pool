// Triton World Cup 2026 — Survival Pool front-end.
// Reads ./data/standings.json (refreshed by the GitHub Action) and renders the board + bracket.

const STAGE_NAMES = {
  group: "Group stage", R32: "Round of 32", R16: "Round of 16",
  QF: "Quarter-final", SF: "Semi-final", Final: "Final", Champion: "Champion",
};
const BRACKET_ROUNDS = [
  { name: "Round of 32", n: 16 },
  { name: "Round of 16", n: 8 },
  { name: "Quarter-finals", n: 4 },
  { name: "Semi-finals", n: 2 },
  { name: "Final", n: 1 },
];

function initials(name) {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join("");
}
function avatarColor(name) {
  let h = 0; for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360;
  return `linear-gradient(135deg, hsl(${h} 55% 55%), hsl(${(h + 38) % 360} 60% 48%))`;
}
function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function avatar(p) {
  const el = document.createElement("div");
  el.className = "avatar";
  if (p.photo) {
    const img = document.createElement("img");
    img.src = p.photo; img.alt = p.name; img.loading = "lazy";
    el.appendChild(img);
  } else {
    el.classList.add("flag");
    el.textContent = p.flag || "🏳️";
  }
  return el;
}

function statusBadge(p) {
  if (p.status === "eliminated") {
    const stage = p.eliminatedAt || STAGE_NAMES[p.stageReached] || "Out";
    return `<span class="badge out">Out · ${escapeHtml(stage)}</span>`;
  }
  if (p.stageReached === "Champion") return `<span class="badge alive">🏆 Champion</span>`;
  if (p.stageReached && p.stageReached !== "group") return `<span class="badge alive">✅ ${STAGE_NAMES[p.stageReached] || "Through"}</span>`;
  return `<span class="badge alive">✅ Alive</span>`;
}

function renderBoard(data) {
  const board = document.getElementById("board");
  board.innerHTML = "";
  data.standings.forEach((p, i) => {
    const li = document.createElement("li");
    li.className = "row" + (p.status === "eliminated" ? " out" : "") + (i === 0 && p.status !== "eliminated" ? " top1" : "");
    const rank = document.createElement("div");
    rank.className = "rank"; rank.textContent = p.rank ?? i + 1;
    const who = document.createElement("div");
    who.className = "who";
    who.innerHTML = `<div class="name">${escapeHtml(p.name)}</div>
      <div class="team">${p.flag || ""} ${escapeHtml(p.team)} <span class="grp-chip">Grp ${escapeHtml(p.group)}</span></div>`;
    const meta = document.createElement("div");
    meta.className = "meta";
    const formHtml = p.form && p.form !== "-" ? `<span class="${p.form}">${escapeHtml(p.statusLabel || p.form)}</span>` : escapeHtml(p.statusLabel || "");
    meta.innerHTML = `${statusBadge(p)}<div class="form">${formHtml}</div>`;
    li.append(rank, avatar(p), who, meta);
    board.appendChild(li);
  });
}

function renderGroups(data) {
  const wrap = document.getElementById("groups");
  wrap.innerHTML = "";
  const groups = {};
  data.standings.forEach((p) => { (groups[p.group] ||= []).push(p); });
  Object.keys(groups).sort().forEach((g) => {
    const card = document.createElement("div");
    card.className = "group-card";
    const rows = groups[g].sort((a, b) => (b.points - a.points) || (b.gd - a.gd))
      .map((p) => `<div class="g-row ${p.status === "eliminated" ? "out" : ""}">
        <span class="g-flag">${p.flag || ""}</span>
        <span class="g-name">${escapeHtml(p.team)} <span>· ${escapeHtml(p.name)}</span></span>
        <span class="g-pts">${p.played ? p.points + " pt" + (p.points === 1 ? "" : "s") : "—"}</span>
      </div>`).join("");
    card.innerHTML = `<h3>Group ${escapeHtml(g)}</h3>${rows}`;
    wrap.appendChild(card);
  });
}

function renderResults(data) {
  const ul = document.getElementById("results");
  const r = data.recentResults || [];
  ul.innerHTML = r.length ? r.map((x) => `<li>${escapeHtml(x)}</li>`).join("") : `<li>No matches recorded yet.</li>`;
}

// ---- Bracket ----
function slotHtml(slot) {
  if (!slot || (!slot.team && !slot.placeholder)) {
    return `<div class="slot tbd"><span class="s-flag">·</span><span class="s-team">TBD</span></div>`;
  }
  if (slot.placeholder) {
    return `<div class="slot tbd"><span class="s-flag">·</span><span class="s-team">${escapeHtml(slot.placeholder)}</span></div>`;
  }
  const cls = "slot" + (slot.win ? " win" : "") + (slot.lose ? " lose" : "");
  const person = slot.person ? `<span class="s-person">${escapeHtml(slot.person)}</span>` : "";
  return `<div class="${cls}"><span class="s-flag">${slot.flag || ""}</span><span class="s-team">${escapeHtml(slot.team)}</span>${person}</div>`;
}

function renderBracket(data) {
  const wrap = document.getElementById("bracket");
  const note = document.getElementById("bracketNote");
  const hasData = data.bracket && Array.isArray(data.bracket.rounds) && data.bracket.rounds.some((r) => r.matches?.some((m) => m.a?.team || m.b?.team));

  note.textContent = hasData
    ? "Win and you advance. Lose and you (and your team's owner) are out."
    : "🔒 Knockout bracket unlocks once the group stage finishes (late June). Top 2 of each group + 8 best 3rd-placed teams make the Round of 32.";

  // Use real data if present, else a TBD skeleton so the structure is visible now.
  const rounds = hasData
    ? data.bracket.rounds
    : BRACKET_ROUNDS.map((r) => ({ name: r.name, matches: Array.from({ length: r.n }, () => ({ a: null, b: null })) }));

  wrap.innerHTML = "";
  rounds.forEach((round, idx) => {
    const col = document.createElement("div");
    col.className = "round" + (idx === rounds.length - 1 ? " final-col" : "");
    const matches = (round.matches || []).map((m) => `<div class="match"><div class="match-card">${slotHtml(m.a)}${slotHtml(m.b)}</div></div>`).join("");
    col.innerHTML = `<div class="round-title">${escapeHtml(round.name)}</div><div class="matches">${matches}</div>`;
    // Champion card under the Final column.
    if (idx === rounds.length - 1 && data.champion) {
      col.innerHTML += `<div class="champ-card"><div class="c-label">🏆 Champion</div><div class="c-team">${data.champion.flag || ""} ${escapeHtml(data.champion.team)} · ${escapeHtml(data.champion.name)}</div></div>`;
    }
    wrap.appendChild(col);
  });
}

// ---- Live, finished & upcoming matches (strip + tap-to-open recap panel) ----
let MATCHES = null;            // last-loaded matches.json
let selectedMatch = null;      // id of the open recap, or null
let matchTouched = false;      // once the user taps, stop auto-opening the live game

function minKey(s) { const m = String(s || "").match(/(\d+)(?:'?\+(\d+))?/); return m ? (+m[1]) * 100 + (m[2] ? +m[2] : 0) : 0; }

function matchCard(m, kind) {
  const status =
    kind === "live" ? `<span class="mc-live">LIVE${m.minute ? " " + escapeHtml(m.minute) : ""}</span>`
    : kind === "recent" ? `<span class="mc-ft">FT</span>`
    : `<span class="mc-date">${escapeHtml(m.date || "")}</span>`;
  const center =
    kind === "upcoming" ? `<div class="mc-time">${escapeHtml(m.time || "vs")}</div>`
    : `<div class="mc-score">${m.a?.score ?? 0}<span>–</span>${m.b?.score ?? 0}</div>`;
  const tappable = kind !== "upcoming";
  const sel = selectedMatch === m.id ? " is-selected" : "";
  const hint = tappable ? `<div class="mc-more">${selectedMatch === m.id ? "Hide details ▴" : "Match details ▾"}</div>` : "";
  return `<div class="matchcard ${kind === "live" ? "is-live" : ""}${sel}" ${tappable ? `data-match="${escapeHtml(m.id)}"` : ""}>
    <div class="mc-top"><span class="mc-comp">${escapeHtml(m.competition || "")}</span>${status}</div>
    <div class="mc-body">
      <div class="mc-team"><span class="mc-flag">${m.a?.flag || ""}</span><span class="mc-name">${escapeHtml(m.a?.team || "TBD")}</span></div>
      ${center}
      <div class="mc-team mc-right"><span class="mc-name">${escapeHtml(m.b?.team || "TBD")}</span><span class="mc-flag">${m.b?.flag || ""}</span></div>
    </div>
    ${hint}
  </div>`;
}

function recapPanel(m) {
  const side = (s) => (s === "a" ? m.a : s === "b" ? m.b : null);
  const events = [
    ...(m.recap?.goals || []).map((g) => ({ ...g, t: "goal" })),
    ...(m.recap?.cards || []).map((c) => ({ ...c, t: "card" })),
  ].sort((x, y) => minKey(x.minute) - minKey(y.minute));

  const rows = events.map((e) => {
    const s = side(e.side);
    const who = s ? `<span class="r-side">${s.flag || ""} ${escapeHtml(s.owner || s.team)}</span>` : "";
    if (e.t === "goal") {
      const tag = (e.penalty ? ` <span class="r-tag">pen</span>` : "") + (e.own ? ` <span class="r-tag">OG</span>` : "");
      const assist = e.assist ? `<span class="r-assist">↳ ${escapeHtml(e.assist)}</span>` : "";
      return `<div class="r-row r-goal"><span class="r-min">${escapeHtml(e.minute || "")}</span><span class="r-ico">⚽</span>
        <span class="r-main"><b>${escapeHtml(e.scorer || "Goal")}</b>${tag} ${who}${assist}</span></div>`;
    }
    return `<div class="r-row"><span class="r-min">${escapeHtml(e.minute || "")}</span><span class="r-ico">${e.color === "red" ? "🟥" : "🟨"}</span>
      <span class="r-main">${escapeHtml(e.player || "Card")} ${who}</span></div>`;
  }).join("");

  const head = `${escapeHtml(m.competition || "")} · ${m.state === "in" ? `LIVE ${escapeHtml(m.minute || "")}` : "Full time"}`;
  const owners = `${escapeHtml(m.a?.owner || "—")} <span>vs</span> ${escapeHtml(m.b?.owner || "—")}`;
  const body = rows || `<div class="r-empty">${m.state === "in" ? "No goals or cards yet — game on. ⚽" : "Goalless, no cards. 😴"}</div>`;
  const impact = m.impact ? `<div class="md-impact">${escapeHtml(m.impact)}</div>` : "";

  return `<div class="md-head">${head}</div>
    <div class="md-score">
      <span class="md-team"><span class="md-flag">${m.a?.flag || ""}</span>${escapeHtml(m.a?.team || "")}</span>
      <span class="md-num">${m.a?.score ?? 0} – ${m.b?.score ?? 0}</span>
      <span class="md-team md-r">${escapeHtml(m.b?.team || "")}<span class="md-flag">${m.b?.flag || ""}</span></span>
    </div>
    <div class="md-owners">${owners}</div>
    <div class="md-timeline">${body}</div>
    ${impact}`;
}

function renderMatches(mdata) {
  MATCHES = mdata;
  const section = document.getElementById("matchesSection");
  const live = Array.isArray(mdata?.live) ? mdata.live : [];
  const recent = Array.isArray(mdata?.recent) ? mdata.recent : [];
  const upcoming = Array.isArray(mdata?.upcoming) ? mdata.upcoming : [];
  const all = [...live, ...recent, ...upcoming];
  if (!all.length) { section.hidden = true; return; }
  section.hidden = false;

  // Auto-open the live match the first time, until the user taps something.
  if (!matchTouched && live.length) selectedMatch = live[0].id;
  // Drop a stale selection (match no longer present).
  if (selectedMatch && !all.some((m) => m.id === selectedMatch)) selectedMatch = null;

  document.getElementById("matchstripTitle").textContent =
    live.length ? "🔴 Live & today's matches" : recent.length ? "Today's matches" : "Upcoming matches";
  document.getElementById("matchstrip").innerHTML =
    [...live.map((m) => matchCard(m, "live")), ...recent.map((m) => matchCard(m, "recent")), ...upcoming.map((m) => matchCard(m, "upcoming"))].join("");

  const panel = document.getElementById("matchDetail");
  const sel = all.find((m) => m.id === selectedMatch && m.state !== "pre");
  if (sel) { panel.hidden = false; panel.innerHTML = recapPanel(sel); }
  else { panel.hidden = true; panel.innerHTML = ""; }
}

// Tap a card to open/close its recap (event-delegated so it survives the 60s re-render).
document.addEventListener("click", (e) => {
  const card = e.target.closest("[data-match]");
  if (!card || !MATCHES) return;
  matchTouched = true;
  const id = card.getAttribute("data-match");
  selectedMatch = selectedMatch === id ? null : id;
  renderMatches(MATCHES);
});

function renderMeta(data) {
  document.getElementById("pills").innerHTML = `
    <div class="pill alive"><span class="num">${data.aliveCount ?? "—"}</span><span class="lbl">Alive</span></div>
    <div class="pill out"><span class="num">${data.eliminatedCount ?? 0}</span><span class="lbl">Eliminated</span></div>
    <div class="pill stage"><span class="num">${escapeHtml(data.stage || "—")}</span><span class="lbl">Now</span></div>`;
  const updated = data.updatedAt ? `Last updated ${data.updatedAt}` : "";
  document.getElementById("updated").textContent = updated;
  const banner = document.getElementById("championBanner");
  if (data.champion) {
    banner.hidden = false;
    banner.innerHTML = `🏆 Champions: ${data.champion.flag || ""} ${escapeHtml(data.champion.team)} — <b>${escapeHtml(data.champion.name)}</b> wins the pool!`;
  }
}

function setupTabs() {
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach((t) => t.classList.remove("is-active"));
      tab.classList.add("is-active");
      document.querySelectorAll(".view").forEach((v) => (v.hidden = true));
      document.getElementById("view-" + tab.dataset.view).hidden = false;
    });
  });
}

async function loadMatches() {
  // ESPN-sourced strip + recaps (refreshes every tick); falls back silently if not present yet.
  try {
    const res = await fetch("./data/matches.json?t=" + Date.now());
    if (res.ok) renderMatches(await res.json());
  } catch { /* matches.json not deployed yet — strip just stays hidden */ }
}

async function load() {
  try {
    const res = await fetch("./data/standings.json?t=" + Date.now());
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    renderMeta(data);
    renderBoard(data);
    renderBracket(data);
    renderGroups(data);
    renderResults(data);
  } catch (e) {
    document.getElementById("board").innerHTML =
      `<li class="row"><div class="who"><div class="name">Couldn't load standings</div><div class="team">${escapeHtml(e.message)}</div></div></li>`;
  } finally {
    document.getElementById("loading").classList.add("hide");
  }
  loadMatches();
}

setupTabs();
load();
// Keep an open tab fresh: re-fetch + re-render every 60s, and whenever the tab regains focus.
setInterval(load, 60000);
document.addEventListener("visibilitychange", () => { if (!document.hidden) load(); });
