/**
 * 服务器上独立运行时的自动证书:申请、保存、到期前续期,并在 80 端口提供验证文件。
 *
 * - 证书与私钥同存在数据目录 `tls/material.json`(0600,整代原子替换);ACME 账户密钥存在 `acme/`。
 * - 剩余有效期不足总时长的 1/3 就续期(6 天的 IP 证书约剩 2 天时续,90 天的域名证书约剩 30 天时续)。
 * - 当前状态写进 `status.json`,部署方经 SSH 读取它报告进度与失败原因(不含任何秘密)。
 */
import { createPrivateKey, randomUUID, X509Certificate } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { AcmeClient, certificateValidity, createAccountKey, LETS_ENCRYPT_DIRECTORY, type IssuedCertificate } from './acme';
import type { CertificateIdentifier } from './csr';
import type { RelayLogger } from './logger';

export const STATUS_FILE = 'status.json';
const CHALLENGE_PREFIX = '/.well-known/acme-challenge/';

export interface TlsMaterial {
  cert: string;
  key: string;
  notBefore: number;
  notAfter: number;
}

export type CertificateState = 'requesting' | 'ready' | 'failed';

export interface CertificateManagerOptions {
  dataDir: string;
  identifier: CertificateIdentifier;
  directoryUrl?: string;
  logger: RelayLogger;
  now?: () => number;
  fetchImpl?: typeof fetch;
}

