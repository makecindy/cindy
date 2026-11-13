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
try {
  const data = value('--data'); if (!data) throw new Error('DATA_DIRECTORY_REQUIRED');
  const bootstrapFile = value('--bootstrap');
  const bootstrap = bootstrapFile ? JSON.parse(await readFile(bootstrapFile, 'utf8')) as Bootstrap : undefined;
  const cert = value('--tls-cert'); const key = value('--tls-key');
  if (!!cert !== !!key) throw new Error('TLS_CERT_AND_KEY_REQUIRED_TOGETHER');
  const legacyUpstream = value('--legacy-upstream'), tlsMaterialFile = value('--tls-material');
  if (!!legacyUpstream !== !!tlsMaterialFile) throw new Error('GATEWAY_TLS_MATERIAL_REQUIRED');
  const readMaterial = async () => {
    const parsed = JSON.parse(await readFile(tlsMaterialFile!, 'utf8')) as { cert?: unknown; key?: unknown };
    if (typeof parsed.cert !== 'string' || typeof parsed.key !== 'string') throw new Error('INVALID_TLS_MATERIAL');
    return { cert: parsed.cert, key: parsed.key };
  };
  let material = tlsMaterialFile ? await readMaterial() : null;
  const authIssuer = value('--auth-issuer');
  const authRegion = value('--auth-region') ?? 'global', peerRegion = value('--auth-peer-region');
  if (!['cn', 'global'].includes(authRegion) || peerRegion && !['cn', 'global'].includes(peerRegion)) throw new Error('INVALID_SHARING_AUTH_REGION');
  if (!authIssuer && ['--auth-jwks-url', '--auth-region', '--auth-peer-issuer', '--auth-peer-region', '--auth-peer-jwks-url'].some(flag => value(flag)))
    throw new Error('SHARING_AUTH_ISSUER_REQUIRED');
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
  logger.error({ name: error instanceof Error ? error.name : 'Unknown' }, 'agent-net relay failed to start');
  process.exitCode = 1;
}
