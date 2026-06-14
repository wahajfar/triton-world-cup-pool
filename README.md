# 🏆 Triton World Cup 2026 — Survival Pool

A live web scoreboard for the company World Cup pool, plus an autonomous updater that
posts to Slack. Everyone's assigned one national team; you stay alive as long as your
team is alive in the tournament. **Last person standing wins.**

- **Live site** — a static page (`index.html`) that reads `data/standings.json`. Hosts free on Vercel, always on.
- **Updater** — `scripts/update.mjs` uses the **Claude API + web search** to pull current results, computes the survival standings, posts Slack alerts, and rewrites `data/standings.json`.
- **Scheduler** — a **GitHub Action** runs the updater a few times a day, commits the new data, and the commit auto-redeploys Vercel.

Nothing needs to stay running on your laptop. The page is always live; the data refreshes in the cloud.

```
GitHub Action (cron)  ──>  node scripts/update.mjs  ──>  Claude API (web search)
        │                          │
        │                          ├─> Slack Incoming Webhook  (elimination / advancement / digest)
        │                          └─> writes data/standings.json
        └─> commits data/standings.json  ──>  Vercel redeploys  ──>  live site updates
```

---

## One-time setup

You need three things: a **GitHub repo**, an **Anthropic API key**, and a **Slack Incoming Webhook**.

### 1. Push this folder to a new GitHub repo

```bash
cd world-cup-pool
git init && git add . && git commit -m "Initial commit: World Cup pool"
gh repo create triton-world-cup-pool --private --source=. --push
# (or create the repo on github.com and `git remote add origin ... && git push -u origin main`)
```

### 2. Get an Anthropic API key

Go to <https://console.anthropic.com> → **API Keys** → create one. Costs a few cents per run
(web search + a single model call). This is separate from any Claude.ai / Claude Code subscription.

### 3. Create a Slack Incoming Webhook

This is the webhook the site uses to post to Slack on its own (the Claude desktop app's Slack
connection can't be reused by an external server).

1. <https://api.slack.com/apps> → **Create New App** → **From scratch** → name it "World Cup Pool", pick your workspace.
2. **Incoming Webhooks** → toggle **On** → **Add New Webhook to Workspace** → choose **#world-cup**.
3. Copy the webhook URL (looks like `https://hooks.slack.com/services/T000/B000/xxxx`).

### 4. Add the secrets to GitHub

Repo → **Settings → Secrets and variables → Actions → New repository secret**:

| Secret name         | Value                          |
| ------------------- | ------------------------------ |
| `ANTHROPIC_API_KEY` | your Anthropic API key         |
| `SLACK_WEBHOOK_URL` | the Slack webhook URL          |

### 5. Deploy to Vercel

1. <https://vercel.com/new> → import the GitHub repo.
2. Framework preset: **Other** (it's a static site — no build step). Click **Deploy**.
3. You get a URL like `https://triton-world-cup-pool.vercel.app`. Share it with the team.

### 6. Turn on the updates

- Repo → **Actions** tab → enable workflows if prompted.
- Run it once now: **Actions → "Update World Cup standings" → Run workflow**. This does the first
  live refresh and confirms the API key + Slack webhook work.
- After that it runs automatically at **1pm / 6pm / 10pm Pacific** (the 10pm run also posts the daily digest).

---

## Editing the pool

- **Roster** — edit `data/roster.json` (name, team, group, flag emoji, optional `photo` URL). Keep the team names matching the official 2026 field.
- **Photos** — set `"photo"` to an image URL for anyone; otherwise the site shows a coloured initials avatar.
- **Schedule** — edit the `cron` lines in `.github/workflows/update.yml` (times are UTC; Pacific in June is UTC-7).

## Run it locally

```bash
npm install
ANTHROPIC_API_KEY=sk-ant-... SLACK_WEBHOOK_URL=https://hooks.slack.com/... npm run update
# preview the site:
npx serve .    # then open the printed URL
```

Tip: add `DIGEST=true` to force the daily-digest Slack post on a manual run.

## How "survival" is scored

Rank = how far your team gets. Group exit → out. Otherwise you advance R32 → R16 → QF → SF → Final → Champion.
The updater marks a person eliminated only when their team is mathematically out, and it only
posts an alert for a change since the previous run (so it never double-pings).
