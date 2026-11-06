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
function serveWebApp(request, response, deps, urlPath) {
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
    response.setHeader('set-cookie', `cindy_host_web=${deps.webSession}; HttpOnly; SameSite=Lax; Path=/`);
  }
  response.writeHead(200, {
    'content-type': MIME[path.extname(file)] ?? 'application/octet-stream',
    'cache-control': 'no-store',
  });
  if (request?.method === 'HEAD') {
    response.end();
    return;
  }
  response.end(body);
}

export function createHostServer(deps) {
  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');

      // Resolve the bundle per request: a desktop build can remove and rebuild it
      // while the host keeps running, and a restart should not be required.
      const webRoot = typeof deps.webDir === 'function' ? deps.webDir() : deps.webDir;
      if (webRoot && (request.method === 'GET' || request.method === 'HEAD')
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
        serveWebApp(request, response, { ...deps, webDir: webRoot }, url.pathname);
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
        // Settings the browser client renders: read from, and written to, the
        // Desktop's own files so both clients show one copy of the account.
        if (url.pathname === '/api/profile') { send(response, 200, await deps.profile()); return; }
        if (url.pathname === '/api/settings/appearance/set') {
          send(response, 200, await deps.settings.setAppearance(body.patch ?? body));
          return;
        }
        if (url.pathname === '/api/settings/appearance/reset') {
          send(response, 200, await deps.settings.resetAppearance());
          return;
        }
        if (url.pathname === '/api/settings/layout/set') {
          send(response, 200, await deps.settings.setLayout(body.layout ?? body));
          return;
        }
        if (url.pathname === '/api/settings/layout/reset') {
          send(response, 200, await deps.settings.resetLayout());
          return;
        }
        if (url.pathname === '/api/settings/sidebar/set') {
          send(response, 200, await deps.settings.setSidebar(body.value ?? body));
          return;
        }
        if (url.pathname === '/api/settings/shortcuts/set') {
          send(response, 200, await deps.settings.setShortcuts(body.overrides ?? body ?? {}));
          return;
        }
        if (url.pathname === '/api/me') { send(response, 200, await deps.me()); return; }
        if (url.pathname === '/api/auth/state') {
          send(response, 200, await (deps.getAuthState ? deps.getAuthState() : deps.me()));
          return;
        }
        if (url.pathname === '/api/auth/refresh') {
          send(response, 200, await (deps.refreshAuth ? deps.refreshAuth() : { ok: true }));
          return;
        }
        // The preload contract for `localDb.sessions.list()` is a bare array.
        if (url.pathname === '/api/sessions/list') { send(response, 200, await deps.listSessions(body)); return; }
        if (url.pathname === '/api/project-aliases/list') { send(response, 200, await deps.listProjectAliases()); return; }
        if (url.pathname === '/api/project-aliases/set') {
          send(response, 200, await deps.setProjectAlias(body));
          return;
        }
        if (url.pathname === '/api/project-aliases/delete') {
          send(response, 200, await deps.deleteProjectAlias(body));
          return;
        }
        if (url.pathname === '/api/recent-workdirs/list') { send(response, 200, await deps.listRecentWorkdirs()); return; }
        if (url.pathname === '/api/sessions/create') { send(response, 201, await deps.createSession(body)); return; }
        if (url.pathname === '/api/sessions/update') { send(response, 200, await deps.updateSession(String(body.sessionId ?? ''), body.patch ?? {})); return; }
        if (url.pathname === '/api/sessions/get') { send(response, 200, await deps.getSession(String(body.sessionId ?? ''))); return; }
        if (url.pathname === '/api/sessions/discard') { send(response, 200, await deps.discardProvisionalSession(String(body.sessionId ?? ''))); return; }
        if (url.pathname === '/api/sessions/interrupted-pending') { send(response, 200, await deps.interruptedPending()); return; }
        if (url.pathname === '/api/sessions/error-tail-pending') { send(response, 200, await deps.errorTailPending()); return; }
        if (url.pathname === '/api/sessions/interrupted-candidates') { send(response, 200, await deps.interruptedCandidates()); return; }
        if (url.pathname === '/api/sessions/commit') { send(response, 200, await deps.commitProvisionalSession(String(body.sessionId ?? ''))); return; }
        if (url.pathname === '/api/sessions/messages') {
          send(response, 200, { messages: await deps.history(String(body.sessionId ?? ''), Number(body.limit ?? 200)) });
          return;
        }
        if (url.pathname === '/api/messages/estimated-value') {
          send(response, 200, await deps.estimatedSessionValue(String(body.sessionId ?? '')));
          return;
        }
        if (url.pathname === '/api/messages/history-view') {
          send(response, 200, await deps.historyView(String(body.sessionId ?? ''), body.before ?? null));
          return;
        }
        if (url.pathname === '/api/messages/create') {
          send(response, 201, await deps.createMessage(String(body.sessionId ?? ''), body.message ?? {}));
          return;
        }
        // The preload contract for `localDb.messages.list()` is a bare array.
        if (url.pathname === '/api/messages/list') {
          send(response, 200, await deps.history(String(body.sessionId ?? ''), Number(body.limit ?? 200)));
          return;
        }
        if (url.pathname === '/api/turn-change-sets/list') { send(response, 200, await deps.turnChangeSets(String(body.sessionId ?? ''))); return; }
        if (url.pathname === '/api/ghosts') { send(response, 200, await deps.ghosts()); return; }
        if (url.pathname === '/api/plugins/list') { send(response, 200, deps.listPlugins()); return; }
        if (url.pathname === '/api/providers') { send(response, 200, await deps.providers()); return; }
        if (url.pathname === '/api/model-visibility/claim') { send(response, 200, deps.modelVisibilityClaim()); return; }
        if (url.pathname === '/api/model-access') { send(response, 200, deps.modelAccess()); return; }
        if (url.pathname === '/api/usage/model-pricing') { send(response, 200, await deps.modelPricing()); return; }
        if (url.pathname === '/api/usage/reference-model-pricing') { send(response, 200, deps.referenceModelPricing()); return; }
        if (url.pathname === '/api/agents') { send(response, 200, deps.agents()); return; }
        if (url.pathname === '/api/interactions/pending') { send(response, 200, deps.interactions.pending(String(body.sessionId ?? ''))); return; }
        if (url.pathname === '/api/interactions/respond') {
          const accepted = deps.interactions.respond(
            String(body.sessionId ?? ''), String(body.requestId ?? ''), body.decision,
          );
          send(response, accepted ? 200 : 404, { ok: accepted });
          return;
        }
        if (url.pathname === '/api/input/projection') { send(response, 200, deps.input.projection(String(body.sessionId ?? ''))); return; }
        if (url.pathname === '/api/input/enqueue') {
          send(response, 200, await deps.input.enqueue(String(body.sessionId ?? ''), body.item ?? {}));
          return;
        }
        if (url.pathname === '/api/input/stop') { send(response, 200, await deps.input.stop(String(body.sessionId ?? ''))); return; }
        if (url.pathname === '/api/input/steer') {
          send(response, 200, { ok: await deps.input.steer(String(body.sessionId ?? ''), body.item ?? {}) });
          return;
        }
        if (url.pathname === '/api/input/remove') {
          send(response, 200, await deps.input.remove(String(body.sessionId ?? ''), String(body.clientId ?? '')));
          return;
        }
        if (url.pathname === '/api/input/resume') { send(response, 200, await deps.input.resume(String(body.sessionId ?? ''))); return; }
        if (url.pathname === '/api/agent-commands') { send(response, 200, await deps.agentCommands(body)); return; }
        if (url.pathname === '/api/agent-skills') { send(response, 200, await deps.agentSkills(body)); return; }
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

      if (request.method === 'GET' && url.pathname === '/events') {
        if (!isWebAuthorized(request, deps)) {
          send(response, 401, { error: 'unauthorized' });
          return;
        }
        response.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-store',
          connection: 'keep-alive',
        });
        response.write(': connected\n\n');

        const sinceHeader = request.headers['last-event-id'];
        const sinceQuery = url.searchParams.get('since') ?? url.searchParams.get('lastEventId') ?? url.searchParams.get('after');
        const sinceVal = sinceHeader ?? sinceQuery;
        if (sinceVal !== null && sinceVal !== undefined && sinceVal !== '') {
          const sinceSeq = parseInt(sinceVal, 10);
          if (!Number.isNaN(sinceSeq) && typeof deps.events.getEventsSince === 'function') {
            const missed = deps.events.getEventsSince(sinceSeq);
            for (const item of missed) {
              const idLine = item.seq != null ? `id: ${item.seq}\n` : '';
              response.write(`${idLine}data: ${JSON.stringify(item)}\n\n`);
            }
          }
        }

        const unsubscribe = deps.events.subscribe((event) => {
          if (response.writableEnded) return;
          const idLine = event.seq != null ? `id: ${event.seq}\n` : '';
          response.write(`${idLine}data: ${JSON.stringify(event)}\n\n`);
        });
        const keepAlive = setInterval(() => {
          if (response.writableEnded) return;
          response.write(': ping\n\n');
        }, 15_000);
        request.on('close', () => {
          clearInterval(keepAlive);
          unsubscribe();
        });
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
