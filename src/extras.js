// ---------------------------------------------------------------------------
// Extra data sources beyond the station itself:
//
//   GET /api/tides                 NOAA tide predictions (high/low) + latest
//                                  measured water level. Station: NOAA_STATION
//                                  env var, default 9450460 (Ketchikan,
//                                  Tongass Narrows).
//   GET /api/forecast?lat=&lon=    National Weather Service 7-day forecast,
//                                  combined into day/night highs and lows.
//   GET /api/rain-month            Daily rain totals for the current month,
//                                  from Ambient history (one call per day,
//                                  each day cached for good once it's over).
//
// All are free and keyless. Everything is cached (see src/cache.js).
// ---------------------------------------------------------------------------

import { cached, peek, json } from './cache.js';
import { mockTides, mockForecast, mockRainMonth } from './mock.js';

const NOAA = 'https://api.tidesandcurrents.noaa.gov/api/prod/datagetter';
const NWS = 'https://api.weather.gov';
const AMBIENT = 'https://rt.ambientweather.net/v1';
const UA = 'weather.basi.onl personal weather dashboard';

// ---------------------------------------------------------------------------
// Tides
// ---------------------------------------------------------------------------

export async function handleTides(request, env, ctx) {
  if (env.AW_MOCK === '1') return json(mockTides(), 'private, max-age=300');

  const station = env.NOAA_STATION || '9450460';
  // Start yesterday (UTC) so the curve has a low/high before "now".
  const start = new Date(Date.now() - 86400e3);
  const begin = `${start.getUTCFullYear()}${pad(start.getUTCMonth() + 1)}${pad(start.getUTCDate())}`;

  try {
    const events = await cached(request, `tides-${station}-${begin}`, 6 * 3600, async () => {
      const url = `${NOAA}?product=predictions&application=weather_basi_onl&begin_date=${begin}&range=96` +
        `&datum=MLLW&station=${station}&time_zone=gmt&units=english&interval=hilo&format=json`;
      const r = await fetch(url, { headers: { 'user-agent': UA } });
      if (!r.ok) throw new Error(`NOAA ${r.status}`);
      const body = await r.json();
      if (!body.predictions) throw new Error(body.error?.message || 'No predictions');
      return body.predictions.map((p) => ({
        t: Date.parse(p.t.replace(' ', 'T') + ':00Z'), // NOAA gives "YYYY-MM-DD HH:MM" in GMT
        ft: Number(p.v),
        type: p.type === 'H' ? 'High' : 'Low',
      }));
    }, ctx);

    // Latest measured water level is a nice-to-have; ignore failures.
    let observed = null;
    try {
      observed = await cached(request, `tides-obs-${station}`, 360, async () => {
        const url = `${NOAA}?product=water_level&application=weather_basi_onl&date=latest` +
          `&datum=MLLW&station=${station}&time_zone=gmt&units=english&format=json`;
        const r = await fetch(url, { headers: { 'user-agent': UA } });
        const body = await r.json();
        const d = body.data?.[0];
        return d ? { t: Date.parse(d.t.replace(' ', 'T') + ':00Z'), ft: Number(d.v) } : null;
      }, ctx);
    } catch { /* optional */ }

    return json({ station, events, observed }, 'private, max-age=300');
  } catch (err) {
    return json({ error: 'Couldn’t load tide predictions from NOAA right now.' }, 'no-store', 502);
  }
}

// ---------------------------------------------------------------------------
// Forecast (National Weather Service)
// ---------------------------------------------------------------------------

