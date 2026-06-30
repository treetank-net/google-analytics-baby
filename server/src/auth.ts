import http from 'http';
import { randomBytes } from 'crypto';
import { exec } from 'child_process';
import { saveConfig } from './config.js';
import type { GaConfig } from './config.js';
import { GA_SCOPES } from './constants.js';

function openBrowser(url: string) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  exec(`${cmd} "${url}"`);
}

interface OAuthState {
  server: http.Server | null;
  port: number;
  stateParam: string;
  authUrl: string;
  resolved: boolean;
  cfg: GaConfig;
}

let oauthState: OAuthState | null = null;

async function exchangeCodeForTokens(
  code: string, clientId: string, clientSecret: string, redirectUri: string,
): Promise<string> {
  const body = new URLSearchParams({
    code, client_id: clientId, client_secret: clientSecret,
    redirect_uri: redirectUri, grant_type: 'authorization_code',
  });
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!res.ok) throw new Error(`Token exchange failed: ${await res.text()}`);
  const data = await res.json() as { refresh_token?: string };
  if (!data.refresh_token) {
    throw new Error('No refresh_token. Revoke access at https://myaccount.google.com/permissions and try again.');
  }
  return data.refresh_token;
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c: Buffer) => data += c.toString());
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

const DONE_PAGE = `<!DOCTYPE html><html><head><meta charset="utf-8">
<style>
  * { box-sizing: border-box; }
  body { font-family: system-ui; display:flex; justify-content:center; align-items:center;
         min-height:100vh; margin:0; background:#f0f4f8; }
  .card { background:white; padding:2.5rem; border-radius:12px; box-shadow:0 2px 8px rgba(0,0,0,.1);
          max-width:480px; width:100%; text-align:center; }
  h1 { color:#16a34a; margin:0 0 .5rem; font-size:2rem; }
  p { color:#444; line-height:1.5; }
</style></head><body><div class="card">
  <h1>Done!</h1>
  <p>Authorization complete and refresh token saved.<br>Close this tab and return to the chat.</p>
</div></body></html>`;

function buildAuthUrl(clientId: string, stateParam: string, port: number): string {
  const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  authUrl.searchParams.set('client_id', clientId);
  authUrl.searchParams.set('redirect_uri', `http://localhost:${port}/callback`);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', GA_SCOPES.join(' '));
  authUrl.searchParams.set('access_type', 'offline');
  authUrl.searchParams.set('prompt', 'consent');
  authUrl.searchParams.set('state', stateParam);
  return authUrl.toString();
}

const OPEN_PAGE = `<!DOCTYPE html><html><head><meta charset="utf-8">
<style>
  * { box-sizing: border-box; }
  body { font-family: system-ui; display:flex; justify-content:center; align-items:center;
         min-height:100vh; margin:0; background:#f0f4f8; }
  .card { background:white; padding:2.5rem; border-radius:12px; box-shadow:0 2px 8px rgba(0,0,0,.1);
          max-width:520px; width:100%; }
  h1 { color:#16a34a; margin:0 0 .5rem; font-size:1.5rem; }
  p { color:#444; line-height:1.5; }
  .custom-fields { display:none; margin:1rem 0; }
  .custom-fields.show { display:block; }
  label { display:block; font-weight:600; margin-bottom:.25rem; margin-top:.75rem; }
  .hint { font-size:.85rem; color:#666; margin-bottom:.5rem; }
  input { width:100%; padding:.6rem; border:1px solid #ddd; border-radius:6px; font-size:1rem; }
  .buttons { margin-top:1.5rem; display:flex; gap:.75rem; flex-wrap:wrap; }
  button { border:none; padding:.7rem 1.5rem; border-radius:6px; font-size:1rem; cursor:pointer; }
  .btn-primary { background:#2563eb; color:white; }
  .btn-primary:hover { background:#1d4ed8; }
  button:disabled { opacity:.5; cursor:wait; }
  .error { color:#dc2626; font-size:.9rem; margin-top:.5rem; }
  .toggle { color:#2563eb; cursor:pointer; font-size:.9rem; margin-top:.75rem; display:inline-block; }
  .toggle:hover { text-decoration:underline; }
</style></head><body><div class="card">
  <h1>Google Analytics — Authorize</h1>
  <p>Click below to sign in with Google and grant read-only access to your Analytics properties.</p>
  <span class="toggle" id="toggle-custom">I want to use my own OAuth app credentials</span>
  <div class="custom-fields" id="custom-fields">
    <label>Client ID</label>
    <div class="hint">From <a href="https://console.cloud.google.com/apis/credentials" target="_blank">Google Cloud Console → Credentials</a></div>
    <input id="custom-id" placeholder="123456789-abc.apps.googleusercontent.com">
    <label>Client Secret</label>
    <input id="custom-secret" placeholder="GOCSPX-..." type="password">
  </div>
  <div class="buttons">
    <button class="btn-primary" id="btn-go">Sign in with Google</button>
  </div>
  <div id="open-error" class="error"></div>
</div>
<script>
const toggle = document.getElementById('toggle-custom');
const fields = document.getElementById('custom-fields');
let showCustom = false;
toggle.onclick = () => {
  showCustom = !showCustom;
  fields.classList.toggle('show', showCustom);
  toggle.textContent = showCustom
    ? 'Use default app credentials'
    : 'I want to use my own OAuth app credentials';
};

document.getElementById('btn-go').onclick = async () => {
  const btn = document.getElementById('btn-go');
  const errEl = document.getElementById('open-error');
  errEl.textContent = '';
  const clientId = document.getElementById('custom-id').value.trim();
  const clientSecret = document.getElementById('custom-secret').value.trim();
  if (showCustom && (!clientId || !clientSecret)) {
    errEl.textContent = 'Both Client ID and Client Secret are required, or collapse the section to use the default app.';
    return;
  }
  btn.disabled = true;
  try {
    const res = await fetch('/start-oauth', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify(showCustom ? { client_id: clientId, client_secret: clientSecret } : {})
    });
    const data = await res.json();
    if (data.error) { errEl.textContent = data.error; btn.disabled = false; return; }
    window.location.href = data.url;
  } catch (e) { errEl.textContent = 'Connection error: ' + e.message; btn.disabled = false; }
};
</script></body></html>`;

