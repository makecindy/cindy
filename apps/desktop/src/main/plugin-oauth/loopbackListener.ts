import http from 'node:http';
import {
  parsePluginOauthCallback,
  type PluginOauthOffer,
  type PluginOauthCallback,
} from '@cindy/device-link';
import { ghostNetworkHostMatches } from '../../shared/ghost.js';
import {
  getGhostOAuthResultCopy,
  getRemoteOAuthCallbackCopy,
  OAUTH_RESULT_HTML_LANG,
  pickOAuthResultPageLang,
  renderOAuthResultPage,
} from '../oauthResultPage.js';
const fail = () => new Error('OAUTH_BRIDGE_UNAVAILABLE');

/** Fixed listener, no arbitrary URL fetch/port tunnelling or port-owner termination. */
export async function listenForOauthCallback(
  offer: PluginOauthOffer,
  deliver: (value: PluginOauthCallback) => Promise<void>,
  assertCurrent: () => void,
  expectedState: string = offer.state,
): Promise<{ close(): Promise<void> }> {
  const endpoint = new URL(offer.callbackUrl);
  let consumed = false;
  let closed = false;
  let ready = false;
  const servers: http.Server[] = [];
  // localhost can resolve to either family. Both listeners share one transaction;
  // literal addresses continue to bind only the requested loopback interface.
  const hosts =
    endpoint.hostname === 'localhost'
      ? ['127.0.0.1', '::1']
      : [endpoint.hostname === '[::1]' ? '::1' : '127.0.0.1'];
  const handle: http.RequestListener = (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const reply = (status: number) => {
      if (res.destroyed || res.writableEnded) return;
      res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
      // No provider text, URL or code in the browser result.
      const lang = pickOAuthResultPageLang(req.headers['accept-language']);
      const copy = getRemoteOAuthCallbackCopy(lang);
      const errors = getGhostOAuthResultCopy(lang);
      res.end(
        renderOAuthResultPage({
          htmlLang: OAUTH_RESULT_HTML_LANG[lang],
          variant: status === 200 ? 'warning' : 'error',
          title: status === 200 ? copy.title : errors.errorTitle,
          body:
            status === 200
              ? copy.body
              : errors.errors['invalid-callback'].replace('{brand}', 'Cindy'),
          pageKind: 'ghost-oauth',
        }),
      );
    };
    try {
      assertCurrent();
      if (
        !ready ||
        closed ||
        req.headers.host !== endpoint.host ||
        !req.url?.startsWith('/') ||
        req.url.startsWith('//') ||
        req.url.length > 12_288
      ) {
        reply(400);
        return;
      }
      const url = new URL(req.url, endpoint.origin);
      if (url.pathname !== endpoint.pathname) {
        reply(404);
        return;
      }
      const origin = req.headers.origin;
      if (typeof origin === 'string') {
        const parsed = new URL(origin);
        if (
          parsed.origin !== origin ||
          parsed.protocol !== 'https:' ||
          (!offer.corsOrigins.includes(origin) &&
            !offer.corsHosts.some((h) => ghostNetworkHostMatches(h, parsed.hostname)))
        ) {
          reply(403);
          return;
        }
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Vary', 'Origin');
        res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
        res.setHeader('Access-Control-Allow-Private-Network', 'true');
      }
      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }
      if (req.method !== 'GET') {
        reply(405);
        return;
      }
      if (consumed) {
        reply(409);
        return;
      }
      if (
        url.searchParams.getAll('state').length !== 1 ||
        url.searchParams.get('state') !== expectedState ||
        url.searchParams.getAll('code').length + url.searchParams.getAll('error').length !== 1
      ) {
        reply(400);
        return;
      }
      const callback = parsePluginOauthCallback({
        state: offer.state,
        ...(url.searchParams.has('error')
          ? { error: url.searchParams.get('error') }
          : { code: url.searchParams.get('code') }),
      });
      if (!callback) {
        reply(400);
        return;
      }
      consumed = true;
      void deliver(callback).then(
        () => reply(200),
        () => reply(502),
      );
    } catch {
      reply(410);
    }
  };
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    if (closing) return closing;
    closed = true;
    // Stop accepting callbacks immediately, but let callers wait until both
    // families have released their sockets before reusing the callback port.
    closing = Promise.all(servers.map((server) => new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    }))).then(() => {});
    return closing;
  };
  try {
    for (const host of hosts) {
      if (closed) throw fail();
      const server = http.createServer(
        { maxHeaderSize: 16_384, requestTimeout: 10_000, headersTimeout: 10_000 },
        handle,
      );
      server.maxConnections = 8;
      servers.push(server);
      try {
        await new Promise<void>((resolve, reject) => {
          server.once('error', reject);
          server.listen({ port: Number(endpoint.port), host, ipv6Only: host === '::1' }, () => {
            server.removeListener('error', reject);
            server.on('error', close);
            resolve();
          });
        });
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        // An OS may disable a family. An occupied/forbidden port is not that case:
        // fail the entire setup so another process cannot intercept localhost.
        if (
          endpoint.hostname !== 'localhost' ||
          (code !== 'EAFNOSUPPORT' && code !== 'EADDRNOTAVAIL')
        )
          throw error;
      }
    }
    if (closed || !servers.some((server) => server.listening)) throw fail();
    assertCurrent();
    ready = true;
    return { close };
  } catch {
    await close();
    throw fail();
  }
}