export async function handleForecast(request, env, ctx) {
  if (env.AW_MOCK === '1') return json(mockForecast(), 'private, max-age=600');

  const q = new URL(request.url).searchParams;
  const lat = Number(q.get('lat'));
  const lon = Number(q.get('lon'));
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    return json({ error: 'Missing station location.' }, 'no-store', 400);
  }
  const key = `${lat.toFixed(3)},${lon.toFixed(3)}`; // NWS wants ≤4 decimals

  try {
    // The grid point for a location never changes, so cache it for a week.
    const forecastUrl = await cached(request, `nws-point-${key}`, 7 * 86400, async () => {
      const r = await fetch(`${NWS}/points/${key}`, { headers: { 'user-agent': UA, accept: 'application/geo+json' } });
      if (!r.ok) throw new Error(`NWS points ${r.status}`);
      return (await r.json()).properties.forecast;
    }, ctx);

    const days = await cached(request, `nws-forecast-${key}`, 30 * 60, async () => {
      const r = await fetch(forecastUrl, { headers: { 'user-agent': UA, accept: 'application/geo+json' } });
      if (!r.ok) throw new Error(`NWS forecast ${r.status}`);
      return toDays((await r.json()).properties.periods);
    }, ctx);

    return json({ source: 'National Weather Service', days }, 'private, max-age=600');
  } catch {
    return json({ error: 'Couldn’t load the forecast from the National Weather Service.' }, 'no-store', 502);
  }
}

// NWS returns alternating day/night periods. Fold them into one entry per day.
function toDays(periods) {
  const days = [];
  for (let i = 0; i < periods.length; i++) {
    const p = periods[i];
    const pop = p.probabilityOfPrecipitation?.value ?? null;
    if (p.isDaytime) {
      const night = periods[i + 1] && !periods[i + 1].isDaytime ? periods[i + 1] : null;
      days.push({
        name: i === 0 ? 'Today' : p.name.slice(0, 3),
        hi: p.temperature,
        lo: night ? night.temperature : null,
        sky: p.shortForecast,
        pop: Math.max(pop ?? 0, night?.probabilityOfPrecipitation?.value ?? 0) || null,
        start: p.startTime,
      });
      if (night) i++;
    } else if (i === 0) {
      // Forecast fetched in the evening starts with "Tonight"
      days.push({ name: 'Tonight', hi: null, lo: p.temperature, sky: p.shortForecast, pop, start: p.startTime });
    }
  }
  return days.slice(0, 7);
}

// ---------------------------------------------------------------------------
// Rain per day, this month (for the calendar)
// ---------------------------------------------------------------------------

const DAYS_PER_CALL = 6; // stay well inside Ambient's 1 request/second limit

export async function handleRainMonth(request, env, ctx) {
  if (env.AW_MOCK === '1') return json(mockRainMonth(), 'private, max-age=300');
  if (!env.AW_APP_KEY || !env.AW_API_KEY) return json({ error: 'API keys missing.' }, 'no-store', 500);

  const auth = `applicationKey=${encodeURIComponent(env.AW_APP_KEY)}&apiKey=${encodeURIComponent(env.AW_API_KEY)}`;

  try {
    // Station MAC + time zone (cached a day; cheap).
    const station = await cached(request, 'rain-station', 86400, async () => {
      const r = await fetch(`${AMBIENT}/devices?${auth}`);
      if (!r.ok) throw new Error(`Ambient ${r.status}`);
      const list = await r.json();
      const s = env.AW_MAC ? list.find((d) => d.macAddress === env.AW_MAC) : list[0];
      return { mac: s.macAddress, tz: s.lastData?.tz || 'UTC' };
    }, ctx);

    const tz = station.tz;
    const today = localDate(Date.now(), tz); // {y, m, d}
    const out = {};
    let fetched = 0;
    let pending = false;

    for (let d = 1; d < today.d; d++) {
      const key = `rain-${station.mac}-${today.y}-${pad(today.m)}-${pad(d)}`;
      const known = await peek(request, key);
      if (known !== undefined) { out[d] = known; continue; }
      if (fetched >= DAYS_PER_CALL) { pending = true; continue; }

      // Last record of that day = the day's total (dailyrainin resets at midnight).
      const endOfDay = zonedEpoch(today.y, today.m, d, 23, 59, tz);
      if (fetched > 0) await sleep(1100);
      fetched++;
      try {
        out[d] = await cached(request, key, 40 * 86400, async () => {
          const r = await fetch(`${AMBIENT}/devices/${encodeURIComponent(station.mac)}?${auth}&endDate=${endOfDay}&limit=1`);
          if (!r.ok) throw new Error(`Ambient ${r.status}`);
          const rows = await r.json();
          const row = rows[0];
          // Ignore a record from an earlier day (station was offline that day).
          if (!row || localDate(row.dateutc, tz).d !== d) return null;
          return row.dailyrainin ?? null;
        }, ctx);
      } catch {
        pending = true; // rate-limited or failed; try again next call
      }
    }

    return json({ year: today.y, month: today.m, today: today.d, tz, days: out, pending }, 'private, max-age=60');
  } catch {
    return json({ error: 'Couldn’t load this month’s rain history.' }, 'no-store', 502);
  }
}

