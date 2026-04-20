// Discord OAuth 2.0 PKCE flow for a desktop/public client.
//
// The launcher is a public OAuth client: it holds no client_secret. PKCE
// prevents a local attacker who sniffs the code from exchanging it, because
// the exchange also requires the code_verifier that never leaves this
// process. The Discord application must register the loopback redirect
// `http://localhost:<port>/cb` (default port 53682).

const http = require('http');
const crypto = require('crypto');
const { shell } = require('electron');

const DEFAULT_PORT = 53682;
const SCOPES = ['identify', 'email'];

function base64UrlEncode(buf) {
  return buf
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function randomVerifier() {
  // 32 random bytes → 43-char base64url. Inside the 43-128 range PKCE allows.
  return base64UrlEncode(crypto.randomBytes(32));
}

function challengeFor(verifier) {
  return base64UrlEncode(crypto.createHash('sha256').update(verifier).digest());
}

// Spins up a one-shot loopback HTTP listener that resolves with the OAuth
// code when Discord redirects back. The listener closes itself as soon as it
// has handled either /cb or a request that clearly isn't ours.
function waitForCode({ port, expectedState, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      if (!req.url || !req.url.startsWith('/cb')) {
        res.writeHead(404).end();
        return;
      }
      const url = new URL(req.url, `http://127.0.0.1:${port}`);
      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');
      const error = url.searchParams.get('error');

      // Always answer the browser so the user isn't left staring at a spinner.
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(renderReturnPage(error ? 'error' : 'ok'));

      cleanup();

      if (error) return reject(new Error(`discord_oauth_${error}`));
      if (!code) return reject(new Error('missing_code'));
      if (state !== expectedState) return reject(new Error('state_mismatch'));
      resolve(code);
    });

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('oauth_timeout'));
    }, timeoutMs);

    function cleanup() {
      clearTimeout(timer);
      try { server.close(); } catch { /* noop */ }
    }

    server.on('error', (e) => {
      cleanup();
      reject(e);
    });
    server.listen(port, '127.0.0.1');
  });
}

function renderReturnPage(kind) {
  const title = kind === 'ok' ? 'Signed in' : 'Sign-in failed';
  const body = kind === 'ok'
    ? 'You can close this tab and return to the launcher.'
    : 'Something went wrong. Return to the launcher and try again.';
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
    <style>
      body{background:#0d0f13;color:#e5e9f0;font-family:Inter,system-ui,sans-serif;
           display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
      main{text-align:center;max-width:420px;padding:32px}
      h1{font-weight:600;margin:0 0 12px;letter-spacing:-0.01em}
      p{color:#9aa3b2;margin:0}
    </style></head><body><main><h1>${title}</h1><p>${body}</p></main></body></html>`;
}

async function exchangeDiscordCode({ clientId, code, verifier, redirectUri }) {
  const form = new URLSearchParams({
    client_id: clientId,
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    code_verifier: verifier,
  });
  const res = await fetch('https://discord.com/api/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`discord_token_exchange_failed:${res.status}:${text}`);
  }
  return res.json();
}

async function exchangeLauncherSession({ apiUrl, discordAccessToken }) {
  const res = await fetch(`${apiUrl.replace(/\/$/, '')}/api/launcher/exchange`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ discord_access_token: discordAccessToken }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(body.error || `backend_exchange_failed_${res.status}`);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

// Full login flow. Returns { sessionToken, expiresAt, user }.
async function login({ apiUrl, discordClientId, oauthPort = DEFAULT_PORT, timeoutMs = 180_000 }) {
  if (!apiUrl) throw new Error('missing_api_url');
  if (!discordClientId) throw new Error('missing_discord_client_id');

  const verifier = randomVerifier();
  const challenge = challengeFor(verifier);
  const state = base64UrlEncode(crypto.randomBytes(16));
  const redirectUri = `http://localhost:${oauthPort}/cb`;

  const authorize = new URL('https://discord.com/oauth2/authorize');
  authorize.searchParams.set('client_id', discordClientId);
  authorize.searchParams.set('redirect_uri', redirectUri);
  authorize.searchParams.set('response_type', 'code');
  authorize.searchParams.set('scope', SCOPES.join(' '));
  authorize.searchParams.set('state', state);
  authorize.searchParams.set('code_challenge', challenge);
  authorize.searchParams.set('code_challenge_method', 'S256');
  authorize.searchParams.set('prompt', 'none');

  const codePromise = waitForCode({ port: oauthPort, expectedState: state, timeoutMs });
  await shell.openExternal(authorize.toString());
  const code = await codePromise;

  const discordTokens = await exchangeDiscordCode({
    clientId: discordClientId,
    code,
    verifier,
    redirectUri,
  });

  const launcherSession = await exchangeLauncherSession({
    apiUrl,
    discordAccessToken: discordTokens.access_token,
  });

  const expiresAt = Date.now() + (launcherSession.expires_in ?? 300) * 1000;
  return {
    sessionToken: launcherSession.session_token,
    expiresAt,
    user: launcherSession.user,
    // Kept in memory so the launcher can re-exchange for a fresh 5-minute
    // session without sending the user through Discord again. Valid for
    // ~7 days per Discord's default access_token TTL.
    discordAccessToken: discordTokens.access_token,
  };
}

// Re-exchanges an in-memory discord_access_token for a fresh launcher
// session. Called on the refresh timer while the DLL is still injected.
async function refreshLauncherSession({ apiUrl, discordAccessToken }) {
  const body = await exchangeLauncherSession({ apiUrl, discordAccessToken });
  return {
    sessionToken: body.session_token,
    expiresAt: Date.now() + (body.expires_in ?? 300) * 1000,
    user: body.user,
  };
}

module.exports = { login, refreshLauncherSession, DEFAULT_PORT };
