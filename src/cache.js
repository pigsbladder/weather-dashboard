// ---------------------------------------------------------------------------
// Shared two-layer cache for the extra data sources (tides, forecast, rain
// history). Same idea as src/weather.js:
//   1. memory (per Worker instance, works on workers.dev too)
//   2. caches.default (shared edge cache, custom domains only)
// Entries count as fresh for `ttl` seconds; if the upstream fails we return
// the last good copy instead of an error. Concurrent callers share one load.
// ---------------------------------------------------------------------------

const memo = new Map();
const inflight = new Map();
const KEEP = 40 * 86400; // keep stale copies for 40 days

export async function cached(request, key, ttl, loader, ctx) {
  const now = Date.now();
  const isFresh = (e) => e && now - e.ts < ttl * 1000;
  const cacheKey = `${new URL(request.url).origin}/__cache/${encodeURIComponent(key)}`;

  let entry = memo.get(key);
  if (isFresh(entry)) return entry.data;

  if (!entry) {
    const hit = await caches.default.match(cacheKey).catch(() => null);
    if (hit) {
      entry = await hit.json();
      memo.set(key, entry);
      if (isFresh(entry)) return entry.data;
    }
  }

  if (!inflight.has(key)) inflight.set(key, loader().finally(() => inflight.delete(key)));

  try {
    const data = await inflight.get(key);
    const fresh = { ts: Date.now(), data };
    memo.set(key, fresh);
    ctx.waitUntil(
      caches.default
        .put(cacheKey, new Response(JSON.stringify(fresh), {
          headers: { 'content-type': 'application/json', 'cache-control': `max-age=${KEEP}` },
        }))
        .catch(() => {}),
    );
    return data;
  } catch (err) {
    if (entry) return entry.data; // stale but better than nothing
    throw err;
  }
}

// Only read from cache (no loading). Used to skip days we already know.
export async function peek(request, key) {
  if (memo.has(key)) return memo.get(key).data;
  const cacheKey = `${new URL(request.url).origin}/__cache/${encodeURIComponent(key)}`;
  const hit = await caches.default.match(cacheKey).catch(() => null);
  if (!hit) return undefined;
  const entry = await hit.json();
  memo.set(key, entry);
  return entry.data;
}

export function json(body, cacheControl = 'no-store', status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': cacheControl },
  });
}
