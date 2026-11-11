// ---------------------------------------------------------------------------
// Made-up station data in the same shape /api/weather returns.
// Used when AW_MOCK=1, so you can preview or restyle the dashboard without
// API keys (or without hitting Ambient's rate limits while you iterate).
// ---------------------------------------------------------------------------

export function mockWeather() {
  const now = Date.now();
  const step = 5 * 60 * 1000;
  const history = [];
  let rain = 0;

  for (let i = 287; i >= 0; i--) {
    const t = Math.floor((now - i * step) / step) * step;
    const hour = new Date(t).getUTCHours() - 9; // roughly Alaska local time
    const day = Math.sin(((hour - 9) / 24) * Math.PI * 2); // warmest mid-afternoon
    const wobble = Math.sin(i / 7) * 0.6 + Math.sin(i / 19) * 0.9;
    const wind = Math.max(0, 7 + Math.sin(i / 23) * 5 + Math.sin(i / 5) * 1.5);
    if (i < 60 && i % 3 === 0) rain += 0.01;

    history.push({
      dateutc: t,
      tempf: +(44 + day * 6 + wobble).toFixed(1),
      baromrelin: +(29.92 - (288 - i) * 0.0009 + Math.sin(i / 40) * 0.02).toFixed(2),
      windspeedmph: +wind.toFixed(1),
      windgustmph: +(wind + 3 + Math.abs(Math.sin(i / 3)) * 6).toFixed(1),
      dailyrainin: +rain.toFixed(2),
      humidity: Math.round(78 - day * 10),
    });
  }

  const last = history.at(-1);
  return {
    name: 'Backyard station',
    location: 'Preview data',
    current: {
      dateutc: last.dateutc,
      tz: 'America/Sitka',
      tempf: last.tempf,
      feelsLike: +(last.tempf - 4.2).toFixed(1),
      dewPoint: 39.4,
      humidity: last.humidity,
      windspeedmph: last.windspeedmph,
      windgustmph: last.windgustmph,
      maxdailygust: 21.3,
      winddir: 214,
      winddir_avg10m: 220,
      baromrelin: last.baromrelin,
      hourlyrainin: 0.03,
      dailyrainin: last.dailyrainin,
      weeklyrainin: 1.42,
      monthlyrainin: 3.87,
      yearlyrainin: 61.2,
      lastRain: new Date(now - 6 * 60 * 1000).toISOString(),
      uv: 1,
      solarradiation: 84.2,
      tempinf: 69.8,
      humidityin: 41,
    },
    history,
    fetchedAt: now,
  };
}
