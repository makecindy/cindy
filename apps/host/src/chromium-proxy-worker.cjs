/**
 * The Host's Chromium proxy helper (release table row 28, 28c), run by Electron. It answers one question —
 * which proxy Chromium would use for a URL under the system settings, PAC and auto-discovery included — so the
 * Host follows the same rules as the desktop's session.resolveProxy. The Host starts it on demand and owns its
 * lifetime (chromium-proxy.ts).
 *
 * Boundary: stdin and stdout only, one JSON object per line; no window, page, port or socket of its own. Its
 * userData is its own directory under the Host data directory; it takes no single-instance lock and opens no
 * desktop profile. It asks an in-memory session (no `persist:` partition: nothing on disk, no cookies), never
 * calls safeStorage and receives no credentials, tokens or request bodies: only URLs, answered with Chromium's
 * PAC result string. Chromium itself fetches PAC files and tries auto-discovery, as for the desktop.
 *
 * Readiness: it says `ready` only after the proxy configuration has been applied and one resolution under it
 * has completed (a PAC file fetched and initialised). Until then every question is answered `not_ready`, never
 * DIRECT: an answer given before the PAC script is ready could send a request direct that should use a proxy.
 *
 * Tests only: CINDY_PROXY_WORKER_TEST_CONFIG holds a session.setProxy configuration to use instead of the system
 * settings. The Host's launcher removes every CINDY_ variable from the environment it passes, so a production
 * start cannot carry it (guarded in hostDesktopSourceContracts.guard.test.ts).
 */
const { app, session } = require('electron');
const { createInterface } = require('node:readline');

const MAX_LINE = 8192;
const MAX_URL = 4096;
// Resolved once before saying ready, so that the configuration (and a PAC script) is loaded. `.invalid` never
// resolves in DNS, so a PAC script that looks the host up gets a quick answer and learns nothing.
const READINESS_PROBE = 'https://cindy-proxy-helper.invalid/';

const profile = process.env.CINDY_PROXY_WORKER_PROFILE;
if (!profile) throw new Error('PROXY_WORKER_PROFILE_REQUIRED');
app.setPath('userData', profile);
app.setName('Cindy Proxy');
app.dock?.hide();
app.disableHardwareAcceleration();

const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
let ses = null;

const lines = createInterface({ input: process.stdin });
lines.on('close', () => app.quit());
lines.on('line', (line) => {
  if (line.length > MAX_LINE) return;
  let request;
  try { request = JSON.parse(line); } catch { return; }
  if (!request || !Number.isSafeInteger(request.id)) return;
  if (request.method === 'ping') return send({ id: request.id, result: 'pong' });
  if (request.method !== 'resolve' || typeof request.url !== 'string' || request.url.length > MAX_URL) {
    return send({ id: request.id, error: 'invalid_request' });
  }
  if (!ses) return send({ id: request.id, error: 'not_ready' });
  ses.resolveProxy(request.url).then(
    (result) => send({ id: request.id, result: String(result) }),
    () => send({ id: request.id, error: 'resolve_failed' }),
  );
});

app.whenReady().then(async () => {
  const candidate = session.fromPartition('cindy-proxy-helper', { cache: false });
  const testConfig = process.env.CINDY_PROXY_WORKER_TEST_CONFIG;
  await candidate.setProxy(testConfig ? JSON.parse(testConfig) : { mode: 'system' });
  // setProxy resolves before the network service applies the configuration: a resolution right after it can
  // still see the previous configuration and answer DIRECT (seen 2 runs in 3). forceReloadProxyConfig is a round
  // trip queued after it, so once it resolves the configuration is in effect; the probe then waits for the PAC
  // script (or auto-discovery) to load.
  await candidate.forceReloadProxyConfig();
  await candidate.resolveProxy(READINESS_PROBE);
  ses = candidate;
  send({ ready: true, pid: process.pid });
}).catch(() => app.exit(1));

process.once('SIGTERM', () => app.quit());
