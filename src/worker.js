// ---------------------------------------------------------------------------
// Worker entry point. Every request to weather.basi.onl lands here first
// (run_worker_first in wrangler.jsonc), in this order:
//
//   1. Password gate   (src/auth.js)    - skipped when SITE_PASSWORD isn't set
//   2. /api/weather    (src/weather.js) - Ambient Weather proxy
//   3. Everything else -> static files in /public
// ---------------------------------------------------------------------------

import { gate } from './auth.js';
import { handleWeather } from './weather.js';

export default {
  async fetch(request, env, ctx) {
    const blocked = await gate(request, env);
    if (blocked) return blocked;

    const { pathname } = new URL(request.url);
    if (pathname === '/api/weather' && request.method === 'GET') {
      return handleWeather(request, env, ctx);
    }

    return env.ASSETS.fetch(request);
  },
};
