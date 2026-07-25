import http from 'node:http';

/**
 * Receives the RFC 8252 loopback callback on the Linux host. A user-facing
 * SSH -L tunnel maps their Mac browser's localhost callback to this listener;
 * it never binds a LAN or public interface.
 */
export async function waitForSsoCallback(
  buildUrl: (redirectUri: string) => string,
  expectedState: string,
  onReady?: (input: { redirectUri: string; authorizationUrl: string }) => void,
): Promise<{ code: string } | { error: string }> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (result: { code: string } | { error: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      server.close(() => resolve(result));
    };
    const server = http.createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      if (url.pathname !== '/auth/callback' || url.searchParams.get('state') !== expectedState) {
        response.writeHead(400).end('Invalid Cindy login callback.');
        return;
      }
      const code = url.searchParams.get('code');
      const error = url.searchParams.get('error');
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end('<!doctype html><title>Cindy</title><p>Login complete. Return to your terminal.</p>');
      finish(code ? { code } : { error: error ?? 'MISSING_AUTHORIZATION_CODE' });
    });
    const timeout = setTimeout(() => finish({ error: 'TIMEOUT' }), 5 * 60_000);
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') return finish({ error: 'CALLBACK_LISTENER_FAILED' });
      const redirectUri = `http://127.0.0.1:${address.port}/auth/callback`;
      const authorizationUrl = buildUrl(redirectUri);
      onReady?.({ redirectUri, authorizationUrl });
      process.stdout.write([
        'Open a second terminal on your Mac and keep this SSH tunnel running:',
        `  ssh -N -L ${address.port}:127.0.0.1:${address.port} <your-server-ssh-host>`,
        '',
        'Then open this URL in your Mac browser:',
        `  ${authorizationUrl}`,
        '',
        'Waiting up to five minutes for the secure SSO callback...',
      ].join('\n') + '\n');
    });
  });
}
