// ===========================================================================
// Weather dashboard — front end
//
// Data (all via this site's own Worker, so no keys reach the browser):
//   /api/weather     station readings + 24h history      every 60 s
//   /api/tides       NOAA high/low predictions            every 30 min
//   /api/forecast    National Weather Service             every 30 min
//   /api/rain-month  daily rain totals for the calendar   on load
// Radar comes straight from RainViewer (public, keyless) into Leaflet.
// Sun and moon times are calculated locally with SunCalc.
// ===========================================================================

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const state = {
  data: null,      // /api/weather
  tides: null,     // /api/tides
  forecast: null,  // /api/forecast
  rain: null,      // /api/rain-month
  metric: readPref(),
};

// ---------------------------------------------------------------------------
// Units
// ---------------------------------------------------------------------------

function readPref() { try { return localStorage.getItem('wx-units') === 'metric'; } catch { return false; } }
function savePref() { try { localStorage.setItem('wx-units', state.metric ? 'metric' : 'us'); } catch { /* ignore */ } }

const C = {
  temp: (f) => (f == null ? null : state.metric ? ((f - 32) * 5) / 9 : f),
  delta: (f) => (f == null ? null : state.metric ? (f * 5) / 9 : f), // temperature differences
  speed: (v) => (v == null ? null : state.metric ? v * 1.609344 : v),
  rain: (v) => (v == null ? null : state.metric ? v * 25.4 : v),
  press: (v) => (v == null ? null : state.metric ? v * 33.8639 : v),
  height: (v) => (v == null ? null : state.metric ? v * 0.3048 : v),
};
const U = () => state.metric
  ? { temp: '°C', speed: 'km/h', rain: 'mm', rate: 'mm/hr', press: 'hPa', height: 'm', rainDp: 1, pressDp: 0, heightDp: 2 }
  : { temp: '°F', speed: 'mph', rain: 'in', rate: 'in/hr', press: 'inHg', height: 'ft', rainDp: 2, pressDp: 2, heightDp: 1 };

function fmt(v, dp = 0) {
  if (v == null || Number.isNaN(v)) return '—';
  return Number(v).toLocaleString(undefined, { minimumFractionDigits: dp, maximumFractionDigits: dp });
}
const signed = (v, dp = 1) => (v == null ? '—' : (v > 0 ? '+' : v < 0 ? '−' : '') + fmt(Math.abs(v), dp));

// ---------------------------------------------------------------------------
// Time (always shown in the station's time zone)
// ---------------------------------------------------------------------------

const tz = () => state.data?.current?.tz || undefined;
const fmtTime = (t, opts) => new Intl.DateTimeFormat(undefined, { timeZone: tz(), ...opts }).format(t);
const clock = (t) => fmtTime(t, { hour: 'numeric', minute: '2-digit' });
const hourLabel = (t) => fmtTime(t, { hour: 'numeric' });

const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
function ago(t) {
  const s = Math.round((t - Date.now()) / 1000), a = Math.abs(s);
  if (a < 60) return 'just now';
  if (a < 3600) return rtf.format(Math.round(s / 60), 'minute');
  if (a < 86400) return rtf.format(Math.round(s / 3600), 'hour');
  return rtf.format(Math.round(s / 86400), 'day');
}

// Wall-clock parts / epoch in the station zone
function zoned(t) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: tz(), hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', weekday: 'short',
  }).formatToParts(t).map((x) => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour, min: +p.minute, wd: p.weekday };
}
function zonedEpoch(y, m, d, hh = 0, mm = 0) {
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  const z = zoned(guess);
  return guess - (Date.UTC(z.y, z.m - 1, z.d, z.h, z.min) - guess);
}
const startOfLocalDay = (t) => { const z = zoned(t); return zonedEpoch(z.y, z.m, z.d); };

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const DIRS16 = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
const DIRS8 = ['north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest'];
const dir16 = (deg) => DIRS16[Math.round(deg / 22.5) % 16];
const dir8 = (deg) => DIRS8[Math.round(deg / 45) % 8];

const kv = (rows, cls = 'kv') => `<dl class="${cls}">${rows.map(([k, v, extra = '']) =>
  `<div><dt>${k}</dt><dd${extra ? ` class="${extra}"` : ''}>${v}</dd></div>`).join('')}</dl>`;
const withUnit = (v, unit) => `${v}<small> ${unit}</small>`;

function rainWord(rate) {
  if (!rate) return null;
  return rate >= 0.3 ? 'heavy' : rate >= 0.1 ? 'moderate' : 'light';
}
function uvWord(uv) {
  return uv >= 11 ? 'extreme' : uv >= 8 ? 'very high' : uv >= 6 ? 'high' : uv >= 3 ? 'moderate' : 'low';
}

