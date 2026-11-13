import { createHash, randomBytes } from 'node:crypto';

/** Browser access is granted only after a local, bearer-authenticated pairing.
 * Codes are single-use; session cookies are unrelated to the profile API token.
 */
export function createWebAuth({ now = Date.now } = {}) {
  const codes = new Map();
  const sessions = new Map();
  const revocations = new Set();
  const sessionRevocations = new Set();
  const callerId = token => `web:${createHash('sha256').update(token).digest('hex')}`;
  function revokeSession(token) {
    if (!sessions.delete(token)) return;
    for (const listener of sessionRevocations) listener(callerId(token));
  }
  function prune() {
    for (const [key, expires] of codes) if (expires <= now()) codes.delete(key);
    for (const [key, expires] of sessions) if (expires <= now()) revokeSession(key);
  }
  return {
    pair() {
      prune();
      if (codes.size >= 32) throw new Error('too many pending browser connections');
      const code = randomBytes(32).toString('base64url');
      codes.set(code, now() + 60_000);
      return code;
    },
    exchange(code) {
      prune();
      if (typeof code !== 'string' || !codes.delete(code)) return null;
      const session = randomBytes(32).toString('base64url');
      sessions.set(session, now() + 12 * 60 * 60_000);
      return session;
    },
    accepts(cookie) {
      prune();
      const match = /(?:^|;\s*)cindy_host_web=([^;]+)/.exec(cookie ?? '');
      if (!match) return false;
      return sessions.has(match[1]);
    },
    caller(cookie) {
      prune();
      const match = /(?:^|;\s*)cindy_host_web=([^;]+)/.exec(cookie ?? '');
      return match && sessions.has(match[1]) ? callerId(match[1]) : null;
    },
    onRevoke(listener) { revocations.add(listener); return () => revocations.delete(listener); },
    onSessionRevoke(listener) { sessionRevocations.add(listener); return () => sessionRevocations.delete(listener); },
    clear() { codes.clear(); for (const token of sessions.keys()) revokeSession(token); for (const listener of revocations) listener(); },
  };
}

/** An untrusted Host header must never turn loopback into a DNS-rebinding API. */
export function isLoopbackRequest(request) {
  try {
    const host = new URL(`http://${request.headers.host}`);
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(host.hostname)) return false;
    if (request.headers.origin && request.headers.origin !== host.origin) return false;
    return true;
  } catch { return false; }
}

export const CONNECT_PAGE = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Cindy Host</title><meta name="color-scheme" content="light dark"></head><body><main><h1>Cindy Host</h1><p id="status">Open this page using pnpm host:open on the Host computer.</p><script src="/connect.js"></script></main></body></html>`;
export const CONNECT_SCRIPT = `(() => {
  const status = document.getElementById('status');
  const zh = navigator.language.startsWith('zh');
  const code = new URLSearchParams(location.hash.slice(1)).get('pair');
  history.replaceState(null, '', location.pathname);
  if (!code) { if (zh) status.textContent = '请在运行 Host 的电脑上执行 pnpm host:open，打开已授权的浏览器入口。'; return; }
  status.textContent = zh ? '正在连接…' : 'Connecting…';
  fetch('/web/session', {method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({code}), credentials:'same-origin'})
    .then(response => {
      if (!response.ok) throw new Error();
      if (typeof BroadcastChannel !== 'undefined') {
        const notice = new BroadcastChannel('cindy-host-pairing');
        notice.postMessage('paired'); notice.close();
      }
      location.replace('/');
    })
    .catch(() => { status.textContent = zh ? '连接链接已失效或服务不可用。请重新执行 pnpm host:open。' : 'The connection link expired or the service is unavailable. Run pnpm host:open again.'; });
})();`;
