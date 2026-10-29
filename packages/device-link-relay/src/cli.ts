/**
 * 独立运行入口(服务器部署与本机调试共用):
 *
 *   relay init  --data <目录> --name <中转名> --owner-user <账号ID> --owner-device <设备ID>
 *               --owner-device-name <设备名> --owner-credential-hash <SHA-256>
 *               --relay-id <UUID> --owner-public-key <公钥> --owner-cert <证书 JSON 的 base64url>
 *   relay serve --data <目录> [--host 127.0.0.1] [--port 47820]
 *               [--tls-cert <PEM> --tls-key <PEM>] [--public-url <https://...>] [--trust-proxy]
 *               [--acme-identifier <域名或IP> [--acme-http-port 80] [--acme-directory <URL>]]
 *
 * `--acme-identifier`:自动向 Let's Encrypt 申请并续期证书(http-01 验证走 `--acme-http-port`),
 * 拿到证书后才开始提供 HTTPS;申请失败按退避重试,状态写进数据目录的 status.json。
 *   relay --version
 *
 * stdout 每行一个 JSON 事件(initialized / listening / error),供部署器解析;
 * 日志写 stderr,不含凭证、加入码与签名地址。
 */
import { CertificateManager, startChallengeServer, type TlsMaterial } from './certificates';
import { identifierFor } from './csr';
import { RelayError } from './errors';
import type { RelayLogger } from './logger';
import { readTlsFiles, startRelayServer } from './server';
import { initializeRelay } from './store';
import { RELAY_VERSION } from './version';

const BOOLEAN_FLAGS = new Set(['trust-proxy']);
/** 首次申请证书失败后的重试间隔(Let's Encrypt 对同一名字每小时只允许几次失败验证)。 */
const ACME_RETRY_DELAYS_MS = [60_000, 5 * 60_000, 15 * 60_000, 30 * 60_000, 60 * 60_000];
const RENEWAL_CHECK_MS = 60 * 60 * 1000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function parsePort(value: string | undefined, fallback: number, name: string): number {
  const port = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new RelayError('BAD_REQUEST', `invalid --${name}`);
  return port;
}

/** 自动证书:先在 80 端口提供验证,拿到(或读到)有效证书后返回;之后由调用方定时续期。 */
async function prepareAcme(flags: Map<string, string>, dataDir: string, host: string) {
  const identifier = identifierFor(required(flags, 'acme-identifier'));
  const manager = new CertificateManager({
    dataDir,
    identifier,
    directoryUrl: flags.get('acme-directory'),
    logger: stderrLogger,
  });
  await startChallengeServer({ host, port: parsePort(flags.get('acme-http-port'), 80, 'acme-http-port'), challenges: manager.challenges });
  let material: TlsMaterial | null = await manager.load();
  if (material && manager.needsRenewal(material)) material = null;
  for (let attempt = 0; !material; attempt++) {
    emit({ event: 'certificate', status: 'requesting', identifier: identifier.value });
    try {
      material = await manager.obtain();
    } catch (error) {
      const delay = ACME_RETRY_DELAYS_MS[Math.min(attempt, ACME_RETRY_DELAYS_MS.length - 1)];
      emit({ event: 'certificate', status: 'failed', retryInMs: delay, message: error instanceof Error ? error.message : 'unknown' });
      // 证书还没到手但旧证书仍有效:先用旧的服务,后台继续申请。
      const previous = await manager.load();
      if (previous) {
        material = previous;
        break;
      }
      await sleep(delay);
    }
  }
  await manager.writeStatus('ready', { notAfter: new Date(material.notAfter).toISOString() });
  return { manager, material };
}

function parseArgs(argv: string[]): { command: string | undefined; flags: Map<string, string> } {
  const flags = new Map<string, string>();
  let command: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      if (command) throw new RelayError('BAD_REQUEST', `unexpected argument: ${arg}`);
      command = arg;
      continue;
    }
    const name = arg.slice(2);
    if (name === 'version' || BOOLEAN_FLAGS.has(name)) {
      flags.set(name, 'true');
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new RelayError('BAD_REQUEST', `missing value for --${name}`);
    flags.set(name, value);
    i++;
  }
  return { command, flags };
}