// Value from history about `hoursAgo` back (closest record at or after that time)
function valueAgo(hist, key, hoursAgo) {
  const target = Date.now() - hoursAgo * 3600e3;
  const r = hist.find((x) => x.dateutc >= target && x[key] != null);
  return r ? r[key] : null;
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

async function getJSON(url) {
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (res.status === 401) { location.reload(); throw new Error('Signed out'); }
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
  return body;
}

async function loadWeather() {
  try {
    state.data = await getJSON('/api/weather');
    setNotice('');
    renderAll();
    initMap();
    if (!state.forecast) loadForecast();
  } catch (err) {
    setNotice(state.data ? `${err.message} Showing the last reading received.` : err.message);
  }
}

async function loadTides() {
  try { state.tides = await getJSON('/api/tides'); renderTides(); }
  catch (err) { $('tideState').textContent = err.message; }
}

async function loadForecast() {
  const c = state.data?.coords;
  if (!c) { $('forecastNote').textContent = 'Station location unknown, so no forecast.'; return; }
  try { state.forecast = await getJSON(`/api/forecast?lat=${c.lat}&lon=${c.lon}`); renderForecast(); }
  catch (err) { $('forecastNote').textContent = err.message; }
}

let rainPolls = 0;
async function loadRainMonth() {
  try {
    state.rain = await getJSON('/api/rain-month');
    renderCalendar();
    // The server fills in a few past days per request; keep asking until done.
    if (state.rain.pending && rainPolls++ < 10) setTimeout(loadRainMonth, 10_000);
  } catch { /* calendar shows today only */ }
}

function setNotice(msg) { $('notice').textContent = msg; $('notice').hidden = !msg; }

// ---------------------------------------------------------------------------
// Render: everything that depends on station data
// ---------------------------------------------------------------------------

function renderAll() {
  if (!state.data) return;
  renderHeader();
  renderHero();
  renderIndoor();
  renderSunMoon();
  renderUV();
  renderRain();
  renderWind();
  renderPressure();
  renderHumidity();
  renderCalendar();
  renderRose();
  renderDegree();
  renderMultiples();
  renderTides();
  renderForecast();
}

function renderHeader() {
  const d = state.data;
  $('station').textContent = d.name;
  $('place').textContent = d.location ?? '';
  $('signout').hidden = !d.locked;
  document.querySelectorAll('[data-units]').forEach((b) => b.setAttribute('aria-pressed', String((b.dataset.units === 'metric') === state.metric)));
  renderUpdated();
}

function renderUpdated() {
  const t = state.data?.current?.dateutc;
  if (!t) return;
  const stale = Date.now() - t > 15 * 60e3;
  $('updated').textContent = stale ? `No report since ${clock(t)}` : `Updated ${ago(t)}`;
  $('updated').style.color = stale ? '#FFB4A0' : '';
}

// --- Hero -------------------------------------------------------------------

function renderHero() {
  const { current: c, history: h } = state.data;
  const u = U();
  const temps = h.map((r) => r.tempf).filter((v) => v != null);
  const yest = valueAgo(h, 'tempf', 24);

  $('temp').textContent = fmt(C.temp(c.tempf), 1);
  $('tempUnit').textContent = u.temp;

  const word = rainWord(c.hourlyrainin);
  $('rainLabel').textContent = word ? `Rain, ${word}` : 'Not raining';
  $('rainRate').textContent = fmt(C.rain(c.hourlyrainin ?? 0), u.rainDp);
  $('rainRateUnit').textContent = u.rate;

  $('summary').textContent = summary(c, h);

  $('heroStats').innerHTML = [
    ['Feels like', `${fmt(C.temp(c.feelsLike), 1)}°`],
    ['Dew point', `${fmt(C.temp(c.dewPoint), 1)}°`],
    ['vs. yesterday', yest == null ? '—' : `${signed(C.delta(c.tempf - yest))}°`, 'amber'],
    ['Rain today', withUnit(fmt(C.rain(c.dailyrainin), u.rainDp), u.rain)],
    ['This storm', withUnit(fmt(C.rain(c.eventrainin), u.rainDp), u.rain)],
    ['24-hr range', temps.length ? `${fmt(C.temp(Math.min(...temps)))}–${fmt(C.temp(Math.max(...temps)))}°` : '—'],
  ].map(([k, v, cls]) => `<div><dt>${k}</dt><dd${cls ? ` class="${cls}"` : ''}>${v}</dd></div>`).join('');
}

// A couple of plain sentences describing what it's like out there.
function summary(c, h) {
  const parts = [];
  const word = rainWord(c.hourlyrainin);
  const speed = c.windspeedmph ?? 0;
  const windTxt = speed < 1 ? 'no wind' : speed < 8 ? 'a light breeze' : speed < 20 ? 'a steady wind' : 'strong wind';
  if (word) parts.push(`${word === 'heavy' ? 'Raining hard' : word === 'moderate' ? 'Raining steadily' : 'Light rain'} with ${windTxt}.`);
  else parts.push(`Dry right now with ${windTxt}.`);

  const spread = c.tempf != null && c.dewPoint != null ? c.tempf - c.dewPoint : null;
  if (spread != null && spread <= 2 && (c.humidity ?? 0) >= 95) {
    parts.push(`The dew point is ${fmt(C.delta(spread), 1)}° below the air temperature, so expect fog.`);
  }

  const p3 = valueAgo(h, 'baromrelin', 3);
  if (c.baromrelin != null && p3 != null) {
    const d = c.baromrelin - p3;
    const level = c.baromrelin < 29.5 ? 'low' : c.baromrelin > 30.2 ? 'high' : 'near normal';
    const trend = d > 0.06 ? 'rising' : d < -0.06 ? 'falling' : 'steady';
    parts.push(`Pressure is ${level} and ${trend}.`);
  }
  return parts.join(' ');
}

// --- Indoors / sun & moon / UV ---------------------------------------------

function renderIndoor() {
  const c = state.data.current, u = U();
  if (c.tempinf == null) { $('tileIndoor').innerHTML = '<h2>Indoors</h2><p class="muted">No indoor sensor reporting.</p>'; return; }
  $('tileIndoor').innerHTML = `
    <h2>Indoors</h2>
    <div class="lead">
      <span class="big num amber">${fmt(C.temp(c.tempinf), 1)}<span class="big-unit">${u.temp}</span></span>
      <span class="big num" style="font-size:36px">${fmt(c.humidityin)}<span class="big-unit">%</span></span>
    </div>
    ${kv([
      ['Dew point', `${fmt(C.temp(c.dewPointin), 1)}°`],
      ['Feels like', `${fmt(C.temp(c.feelsLikein ?? c.tempinf), 1)}°`],
      ['vs. outside', `${signed(C.delta(c.tempinf - c.tempf))}°`],
    ])}`;
}

function renderSunMoon() {
  const el = $('tileSunMoon');
  const co = state.data.coords;
  if (!window.SunCalc || !co) { el.innerHTML = '<h2>Sun and moon</h2><p class="muted">Needs the station’s location.</p>'; return; }
  const now = new Date();
  const s = SunCalc.getTimes(now, co.lat, co.lon);
  const ill = SunCalc.getMoonIllumination(now);
  const mt = SunCalc.getMoonTimes(now, co.lat, co.lon);
  const daylight = s.sunset - s.sunrise;
  const valid = (d) => d instanceof Date && !Number.isNaN(d.getTime());

  el.innerHTML = `
    <h2>Sun and moon</h2>
    <div class="moon-row">
      ${kv([
        ['Sunrise', valid(s.sunrise) ? clock(s.sunrise) : '—'],
        ['Sunset', valid(s.sunset) ? clock(s.sunset) : '—'],
        ['Daylight', valid(s.sunrise) ? `${Math.floor(daylight / 3600e3)}h ${Math.round((daylight % 3600e3) / 60e3)}m` : '—'],
      ])}
      <div class="moon">
        ${moonSvg(ill.fraction, ill.phase)}
        ${kv([
          [phaseName(ill.phase), `${Math.round(ill.fraction * 100)}%`],
          ['Moonrise', mt.rise ? clock(mt.rise) : '—'],
          ['Moonset', mt.set ? clock(mt.set) : '—'],
        ])}
      </div>
    </div>`;
}

function phaseName(p) {
  if (p < 0.03 || p > 0.97) return 'New moon';
  if (p < 0.22) return 'Waxing crescent';
  if (p < 0.28) return 'First quarter';
  if (p < 0.47) return 'Waxing gibbous';
  if (p < 0.53) return 'Full moon';
  if (p < 0.72) return 'Waning gibbous';
  if (p < 0.78) return 'Last quarter';
  return 'Waning crescent';
}

// Lit side on the right while waxing, left while waning.
function moonSvg(f, phase) {
  const r = 34, waxing = phase < 0.5, rx = Math.abs(1 - 2 * f) * r;
  const outer = waxing ? 1 : 0;
  const term = f < 0.5 ? (waxing ? 0 : 1) : (waxing ? 1 : 0);
  const lit = f < 0.01 ? '' : `<path d="M0 ${-r} A${r} ${r} 0 0 ${outer} 0 ${r} A${rx.toFixed(1)} ${r} 0 0 ${term} 0 ${-r}Z" fill="#F1F6F8"/>`;
  return `<svg viewBox="-40 -40 80 80" width="64" height="64" role="img" aria-label="Moon ${Math.round(f * 100)} percent lit" style="flex:none">
    <circle r="${r}" fill="#22343D"/>${lit}</svg>`;
}

function renderUV() {
  const { current: c, history: h } = state.data;
  const since = startOfLocalDay(Date.now());
  const today = h.filter((r) => r.dateutc >= since);
  const peak = today.reduce((m, r) => Math.max(m, r.solarradiation ?? 0), 0);
  // Integrate W/m² over the 5-minute steps → kJ/m²
  const total = today.reduce((sum, r) => sum + (r.solarradiation ?? 0) * 300, 0) / 1000;
  const uv = c.uv ?? 0;
  const segs = Array.from({ length: 11 }, (_, i) => `<div style="height:8px;border-radius:2px;background:${i <= uv && (i > 0 || uv === 0) ? '#FFC27A' : '#2B3C45'}"></div>`).join('');
  $('tileUV').innerHTML = `
    <h2>Sun and UV</h2>
    <div class="lead"><span class="big num">${fmt(uv)}</span><span class="note">UV index, ${uvWord(uv)}</span></div>
    <div aria-hidden="true" style="display:grid;grid-template-columns:repeat(11,minmax(0,1fr));gap:3px">${segs}</div>
    ${kv([
      ['Solar now', fmt(c.solarradiation, 1)],
      ['Peak today', fmt(peak, 1), 'amber'],
      ['Total today', fmt(total)],
    ])}
    <p class="muted small">Solar in W/m², total in kJ/m².</p>`;
}

// --- Rain / wind / pressure / humidity --------------------------------------

function renderRain() {
  const { current: c, history: h } = state.data, u = U();
  $('tileRain').innerHTML = `
    <h2>Rain</h2>
    <div class="lead"><span class="big num teal">${fmt(C.rain(c.dailyrainin), u.rainDp)}</span><span class="muted">${u.rain} today</span></div>
    <svg viewBox="0 0 1000 60" preserveAspectRatio="none" role="img" aria-label="Rain rate over the last 24 hours" style="width:100%;height:44px;display:block">
      <path d="${barsPath(h.map((r) => r.hourlyrainin ?? 0), h)}" stroke="#86DCEB" stroke-width="3" vector-effect="non-scaling-stroke"/>
    </svg>
    ${kv([
      ['This week', fmt(C.rain(c.weeklyrainin), u.rainDp)],
      ['This month', fmt(C.rain(c.monthlyrainin), u.rainDp)],
      ['This year', fmt(C.rain(c.yearlyrainin), u.rainDp)],
    ])}
    <p class="muted small">${c.lastRain && !c.hourlyrainin ? `Last rain ${ago(new Date(c.lastRain).getTime())}. ` : ''}Amounts in ${u.rain === 'in' ? 'inches' : 'millimetres'}.</p>`;
}

function renderWind() {
  const c = state.data.current, u = U();
  const speed = c.windspeedmph ?? 0, deg = c.winddir_avg10m ?? c.winddir ?? 0;
  let ticks = '', majors = '';
  for (let a = 0; a < 360; a += 5) {
    const r = (a * Math.PI) / 180, major = a % 90 === 0, r0 = major ? 54 : 60;
    const seg = `M${(Math.sin(r) * r0).toFixed(1)} ${(-Math.cos(r) * r0).toFixed(1)}L${(Math.sin(r) * 66).toFixed(1)} ${(-Math.cos(r) * 66).toFixed(1)}`;
    if (major) majors += seg; else ticks += seg;
  }
  const label = (x, y, t, bold) => `<text x="${x}" y="${y}" text-anchor="middle" dominant-baseline="central" fill="#B2C3CA" font-size="13" ${bold ? 'font-weight="700"' : ''}>${t}</text>`;
  $('tileWind').innerHTML = `
    <h2>Wind</h2>
    <div class="with-dial">
      <svg viewBox="-80 -80 160 160" width="128" height="128" role="img" aria-label="${speed < 1 ? 'Calm' : `${fmt(C.speed(speed))} ${u.speed}`}, from the ${dir8(deg)}">
        <circle r="66" fill="none" stroke="#2B3C45" stroke-width="1.5"/>
        <path d="${ticks}" stroke="#41565F" stroke-width="1.2"/><path d="${majors}" stroke="#B2C3CA" stroke-width="2"/>
        ${label(0, -44, 'N', true)}${label(44, 0, 'E')}${label(0, 44, 'S')}${label(-44, 0, 'W')}
        <g transform="rotate(${deg})"><path d="M0 -77 L8 -58 L0 -62 L-8 -58 Z" fill="#F1F6F8" opacity="${speed < 1 ? 0.5 : 1}"/></g>
        <text x="0" y="-2" text-anchor="middle" dominant-baseline="central" fill="#F1F6F8" font-size="30">${fmt(C.speed(speed), 1)}</text>
        <text x="0" y="20" text-anchor="middle" fill="#B2C3CA" font-size="12">${u.speed}</text>
      </svg>
      ${kv([
        ['From', dir16(deg)],
        ['Gusts', withUnit(fmt(C.speed(c.windgustmph), 1), u.speed)],
        ['Today’s peak', withUnit(fmt(C.speed(c.maxdailygust), 1), u.speed), 'amber'],
      ], 'kv col')}
    </div>`;
}

function renderPressure() {
  const { current: c, history: h } = state.data, u = U();
  const p = c.baromrelin;
  const cx = 90, cy = 90, R = 68;
  const pt = (deg, r) => { const a = (deg * Math.PI) / 180; return [(cx + r * Math.sin(a)).toFixed(1), (cy - r * Math.cos(a)).toFixed(1)]; };
  const arc = (a0, a1) => { const p0 = pt(a0, R), p1 = pt(a1, R); return `M${p0[0]} ${p0[1]}A${R} ${R} 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${p1[0]} ${p1[1]}`; };
  const clamp = Math.min(32, Math.max(28, p ?? 30));
  const ang = -120 + ((clamp - 28) / 4) * 240;
  let ticks = '';
  for (let t = 0; t <= 16; t++) { const d = -120 + t * 15, a = pt(d, t % 4 === 0 ? 50 : 54), b = pt(d, 58); ticks += `M${a[0]} ${a[1]}L${b[0]} ${b[1]}`; }
  const n = pt(ang, 52);
  const p3 = valueAgo(h, 'baromrelin', 3);
  const d3 = p != null && p3 != null ? p - p3 : null;
  const trend = d3 == null ? '—' : d3 > 0.06 ? 'Rising' : d3 < -0.06 ? 'Falling' : 'Steady';
  const lo = state.metric ? '948' : '28', hi = state.metric ? '1084' : '32';

  $('tilePressure').innerHTML = `
    <h2>Pressure</h2>
    <div class="with-dial">
      <svg viewBox="0 0 180 150" width="140" height="117" role="img" aria-label="${fmt(C.press(p), u.pressDp)} ${u.press}, ${trend.toLowerCase()}">
        <path d="${arc(-120, 120)}" fill="none" stroke="#2B3C45" stroke-width="10" stroke-linecap="round"/>
        <path d="${arc(-120, ang)}" fill="none" stroke="#86DCEB" stroke-width="10" stroke-linecap="round"/>
        <path d="${ticks}" stroke="#41565F" stroke-width="1.2"/>
        <text x="22" y="142" fill="#B2C3CA" font-size="13">${lo}</text><text x="158" y="142" text-anchor="end" fill="#B2C3CA" font-size="13">${hi}</text>
        <line x1="90" y1="90" x2="${n[0]}" y2="${n[1]}" stroke="#F1F6F8" stroke-width="3" stroke-linecap="round"/><circle cx="90" cy="90" r="5" fill="#F1F6F8"/>
      </svg>
      ${kv([
        ['Relative', withUnit(fmt(C.press(p), u.pressDp), u.press)],
        ['3-hour trend', trend],
        ['3-hour change', d3 == null ? '—' : signed(C.press(d3), u.pressDp)],
      ], 'kv col')}
    </div>`;
}

function renderHumidity() {
  const { current: c, history: h } = state.data;
  const spread = c.tempf != null && c.dewPoint != null ? c.tempf - c.dewPoint : null;
  const yest = valueAgo(h, 'humidity', 24);
  const note = spread != null && spread <= 2 && c.humidity >= 95 ? 'Air is saturated. Fog likely.'
    : c.humidity >= 80 ? 'Damp air.' : c.humidity <= 30 ? 'Dry air.' : 'Comfortable.';
  $('tileHumidity').innerHTML = `
    <h2>Humidity</h2>
    <div class="lead"><span class="big num teal">${fmt(c.humidity)}</span><span class="muted" style="font-size:24px">%</span></div>
    <div class="bar" aria-hidden="true"><div style="width:${Math.min(100, c.humidity ?? 0)}%"></div></div>
    ${kv([
      ['Dew point', `${fmt(C.temp(c.dewPoint), 1)}°`],
      ['Spread', spread == null ? '—' : `${fmt(C.delta(spread), 1)}°`],
      ['vs. yest.', yest == null ? '—' : `${signed(c.humidity - yest, 0)}%`],
    ])}
    <p class="note">${note}</p>`;
}

// --- Rainfall calendar --------------------------------------------------------

function renderCalendar() {
  const el = $('tileCalendar');
  if (!state.data) return;
  const c = state.data.current, u = U();
  const now = zoned(Date.now());
  const y = state.rain?.year ?? now.y, m = state.rain?.month ?? now.m;
  const daysIn = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const firstDow = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
  const vals = { ...(state.rain?.days || {}) };
  vals[now.d] = c.dailyrainin ?? 0; // today comes from the live reading
  const monthName = new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(Date.UTC(y, m - 1, 1));
  const max = Math.max(1, ...Object.values(vals).filter((v) => v != null));

  let cells = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d) => `<span class="cal-head">${d}</span>`).join('');
  for (let i = 0; i < firstDow; i++) cells += '<div class="cal-day empty" aria-hidden="true"></div>';
  for (let d = 1; d <= daysIn; d++) {
    const v = vals[d];
    const future = d > now.d;
    const a = v ? Math.min(0.9, 0.18 + (v / max) * 0.72) : 0;
    const dark = a > 0.5;
    const style = v ? ` style="background:rgba(134,220,235,${a.toFixed(2)})"` : '';
    const label = future ? '' : v == null ? '—' : v === 0 ? '0' : fmt(C.rain(v), u.rainDp);
    cells += `<div class="cal-day${d === now.d ? ' today' : ''}${dark ? ' dark' : ''}"${style} aria-label="${monthName.split(' ')[0]} ${d}: ${future ? 'future' : `${label} ${u.rain}`}">
      <span class="d num">${d}</span><span class="v">${label}</span></div>`;
  }
  const filling = state.rain?.pending ? ' Filling in earlier days…' : '';
  el.innerHTML = `
    <div class="row-between"><h2>Rainfall, ${monthName}</h2><span class="num strong teal" style="font-size:18px">${fmt(C.rain(c.monthlyrainin), u.rainDp)} ${u.rain}</span></div>
    <div class="cal">${cells}</div>
    <p class="muted small">Per day, in ${u.rain === 'in' ? 'inches' : 'millimetres'}. Darker cells had more rain. Today is outlined.${filling}</p>`;
}

