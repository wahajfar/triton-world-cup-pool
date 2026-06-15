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

// ---- Live & upcoming matches (Google-style strip) ----
function matchCard(m, isLive) {
  const status = isLive
    ? `<span class="mc-live">LIVE${m.minute ? " " + escapeHtml(m.minute) : ""}</span>`
    : `<span class="mc-date">${escapeHtml(m.date || "")}</span>`;
  const center = isLive
    ? `<div class="mc-score">${m.a?.score ?? 0}<span>–</span>${m.b?.score ?? 0}</div>`
    : `<div class="mc-time">${escapeHtml(m.time || "vs")}</div>`;
  return `<div class="matchcard ${isLive ? "is-live" : ""}">
    <div class="mc-top"><span class="mc-comp">${escapeHtml(m.competition || "")}</span>${status}</div>
    <div class="mc-body">
      <div class="mc-team"><span class="mc-flag">${m.a?.flag || ""}</span><span class="mc-name">${escapeHtml(m.a?.team || "TBD")}</span></div>
      ${center}
      <div class="mc-team mc-right"><span class="mc-name">${escapeHtml(m.b?.team || "TBD")}</span><span class="mc-flag">${m.b?.flag || ""}</span></div>
    </div>
  </div>`;
}

function renderMatches(data) {
  const section = document.getElementById("matchesSection");
  const m = data.matches || {};
  const live = Array.isArray(m.live) ? m.live : [];
  const upcoming = Array.isArray(m.upcoming) ? m.upcoming : [];
  const cards = [...live.map((x) => matchCard(x, true)), ...upcoming.slice(0, 3).map((x) => matchCard(x, false))];
  if (!cards.length) { section.hidden = true; return; }
  section.hidden = false;
  document.getElementById("matchstripTitle").textContent = live.length ? "🔴 Live & upcoming" : "Upcoming matches";
  document.getElementById("matchstrip").innerHTML = cards.join("");
}

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

async function load() {
  try {
    const res = await fetch("./data/standings.json?t=" + Date.now());
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    renderMeta(data);
    renderMatches(data);
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
}

setupTabs();
load();
// Keep an open tab fresh: re-fetch + re-render every 60s, and whenever the tab regains focus.
setInterval(load, 60000);
document.addEventListener("visibilitychange", () => { if (!document.hidden) load(); });