// ---------------------------------------------------------------------------
// Rain this year (fallback when the station doesn't report yearlyrainin)
//
//   GET /api/rain-year   → { year, months: {1: 9.8, ...}, missing: [..], pending }
//
// For each finished month, the last record of that month carries the month's
// total (monthlyrainin). One Ambient call per month, cached for good. The
// current month comes from the live reading in the browser.
// ---------------------------------------------------------------------------

export async function handleRainYear(request, env, ctx) {
  if (env.AW_MOCK === '1') {
    const m = new Date().getMonth() + 1, months = {};
    for (let i = 1; i < m; i++) months[i] = [12.1, 9.4, 11.8, 8.2, 6.5, 5.9, 7.1, 9.8, 14.2, 21.4, 18.7][i - 1];
    return json({ year: new Date().getFullYear(), months, missing: [], pending: false }, 'private, max-age=300');
  }
  if (!env.AW_APP_KEY || !env.AW_API_KEY) return json({ error: 'API keys missing.' }, 'no-store', 500);
  const auth = `applicationKey=${encodeURIComponent(env.AW_APP_KEY)}&apiKey=${encodeURIComponent(env.AW_API_KEY)}`;

  try {
    const station = await cached(request, 'rain-station', 86400, async () => {
      const r = await fetch(`${AMBIENT}/devices?${auth}`);
      if (!r.ok) throw new Error(`Ambient ${r.status}`);
      const list = await r.json();
      const s = env.AW_MAC ? list.find((d) => d.macAddress === env.AW_MAC) : list[0];
      return { mac: s.macAddress, tz: s.lastData?.tz || 'UTC' };
    }, ctx);

    const tz = station.tz;
    const today = localDate(Date.now(), tz);
    const months = {};
    const missing = [];
    let fetched = 0, pending = false;

    for (let m = 1; m < today.m; m++) {
      const key = `rainmonth-${station.mac}-${today.y}-${pad(m)}`;
      let v = await peek(request, key);
      if (v === undefined) {
        if (fetched >= DAYS_PER_CALL) { pending = true; continue; }
        const lastDay = new Date(Date.UTC(today.y, m, 0)).getUTCDate();
        const end = zonedEpoch(today.y, m, lastDay, 23, 59, tz);
        if (fetched > 0) await sleep(1100);
        fetched++;
        try {
          v = await cached(request, key, 40 * 86400, async () => {
            const r = await fetch(`${AMBIENT}/devices/${encodeURIComponent(station.mac)}?${auth}&endDate=${end}&limit=1`);
            if (!r.ok) throw new Error(`Ambient ${r.status}`);
            const row = (await r.json())[0];
            // No record in that month = station wasn't reporting yet
            if (!row || localDate(row.dateutc, tz).m !== m) return null;
            return row.monthlyrainin ?? null;
          }, ctx);
        } catch { pending = true; continue; }
      }
      if (v == null) missing.push(m); else months[m] = v;
    }
    return json({ year: today.y, months, missing, pending }, 'private, max-age=300');
  } catch {
    return json({ error: 'Couldn’t load this year’s rain history.' }, 'no-store', 502);
  }
}

// ---------------------------------------------------------------------------
// Time zone helpers (no libraries in Workers, so use Intl)
// ---------------------------------------------------------------------------

function localDate(ms, tz) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: 'numeric', day: 'numeric' })
      .formatToParts(new Date(ms)).map((p) => [p.type, p.value]),
  );
  return { y: Number(parts.year), m: Number(parts.month), d: Number(parts.day) };
}

// Epoch ms for a wall-clock time in a given zone.
function zonedEpoch(y, m, d, hh, mm, tz) {
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric',
    }).formatToParts(new Date(guess)).map((p) => [p.type, p.value]),
  );
  const asLocal = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
  return guess - (asLocal - guess);
}

const pad = (n) => String(n).padStart(2, '0');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