export function startAuthFlow(cfg: GaConfig): { url: string; shortUrl: string; port: number } {
  if (oauthState?.server) oauthState.server.close();

  const stateParam = randomBytes(16).toString('hex');
  const port = 9877;
  const redirectUri = `http://localhost:${port}/callback`;

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://localhost:${port}`);
    const json = (status: number, data: object) => {
      res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify(data));
    };
    const html = (status: number, body: string) => {
      res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(body);
    };

    if (url.pathname === '/callback') {
      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');
      const error = url.searchParams.get('error');
      if (error) { html(200, `<h1>Authorization error</h1><p>${error}</p>`); return; }
      if (state !== stateParam || !code) { html(400, '<h1>Invalid request</h1>'); return; }
      try {
        const refreshToken = await exchangeCodeForTokens(code, cfg.clientId, cfg.clientSecret, redirectUri);
        await saveConfig({ refreshToken });
        cfg.refreshToken = refreshToken;
        oauthState!.resolved = true;
        html(200, DONE_PAGE);
        cleanup();
      } catch (err: any) {
        html(500, `<h1>Error</h1><p>${err.message}</p>`);
      }
      return;
    }

    if (url.pathname === '/open') {
      if (!oauthState) { html(404, '<h1>Authorization flow not active</h1>'); return; }
      html(200, OPEN_PAGE);
      return;
    }

    if (url.pathname === '/start-oauth' && req.method === 'POST') {
      if (!oauthState) { json(404, { error: 'Authorization flow not active' }); return; }
      try {
        const body = JSON.parse(await readBody(req));
        const customId = (body.client_id || '').trim();
        const customSecret = (body.client_secret || '').trim();
        if (customId && customSecret) {
          cfg.clientId = customId;
          cfg.clientSecret = customSecret;
          await saveConfig({ clientId: customId, clientSecret: customSecret });
        }
        if (!cfg.clientId || !cfg.clientSecret) {
          json(400, { error: 'Client ID and Client Secret are required. Expand the custom credentials section and paste your OAuth desktop app credentials.' });
          return;
        }
        const authUrl = buildAuthUrl(cfg.clientId, oauthState.stateParam, oauthState.port);
        oauthState.authUrl = authUrl;
        json(200, { url: authUrl });
      } catch (err: any) {
        json(500, { error: err.message || String(err) });
      }
      return;
    }

    res.writeHead(404); res.end('Not found');
  });

  server.listen(port, '127.0.0.1');

  const url = buildAuthUrl(cfg.clientId, stateParam, port);
  oauthState = { server, port, stateParam, authUrl: url, resolved: false, cfg };

  openBrowser(`http://127.0.0.1:${port}/open`);

  return { url, shortUrl: `http://127.0.0.1:${port}/open`, port };
}

export function checkAuthStatus(): { done: boolean } {
  return { done: oauthState?.resolved ?? false };
}

function cleanup() {
  if (oauthState?.server) {
    setTimeout(() => { oauthState?.server?.close(); oauthState!.server = null; }, 2000);
  }
}