function required(flags: Map<string, string>, name: string): string {
  const value = flags.get(name);
  if (!value) throw new RelayError('BAD_REQUEST', `--${name} is required`);
  return value;
}

/** JSON 参数以 base64url 传入,避免经 SSH 拼命令时的引号转义。 */
function parseJsonArg(value: string, name: string): unknown {
  try {
    return JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown;
  } catch {
    throw new RelayError('BAD_REQUEST', `--${name} must be base64url-encoded JSON`);
  }
}

function emit(event: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

const stderrLogger: RelayLogger = {
  info: (message, fields) => process.stderr.write(`${JSON.stringify({ level: 'info', message, ...fields })}\n`),
  warn: (message, fields) => process.stderr.write(`${JSON.stringify({ level: 'warn', message, ...fields })}\n`),
  error: (message, fields) => process.stderr.write(`${JSON.stringify({ level: 'error', message, ...fields })}\n`),
};

async function main(): Promise<void> {
  const { command, flags } = parseArgs(process.argv.slice(2));
  if (flags.has('version')) {
    emit({ event: 'version', relayVersion: RELAY_VERSION });
    return;
  }
  if (command === 'init') {
    const { relayId } = await initializeRelay({
      dataDir: required(flags, 'data'),
      name: required(flags, 'name'),
      ownerUserId: required(flags, 'owner-user'),
      ownerDeviceId: required(flags, 'owner-device'),
      ownerDeviceName: required(flags, 'owner-device-name'),
      ownerCredentialHash: required(flags, 'owner-credential-hash'),
      relayId: required(flags, 'relay-id'),
      ownerPublicKey: required(flags, 'owner-public-key'),
      ownerCert: parseJsonArg(required(flags, 'owner-cert'), 'owner-cert'),
    });
    emit({ event: 'initialized', relayId });
    return;
  }
  if (command === 'serve') {
    const certPath = flags.get('tls-cert');
    const keyPath = flags.get('tls-key');
    if (Boolean(certPath) !== Boolean(keyPath)) {
      throw new RelayError('BAD_REQUEST', '--tls-cert and --tls-key must be given together');
    }
    if (flags.has('acme-identifier') && certPath) {
      throw new RelayError('BAD_REQUEST', '--acme-identifier cannot be combined with --tls-cert');
    }
    const port = parsePort(flags.get('port'), 47820, 'port');
    const dataDir = required(flags, 'data');
    const host = flags.get('host') ?? '127.0.0.1';
    const acme = flags.has('acme-identifier') ? await prepareAcme(flags, dataDir, host) : null;
    let material = acme?.material ?? null;
    const handle = await startRelayServer({
      dataDir,
      host,
      port,
      tls: material ? { cert: material.cert, key: material.key } : certPath && keyPath ? await readTlsFiles(certPath, keyPath) : undefined,
      publicUrl: flags.get('public-url'),
      trustProxyHeaders: flags.has('trust-proxy'),
      logger: stderrLogger,
      certificateExpiresAt: () => (material ? new Date(material.notAfter).toISOString() : null),
    });
    emit({ event: 'listening', relayId: handle.relayId, url: handle.localUrl, port: handle.port });
    if (acme) {
      let renewing = false;
      const timer = setInterval(() => {
        if (renewing || !material || !acme.manager.needsRenewal(material)) return;
        renewing = true;
        void acme.manager
          .obtain()
          .then((next) => {
            material = next;
            handle.updateTls({ cert: next.cert, key: next.key });
          })
          .catch(() => {
            // 已记录;旧证书仍有效时下个小时再试。
          })
          .finally(() => {
            renewing = false;
          });
      }, RENEWAL_CHECK_MS);
      timer.unref?.();
    }
    const shutdown = () => {
      void handle.close().then(() => process.exit(0));
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
    return;
  }
  throw new RelayError('BAD_REQUEST', 'usage: relay <init|serve> [options] | relay --version');
}

main().catch((error: unknown) => {
  const relayError = error instanceof RelayError ? error : null;
  emit({
    event: 'error',
    code: relayError?.code ?? 'INTERNAL',
    message: relayError?.message ?? (error instanceof Error ? error.message : 'unknown error'),
  });
  process.exitCode = 1;
});