// --- Wind rose (last 24 h) ------------------------------------------------------

function renderRose() {
  const h = state.data.history, u = U();
  const bands = state.metric ? ['Under 6 km/h', '6–13', '13+'] : ['Under 4 mph', '4–8', '8+'];
  const colors = ['#3B7F8E', '#5FB3C3', '#BFEFF7'];
  const counts = Array.from({ length: 16 }, () => [0, 0, 0]);
  let n = 0, calm = 0;
  h.forEach((r) => {
    if (r.winddir == null || r.windspeedmph == null) return;
    n++;
    if (r.windspeedmph < 0.5) { calm++; return; }
    const b = r.windspeedmph < 4 ? 0 : r.windspeedmph < 8 ? 1 : 2;
    counts[Math.round(r.winddir / 22.5) % 16][b]++;
  });
  const totals = counts.map((c) => c[0] + c[1] + c[2]);
  const maxTot = Math.max(1, ...totals);
  const P = (r, deg) => { const a = (deg * Math.PI) / 180; return `${(r * Math.sin(a)).toFixed(1)} ${(-r * Math.cos(a)).toFixed(1)}`; };
  const wedge = (r0, r1, a0, a1) => `M${P(r0, a0)}L${P(r1, a0)}A${r1} ${r1} 0 0 1 ${P(r1, a1)}L${P(r0, a1)}${r0 > 0 ? `A${r0} ${r0} 0 0 0 ${P(r0, a0)}` : ''}Z`;
  const paths = ['', '', ''];
  counts.forEach((c, k) => {
    let r = 0;
    c.forEach((v, b) => { if (!v) return; const r2 = r + (v / maxTot) * 92; paths[b] += wedge(r, r2, k * 22.5 - 9, k * 22.5 + 9); r = r2; });
  });
  const top = totals.indexOf(Math.max(...totals));
  const note = n === 0 ? 'No wind data yet.' : calm === n ? 'Calm all day.'
    : `Mostly from the ${dir8(top * 22.5)}.${calm / n > 0.25 ? ` Calm ${Math.round((calm / n) * 100)}% of the time.` : ''}`;
  const lbl = (x, y, t, b) => `<text x="${x}" y="${y}" text-anchor="middle" fill="${b ? '#F1F6F8' : '#B2C3CA'}" font-size="13" ${b ? 'font-weight="700"' : ''}>${t}</text>`;

  $('tileRose').innerHTML = `
    <h2>Wind rose, 24 hours</h2>
    <svg viewBox="-110 -110 220 220" role="img" aria-label="Wind rose. ${note}" style="width:100%;max-width:240px;height:auto;align-self:center">
      <circle r="96" fill="none" stroke="#2B3C45"/><circle r="64" fill="none" stroke="#2B3C45"/><circle r="32" fill="none" stroke="#2B3C45"/>
      <path d="M0 -96V96M-96 0H96" stroke="#2B3C45"/>
      ${paths.map((d, i) => `<path d="${d}" fill="${colors[i]}"/>`).join('')}
      ${lbl(0, -100, 'N', true)}${lbl(104, 4, 'E')}${lbl(0, 110, 'S')}${lbl(-104, 4, 'W')}
    </svg>
    <div class="chips">${bands.map((b, i) => `<span><span class="chip-sw" style="background:${colors[i]}" aria-hidden="true"></span>${b}</span>`).join('')}</div>
    <p class="muted small">${note}</p>`;
}

