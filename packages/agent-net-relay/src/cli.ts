import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { startAgentNetRelay, type Bootstrap, type RelayLogger } from './server.js';
import { startRelayGateway } from './gateway.js';
import { createAgentNetSharingAuth } from './sharingAuth.js';
import { createNotificationBridge, readNotificationBridgeConfig } from './notificationBridge.js';
const args = process.argv.slice(2);
if (args[0] === 'serve') args.shift();
function value(flag: string): string | undefined {
  const index = args.indexOf(flag); return index < 0 ? undefined : args[index + 1];
}
function port(flag: string): number | undefined {
  const input = value(flag); if (input === undefined) return undefined;
  const result = Number(input); if (!/^\d+$/.test(input) || !Number.isInteger(result) || result < 0 || result > 65535) throw new Error('INVALID_PORT');
  return result;
}
const logger: RelayLogger = Object.fromEntries(['info', 'warn', 'error'].map((level) => [level, (fields: Record<string, unknown>, message: string) => {
  process.stdout.write(JSON.stringify({ level, msg: message, ...fields }) + '\n');
}])) as unknown as RelayLogger;
// Diagnostics are allowlisted: arbitrary filesystem/TLS messages may contain paths or secrets.
const safeCodes = new Set(['ENOENT', 'EACCES', 'EPERM', 'EADDRINUSE', 'EADDRNOTAVAIL', 'EINVAL',
  'ERR_OSSL_PEM_NO_START_LINE', 'ERR_OSSL_X509_KEY_VALUES_MISMATCH', 'ERR_OSSL_UNSUPPORTED']);
const safeReasons = new Set(['DATA_DIRECTORY_REQUIRED', 'TLS_CERT_AND_KEY_REQUIRED_TOGETHER',
  'GATEWAY_TLS_MATERIAL_REQUIRED', 'INVALID_TLS_MATERIAL', 'INVALID_PORT',
  'INVALID_SHARING_AUTH_REGION', 'SHARING_AUTH_ISSUER_REQUIRED', 'INVALID_BOOTSTRAP',
  'BOOTSTRAP_IDENTITY_MISMATCH', 'SELF_HOSTED_BOOTSTRAP_REQUIRED', 'INVALID_STUN_HOST']);
let stage = 'arguments';
try {
  const data = value('--data'); if (!data) throw new Error('DATA_DIRECTORY_REQUIRED');
  const bootstrapFile = value('--bootstrap');
  stage = 'bootstrap';
  const bootstrap = bootstrapFile ? JSON.parse(await readFile(bootstrapFile, 'utf8')) as Bootstrap : undefined;
  stage = 'arguments';
  const cert = value('--tls-cert'); const key = value('--tls-key');
  if (!!cert !== !!key) throw new Error('TLS_CERT_AND_KEY_REQUIRED_TOGETHER');
  const legacyUpstream = value('--legacy-upstream'), tlsMaterialFile = value('--tls-material');
  if (!!legacyUpstream !== !!tlsMaterialFile) throw new Error('GATEWAY_TLS_MATERIAL_REQUIRED');
  const readMaterial = async () => {
    const parsed = JSON.parse(await readFile(tlsMaterialFile!, 'utf8')) as { cert?: unknown; key?: unknown };
    if (typeof parsed.cert !== 'string' || typeof parsed.key !== 'string') throw new Error('INVALID_TLS_MATERIAL');
    return { cert: parsed.cert, key: parsed.key };
  };
  stage = 'tls-material';
  let material = tlsMaterialFile ? await readMaterial() : null;
  stage = 'arguments';
  const authIssuer = value('--auth-issuer');
  const authRegion = value('--auth-region') ?? 'global', peerRegion = value('--auth-peer-region');
  if (!['cn', 'global'].includes(authRegion) || peerRegion && !['cn', 'global'].includes(peerRegion)) throw new Error('INVALID_SHARING_AUTH_REGION');
  if (!authIssuer && ['--auth-jwks-url', '--auth-region', '--auth-peer-issuer', '--auth-peer-region', '--auth-peer-jwks-url'].some(flag => value(flag)))
    throw new Error('SHARING_AUTH_ISSUER_REQUIRED');
  stage = 'relay';
  const relay = await startAgentNetRelay({
    notify: await createNotificationBridge(readNotificationBridgeConfig()),
    dataDir: path.resolve(data), bootstrap, mode: 'self-hosted', host: value('--host') ?? '127.0.0.1',
    port: port('--port') ?? 0, udpHost: value('--udp-host'), udpPort: port('--udp-port'), stunHost: value('--stun-host'), publicUrl: value('--public-url'),
    ...(cert && key ? { tls: { cert: await readFile(cert), key: await readFile(key) } } : {}), logger,
    ...(authIssuer ? { sharing: createAgentNetSharingAuth({ issuer: authIssuer,
      jwksUrl: value('--auth-jwks-url'), region: authRegion as 'cn' | 'global',
      ...(value('--auth-peer-issuer') ? { peers: [{ issuer: value('--auth-peer-issuer')!, region: peerRegion as 'cn' | 'global', jwksUrl: value('--auth-peer-jwks-url') }] } : {}) }) } : {}),
  });
  let gateway: Awaited<ReturnType<typeof startRelayGateway>> | null = null;
  try {
    stage = 'gateway';
    if (legacyUpstream && material) gateway = await startRelayGateway({ host: value('--gateway-host') ?? '0.0.0.0', port: port('--gateway-port') ?? 443,
      legacyUrl: legacyUpstream, agentNetUrl: relay.url, tls: material });
  } catch (error) { await relay.close(); throw error; }
  let reloading = false;
  const timer = gateway && tlsMaterialFile ? setInterval(() => {
    if (reloading) return; reloading = true;
    void readMaterial().then((next) => {
      if (next.cert !== material?.cert || next.key !== material?.key) { gateway!.updateTls(next); material = next; }
    }).catch(() => logger.warn({}, 'gateway certificate reload failed')).finally(() => { reloading = false; });
  }, 30_000) : null;
  timer?.unref();
  logger.info({ port: new URL(relay.url).port, udpPort: relay.udpAddress?.port }, 'agent-net relay ready');
  let stopping = false;
  const stop = () => { if (stopping) return; stopping = true; if (timer) clearInterval(timer);
    void (async () => { await gateway?.close(); await relay.close(); })().then(() => process.exit(0), () => process.exit(1)); };
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
} catch (error) {
  const rawCode = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  const code = typeof rawCode === 'string' && safeCodes.has(rawCode) ? rawCode
    : error instanceof Error && safeReasons.has(error.message) ? error.message
    : error instanceof SyntaxError ? 'INVALID_JSON' : 'STARTUP_FAILED';
  logger.error({ stage, code }, 'agent-net relay failed to start');
  process.exitCode = 1;
}
