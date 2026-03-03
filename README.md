# Web Job Notifier (Non-LinkedIn)

This bot tracks remote jobs from non-LinkedIn sources and sends Telegram alerts.

Sources:
- Remotive API
- RemoteOK API
- WeWorkRemotely RSS
- Jobspresso RSS
- Google Jobs-style aggregator coverage (Jooble, Adzuna, Talent, Indeed, BeBee, Jobvite, Cutshort, Uplers, Recruiterflow, and similar)

## Setup

```bash
npm install
```

Copy `.env.example` to `.env` and fill:

- `BOT_TOKEN`
- `GROUP_ID`
- `POLL_SECONDS=60`
- `MAX_ALERTS_PER_CYCLE=5`
- `MAX_POST_AGE_HOURS=24`
- `REQUIRE_REMOTE=1`

## Run

```bash
npm start
```

Test one cycle only:

```bash
npm test
```

## Free 24/7

Workflow file:
- `.github/workflows/web-jobs-notifier.yml`

Add GitHub Actions repo secrets:
- `BOT_TOKEN`
- `GROUP_ID`

Then run workflow once manually from Actions tab. It auto-runs every 5 minutes.
