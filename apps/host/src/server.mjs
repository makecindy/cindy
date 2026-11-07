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
import { createWebAuth, isLoopbackRequest, CONNECT_PAGE, CONNECT_SCRIPT } from './web-auth.mjs';

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
  return deps.webAuth.accepts(request.headers.cookie);
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
    const boot = JSON.stringify(typeof deps.bootValues === 'function' ? deps.bootValues() : (deps.bootValues ?? {})).replace(/</g, '\\u003c');
    const html = body.toString('utf8')
      .replace(/<head([^>]*)>/, `<head$1><script>window.__cindyBoot=${boot};</script><script src="/shim.js"></script>`);
    body = Buffer.from(html, 'utf8');
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

export function createHostServer(input) {
  const deps = { ...input, webAuth: input.webAuth ?? createWebAuth() };
  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      response.setHeader('referrer-policy', 'no-referrer');
      response.setHeader('x-content-type-options', 'nosniff');
      response.setHeader('x-frame-options', 'DENY');
      if (!isLoopbackRequest(request)) { send(response, 403, { error: 'origin_not_allowed' }); return; }
      if (request.method === 'POST' && url.pathname === '/web/pair') {
        if (!isAuthorized(request.headers.authorization, deps.token)) { send(response, 401, { error: 'unauthorized' }); return; }
        send(response, 200, { code: deps.webAuth.pair() });
        return;
      }
      if (request.method === 'POST' && url.pathname === '/web/session') {
        const body = await readJson(request);
        const session = deps.webAuth.exchange(body.code);
        if (!session) { send(response, 401, { error: 'pairing_expired' }); return; }
        send(response, 200, { connected: true }, { 'set-cookie': `cindy_host_web=${session}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200` });
        return;
      }
      if ((request.method === 'GET' || request.method === 'HEAD') && (url.pathname === '/connect' || url.pathname === '/connect.js'
        || (url.pathname === '/' && !isWebAuthorized(request, deps)))) {
        const script = url.pathname === '/connect.js';
        response.writeHead(200, { 'content-type': script ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        response.end(request.method === 'HEAD' ? undefined : script ? CONNECT_SCRIPT : CONNECT_PAGE);
        return;
      }

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
        const body = await readJson(request);
        if (url.pathname === '/api/runtime/sessions') {
          send(response, 200, deps.listRunningSessions(body.options));
          return;
        }
        if (url.pathname === '/api/auth/logout') {
          const result = await deps.logout();
          deps.webAuth.clear();
          send(response, 200, result, { 'set-cookie': 'cindy_host_web=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' });
          return;
        }
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
        if (url.pathname === '/api/sessions/switch-agent') {
          send(response, 200, await deps.switchSessionAgent(
            String(body.sessionId ?? ''),
            String(body.targetAgentKind ?? ''),
            String(body.model ?? ''),
            body.providerId ?? null,
            body.effort,
            body.fastMode,
          ));
          return;
        }
        if (url.pathname === '/api/sessions/agent-switch-intent') {
          send(response, 200, deps.getSessionAgentSwitchIntent(String(body.sessionId ?? '')));
          return;
        }
        if (url.pathname === '/api/sessions/auto-title') {
          send(response, 200, await deps.autoTitle(body));
          return;
        }
        if (url.pathname === '/api/sessions/delete') { send(response, 200, await deps.deleteSession(String(body.sessionId ?? ''))); return; }
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
        if (url.pathname === '/api/messages/work-details') {
          send(response, 200, await deps.workDetails(String(body.sessionId ?? ''), body.ref, body.after ?? null));
          return;
        }
        if (url.pathname === '/api/messages/create') {
          send(response, 201, await deps.createMessage(String(body.sessionId ?? ''), body.message ?? {}));
          return;
        }
        // The preload contract for `localDb.messages.list()` is a bare array.
        if (url.pathname === '/api/messages/list') {
          send(response, 200, await (deps.messagesList ? deps.messagesList(String(body.sessionId ?? ''), Number(body.limit ?? 200), body.before ?? null) : deps.history(String(body.sessionId ?? ''), Number(body.limit ?? 200))));
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
            body.sessionId ? String(body.sessionId) : null, String(body.requestId ?? ''), body.decision,
          );
          send(response, accepted ? 200 : 404, { ok: accepted, accepted });
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
        if (url.pathname === '/api/input/update-content') {
          send(response, 200, await deps.input.updateContent(String(body.sessionId ?? ''), String(body.clientId ?? ''), body.item ?? {}));
          return;
        }
        if (url.pathname === '/api/input/update-text') {
          send(response, 200, await deps.input.updateText(String(body.sessionId ?? ''), String(body.clientId ?? ''), body.newText));
          return;
        }
        if (url.pathname === '/api/input/move') {
          send(response, 200, await deps.input.move(String(body.sessionId ?? ''), String(body.clientId ?? ''), Number(body.targetIndex ?? 0)));
          return;
        }
        if (url.pathname === '/api/input/set-expanded') {
          send(response, 200, await deps.input.setExpanded(String(body.sessionId ?? ''), Boolean(body.expanded)));
          return;
        }
        if (url.pathname === '/api/input/set-interaction-lock') {
          send(response, 200, await deps.input.setInteractionLock(String(body.sessionId ?? ''), String(body.lockId ?? ''), Boolean(body.locked)));
          return;
        }
        if (url.pathname === '/api/input/set-edit-lock') {
          send(response, 200, await deps.input.setEditLock(String(body.sessionId ?? ''), String(body.clientId ?? ''), Boolean(body.locked)));
          return;
        }
        if (url.pathname === '/api/input/clear-session') {
          send(response, 200, await deps.input.clearSession(String(body.sessionId ?? '')));
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
        request.socket?.setNoDelay(true);
        response.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-store, no-transform',
          'x-accel-buffering': 'no',
          connection: 'keep-alive',
        });
        response.write(': connected\n\n');
        response.flush?.();

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
            response.flush?.();
          }
        }

        const unsubscribe = deps.events.subscribe((event) => {
          if (response.writableEnded) return;
          if (!isWebAuthorized(request, deps)) { response.end(); return; }
          const idLine = event.seq != null ? `id: ${event.seq}\n` : '';
          response.write(`${idLine}data: ${JSON.stringify(event)}\n\n`);
          response.flush?.();
        });
        const keepAlive = setInterval(() => {
          if (response.writableEnded) return;
          if (!isWebAuthorized(request, deps)) { response.end(); return; }
          response.write(': ping\n\n');
        }, 15_000);
        const revoke = deps.webAuth.onRevoke(() => response.end());
        request.on('close', () => {
          revoke();
          clearInterval(keepAlive);
          unsubscribe();
        });
        return;
      }

      if (request.method === 'GET' && url.pathname === '/health') {
        send(response, 200, isWebAuthorized(request, deps) ? await deps.probe() : { status: 'ok', service: 'cindy-host' });
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
          const result = await deps.logout();
          deps.webAuth.clear();
          send(response, 200, result);
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

/** Bound request memory before parsing; aborted requests must not hang forever. */
async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1024 * 1024) throw new Error('request too large');
    chunks.push(chunk);
  }
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  return body && typeof body === 'object' && !Array.isArray(body) ? body : {};
}
