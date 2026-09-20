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
): Promise<{ close(): void }> {
  const endpoint = new URL(offer.callbackUrl);
  let consumed = false;
  let closed = false;
  const server = http.createServer(
    { maxHeaderSize: 16_384, requestTimeout: 10_000, headersTimeout: 10_000 },
    (req, res) => {
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
    },
  );
  server.maxConnections = 8;
  const close = () => {
    closed = true;
    server.close();
    server.closeAllConnections();
  };
  server.on('error', close);
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(
        Number(endpoint.port),
        endpoint.hostname === '[::1]' ? '::1' : '127.0.0.1',
        () => {
          server.removeListener('error', reject);
          resolve();
        },
      );
    });
    assertCurrent();
    return { close };
  } catch {
    close();
    throw fail();
  }
}