async function writeFileAtomically(file: string, content: string, mode: number): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, content, { mode, flag: 'wx' });
    await rename(tmp, file);
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function readOptional(file: string): Promise<string | null> {
  try {
    return await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export class CertificateManager {
  /** 当前待验证的 token → key authorization,由 80 端口服务读取。 */
  readonly challenges = new Map<string, string>();
  private readonly now: () => number;
  private readonly directoryUrl: string;

  constructor(private readonly options: CertificateManagerOptions) {
    this.now = options.now ?? Date.now;
    this.directoryUrl = options.directoryUrl ?? LETS_ENCRYPT_DIRECTORY;
  }

  private file(...parts: string[]): string {
    return path.join(this.options.dataDir, ...parts);
  }

  /** 读取已保存的证书;名字不符或已过期时返回 null。 */
  async load(): Promise<TlsMaterial | null> {
    const materialText = await readOptional(this.file('tls', 'material.json'));
    try {
      let cert: string;
      let key: string;
      let meta: { identifier?: CertificateIdentifier };
      if (materialText !== null) {
        const stored = JSON.parse(materialText) as TlsMaterial & { identifier?: CertificateIdentifier };
        cert = stored.cert;
        key = stored.key;
        meta = stored;
      } else {
        // 兼容开发期间的分立 PEM;只接收能实际组成 TLS 身份的一对。
        const [legacyCert, legacyKey, metaText] = await Promise.all([
          readOptional(this.file('tls', 'cert.pem')),
          readOptional(this.file('tls', 'key.pem')),
          readOptional(this.file('tls', 'meta.json')),
        ]);
        if (!legacyCert || !legacyKey || !metaText) return null;
        cert = legacyCert;
        key = legacyKey;
        meta = JSON.parse(metaText) as { identifier?: CertificateIdentifier };
      }
      if (meta.identifier?.type !== this.options.identifier.type || meta.identifier.value !== this.options.identifier.value) {
        return null;
      }
      if (!new X509Certificate(cert).checkPrivateKey(createPrivateKey(key))) return null;
      const validity = certificateValidity(cert);
      if (validity.notAfter <= this.now()) return null;
      return { cert, key, ...validity };
    } catch {
      return null;
    }
  }

  needsRenewal(material: TlsMaterial): boolean {
    const lifetime = material.notAfter - material.notBefore;
    return material.notAfter - this.now() < lifetime / 3;
  }

  /** 走一遍 ACME 申请新证书并保存;失败时写入状态再抛出。 */
  async obtain(): Promise<TlsMaterial> {
    await this.writeStatus('requesting');
    try {
      const issued = await this.issue();
      if (!new X509Certificate(issued.certPem).checkPrivateKey(createPrivateKey(issued.keyPem))) {
        throw new Error('certificate does not match its private key');
      }
      // 私钥和证书只提交一次:下载/写入/进程中断都不能留下新私钥配旧证书。
      await writeFileAtomically(
        this.file('tls', 'material.json'),
        JSON.stringify({ cert: issued.certPem, key: issued.keyPem, identifier: this.options.identifier }),
        0o600,
      );
      await this.writeStatus('ready', { notAfter: new Date(issued.notAfter).toISOString() });
      this.options.logger.info('certificate issued', { notAfter: new Date(issued.notAfter).toISOString() });
      return { cert: issued.certPem, key: issued.keyPem, notBefore: issued.notBefore, notAfter: issued.notAfter };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown error';
      await this.writeStatus('failed', { error: message.slice(0, 500) });
      this.options.logger.error('certificate request failed', { reason: message.slice(0, 500) });
      throw error;
    }
  }

  private async issue(): Promise<IssuedCertificate> {
    const keyFile = this.file('acme', 'account-key.pem');
    const accountFile = this.file('acme', 'account.json');
    let keyPem = await readOptional(keyFile);
    if (!keyPem) {
      keyPem = createAccountKey().export({ type: 'pkcs8', format: 'pem' }) as string;
      await writeFileAtomically(keyFile, keyPem, 0o600);
    }
    let accountUrl: string | null = null;
    try {
      const saved = JSON.parse((await readOptional(accountFile)) ?? '{}') as { directoryUrl?: string; accountUrl?: string };
      if (saved.directoryUrl === this.directoryUrl && typeof saved.accountUrl === 'string') accountUrl = saved.accountUrl;
    } catch {
      accountUrl = null;
    }
    const client = new AcmeClient({
      directoryUrl: this.directoryUrl,
      accountKey: createPrivateKey(keyPem),
      accountUrl,
      fetchImpl: this.options.fetchImpl,
      log: (message) => this.options.logger.info(message),
    });
    try {
      return await client.obtainCertificate(this.options.identifier, this.challenges);
    } finally {
      if (client.accountUrl && client.accountUrl !== accountUrl) {
        await writeFileAtomically(accountFile, JSON.stringify({ directoryUrl: this.directoryUrl, accountUrl: client.accountUrl }), 0o600);
      }
    }
  }

  async writeStatus(state: CertificateState, extra: { notAfter?: string; error?: string } = {}): Promise<void> {
    const status = {
      certificate: { state, identifier: this.options.identifier.value, ...extra, updatedAt: new Date(this.now()).toISOString() },
    };
    await writeFileAtomically(this.file(STATUS_FILE), JSON.stringify(status), 0o600).catch(() => undefined);
  }
}

/** 80 端口:只回答 ACME 验证文件,其余请求提示使用 https。 */
export async function startChallengeServer(options: {
  host: string;
  port: number;
  challenges: Map<string, string>;
}): Promise<{ port: number; close(): Promise<void> }> {
  const server: Server = createServer((req, res) => {
    let pathname: string;
    try {
      pathname = new URL(req.url ?? '/', 'http://relay.invalid').pathname;
    } catch {
      res.writeHead(400, { 'Connection': 'close', 'Content-Type': 'text/plain' });
      res.end('Invalid request target.\n');
      return;
    }
    if (req.method === 'GET' && pathname.startsWith(CHALLENGE_PREFIX)) {
      const answer = options.challenges.get(pathname.slice(CHALLENGE_PREFIX.length));
      if (answer) {
        res.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Length': String(Buffer.byteLength(answer)) });
        res.end(answer);
        return;
      }
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('This is a Cindy relay. Use https.\n');
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 10_000;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  return {
    port: (server.address() as AddressInfo).port,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      }),
  };
}
