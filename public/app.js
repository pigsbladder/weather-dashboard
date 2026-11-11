// ===========================================================================
// Weather dashboard front end
// Fetches /api/weather (the password-protected proxy), renders it, and
// refreshes every minute. No framework, no build step.
// ===========================================================================

const $ = (id) => document.getElementById(id);
const REFRESH_MS = 60_000;
const STALE_MS = 15 * 60_000; // station hasn't reported in 15 min = flag it

const state = {
  data: null,
  series: 'temp',
  metric: readPref(),
  drawn: false, // the pen animation only runs on first load
};

// ---------------------------------------------------------------------------
// Units
// ---------------------------------------------------------------------------

function readPref() {
  try { return localStorage.getItem('wx-units') === 'metric'; } catch { return false; }
}
function savePref() {
  try { localStorage.setItem('wx-units', state.metric ? 'metric' : 'us'); } catch { /* private mode etc. */ }
}

const conv = {
  temp: (f) => (f == null ? null : state.metric ? ((f - 32) * 5) / 9 : f),
  // temperature *differences* (no -32 offset)
  tempDelta: (f) => (state.metric ? (f * 5) / 9 : f),
  speed: (mph) => (mph == null ? null : state.metric ? mph * 1.609344 : mph),
  rain: (inch) => (inch == null ? null : state.metric ? inch * 25.4 : inch),
  press: (inHg) => (inHg == null ? null : state.metric ? inHg * 33.8639 : inHg),
};

const U = () =>
  state.metric
    ? { temp: '°C', speed: 'km/h', rain: 'mm', press: 'hPa', rainDp: 1, pressDp: 0 }
    : { temp: '°F', speed: 'mph', rain: 'in', press: 'inHg', rainDp: 2, pressDp: 2 };

function fmt(v, dp = 0) {
  if (v == null || Number.isNaN(v)) return '—';
  return v.toLocaleString(undefined, { minimumFractionDigits: dp, maximumFractionDigits: dp });
}

// ---------------------------------------------------------------------------
// Time helpers (shown in the station's own time zone)
// ---------------------------------------------------------------------------

const tz = () => state.data?.current?.tz || undefined;

function clock(t) {
  return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit', timeZone: tz() }).format(t);
}
function hourLabel(t) {
  return new Intl.DateTimeFormat(undefined, { hour: 'numeric', timeZone: tz() }).format(t);
}
function hourOfDay(t) {
  return Number(new Intl.DateTimeFormat('en-US', { hour: 'numeric', hourCycle: 'h23', timeZone: tz() }).format(t));
}

const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
function ago(t) {
  const s = Math.round((t - Date.now()) / 1000);
  const abs = Math.abs(s);
  if (abs < 60) return 'just now';
  if (abs < 3600) return rtf.format(Math.round(s / 60), 'minute');
  if (abs < 86400) return rtf.format(Math.round(s / 3600), 'hour');
  return rtf.format(Math.round(s / 86400), 'day');
}

// ---------------------------------------------------------------------------
// Wind direction
// ---------------------------------------------------------------------------

const DIR_WORDS = ['north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest'];
const DIR_SHORT = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
const dirWord = (deg) => DIR_WORDS[Math.round(deg / 45) % 8];
const dirShort = (deg) => DIR_SHORT[Math.round(deg / 22.5) % 16];

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------

async function load() {
  try {
    const res = await fetch('/api/weather', { headers: { accept: 'application/json' } });
    if (res.status === 401) return location.reload(); // session expired -> sign-in page
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || 'Couldn’t load the weather.');

    state.data = body;
    setNotice('');
    render();
  } catch (err) {
    setNotice(
      state.data
        ? `${err.message} Showing the last reading received.`
        : err.message || 'Couldn’t load the weather. Refresh the page to try again.',
    );
  }
}

