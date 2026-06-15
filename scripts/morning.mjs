// Morning fixtures post — every morning, drops the day's World Cup matchups into Slack,
// tagging the pool members whose teams are playing. Uses ESPN's free feed + the Slack webhook.

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA = join(__dirname, "..", "data");
const ESPN = "https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard";
const TZ = "America/Los_Angeles";

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
const ref = (o) => (o ? (o.slackId ? `<@${o.slackId}>` : `*${o.name}*`) : "TBD");

async function postSlack(text) {
  const url = process.env.SLACK_WEBHOOK_URL;
  if (!url) { console.log("[morning] no webhook — would post:\n" + text); return; }
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }) });
  console.log(r.ok ? "[morning] posted" : `[morning] slack failed ${r.status} ${await r.text()}`);
}

const ymdPT = (d) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(d).replace(/-/g, "");
const timePT = (iso) => new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "numeric", minute: "2-digit", hour12: true }).format(new Date(iso)) + " PT";

async function main() {
  const roster = JSON.parse(await readFile(join(DATA, "roster.json"), "utf8"));
  const teams = roster.people.map((p) => p.team);
  const owner = new Map(roster.people.map((p) => [canonical(p.team, teams), p]));

  const today = ymdPT(new Date());
  const res = await fetch(`${ESPN}?dates=${today}`, { headers: { "User-Agent": "triton-wc/1.0" } });
  if (!res.ok) { console.error("[morning] ESPN fetch failed", res.status); process.exit(0); }
  const data = await res.json();
  const dateLabel = new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "long", month: "short", day: "numeric" }).format(new Date());

  // Only matches that haven't finished yet (state pre/in).
  const events = (data.events || [])
    .filter((e) => (e.status?.type?.state || "pre") !== "post")
    .sort((a, b) => new Date(a.date) - new Date(b.date));

  if (!events.length) {
    await postSlack(`☀️ *Good morning!* No World Cup games today — enjoy the rest day. 😴⚽`);
    return;
  }

  const lines = [`☀️ *Today's World Cup matches* — ${dateLabel}`, ""];
  for (const ev of events) {
    const cs = ev.competitions?.[0]?.competitors || [];
    const home = cs.find((c) => c.homeAway === "home") || cs[0];
    const away = cs.find((c) => c.homeAway === "away") || cs[1];
    if (!home || !away) continue;
    const hName = home.team?.displayName || home.team?.name || "";
    const aName = away.team?.displayName || away.team?.name || "";
    const hP = owner.get(canonical(hName, teams)), aP = owner.get(canonical(aName, teams));
    const grp = hP?.group || aP?.group || "";
    lines.push(`🕒 *${timePT(ev.date)}*${grp ? ` · Group ${grp}` : ""}`);
    lines.push(`${hP?.flag || ""} ${hName} vs ${aName} ${aP?.flag || ""}  —  ${ref(hP)} vs ${ref(aP)}`);
    lines.push("");
  }
  lines.push("Good luck out there! Standings → https://triton-world-cup.vercel.app");
  await postSlack(lines.join("\n"));
}

main().catch((e) => { console.error("[morning] FAILED:", e); process.exit(1); });