// --- Degree days + evaporation estimate ------------------------------------------

function renderDegree() {
  const { history: h, coords } = state.data, u = U();
  const temps = h.map((r) => r.tempf).filter((v) => v != null);
  if (!temps.length) { $('tileDegree').innerHTML = '<h2>Degree days</h2><p class="muted">Not enough data yet.</p>'; return; }
  const mean = temps.reduce((a, b) => a + b, 0) / temps.length;
  const tmax = Math.max(...temps), tmin = Math.min(...temps);
  const hdd = Math.max(0, 65 - mean), cdd = Math.max(0, mean - 65);
  const gdd = Math.max(0, (Math.min(tmax, 86) + Math.max(tmin, 50)) / 2 - 50);

  // Hargreaves reference evapotranspiration (rough, from temps + latitude)
  let et = null;
  if (coords) {
    const tc = (f) => ((f - 32) * 5) / 9;
    const doy = Math.floor((Date.now() - Date.UTC(new Date().getUTCFullYear(), 0, 0)) / 864e5);
    const phi = (coords.lat * Math.PI) / 180;
    const dr = 1 + 0.033 * Math.cos(((2 * Math.PI) / 365) * doy);
    const dec = 0.409 * Math.sin(((2 * Math.PI) / 365) * doy - 1.39);
    const ws = Math.acos(Math.max(-1, Math.min(1, -Math.tan(phi) * Math.tan(dec))));
    const Ra = ((24 * 60) / Math.PI) * 0.082 * dr * (ws * Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.sin(ws));
    const mm = 0.0023 * (tc(mean) + 17.8) * Math.sqrt(Math.max(0, tc(tmax) - tc(tmin))) * Ra * 0.408;
    et = Math.max(0, mm / 25.4); // inches
  }
  const dd = (v) => fmt(C.delta(v), 1);
  $('tileDegree').innerHTML = `
    <h2>Degree days</h2>
    <dl class="rows">
      <div><dt>Heating</dt><dd class="amber">${dd(hdd)}</dd></div>
      <div><dt>Cooling</dt><dd>${dd(cdd)}</dd></div>
      <div><dt>Growing</dt><dd>${dd(gdd)}</dd></div>
      <div><dt>Evaporation (est.)</dt><dd>${et == null ? '—' : withUnit(fmt(C.rain(et), u.rainDp), u.rain)}</dd></div>
    </dl>
    <p class="muted small">Last 24 hours. Heating and cooling use a ${state.metric ? '18.3°C' : '65°F'} base, growing ${state.metric ? '10°C' : '50°F'}.</p>`;
}

