import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import {
  getGhostOAuthResultCopy, OAUTH_RESULT_HTML_LANG, pickOAuthResultPageLang, renderOAuthResultPage,
} from '../../oauthResultPage';

interface ConnectDeps {
  start(input: { state: string; codeChallenge: string; redirectUri: string }): Promise<{ url: string }>;
  complete(input: { state: string; code: string; verifier: string }): Promise<{ url: string }>;
  isCurrent(): boolean;
  onConnected(): void;
}

/** Browser authorization must return to the initiating Desktop. No server polling
 * can retrieve its code, and the private verifier never leaves this process until redemption.
 */
export async function beginGithubConnect(deps: ConnectDeps): Promise<{ url: string; close(): void }> {
  const state = randomBytes(32).toString('base64url');
  const verifier = randomBytes(32).toString('base64url');
  let host = '';
  let consumed = false;
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const server = createServer({ maxHeaderSize: 8192, requestTimeout: 10_000, headersTimeout: 10_000 }, (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const fail = (status: number) => {
      const lang = pickOAuthResultPageLang(req.headers['accept-language']);
      const copy = getGhostOAuthResultCopy(lang);
      res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(renderOAuthResultPage({ htmlLang: OAUTH_RESULT_HTML_LANG[lang], variant: 'error',
        title: copy.errorTitle, body: copy.errors['invalid-callback'].replace('{brand}', 'Cindy'), pageKind: 'ghost-oauth' }));
    };
    if (closed || !deps.isCurrent()) { fail(410); return; }
    if (req.method !== 'GET' || req.headers.host !== host || req.headers.origin
      || !req.url?.startsWith('/') || req.url.startsWith('//') || req.url.length > 2048) { fail(400); return; }
    const url = new URL(req.url, `http://${host}`);
    const code = url.searchParams.get('code');
    if (url.pathname !== '/github/callback' || url.searchParams.getAll('state').length !== 1
      || url.searchParams.get('state') !== state || url.searchParams.getAll('code').length !== 1
      || !code || code.length > 512 || consumed) { fail(400); return; }
    consumed = true;
    void deps.complete({ state, code, verifier }).then(result => {
      if (closed || !deps.isCurrent()) { fail(410); return; }
      const install = new URL(result.url);
      if (install.origin !== 'https://github.com' || install.username || install.password
        || !/^\/apps\/[a-z0-9-]+\/installations\/new$/.test(install.pathname)) throw new Error('GITHUB_INVALID_INSTALL_URL');
      deps.onConnected();
      res.writeHead(303, { Location: install.toString() });
      res.end();
    }).catch(() => { if (!res.writableEnded) fail(400); })
      .finally(() => { if (timer) clearTimeout(timer); server.close(); });
  });
  server.maxConnections = 8;
  const close = () => {
    closed = true;
    if (timer) clearTimeout(timer);
    server.close();
    server.closeAllConnections();
  };
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
    });
    server.on('error', close);
    const address = server.address();
    if (!address || typeof address === 'string' || !deps.isCurrent()) throw new Error('GITHUB_CONNECT_CANCELLED');
    host = `127.0.0.1:${address.port}`;
    timer = setTimeout(close, 10 * 60_000);
    timer.unref?.();
    const result = await deps.start({ state, codeChallenge: createHash('sha256').update(verifier).digest('base64url'),
      redirectUri: `http://${host}/github/callback` });
    if (closed || !deps.isCurrent()) throw new Error('GITHUB_CONNECT_CANCELLED');
    const authorize = new URL(result.url);
    if (authorize.origin !== 'https://github.com' || authorize.username || authorize.password
      || authorize.pathname !== '/login/oauth/authorize' || authorize.searchParams.getAll('state').length !== 1
      || authorize.searchParams.get('state') !== state || authorize.searchParams.get('code_challenge_method') !== 'S256') {
      throw new Error('GITHUB_CLIENT_BINDING_UNSUPPORTED');
    }
    return { url: result.url, close };
  } catch (error) {
    close();
    throw error;
  }
}
