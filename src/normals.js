// ---------------------------------------------------------------------------
// GET /api/normals
//
// NOAA 1991–2020 daily climate normals for rain, used to judge whether a
// day / month is typical. Station: NORMALS_STATION env var, default
// USW00025325 (Ketchikan International Airport). These only change once a
// decade, so they're fetched once and cached for 180 days.
//
// Returns { station, name, days: { "11-17": { mtd, ytd, p25, p50, p75, ge } } }
//   mtd / ytd  normal rain so far this month / year, through that date (in)
//   p25..p75   percentiles of the amount on days that DO get rain (in)
//   ge         % of ALL days getting at least each amount in GE_AMOUNTS
// ---------------------------------------------------------------------------

import { cached, json } from './cache.js';

const NCEI = 'https://www.ncei.noaa.gov/access/services/data/v1';
export const GE_AMOUNTS = [0.01, 0.1, 0.25, 0.5, 1, 2, 4, 6];
const GE_KEYS = ['001', '010', '025', '050', '100', '200', '400', '600'];

export async function handleNormals(request, env, ctx) {
  const station = env.NORMALS_STATION || 'USW00025325';
  try {
    const data = await cached(request, `normals-${station}`, 180 * 86400, async () => {
      const url = `${NCEI}?dataset=normals-daily-1991-2020&stations=${station}&format=json` +
        '&startDate=0001-01-01&endDate=9996-12-31&includeStationName=true';
      const r = await fetch(url);
      if (!r.ok) throw new Error(`NCEI ${r.status}`);
      const rows = await r.json();
      if (!Array.isArray(rows) || !rows.length) throw new Error('No normals');
      const n = (v) => (v == null || v.trim() === '' ? null : Number(v));
      const days = {};
      for (const row of rows) {
        days[row.DATE] = {
          mtd: n(row['MTD-PRCP-NORMAL']),
          ytd: n(row['YTD-PRCP-NORMAL']),
          p25: n(row['DLY-PRCP-25PCTL']),
          p50: n(row['DLY-PRCP-50PCTL']),
          p75: n(row['DLY-PRCP-75PCTL']),
          ge: GE_KEYS.map((k) => n(row[`DLY-PRCP-PCTALL-GE${k}HI`])),
        };
      }
      return { station, name: rows[0].NAME, geAmounts: GE_AMOUNTS, days };
    }, ctx);
    return json(data, 'private, max-age=86400');
  } catch {
    return json({ error: 'Couldn’t load climate normals from NOAA.' }, 'no-store', 502);
  }
}