function setNotice(msg) {
  const el = $('notice');
  el.textContent = msg;
  el.hidden = !msg;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function render() {
  const d = state.data;
  if (!d) return;
  const c = d.current;
  const u = U();

  $('station').textContent = d.name;
  $('place').textContent = d.location ?? '';
  $('units').textContent = state.metric ? 'Show US units' : 'Show metric';

  $('temp').textContent = fmt(conv.temp(c.tempf));
  $('tempUnit').textContent = u.temp;
  $('summary').textContent = summary(c);

  renderUpdated();
  renderDial(c);
  renderChart();
  renderReadings(c);
}

// One or two plain sentences: what it feels like out there.
function summary(c) {
  const u = U();
  const parts = [];

  if (c.feelsLike != null && Math.abs(c.feelsLike - c.tempf) >= 2) {
    parts.push(`Feels like ${fmt(conv.temp(c.feelsLike))}°.`);
  }

  const speed = c.windspeedmph ?? 0;
  const dir = c.winddir_avg10m ?? c.winddir;
  if (speed < 1) {
    parts.push('Calm.');
  } else {
    let s = `Wind from the ${dirWord(dir)} at ${fmt(conv.speed(speed))} ${u.speed}`;
    if (c.windgustmph != null && c.windgustmph >= speed + 3) s += `, gusting ${fmt(conv.speed(c.windgustmph))}`;
    parts.push(s + '.');
  }

  if (c.hourlyrainin > 0) {
    parts.push(`Raining now, with ${fmt(conv.rain(c.hourlyrainin), u.rainDp)} ${u.rain} over the last hour.`);
  } else if (c.dailyrainin > 0) {
    parts.push(`${fmt(conv.rain(c.dailyrainin), u.rainDp)} ${u.rain} of rain today.`);
  } else if (c.lastRain) {
    parts.push(`Dry today. Last rain ${ago(new Date(c.lastRain).getTime())}.`);
  }

  return parts.join(' ');
}

function renderUpdated() {
  const t = state.data?.current?.dateutc;
  const el = $('updated');
  if (!t) return;
  const stale = Date.now() - t > STALE_MS;
  el.textContent = stale ? `No report since ${clock(t)}` : `Updated ${ago(t)}`;
  el.classList.toggle('stale', stale);
}

// --- Wind dial --------------------------------------------------------------

function renderDial(c) {
  const svg = $('dial');
  const u = U();
  const deg = c.winddir_avg10m ?? c.winddir ?? 0;
  const speed = c.windspeedmph ?? 0;

  // Build the static face once.
  if (!svg.dataset.built) {
    let face = '<circle class="ring" r="96"/>';
    for (let a = 0; a < 360; a += 15) {
      const major = a % 90 === 0;
      const r1 = major ? 84 : 89;
      const rad = (a * Math.PI) / 180;
      face += `<line class="tick${major ? ' major' : ''}" x1="${Math.sin(rad) * r1}" y1="${-Math.cos(rad) * r1}" x2="${Math.sin(rad) * 96}" y2="${-Math.cos(rad) * 96}"/>`;
    }
    [['N', 0], ['E', 90], ['S', 180], ['W', 270]].forEach(([l, a]) => {
      const rad = (a * Math.PI) / 180;
      face += `<text class="cardinal" x="${Math.sin(rad) * 70}" y="${-Math.cos(rad) * 70}">${l}</text>`;
    });
    // Needle sits on the rim and points inward from where the wind comes from.
    face += '<path class="needle" id="needle" d="M0 -104 L9 -80 L0 -86 L-9 -80 Z"/>';
    face += '<text class="speed" id="dialSpeed" y="-4"></text>';
    face += '<text class="speed-unit" id="dialUnit" y="26"></text>';
    svg.innerHTML = face;
    svg.dataset.built = '1';
  }

  $('needle').style.transform = `rotate(${deg}deg)`;
  $('needle').style.opacity = speed < 1 ? 0.35 : 1;
  $('dialSpeed').textContent = fmt(conv.speed(speed));
  $('dialUnit').textContent = u.speed;

  const gust = c.maxdailygust != null ? ` Strongest gust today ${fmt(conv.speed(c.maxdailygust))} ${u.speed}.` : '';
  $('windText').textContent = speed < 1 ? `Calm.${gust}` : `From the ${dirShort(deg)}.${gust}`;
}

// --- 24h chart ----------------------------------------------------------------

const SERIES = {
  temp: {
    get: (r) => conv.temp(r.tempf),
    unit: () => U().temp,
    dp: () => 0,
    minSpan: () => conv.tempDelta(6),
    note: (pts) => {
      const hi = pts.reduce((a, b) => (b.v > a.v ? b : a));
      const lo = pts.reduce((a, b) => (b.v < a.v ? b : a));
      return `High ${fmt(hi.v)}° at ${hourLabel(hi.t)}, low ${fmt(lo.v)}° at ${hourLabel(lo.t)}.`;
    },
  },
  pressure: {
    get: (r) => conv.press(r.baromrelin),
    unit: () => U().press,
    dp: () => U().pressDp,
    minSpan: () => conv.press(0.12),
    note: (pts) => {
      // Compare now with ~3 hours ago, the usual barometric tendency window.
      const last = pts.at(-1);
      const then = pts.find((p) => p.t >= last.t - 3 * 3600e3) ?? pts[0];
      const delta = last.v - then.v;
      const threshold = conv.press(0.02);
      const trend = delta > threshold ? 'Rising' : delta < -threshold ? 'Falling' : 'Steady';
      return `${trend} over the last 3 hours (${delta >= 0 ? '+' : ''}${fmt(delta, U().pressDp)} ${U().press}).`;
    },
  },
  wind: {
    get: (r) => conv.speed(r.windspeedmph),
    get2: (r) => conv.speed(r.windgustmph), // gusts drawn as a lighter dashed line
    unit: () => U().speed,
    dp: () => 0,
    floor: 0,
    minSpan: () => conv.speed(10),
    note: (pts) => {
      const top = pts.reduce((a, b) => ((b.v2 ?? b.v) > (a.v2 ?? a.v) ? b : a));
      return `Strongest gust ${fmt(top.v2 ?? top.v)} ${U().speed} at ${clock(top.t)}. Dashed line shows gusts.`;
    },
  },
};

function renderChart() {
  const svg = $('chart');
  const box = $('paper');
  const W = box.clientWidth;
  const H = box.clientHeight;
  const s = SERIES[state.series];
  const hist = state.data?.history ?? [];

  const pts = hist
    .map((r) => ({ t: r.dateutc, v: s.get(r), v2: s.get2 ? s.get2(r) : null }))
    .filter((p) => p.v != null);

  if (pts.length < 2 || !W) {
    svg.innerHTML = '';
    $('chartNote').textContent = 'No history yet. The chart fills in as the station reports.';
    return;
  }

  // --- Scales ---
  const t1 = pts.at(-1).t;
  const t0 = t1 - 24 * 3600e3;
  const all = pts.flatMap((p) => (p.v2 != null ? [p.v, p.v2] : [p.v]));
  let lo = Math.min(...all);
  let hi = Math.max(...all);
  const span = Math.max(hi - lo, s.minSpan());
  const mid = (hi + lo) / 2;
  lo = s.floor != null ? Math.max(s.floor, mid - span * 0.6) : mid - span * 0.6;
  hi = lo + span * 1.2;

  const pad = { l: 12, r: 16, t: 18, b: 30 };
  const x = (t) => pad.l + ((t - t0) / (t1 - t0)) * (W - pad.l - pad.r);
  const y = (v) => pad.t + (1 - (v - lo) / (hi - lo)) * (H - pad.t - pad.b);

  let out = '';

  // --- Chart-paper grid: hourly lines, heavier every 6 hours ---
  for (let t = Math.ceil(t0 / 3600e3) * 3600e3; t <= t1; t += 3600e3) {
    const major = hourOfDay(t) % 6 === 0;
    const gx = x(t).toFixed(1);
    out += `<line class="grid${major ? ' major' : ''}" x1="${gx}" x2="${gx}" y1="0" y2="${H - pad.b + 6}"/>`;
    if (major) out += `<text class="axis-label" x="${gx}" y="${H - 9}" text-anchor="middle">${hourLabel(t)}</text>`;
  }
  for (let i = 0; i <= 4; i++) {
    const gy = (pad.t + (i / 4) * (H - pad.t - pad.b)).toFixed(1);
    out += `<line class="grid${i === 4 ? ' major' : ''}" x1="0" x2="${W}" y1="${gy}" y2="${gy}"/>`;
  }

  // Top/bottom value labels
  const dp = s.dp();
  out += `<text class="value-label" x="${pad.l + 4}" y="${pad.t - 5}">${fmt(hi, dp)} ${s.unit()}</text>`;
  out += `<text class="value-label" x="${pad.l + 4}" y="${H - pad.b - 6}">${fmt(lo, dp)}</text>`;

  // --- Ink: break the line where the station skipped reports (>20 min gap) ---
  const path = (key) =>
    pts
      .filter((p) => p[key] != null)
      .map((p, i, arr) => {
        const gap = i > 0 && p.t - arr[i - 1].t > 20 * 60e3;
        return `${i === 0 || gap ? 'M' : 'L'}${x(p.t).toFixed(1)} ${y(p[key]).toFixed(1)}`;
      })
      .join('');

  if (s.get2) out += `<path class="ink soft" d="${path('v2')}"/>`;
  out += `<path class="ink" id="mainInk" d="${path('v')}"/>`;

  const last = pts.at(-1);
  out += `<circle class="pen" cx="${x(last.t).toFixed(1)}" cy="${y(last.v).toFixed(1)}" r="4"/>`;

  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.innerHTML = out;
  $('chartNote').textContent = s.note(pts);

  // --- One-time pen-drawing animation on first load ---
  if (!state.drawn) {
    state.drawn = true;
    const ink = $('mainInk');
    const len = ink.getTotalLength();
    ink.style.strokeDasharray = len;
    ink.style.strokeDashoffset = len;
    ink.classList.add('drawing');
    ink.addEventListener('animationend', () => {
      ink.style.strokeDasharray = '';
      ink.style.strokeDashoffset = '';
      ink.classList.remove('drawing');
    }, { once: true });
  }
}

// --- Readings grid ------------------------------------------------------------

function renderReadings(c) {
  const u = U();
  const val = (v, unit, dp = 0) => (v == null ? null : `${fmt(v, dp)}<small>${unit}</small>`);

  const groups = [
    {
      title: 'Rain',
      cls: 'rain',
      rows: [
        ['Last hour', val(conv.rain(c.hourlyrainin), u.rain, u.rainDp)],
        ['Today', val(conv.rain(c.dailyrainin), u.rain, u.rainDp)],
        ['This week', val(conv.rain(c.weeklyrainin), u.rain, u.rainDp)],
        ['This month', val(conv.rain(c.monthlyrainin), u.rain, u.rainDp)],
        ['This year', val(conv.rain(c.yearlyrainin), u.rain, u.rainDp)],
      ],
    },
    {
      title: 'Air',
      rows: [
        ['Humidity', val(c.humidity, '%')],
        ['Dew point', val(conv.temp(c.dewPoint), '°')],
        ['Pressure', val(conv.press(c.baromrelin), u.press, u.pressDp)],
      ],
    },
    {
      title: 'Sun',
      rows: [
        ['UV index', c.uv == null ? null : fmt(c.uv)],
        ['Solar radiation', val(c.solarradiation, 'W/m²')],
      ],
    },
    {
      title: 'Indoors',
      rows: [
        ['Temperature', val(conv.temp(c.tempinf), u.temp)],
        ['Humidity', val(c.humidityin, '%')],
      ],
    },
  ];

  $('readings').innerHTML = groups
    .map((g) => {
      const rows = g.rows.filter(([, v]) => v != null); // hide sensors the station doesn't have
      if (!rows.length) return '';
      return `<div class="${g.cls ?? ''}"><h3>${g.title}</h3><dl>${rows
        .map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`)
        .join('')}</dl></div>`;
    })
    .join('');
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

$('units').addEventListener('click', () => {
  state.metric = !state.metric;
  savePref();
  render();
});

document.querySelectorAll('.tabs button').forEach((btn) => {
  btn.addEventListener('click', () => {
    state.series = btn.dataset.series;
    document.querySelectorAll('.tabs button').forEach((b) => b.setAttribute('aria-pressed', String(b === btn)));
    renderChart();
  });
});

// Redraw the chart at the new size when the window changes.
new ResizeObserver(() => state.data && renderChart()).observe($('paper'));

// Refresh every minute, and right away when the tab comes back into view.
setInterval(load, REFRESH_MS);
setInterval(renderUpdated, 20_000);
document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && load());

load();