// --- Last 24 hours small multiples -----------------------------------------------

function xFor(h) {
  const t0 = h[0].dateutc, t1 = h[h.length - 1].dateutc || t0 + 1;
  return (t) => (((t - t0) / Math.max(1, t1 - t0)) * 1000).toFixed(1);
}
function linePath(vals, h, lo, hi) {
  const X = xFor(h);
  let d = '', pen = false;
  vals.forEach((v, i) => {
    if (v == null) { pen = false; return; }
    const gap = i > 0 && h[i].dateutc - h[i - 1].dateutc > 20 * 60e3;
    d += `${!pen || gap ? 'M' : 'L'}${X(h[i].dateutc)} ${(56 - ((v - lo) / (hi - lo || 1)) * 50).toFixed(1)}`;
    pen = true;
  });
  return d;
}
function barsPath(vals, h) {
  const X = xFor(h), hi = Math.max(0.1, ...vals.map((v) => v ?? 0));
  return vals.map((v, i) => (v > 0.001 ? `M${X(h[i].dateutc)} 60V${(60 - (v / hi) * 56).toFixed(1)}` : '')).join('');
}

function renderMultiples() {
  const { current: c, history: h } = state.data, u = U();
  if (h.length < 2) { $('multiples').innerHTML = '<p class="muted">History fills in as the station reports.</p>'; return; }
  const series = (key, conv) => h.map((r) => (r[key] == null ? null : conv(r[key])));
  const range = (a) => { const v = a.filter((x) => x != null); return [Math.min(...v), Math.max(...v)]; };

  const temp = series('tempf', C.temp), [tLo, tHi] = range(temp);
  const rate = series('hourlyrainin', C.rain), [, rHi] = range(rate.map((v) => v ?? 0));
  const pres = series('baromrelin', C.press), [pLo, pHi] = range(pres);
  const wind = series('windspeedmph', C.speed), [, wHi] = range(wind.map((v) => v ?? 0));
  const pPad = state.metric ? 0.7 : 0.02;

  const rows = [
    { label: 'Temperature', sub: `${fmt(tLo, 1)}° to ${fmt(tHi, 1)}°`, now: fmt(C.temp(c.tempf), 1), unit: u.temp, color: '#FFC27A', d: linePath(temp, h, tLo - 0.5, tHi + 0.5), area: true },
    { label: 'Rain rate', sub: `Peak ${fmt(rHi, u.rainDp)} ${u.rate}`, now: fmt(C.rain(c.hourlyrainin ?? 0), u.rainDp), unit: u.rate, color: '#86DCEB', d: barsPath(rate.map((v) => v ?? 0), h), bars: true },
    { label: 'Pressure', sub: `${fmt(pLo, u.pressDp)} to ${fmt(pHi, u.pressDp)}`, now: fmt(C.press(c.baromrelin), u.pressDp), unit: u.press, color: '#D4E0E5', d: linePath(pres, h, pLo - pPad, pHi + pPad), area: true },
    { label: 'Wind', sub: `Peak ${fmt(wHi, 1)} ${u.speed}`, now: fmt(C.speed(c.windspeedmph), 1), unit: u.speed, color: '#B2C3CA', d: linePath(wind, h, 0, wHi + 1), area: true },
  ];
  const t0 = h[0].dateutc, t1 = h[h.length - 1].dateutc;
  const ticks = [0, 0.25, 0.5, 0.75].map((f) => hourLabel(t0 + f * (t1 - t0)));

  $('multiples').innerHTML = rows.map((r) => `
    <div class="mrow">
      <div><p class="strong">${r.label}</p><p class="muted small num">${r.sub}</p></div>
      <svg viewBox="0 0 1000 60" preserveAspectRatio="none" role="img" aria-label="${r.label} over the last 24 hours">
        ${r.area && r.d ? `<path d="${r.d}L1000 60L0 60Z" fill="${r.color}" opacity="0.14"/>` : ''}
        <path d="${r.d}" fill="none" stroke="${r.color}" stroke-width="${r.bars ? 3 : 2.5}" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>
      </svg>
      <p class="mnow">${r.now}<small> ${r.unit}</small></p>
    </div>`).join('') + `
    <div class="mrow axis"><span></span><div class="axis-labels num">${ticks.map((t) => `<span>${t}</span>`).join('')}<span>Now</span></div><span></span></div>`;
}

