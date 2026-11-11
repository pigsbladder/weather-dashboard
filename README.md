# weather-dashboard

A dashboard for an Ambient Weather WS-2902, running as a Cloudflare Worker at **weather.basi.onl**.

- `public/`: the dashboard (plain HTML/CSS/JS, no build step)
- `src/worker.js`: entry point. Every request goes through the gate, then the API, then static files.
- `src/auth.js`: optional shared-password gate (off unless `SITE_PASSWORD` is set)
- `src/weather.js`: proxy to the Ambient Weather API (your keys never reach the browser) with edge caching
- `src/mock.js`: made-up data for previewing without keys (`AW_MOCK=1`)
- `wrangler.jsonc`: Worker config

Pushing to `main` deploys automatically (Workers Builds).

## Secrets

Worker → **Settings → Variables and Secrets → + Add**. Use type **Secret** so deploys don't wipe them.

| Name | Value |
|---|---|
| `AW_API_KEY` | Ambient API key (ambientweather.net → Account → API Keys) |
| `AW_APP_KEY` | Ambient Application key (same page) |
| `SITE_PASSWORD` *(optional)* | Shared password. Leave it out and the site is public. |
| `AW_MAC` *(optional)* | Station MAC, only if the account has more than one station |
| `AW_MOCK` *(optional)* | `1` = show preview data instead of calling Ambient |

Secrets apply from the next deployment: **Deployments → latest → ⋯ → Retry**, or just push.

## Domain

Worker → **Domains → Add Domain** → `weather.basi.onl`.

## Changing the password

Update `SITE_PASSWORD` and redeploy. Everyone signed in with the old one is signed out automatically.

## Local development

```bash
cp .dev.vars.example .dev.vars   # fill in, or set AW_MOCK=1
npx wrangler dev
# → http://localhost:8787
```

## Notes

- Ambient allows 1 request/second per API key. Current conditions are cached for 60 s and history for 5 min.
- Sessions last 30 days (`SESSION_DAYS` in `src/auth.js`).
- History shows the last 24 h of 5-minute readings from Ambient's free tier.
