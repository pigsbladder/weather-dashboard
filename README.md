# weather-dashboard

A password-protected dashboard for an Ambient Weather WS-2902, hosted on Cloudflare Pages at **weather.basi.onl**.

- `public/`: the dashboard (plain HTML/CSS/JS, no build step)
- `functions/_middleware.js`: shared-password gate for every page and API call
- `functions/api/weather.js`: proxy to the Ambient Weather API (your keys never reach the browser) with edge caching
- `lib/mock.js`: made-up data for previewing without keys (`AW_MOCK=1`)

## 1. Get your Ambient Weather keys

On ambientweather.net, open **Account → API Keys**. Create an **API key** and an **Application key**.

## 2. Create the Pages project

Cloudflare dashboard → **Workers & Pages → Create → Pages → Connect to Git** → pick `weather-dashboard`.

| Setting | Value |
|---|---|
| Framework preset | None |
| Build command | *(leave empty)* |
| Build output directory | `public` |

Deploy. The first deploy will show "SITE_PASSWORD is not set". That's expected.

## 3. Add the secrets

Project → **Settings → Variables and Secrets** → add these as type **Secret** for Production:

| Name | Value |
|---|---|
| `SITE_PASSWORD` | The password you'll share |
| `AW_APP_KEY` | Ambient application key |
| `AW_API_KEY` | Ambient API key |
| `AW_MAC` *(optional)* | Station MAC, only if your account has more than one station |

Then **Deployments → ⋯ → Retry deployment** so the new values take effect.

> To share a preview before the keys are in, add `AW_MOCK` = `1` instead. Remove it when you go live.

## 4. Add the domain

Project → **Custom domains → Set up a custom domain** → `weather.basi.onl`. basi.onl is already on Cloudflare, so the DNS record is created for you.

## Changing the password

Update `SITE_PASSWORD` and redeploy. Everyone who signed in with the old one is signed out automatically.

## Local development

```bash
cp .dev.vars.example .dev.vars   # fill in, or set AW_MOCK=1
npx wrangler pages dev public
# → http://localhost:8788
```

## Notes

- Ambient allows 1 request/second per API key. Current conditions are cached for 60 s and history for 5 min, so traffic barely touches their API.
- Sessions last 30 days (`SESSION_DAYS` in `functions/_middleware.js`).
- History shows the last 24 h of 5-minute readings from Ambient's free tier.