// --- Tides ----------------------------------------------------------------------

function tideAt(events, t) {
  for (let k = 0; k < events.length - 1; k++) {
    const a = events[k], b = events[k + 1];
    if (t >= a.t && t <= b.t) {
      const f = (t - a.t) / (b.t - a.t);
      return a.ft + (b.ft - a.ft) * (1 - Math.cos(Math.PI * f)) / 2;
    }
  }
  return null;
}

function renderTides() {
  const td = state.tides;
  if (!td || !state.data) return;
  const u = U(), ev = td.events, now = Date.now();
  const hNow = tideAt(ev, now);
  const next = ev.find((e) => e.t > now);

  $('tideNow').textContent = fmt(C.height(hNow), u.heightDp);
  $('tideUnit').textContent = ` ${u.height}`;
  $('tideState').textContent = next ? `${next.type === 'High' ? 'Rising' : 'Falling'}, ${next.type.toLowerCase()} tide at ${clock(next.t)}` : '';
  $('tideObserved').textContent = td.observed ? `Predicted. Measured ${fmt(C.height(td.observed.ft), u.heightDp)} ${u.height} at ${clock(td.observed.t)}.` : 'Predicted height.';

  // Today's table
  const day0 = startOfLocalDay(now), day1 = day0 + 86400e3;
  $('tideCaption').textContent = `Today, ${fmtTime(now, { weekday: 'long' })}`;
  $('tideRows').innerHTML = ev.filter((e) => e.t >= day0 && e.t < day1).map((e) => `
    <tr class="${e.t < now ? 'past' : ''}">
      <th scope="row" style="color:${e.t < now ? '' : e.type === 'High' ? '#86DCEB' : '#F1F6F8'}">${e.type} tide</th>
      <td>${clock(e.t)}</td><td>${fmt(C.height(e.ft), u.heightDp)} ${u.height}</td>
    </tr>`).join('');

  // 36-hour chart from local midnight
  const T0 = day0, T1 = day0 + 36 * 3600e3;
  const inWin = ev.filter((e) => e.t >= T0 - 7 * 3600e3 && e.t <= T1 + 7 * 3600e3);
  const lo = Math.min(...inWin.map((e) => e.ft), 0) - 0.5, hi = Math.max(...inWin.map((e) => e.ft)) + 1;
  const x = (t) => ((t - T0) / (T1 - T0)) * 1000;
  const y = (ft) => 212 - ((ft - lo) / (hi - lo)) * 172; // leaves room for low-tide labels above the axis

  let path = '';
  for (let s = 0; s <= 240; s++) {
    const t = T0 + (s / 240) * (T1 - T0), v = tideAt(ev, t);
    if (v != null) path += `${path ? 'L' : 'M'}${x(t).toFixed(1)} ${y(v).toFixed(1)}`;
  }

  // Night shading from SunCalc (station location)
  let nights = '';
  const co = state.data.coords;
  if (window.SunCalc && co) {
    const a = SunCalc.getTimes(new Date(T0 + 12 * 3600e3), co.lat, co.lon);
    const b = SunCalc.getTimes(new Date(T0 + 36 * 3600e3), co.lat, co.lon);
    [[T0, +a.sunrise], [+a.sunset, +b.sunrise], [+b.sunset, T1]].forEach(([s, e]) => {
      if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) return;
      const xs = Math.max(0, x(s)), xe = Math.min(1000, x(e));
      if (xe > xs) nights += `<rect x="${xs.toFixed(1)}" y="20" width="${(xe - xs).toFixed(1)}" height="240" fill="#1E3039"/>`;
    });
  }

  const marks = ev.filter((e) => e.t > T0 + 0.4 * 3600e3 && e.t < T1 - 0.4 * 3600e3).map((e) => {
    const cx = x(e.t), cy = y(e.ft), high = e.type === 'High';
    const anchor = cx < 50 ? 'start' : cx > 950 ? 'end' : 'middle';
    return `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="5" fill="#152229" stroke="#86DCEB" stroke-width="2.5"/>
      <text x="${cx.toFixed(1)}" y="${(high ? cy - 30 : cy + 26).toFixed(1)}" text-anchor="${anchor}" fill="#F1F6F8" font-size="17" font-weight="700">${fmt(C.height(e.ft), u.heightDp)} ${u.height}</text>
      <text x="${cx.toFixed(1)}" y="${(high ? cy - 12 : cy + 44).toFixed(1)}" text-anchor="${anchor}" fill="#B2C3CA" font-size="14">${clock(e.t)}</text>`;
  }).join('');

  const axis = [0, 6, 12, 18, 24, 30, 36].map((hh, i, arr) => {
    const t = T0 + hh * 3600e3;
    const lbl = hh % 24 === 0 ? fmtTime(t, { weekday: 'short' }) : hourLabel(t);
    return `<text x="${x(t).toFixed(0)}" y="292" text-anchor="${i === 0 ? 'start' : i === arr.length - 1 ? 'end' : 'middle'}" fill="#B2C3CA" font-size="14">${lbl}</text>`;
  }).join('');

  const nx = x(now), ny = hNow == null ? null : y(hNow);
  $('tideSvg').setAttribute('aria-label', `Tide over the next 36 hours. ${ev.filter((e) => e.t > now && e.t < T1).slice(0, 4).map((e) => `${e.type} ${fmt(C.height(e.ft), u.heightDp)} ${u.height} at ${clock(e.t)}`).join(', ')}.`);
  $('tideSvg').innerHTML = `
    ${nights}
    <line x1="0" y1="${y(0).toFixed(1)}" x2="1000" y2="${y(0).toFixed(1)}" stroke="#3A4F59" stroke-dasharray="4 6"/>
    <text x="6" y="${(y(0) - 6).toFixed(1)}" fill="#B2C3CA" font-size="14">0 ${u.height}</text>
    <path d="${path}L1000 260L0 260Z" fill="#86DCEB" opacity="0.16"/>
    <path d="${path}" fill="none" stroke="#86DCEB" stroke-width="3" stroke-linejoin="round"/>
    ${nx >= 0 && nx <= 1000 ? `<line x1="${nx.toFixed(1)}" y1="14" x2="${nx.toFixed(1)}" y2="262" stroke="#FFC27A" stroke-width="3"/>` : ''}
    ${ny != null && nx >= 0 && nx <= 1000 ? `<circle cx="${nx.toFixed(1)}" cy="${ny.toFixed(1)}" r="7" fill="#FFC27A" stroke="#152229" stroke-width="3"/>` : ''}
    ${marks}${axis}`;
}

