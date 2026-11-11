// ---------------------------------------------------------------------------
// GET /api/weather
//
// Server-side proxy to the Ambient Weather REST API. The browser never sees
// your keys: they live in Cloudflare as secrets (AW_APP_KEY, AW_API_KEY).
//
// Returns:
//   { name, location, current: {...lastData}, history: [...24h of 5-min records], fetchedAt }
//
// Ambient allows 1 request/second per apiKey, so responses are cached at the
// edge: current conditions for 60s, the 24h history for 5 minutes. Most
// visits cost zero or one upstream call.
// ---------------------------------------------------------------------------

import { mockWeather } from './mock.js';

const AMBIENT = 'https://rt.ambientweather.net/v1';
const CURRENT_TTL = 60;   // seconds
const HISTORY_TTL = 300;  // seconds

// Only the fields the chart needs, to keep the payload small.
const HISTORY_FIELDS = ['dateutc', 'tempf', 'baromrelin', 'windspeedmph', 'windgustmph', 'winddir', 'hourlyrainin', 'dailyrainin', 'humidity', 'solarradiation', 'uv'];

export async function handleWeather(request, env, ctx) {
  const waitUntil = (p) => ctx.waitUntil(p);
  // Preview mode: set AW_MOCK=1 to see the dashboard with made-up data.
  if (env.AW_MOCK === '1') return json(mockWeather(), 'private, max-age=30');

  if (!env.AW_APP_KEY || !env.AW_API_KEY) {
    return json({ error: 'The station’s API keys aren’t set up yet. Add AW_APP_KEY and AW_API_KEY in Cloudflare.' }, 'no-store', 500);
  }

  const auth = `applicationKey=${encodeURIComponent(env.AW_APP_KEY)}&apiKey=${encodeURIComponent(env.AW_API_KEY)}`;
  const cache = caches.default;
  const origin = new URL(request.url).origin;

  try {
    // --- Current conditions (cached 60s) -----------------------------------
    const devices = await cachedFetch(cache, `${origin}/__cache/devices`, `${AMBIENT}/devices?${auth}`, CURRENT_TTL, waitUntil);
    if (!devices.ok) return upstreamError(devices.status);

    const list = devices.data;
    const station = env.AW_MAC ? list.find((d) => d.macAddress === env.AW_MAC) : list[0];
    if (!station) {
      return json({ error: 'No weather station was found on this Ambient Weather account.' }, 'no-store', 404);
    }

    // --- 24h history (cached 5 min) -----------------------------------------
    // If we just made a live call above, wait a beat so we don't trip the
    // 1 request/second limit.
    const histUrl = `${AMBIENT}/devices/${encodeURIComponent(station.macAddress)}?${auth}&limit=288`;
    const history = await cachedFetch(cache, `${origin}/__cache/history`, histUrl, HISTORY_TTL, waitUntil, devices.fresh ? 1100 : 0);

    const rows = history.ok && Array.isArray(history.data)
      ? history.data
          .map((r) => Object.fromEntries(HISTORY_FIELDS.map((k) => [k, r[k] ?? null])))
          .sort((a, b) => a.dateutc - b.dateutc) // oldest -> newest
      : [];

    const info = station.info ?? {};
    return json(
      {
        name: info.name ?? 'Weather station',
        location: info.coords?.location ?? info.location ?? null,
        // Used for the radar map, forecast and sun/moon times
        coords: info.coords?.coords
          ? { lat: info.coords.coords.lat, lon: info.coords.coords.lon }
          : env.LAT && env.LON ? { lat: Number(env.LAT), lon: Number(env.LON) } : null,
        current: station.lastData ?? {},
        history: rows,
        locked: Boolean(env.SITE_PASSWORD), // shows the Sign out link
        fetchedAt: Date.now(),
      },
      'private, max-age=30',
    );
  } catch (err) {
    return json({ error: 'Couldn’t reach Ambient Weather. Try again in a minute.' }, 'no-store', 502);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Two cache layers so we rarely touch Ambient:
//   1. memory   - per Worker instance; works on workers.dev too
//   2. caches.default - shared edge cache (custom domains only)
// Entries are kept for a day but count as "fresh" only for `ttl` seconds.
// If Ambient fails or rate-limits us, we serve the last good copy instead of
// an error. Concurrent requests share one in-flight upstream call.
const memo = new Map(); // key -> { ts, data }
const inflight = new Map(); // key -> Promise
const KEEP_STALE = 86400; // seconds

// Returns { ok, status, data, fresh } where fresh = true means we hit Ambient.
async function cachedFetch(cache, cacheKey, upstreamUrl, ttl, waitUntil, delayMs = 0) {
  const now = Date.now();
  const isFresh = (e) => e && now - e.ts < ttl * 1000;

  // 1. memory
  let entry = memo.get(cacheKey);
  if (isFresh(entry)) return { ok: true, status: 200, data: entry.data, fresh: false };

  // 2. edge cache
  if (!entry) {
    const hit = await cache.match(cacheKey).catch(() => null);
    if (hit) {
      entry = await hit.json();
      memo.set(cacheKey, entry);
      if (isFresh(entry)) return { ok: true, status: 200, data: entry.data, fresh: false };
    }
  }

  // 3. Ambient (deduplicated)
  if (!inflight.has(cacheKey)) {
    inflight.set(cacheKey, upstream(upstreamUrl, delayMs).finally(() => inflight.delete(cacheKey)));
  }
  const res = await inflight.get(cacheKey);

  if (res.ok) {
    const fresh = { ts: Date.now(), data: res.data };
    memo.set(cacheKey, fresh);
    waitUntil(
      cache
        .put(cacheKey, new Response(JSON.stringify(fresh), {
          headers: { 'content-type': 'application/json', 'cache-control': `max-age=${KEEP_STALE}` },
        }))
        .catch(() => {}),
    );
    return { ok: true, status: 200, data: res.data, fresh: true };
  }

  // Ambient failed: fall back to the last good copy if we have one.
  if (entry) return { ok: true, status: 200, data: entry.data, fresh: true, stale: true };
  return { ok: false, status: res.status, data: null, fresh: true };
}

// One call to Ambient, with a single retry if it rate-limits us.
async function upstream(url, delayMs) {
  for (let attempt = 0; attempt < 2; attempt++) {
    if (delayMs || attempt) await new Promise((r) => setTimeout(r, attempt ? 1500 : delayMs));
    try {
      const r = await fetch(url, { headers: { accept: 'application/json' } });
      if (r.ok) return { ok: true, status: 200, data: await r.json() };
      if (r.status !== 429) return { ok: false, status: r.status };
      if (attempt) return { ok: false, status: 429 };
    } catch {
      if (attempt) return { ok: false, status: 502 };
    }
  }
}

function upstreamError(status) {
  const message =
    status === 401 || status === 403
      ? 'Ambient Weather rejected the API keys. Check AW_APP_KEY and AW_API_KEY in Cloudflare.'
      : status === 429
        ? 'Ambient Weather is rate-limiting requests. Try again in a minute.'
        : `Ambient Weather returned an error (${status}). Try again in a minute.`;
  return json({ error: message }, 'no-store', 502);
}

function json(body, cacheControl, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': cacheControl },
  });
}
