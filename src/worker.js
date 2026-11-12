// ---------------------------------------------------------------------------
// Worker entry point. Every request to weather.basi.onl lands here first
// (run_worker_first in wrangler.jsonc), in this order:
//
//   1. Password gate   (src/auth.js)    - skipped when SITE_PASSWORD isn't set
//   2. /api/weather    (src/weather.js) - Ambient Weather proxy
//      /api/tides, /api/forecast, /api/rain-month (src/extras.js)
//      /api/alerts (src/alerts.js)
//   3. Everything else -> static files in /public
// ---------------------------------------------------------------------------

import { gate } from './auth.js';
import { handleWeather } from './weather.js';
import { handleTides, handleForecast, handleRainMonth } from './extras.js';
import { handleAlerts } from './alerts.js';
import { mockAlerts } from './mock.js';

export default {
  async fetch(request, env, ctx) {
    const blocked = await gate(request, env);
    if (blocked) return blocked;

    const { pathname } = new URL(request.url);
    if (request.method === 'GET') {
      if (pathname === '/api/weather') return handleWeather(request, env, ctx);
      if (pathname === '/api/tides') return handleTides(request, env, ctx);
      if (pathname === '/api/forecast') return handleForecast(request, env, ctx);
      if (pathname === '/api/rain-month') return handleRainMonth(request, env, ctx);
      if (pathname === '/api/alerts') {
        if (env.AW_MOCK === '1') return Response.json(mockAlerts());
        return handleAlerts(request, env, ctx);
      }
    }

    return env.ASSETS.fetch(request);
  },
};
