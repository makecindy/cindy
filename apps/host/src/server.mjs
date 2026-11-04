/**
 * Loopback HTTP API for the host.
 *
 * Every response is JSON. The listener is bound to 127.0.0.1 by the caller; this
 * module never decides exposure. Read endpoints require the profile bearer token
 * so another local account cannot read task data through a stray request.
 */

import { createServer } from 'node:http';

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
export function createHostServer(deps) {
  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');

      if (request.method === 'GET' && url.pathname === '/health') {
        send(response, 200, await deps.probe());
        return;
      }

      if ((request.method === 'GET' && (url.pathname === '/sessions' || url.pathname === '/me'))
        || (request.method === 'POST' && url.pathname === '/logout')) {
        if (!isAuthorized(request.headers.authorization, deps.token)) {
          send(response, 401, { error: 'unauthorized' }, { 'www-authenticate': 'Bearer' });
          return;
        }
        if (url.pathname === '/me') {
          send(response, 200, await deps.me());
          return;
        }
        if (url.pathname === '/logout') {
          send(response, 200, await deps.logout());
          return;
        }
        const sessions = await deps.listSessions();
        send(response, 200, {
          sessions: sessions.map((session) => ({
            id: session.id,
            title: session.title,
            agentKind: session.agentKind,
            model: session.model,
            workDir: session.workDir,
            updatedAt: session.updatedAt,
          })),
        });
        return;
      }

      send(response, 404, { error: 'not_found' });
    } catch (error) {
      send(response, 500, { error: 'internal_error', message: error instanceof Error ? error.message : String(error) });
    }
  });
}
