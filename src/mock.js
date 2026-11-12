// ---------------------------------------------------------------------------
// Made-up data in the same shapes the real endpoints return.
// Used when AW_MOCK=1 so you can preview or restyle without API keys.
// ---------------------------------------------------------------------------

const STEP = 5 * 60 * 1000;

export function mockWeather() {
  const now = Date.now();
  const history = [];
  for (let i = 287; i >= 0; i--) {
    const t = Math.floor((now - i * STEP) / STEP) * STEP;
    const h = (288 - i) / 12; // hours into the window
    const temp = 45 - 1.9 * Math.cos(((h - 10) / 24) * 2 * Math.PI) + 0.2 * Math.sin(i / 3);
    const rain = h > 3 ? Math.max(0, 0.06 + 0.26 * Math.sin(((h - 3) / 21) * Math.PI * 0.9) + 0.06 * Math.sin(i / 2)) : 0;
    const wind = Math.max(0, 3 + 8 * Math.exp(-Math.pow((h - 10) / 3, 2)) + Math.abs(Math.sin(i / 4)));
    history.push({
      dateutc: t,
      tempf: +temp.toFixed(1),
      baromrelin: +(29.1 - 0.17 * (h / 24) + 0.01 * Math.sin(i / 20)).toFixed(2),
      windspeedmph: +wind.toFixed(1),
      windgustmph: +(wind * 1.6 + 1).toFixed(1),
      winddir: Math.round((140 + 40 * Math.sin(i / 30) + 360) % 360),
      hourlyrainin: +rain.toFixed(2),
      dailyrainin: 0,
      humidity: Math.round(Math.min(99, 85 + h / 2)),
      solarradiation: h > 9 && h < 18 ? +(60 * Math.sin(((h - 9) / 9) * Math.PI)).toFixed(1) : 0,
      uv: 0,
    });
  }
  const last = history.at(-1);
  return {
    name: 'moops weather',
    location: 'Ketchikan, AK',
    coords: { lat: 55.342, lon: -131.646 },
    current: {
      dateutc: last.dateutc,
      tz: 'America/Sitka',
      tempf: 46.4, feelsLike: 46.4, dewPoint: 46.1, humidity: 99,
      windspeedmph: 0, windgustmph: 0, maxdailygust: 11.4, winddir: 315,
      baromrelin: 28.93, baromabsin: 28.81,
      hourlyrainin: 0.38, dailyrainin: 1.64, eventrainin: 13.03, weeklyrainin: 4.12, monthlyrainin: 11.02, yearlyrainin: 141.6,
      lastRain: new Date(now - 4 * 60 * 1000).toISOString(),
      uv: 0, solarradiation: 0,
      tempinf: 64.4, humidityin: 67, feelsLikein: 64.4, dewPointin: 53.2,
      battout: 1,
    },
    history,
    fetchedAt: now,
  };
}

export function mockTides() {
  // Semi-diurnal: highs/lows every ~6h12m, starting a little before yesterday.
  const now = Date.now();
  const half = 6.21 * 3600e3;
  const t0 = now - 30 * 3600e3;
  const events = [];
  for (let k = 0; k < 16; k++) {
    const high = k % 2 === 0;
    events.push({
      t: t0 + k * half,
      ft: high ? +(15 + 1.6 * Math.sin(k / 3)).toFixed(1) : +(1.2 + 1.4 * Math.cos(k / 3)).toFixed(1),
      type: high ? 'High' : 'Low',
    });
  }
  return { station: '9450460', events, observed: null };
}

export function mockForecast() {
  const days = [
    ['Today', 53, 47, 'Rain', 98], ['Thu', 50, 42, 'Rain', 90], ['Fri', 49, 42, 'Rain Likely', 70],
    ['Sat', 48, 43, 'Rain', 80], ['Sun', 50, 45, 'Chance Rain Showers', 50], ['Mon', 49, 42, 'Rain Showers Likely', 60],
  ];
  return { source: 'National Weather Service', days: days.map(([name, hi, lo, sky, pop]) => ({ name, hi, lo, sky, pop })) };
}

export function mockRainMonth() {
  const d = new Date();
  const vals = [1.21, 0.84, 0.12, 1.65, 2.02, 0.97, 0, 0.66, 1.48, 1.64, 0.31, 0.2, 0.9, 1.1, 0.4];
  const days = {};
  for (let i = 1; i < Math.min(d.getDate(), 16); i++) days[i] = vals[i - 1];
  return { year: d.getFullYear(), month: d.getMonth() + 1, today: d.getDate(), tz: 'America/Sitka', days, pending: false };
}

export function mockAlerts() {
  const h = 3600e3, now = Date.now();
  return {
    marineZones: ['PKZ036', 'PKZ641'],
    alerts: [
      { id: 'a1', event: 'Storm Warning', severity: 'Severe', marine: true, area: 'Clarence Strait',
        headline: 'Storm Warning issued by NWS Juneau AK', onset: new Date(now + 9 * h).toISOString(), ends: new Date(now + 21 * h).toISOString(),
        description: '* WHAT...Southeast winds 50 kt with gusts to 60 kt. Seas 12 ft.\n\n* WHERE...Clarence Strait.', instruction: 'Mariners should remain in port.' },
      { id: 'a2', event: 'Wind Advisory', severity: 'Moderate', marine: false, area: 'Southern Inner Channels',
        headline: 'Wind Advisory issued by NWS Juneau AK', onset: new Date(now - 3 * h).toISOString(), ends: new Date(now + 1.5 * h).toISOString(),
        description: '* WHAT...Southeast winds 25 to 35 mph with gusts up to 55 mph.\n\n* WHERE...Ketchikan.', instruction: 'Secure outdoor objects.' },
      { id: 'a3', event: 'Small Craft Advisory', severity: 'Minor', marine: true, area: 'Clarence Strait',
        headline: 'Small Craft Advisory issued by NWS Juneau AK', onset: new Date(now - 5 * h).toISOString(), ends: new Date(now + 1.5 * h).toISOString(),
        description: 'Southeast wind 25 kt. Seas 6 ft.', instruction: null },
    ],
  };
}
