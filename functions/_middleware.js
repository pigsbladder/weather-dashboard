// ---------------------------------------------------------------------------
// Password gate for the whole site.
//
// Every request passes through here first (Cloudflare Pages runs
// functions/_middleware.js ahead of static files and other functions).
//
//   POST /login   -> checks the shared password, sets a signed session cookie
//   GET  /logout  -> clears the cookie
//   anything else -> passes through if the cookie is valid, otherwise shows
//                    the login page (or a 401 JSON for /api/* calls)
//
// The cookie is "<expiry>.<signature>", where the signature is an HMAC of the
// expiry keyed with SITE_PASSWORD. Nobody can forge one without knowing the
// password, and changing SITE_PASSWORD signs everyone out automatically.
// ---------------------------------------------------------------------------

const COOKIE = 'wx_session';
const SESSION_DAYS = 30;

// Files the login page itself needs, so they load before sign-in.
const PUBLIC_PATHS = new Set(['/styles.css', '/favicon.svg']);

export async function onRequest(context) {
  const { request, env, next } = context;
  const url = new URL(request.url);

  if (!env.SITE_PASSWORD) {
    return new Response('SITE_PASSWORD is not set. Add it in Cloudflare Pages > Settings > Variables and Secrets.', {
      status: 500,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  }

  if (PUBLIC_PATHS.has(url.pathname)) return next();

  // --- Sign in -------------------------------------------------------------
  if (url.pathname === '/login' && request.method === 'POST') {
    const form = await request.formData();
    const attempt = String(form.get('password') ?? '');

    // Compare HMACs rather than raw strings so the comparison is constant-time
    // and length doesn't leak.
    const ok = safeEqual(await hmac(env.SITE_PASSWORD, attempt), await hmac(env.SITE_PASSWORD, env.SITE_PASSWORD));

    if (!ok) {
      await sleep(600); // slows down anyone guessing in a loop
      return loginPage({ error: true, status: 401 });
    }

    const expires = Date.now() + SESSION_DAYS * 864e5;
    const token = `${expires}.${await hmac(env.SITE_PASSWORD, `session:${expires}`)}`;
    return new Response(null, {
      status: 303,
      headers: {
        location: '/',
        'set-cookie': `${COOKIE}=${token}; Path=/; Max-Age=${SESSION_DAYS * 86400}; HttpOnly; Secure; SameSite=Lax`,
      },
    });
  }

  // --- Sign out ------------------------------------------------------------
  if (url.pathname === '/logout') {
    return new Response(null, {
      status: 303,
      headers: {
        location: '/',
        'set-cookie': `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`,
      },
    });
  }

  // --- Everything else needs a valid session --------------------------------
  if (await validSession(request, env.SITE_PASSWORD)) return next();

  if (url.pathname.startsWith('/api/')) {
    return Response.json({ error: 'Sign in to see the weather.' }, { status: 401 });
  }
  return loginPage({ status: 401 });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function validSession(request, secret) {
  const cookie = request.headers.get('cookie') ?? '';
  const match = cookie.match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
  if (!match) return false;

  const [expires, sig] = match[1].split('.');
  if (!expires || !sig || Number(expires) < Date.now()) return false;

  return safeEqual(sig, await hmac(secret, `session:${expires}`));
}

async function hmac(secret, message) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  // base64url so it's cookie-safe
  return btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The sign-in page. Inline so it can be served without exposing anything
// else in /public.
function loginPage({ error = false, status = 200 } = {}) {
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex">
  <title>Weather — sign in</title>
  <link rel="icon" href="/favicon.svg" type="image/svg+xml">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@62..125,300..800&display=swap">
  <link rel="stylesheet" href="/styles.css">
</head>
<body class="login">
  <main class="login-card">
    <svg class="login-trace" viewBox="0 0 320 60" aria-hidden="true">
      <path d="M0 38 C30 36 45 22 70 24 S110 44 140 40 S190 12 220 16 S270 40 320 30" />
    </svg>
    <h1>Weather station</h1>
    <p>Enter the password you were given to see current conditions.</p>
    <form method="post" action="/login">
      <label for="password">Password</label>
      <input id="password" name="password" type="password" autocomplete="current-password" required autofocus
        ${error ? 'aria-invalid="true" aria-describedby="login-error"' : ''}>
      ${error ? '<p class="login-error" id="login-error" role="alert">That password didn’t match. Check it and try again.</p>' : ''}
      <button type="submit">View the weather</button>
    </form>
  </main>
</body>
</html>`;
  return new Response(html, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  });
}