// --- Forecast ---------------------------------------------------------------------

function renderForecast() {
  const f = state.forecast;
  if (!f || !state.data) return;
  const days = f.days || [];
  const temps = days.flatMap((d) => [d.hi, d.lo]).filter((v) => v != null);
  const lo = Math.min(...temps), hi = Math.max(...temps), span = Math.max(1, hi - lo);
  const batt = state.data.current.battout;
  $('forecastNote').textContent = `${f.source}.${batt === 1 || batt === '1' ? ' Station batteries OK.' : batt === 0 || batt === '0' ? ' Station battery low.' : ''}`;
  $('forecast').innerHTML = days.map((d, i) => {
    const a = d.lo ?? d.hi, b = d.hi ?? d.lo;
    const left = ((a - lo) / span) * 100, width = Math.max(4, ((b - a) / span) * 100);
    const t = (v) => (v == null ? '—' : `${fmt(C.temp(v))}°`);
    return `<div class="fday${i === 0 ? ' first' : ''}">
      <p class="strong">${esc(d.name)}</p>
      <p class="sky">${esc(d.sky)}${d.pop ? `, ${d.pop}%` : ''}</p>
      <div class="temps"><span class="hi num">${t(d.hi)}</span><span class="lo num">${t(d.lo)}</span></div>
      <div class="range" aria-hidden="true"><div style="left:${left.toFixed(0)}%;width:${width.toFixed(0)}%"></div></div>
    </div>`;
  }).join('');
}

