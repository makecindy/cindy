/**
 * Loopback HTTP API for the host.
 *
 * Every response is JSON. The listener is bound to 127.0.0.1 by the caller; this
 * module never decides exposure. Read endpoints require the profile bearer token
 * so another local account cannot read task data through a stray request.
 */

import { createServer } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

import { isAuthorized } from './api-token.mjs';

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };

function send(response, status, body, extraHeaders = {}) {
  response.writeHead(status, { ...JSON_HEADERS, ...extraHeaders });
  response.end(JSON.stringify(body));
}

/**
 * @param {{
 *   token: string,
 *   probe: () => Promise<unknown> | unknown,
 * }} deps
 */
/** Cookie auth for the bundled web client; the bearer stays the CLI path. */
function isWebAuthorized(request, deps) {
  if (isAuthorized(request.headers.authorization, deps.token)) return true;
  const cookie = request.headers.cookie ?? '';
  const match = /(?:^|;\s*)cindy_host_web=([^;]+)/.exec(cookie);
  return Boolean(match && deps.webSession && match[1] === deps.webSession);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
  '.map': 'application/json; charset=utf-8',
};

/** Serve the prebuilt renderer and inject the host shim before the app entry. */
function serveWebApp(response, deps, urlPath) {
  const root = deps.webDir;
  const relative = urlPath === '/' ? '/index.html' : urlPath;
  const file = path.join(root, path.normalize(relative).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(root) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    response.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify({ error: 'not_found' }));
    return;
  }
  let body = fs.readFileSync(file);
  if (relative === '/index.html') {
    // The shim must run before the app module: it defines window.electronAPI.
    const boot = JSON.stringify(typeof deps.bootValues === 'function' ? deps.bootValues() : (deps.bootValues ?? {}));
    const html = body.toString('utf8')
      .replace(/<head([^>]*)>/, `<head$1><script>window.__cindyBoot=${boot};</script><script src="/shim.js"></script>`);
    body = Buffer.from(html, 'utf8');
    response.setHeader('set-cookie', `cindy_host_web=${deps.webSession}; HttpOnly; SameSite=Strict; Path=/`);
  }
  response.writeHead(200, {
    'content-type': MIME[path.extname(file)] ?? 'application/octet-stream',
    'cache-control': 'no-store',
  });
  response.end(body);
}

export function createHostServer(deps) {
  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');

      if (deps.webDir && request.method === 'GET'
        && (url.pathname === '/' || url.pathname === '/shim.js' || url.pathname.startsWith('/assets/'))) {
        if (url.pathname === '/shim.js') {
          if (!deps.shimPath || !fs.existsSync(deps.shimPath)) {
            send(response, 404, { error: 'shim_missing' });
            return;
          }
          response.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' });
          response.end(fs.readFileSync(deps.shimPath));
          return;
        }
        serveWebApp(response, deps, url.pathname);
        return;
      }

      if (request.method === 'POST' && url.pathname.startsWith('/api/')) {
        if (!isWebAuthorized(request, deps)) {
          send(response, 401, { error: 'unauthorized' });
          return;
        }
        const body = JSON.parse(await new Promise((resolve) => {
          let raw = '';
          request.on('data', (chunk) => { raw += chunk; });
          request.on('end', () => resolve(raw || '{}'));
        }));
        if (url.pathname === '/api/me') { send(response, 200, await deps.me()); return; }
        if (url.pathname === '/api/sessions/list') { send(response, 200, { sessions: await deps.listSessions() }); return; }
        if (url.pathname === '/api/sessions/create') { send(response, 201, await deps.createSession(body)); return; }
        if (url.pathname === '/api/sessions/get') { send(response, 200, await deps.getSession(String(body.sessionId ?? ''))); return; }
        if (url.pathname === '/api/sessions/discard') { send(response, 200, await deps.discardProvisionalSession(String(body.sessionId ?? ''))); return; }
        if (url.pathname === '/api/sessions/commit') { send(response, 200, await deps.commitProvisionalSession(String(body.sessionId ?? ''))); return; }
        if (url.pathname === '/api/sessions/messages') {
          send(response, 200, { messages: await deps.history(String(body.sessionId ?? ''), Number(body.limit ?? 200)) });
          return;
        }
        if (url.pathname === '/api/plugins/list') { send(response, 200, deps.listPlugins()); return; }
        if (url.pathname === '/api/providers') { send(response, 200, await deps.providers()); return; }
        if (url.pathname === '/api/model-access') { send(response, 200, deps.modelAccess()); return; }
        if (url.pathname === '/api/usage/model-pricing') { send(response, 200, await deps.modelPricing()); return; }
        if (url.pathname === '/api/usage/reference-model-pricing') { send(response, 200, deps.referenceModelPricing()); return; }
        if (url.pathname === '/api/agents') { send(response, 200, deps.agents()); return; }
        if (url.pathname === '/api/capabilities') {
          try {
            send(response, 200, await deps.capabilities(String(body.agentKind ?? '')));
          } catch (error) {
            const agentKind = String(body.agentKind ?? '');
            const message = error instanceof Error ? error.message : String(error);
            send(response, 404, { error: 'agent_not_registered', message: agentKind === 'pi' ? "Agent 'pi' is not registered" : message });
          }
          return;
        }
        send(response, 404, { error: 'not_found' });
        return;
      }

      if (request.method === 'GET' && url.pathname === '/health') {
        send(response, 200, await deps.probe());
        return;
      }

      if (request.method === 'POST' && url.pathname === '/chat') {
        if (!isWebAuthorized(request, deps)) {
          send(response, 401, { error: 'unauthorized' }, { 'www-authenticate': 'Bearer' });
          return;
        }
        await deps.chat(request, response);
        return;
      }

      if (request.method === 'GET' && url.pathname.startsWith('/sessions/') && url.pathname.endsWith('/messages')) {
        if (!isAuthorized(request.headers.authorization, deps.token)) {
          send(response, 401, { error: 'unauthorized' }, { 'www-authenticate': 'Bearer' });
          return;
        }
        const sessionId = decodeURIComponent(url.pathname.slice('/sessions/'.length, -'/messages'.length));
        const limit = Math.min(Number(url.searchParams.get('limit') ?? 200) || 200, 500);
        send(response, 200, { messages: await deps.history(sessionId, limit) });
        return;
      }

      if ((request.method === 'GET' && (url.pathname === '/sessions' || url.pathname === '/me' || url.pathname === '/plugins'))
        || (request.method === 'POST' && url.pathname === '/logout')) {
        if (!isAuthorized(request.headers.authorization, deps.token)) {
          send(response, 401, { error: 'unauthorized' }, { 'www-authenticate': 'Bearer' });
          return;
        }
        if (url.pathname === '/me') {
          send(response, 200, await deps.me());
          return;
        }
        if (url.pathname === '/plugins') {
          send(response, 200, deps.listPlugins());
          return;
        }
        if (url.pathname === '/logout') {
          send(response, 200, await deps.logout());
          return;
        }
        send(response, 200, { sessions: await deps.listSessions() });
        return;
      }

      send(response, 404, { error: 'not_found' });
    } catch (error) {
      if (response.headersSent) {
        response.end();
        return;
      }
      send(response, 500, { error: 'internal_error', message: error instanceof Error ? error.message : String(error) });
    }
  });
}
