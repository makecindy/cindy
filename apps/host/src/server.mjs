import { createHostService } from './service.mjs';
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
import { clientErrorMessage } from './client-error.mjs';
import { createWebAuth, isLoopbackRequest, CONNECT_PAGE, CONNECT_SCRIPT } from './web-auth.mjs';
import { buildWebShim } from './web-client-build.mjs';

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
  const service = input.service ?? createHostService(deps);
  // One compilation per Host, shared by concurrent page loads. A failed build
  // may be retried after its source/dependency is repaired.
  let shimBuild;
  let stopping = false;
  let ownerPaused = false;
  let activeRequests = 0;
  const drainWaiters = new Set();
  const ownerRequests = new Set();
  let logoutFlight;
  let authDrain;
  const cancelPendingAuth = () => authDrain ??= Promise.resolve().then(() => deps.cancelPendingAuth?.());
  const unsubscribeSessions = deps.webAuth.onSessionRevoke?.(caller => deps.releaseAuthCaller?.(caller));
  const logout = () => {
    if (logoutFlight) return logoutFlight;
    // Revoke browser streams immediately and drain existing database callers
    // before the owner runtime closes. Concurrent sign-out clicks share a result.
    deps.webAuth.clear();
    logoutFlight = cancelPendingAuth().then(() => Promise.all([...ownerRequests])).then(() => deps.logout())
      .finally(() => { logoutFlight = undefined; });
    return logoutFlight;
  };
  const server = createServer(async (request, response) => {
    if (stopping) { send(response, 503, { error: 'host_stopping' }, { connection: 'close' }); return; }
    activeRequests++;
    let finishOwnerRequest;
    try {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      response.setHeader('referrer-policy', 'no-referrer');
      response.setHeader('x-content-type-options', 'nosniff');
      response.setHeader('x-frame-options', 'DENY');
      if (!isLoopbackRequest(request)) { send(response, 403, { error: 'origin_not_allowed' }); return; }
      const ownerRequest = (url.pathname.startsWith('/api/') && !url.pathname.startsWith('/api/auth/') && url.pathname !== '/api/me')
        || ['/control/remote', '/events', '/chat', '/sessions', '/plugins'].includes(url.pathname) || url.pathname.startsWith('/sessions/');
      if (ownerRequest) {
        if (ownerPaused || logoutFlight || deps.isOwnerReady?.() === false) {
          send(response, 409, { error: 'owner_runtime_unavailable' }); return;
        }
        const completion = new Promise(resolve => { finishOwnerRequest = resolve; });
        ownerRequests.add(completion);
        finishOwnerRequest = (() => { const complete = finishOwnerRequest;
          return () => { ownerRequests.delete(completion); complete(); }; })();
      }
      if (request.method === 'POST' && url.pathname === '/control/remote') {
        if (!isAuthorized(request.headers.authorization, deps.token)) { send(response, 401, { error: 'unauthorized' }); return; }
        const body = await readJson(request);
        if (body.instanceId !== deps.instanceId || !deps.instanceId) { send(response, 409, { error: 'host_instance_changed' }); return; }
        if (!deps.remoteControl || logoutFlight || deps.isOwnerReady?.() === false) { send(response, 409, { error: 'owner_runtime_unavailable' }); return; }
        send(response, 200, await deps.remoteControl(body.action, body));
        return;
      }
      if (request.method === 'POST' && url.pathname === '/control/stop') {
        if (!isAuthorized(request.headers.authorization, deps.token)) { send(response, 401, { error: 'unauthorized' }); return; }
        const body = await readJson(request);
        if (!deps.instanceId || body.instanceId !== deps.instanceId || typeof deps.requestStop !== 'function') {
          send(response, 409, { error: 'host_instance_changed' }); return;
        }
        response.once('finish', () => deps.requestStop());
        send(response, 202, { stopping: true });
        return;
      }
      if ((ownerPaused || logoutFlight) && ['/web/pair', '/web/session'].includes(url.pathname)) {
        send(response, 409, { error: 'owner_runtime_unavailable' }); return;
      }
      if (request.method === 'POST' && url.pathname === '/web/pair') {
        if (!isAuthorized(request.headers.authorization, deps.token)) { send(response, 401, { error: 'unauthorized' }); return; }
        send(response, 200, { code: deps.webAuth.pair() });
        return;
      }
      if (request.method === 'POST' && url.pathname === '/web/session') {
        const body = await readJson(request);
        // Logout can begin while a request body is arriving.
        if (ownerPaused || logoutFlight) { send(response, 409, { error: 'owner_runtime_unavailable' }); return; }
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
          shimBuild ??= (deps.shimPrebuilt
            ? fs.promises.readFile(deps.shimPath, 'utf8')
            : buildWebShim(deps.shimPath)).catch(error => { shimBuild = undefined; throw error; });
          const shim = await shimBuild;
          response.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' });
          response.end(request.method === 'HEAD' ? undefined : shim);
          return;
        }
        serveWebApp(request, response, { ...deps, webDir: webRoot }, url.pathname);
        return;
      }

      if (request.method === 'POST' && url.pathname.startsWith('/api/')) {
        if (!isWebAuthorized(request, deps)) {
          send(response, 401, { error: 'unauthorized' }); return;
        }
        const body = await readJson(request);
        if (url.pathname === '/api/auth/logout') {
          const result = await logout();
          send(response, 200, result, { 'set-cookie': 'cindy_host_web=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' });
          return;
        }
        const caller = deps.webAuth.caller?.(request.headers.cookie)
          ?? (isAuthorized(request.headers.authorization, deps.token) ? `local-api:${deps.instanceId}` : null);
        const result = await service(url.pathname, body, { caller });
        send(response, result.status, result.body);
        return;
      }

      if (request.method === 'GET' && url.pathname === '/events') {
        if (!isWebAuthorized(request, deps)) {
          send(response, 401, { error: 'unauthorized' });
          return;
        }
        request.socket?.setNoDelay(true);
        const versioned = url.searchParams.get('protocol') === '2';
        response.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-store, no-transform',
          'x-accel-buffering': 'no',
          connection: 'keep-alive',
          ...(versioned ? { 'x-cindy-event-protocol': '2' } : {}),
        });
        response.write(': connected\n\n');
        response.flush?.();

        const sinceHeader = request.headers['last-event-id'];
        const sinceQuery = url.searchParams.get('since') ?? url.searchParams.get('lastEventId') ?? url.searchParams.get('after');
        const sinceVal = sinceHeader ?? sinceQuery;
        if (versioned) {
          const replay = deps.events.replay({ since: sinceVal, runtime: url.searchParams.get('runtime') });
          const { events, ...cursor } = replay;
          response.write(`data: ${JSON.stringify({ type: 'host_stream', phase: 'start', ...cursor })}\n\n`);
          for (const item of events) response.write(`id: ${item.seq}\ndata: ${JSON.stringify(item)}\n\n`);
          response.write(`data: ${JSON.stringify({ type: 'host_stream', phase: 'ready', ...cursor })}\n\n`);
        } else if (sinceVal !== null && sinceVal !== undefined && sinceVal !== '') {
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
          const result = await logout();
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
      send(response, 500, { error: 'internal_error', message: clientErrorMessage(error) });
    } finally {
      finishOwnerRequest?.();
      activeRequests--;
      if (!activeRequests) {
        for (const resolve of drainWaiters) resolve();
        drainWaiters.clear();
      }
    }
  });
  // Stop accepting new work first. The caller closes SSE connections after the
  // queue and runtime have drained; they do not keep database requests in flight.
  const stopAccepting = () => {
    stopping = true;
    server.close();
    const drained = activeRequests ? new Promise(resolve => drainWaiters.add(resolve)) : Promise.resolve();
    return Promise.all([cancelPendingAuth(), drained]);
  };
  const pauseOwnerRequests = () => {
    ownerPaused = true;
    deps.webAuth.clear();
    return Promise.all([cancelPendingAuth(), Promise.allSettled([...ownerRequests])]);
  };
  server.once('close', () => unsubscribeSessions?.());
  return Object.assign(server, { stopAccepting, pauseOwnerRequests });
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