// ---------------------------------------------------------------------------
// Radar map: Leaflet + CARTO dark tiles + RainViewer radar frames
// (RainViewer's free tier: radar zoom tops out at 7, so we stretch it.)
// ---------------------------------------------------------------------------

const radar = { map: null, layers: [], frames: [], idx: 0, timer: null };

function initMap() {
  if (radar.map || !window.L) return;
  const co = state.data?.coords;
  if (!co) { $('map').innerHTML = '<p class="radar-empty">Radar needs the station’s location from Ambient Weather.</p>'; return; }

  radar.map = L.map('map', { zoomControl: true, attributionControl: false, scrollWheelZoom: false, maxZoom: 12, minZoom: 4 })
    .setView([co.lat, co.lon], 8);
  radar.map.zoomControl.setPosition('topright');
  // Base map: Stadia "Alidade Smooth Dark" (free, authorised by domain in the
  // Stadia dashboard, so no key in the code). If its tiles are refused, e.g.
  // before the domain is registered, fall back to OpenStreetMap tiles
  // darkened with a CSS filter.
  // Stadia answers an unauthorised request with a 401 *image*, which Leaflet
  // treats as a normal tile, so test one tile first and pick the layer.
  addBaseMap(co);
  L.marker([co.lat, co.lon], { icon: L.divIcon({ className: '', html: '<div class="station-pin"></div>', iconSize: [18, 18], iconAnchor: [9, 9] }), keyboard: false })
    .bindTooltip(esc(state.data.name), { permanent: true, direction: 'right', className: 'station-label', offset: [12, 0] })
    .addTo(radar.map);

  loadRadarFrames();
  setInterval(loadRadarFrames, 10 * 60e3);
}

async function addBaseMap(co) {
  const z = 8;
  const x = Math.floor(((co.lon + 180) / 360) * 2 ** z);
  const latR = (co.lat * Math.PI) / 180;
  const y = Math.floor(((1 - Math.log(Math.tan(latR) + 1 / Math.cos(latR)) / Math.PI) / 2) * 2 ** z);
  let stadiaOk = false;
  try {
    const res = await fetch(`https://tiles.stadiamaps.com/tiles/alidade_smooth_dark/${z}/${x}/${y}.png`, { mode: 'cors' });
    stadiaOk = res.ok;
  } catch { /* network or CORS problem: use the fallback */ }

  if (stadiaOk) {
    L.tileLayer('https://tiles.stadiamaps.com/tiles/alidade_smooth_dark/{z}/{x}/{y}{r}.png', { maxZoom: 12 }).addTo(radar.map);
  } else {
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 12, className: 'osm-dark' }).addTo(radar.map);
    $('mapCredit').innerHTML = 'Map © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors.';
  }
}

async function loadRadarFrames() {
  try {
    const res = await fetch('https://api.rainviewer.com/public/weather-maps.json');
    const data = await res.json();
    const frames = (data.radar?.past || []).slice(-7); // last hour, 10-minute steps
    if (!frames.length) throw new Error('No radar frames');

    radar.layers.forEach((l) => radar.map.removeLayer(l));
    radar.frames = frames;
    radar.layers = frames.map((f) => L.tileLayer(`${data.host}${f.path}/256/{z}/{x}/{y}/2/1_1.png`, {
      opacity: 0, maxNativeZoom: 7, maxZoom: 12, zIndex: 10,
    }).addTo(radar.map));

    const input = $('radarFrame');
    input.max = String(frames.length - 1);
    $('radarStart').textContent = `${Math.round((frames.at(-1).time - frames[0].time) / 60)} min ago`;
    showFrame(frames.length - 1);
  } catch {
    $('radarNow').textContent = 'Radar unavailable right now';
  }
}

function showFrame(i) {
  radar.idx = i;
  radar.layers.forEach((l, k) => l.setOpacity(k === i ? 0.75 : 0));
  $('radarFrame').value = String(i);
  const f = radar.frames[i];
  if (f) $('radarNow').textContent = `${i === radar.frames.length - 1 ? 'Latest, ' : ''}${clock(f.time * 1000)}`;
}

function togglePlay() {
  const btn = $('radarPlay');
  if (radar.timer) {
    clearInterval(radar.timer); radar.timer = null;
    $('playIcon').setAttribute('d', 'M1 1l12 7-12 7z');
    btn.setAttribute('aria-label', 'Play the last hour of radar');
    return;
  }
  $('playIcon').setAttribute('d', 'M1 1h4v14H1zM9 1h4v14H9z');
  btn.setAttribute('aria-label', 'Pause radar');
  if (radar.idx === radar.frames.length - 1) showFrame(0);
  radar.timer = setInterval(() => {
    const n = radar.frames.length;
    if (!n) return;
    showFrame((radar.idx + 1) % n);
  }, 700);
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

document.querySelectorAll('[data-units]').forEach((b) => b.addEventListener('click', () => {
  state.metric = b.dataset.units === 'metric';
  savePref();
  renderAll();
}));
$('radarPlay').addEventListener('click', togglePlay);
$('radarFrame').addEventListener('input', (e) => {
  if (radar.timer) togglePlay();
  showFrame(Number(e.target.value));
});

// Scripts load with `defer`; wait for Leaflet/SunCalc before first render.
window.addEventListener('DOMContentLoaded', () => {
  loadWeather();
  loadTides();
  setTimeout(loadRainMonth, 2500); // after the first weather call, to spare Ambient's rate limit
});
setInterval(loadWeather, 60_000);
setInterval(loadTides, 30 * 60_000);
setInterval(() => { state.forecast = null; loadForecast(); }, 30 * 60_000);
setInterval(renderUpdated, 20_000);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') loadWeather(); });
