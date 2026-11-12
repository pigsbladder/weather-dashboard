// ---------------------------------------------------------------------------
// GET /api/alerts?lat=&lon=
//
// Active National Weather Service alerts for the station:
//   - land alerts for the station's point (wind advisories, winter storms...)
//   - marine alerts for nearby water (gale, storm, small craft warnings).
//     Those are issued for marine zones, never for a point on land, so we find
//     the marine zones within MARINE_RADIUS_KM of the station once (zone
//     shapes are cached for 30 days) and ask for their alerts too.
//     Override with NWS_MARINE_ZONES="PKZ036,PKZ641" (adds Dixon Entrance) if you want specific ones.
//
// The feed can include cancelled or long-expired messages, so those are
// filtered out, and repeated updates of the same alert are merged.
// ---------------------------------------------------------------------------

import { cached, json } from './cache.js';

const NWS = 'https://api.weather.gov';
const UA = 'weather.basi.onl personal weather dashboard';
const MARINE_RADIUS_KM = 25; // the station's own waters (Clarence Strait for Ketchikan)
const HEADERS = { 'user-agent': UA, accept: 'application/geo+json' };
const SEVERITY = { Extreme: 0, Severe: 1, Moderate: 2, Minor: 3, Unknown: 4 };

async function getJSON(url) {
  const r = await fetch(url, { headers: HEADERS });
  if (!r.ok) throw new Error(`NWS ${r.status}`);
  return r.json();
}

export async function handleAlerts(request, env, ctx) {
  const q = new URL(request.url).searchParams;
  const lat = Number(q.get('lat')), lon = Number(q.get('lon'));
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return json({ error: 'Missing station location.' }, 'no-store', 400);
  const key = `${lat.toFixed(3)},${lon.toFixed(3)}`;

  try {
    // Which forecast office covers the station (cached a month)
    const office = await cached(request, `nws-office-${key}`, 30 * 86400, async () =>
      (await getJSON(`${NWS}/points/${key}`)).properties.gridId, ctx);

    // Nearby marine zones (cached a month)
    const marine = env.NWS_MARINE_ZONES
      ? env.NWS_MARINE_ZONES.split(',').map((z) => z.trim()).filter(Boolean)
      : await cached(request, `nws-marine-${MARINE_RADIUS_KM}-${key}`, 30 * 86400, () => nearbyMarineZones(lat, lon, office), ctx);

    const alerts = await cached(request, `nws-alerts-${key}`, 180, async () => {
      const lists = [getJSON(`${NWS}/alerts/active?point=${key}`)];
      if (marine.length) lists.push(getJSON(`${NWS}/alerts/active?zone=${marine.join(',')}`));
      const results = await Promise.all(lists);
      return clean(results.flatMap((r, i) => r.features.map((f) => ({ ...f.properties, marine: i === 1 }))));
    }, ctx);

    return json({ alerts, marineZones: marine }, 'private, max-age=120');
  } catch {
    return json({ error: 'Couldn’t load weather alerts from the National Weather Service.' }, 'no-store', 502);
  }
}

// Keep live alerts, merge updates, most severe first.
function clean(list) {
  const now = Date.now();
  const latest = new Map();
  for (const a of list) {
    const end = Date.parse(a.ends || a.expires);
    if (a.status !== 'Actual' || a.messageType === 'Cancel' || !(end > now)) continue;
    const k = `${a.event}|${a.areaDesc}`;
    const prev = latest.get(k);
    if (!prev || Date.parse(a.sent) > Date.parse(prev.sent)) latest.set(k, a);
  }
  return [...latest.values()]
    .map((a) => ({
      id: a.id,
      event: a.event,
      severity: a.severity,
      headline: a.headline,
      area: a.areaDesc,
      marine: a.marine,
      onset: a.onset || a.effective,
      ends: a.ends || a.expires,
      description: a.description,
      instruction: a.instruction,
    }))
    .sort((x, y) => (SEVERITY[x.severity] ?? 4) - (SEVERITY[y.severity] ?? 4) || Date.parse(x.onset) - Date.parse(y.onset));
}

// Marine zones run by the same office whose outline comes within the radius.
async function nearbyMarineZones(lat, lon, office) {
  const list = await getJSON(`${NWS}/zones?type=coastal&area=PK,PZ,AN,AM,GM,LS,LM,LH,LC,LE,LO,PH,PS`).catch(() => ({ features: [] }));
  const ours = list.features.map((f) => f.properties).filter((p) => (p.cwa || []).includes(office)).slice(0, 40);
  const near = [];
  for (const z of ours) {
    try {
      const shape = await getJSON(`${NWS}/zones/coastal/${z.id}`);
      if (shape.geometry && minDistanceKm(lat, lon, shape.geometry) <= MARINE_RADIUS_KM) near.push(z.id);
    } catch { /* skip zone */ }
  }
  return near;
}

// Smallest distance from the point to any vertex of the zone outline.
function minDistanceKm(lat, lon, geom) {
  const polys = geom.type === 'Polygon' ? [geom.coordinates] : geom.type === 'MultiPolygon' ? geom.coordinates : [];
  let best = Infinity;
  for (const poly of polys) for (const ring of poly) for (const [x, y] of ring) {
    const d = haversine(lat, lon, y, x);
    if (d < best) best = d;
  }
  return best;
}

function haversine(lat1, lon1, lat2, lon2) {
  const r = Math.PI / 180;
  const a = Math.sin(((lat2 - lat1) * r) / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(((lon2 - lon1) * r) / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(a));
}
