/**
 * 最小 ACME 客户端(RFC 8555),只做中转需要的一件事:用 http-01 验证给一个域名或 IP 申请证书。
 *
 * - 账户密钥 ECDSA P-256(ES256);证书私钥每次新生成,不复用。
 * - IP 证书使用 Let's Encrypt 的 `shortlived` 配置(有效期约 6 天,由证书管理定时续期);
 *   域名证书用 CA 默认配置。
 * - 验证文件由调用方经 80 端口提供(`challenges`:token → key authorization)。
 */
import { createHash, generateKeyPairSync, sign, X509Certificate, type KeyObject } from 'node:crypto';
import { buildCsr, type CertificateIdentifier } from './csr';

export const LETS_ENCRYPT_DIRECTORY = 'https://acme-v02.api.letsencrypt.org/directory';

const VALIDATION_TIMEOUT_MS = 3 * 60 * 1000;
const POLL_INTERVAL_MS = 2_000;

export class AcmeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AcmeError';
  }
}

interface Directory {
  newNonce: string;
  newAccount: string;
  newOrder: string;
  meta?: { profiles?: Record<string, unknown> };
}

interface AcmeResponse {
  status: number;
  headers: Headers;
  body: Record<string, any> | null;
  text: string;
}

export interface IssuedCertificate {
  certPem: string;
  keyPem: string;
  notBefore: number;
  notAfter: number;
}

export interface AcmeClientOptions {
  directoryUrl: string;
  accountKey: KeyObject;
  /** 上次注册得到的账户地址;没有时自动注册(同一密钥重复注册会拿回同一账户)。 */
  accountUrl?: string | null;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  log?: (message: string) => void;
}

function b64url(data: Buffer | string): string {
  return Buffer.from(data).toString('base64url');
}

function problem(body: Record<string, any> | null, fallback: string): string {
  if (!body) return fallback;
  const subproblems = Array.isArray(body.subproblems)
    ? body.subproblems.map((p: Record<string, unknown>) => p.detail).filter(Boolean).join('; ')
    : '';
  return [body.type, body.detail, subproblems].filter(Boolean).join(': ') || fallback;
}

export function firstCertificate(pemChain: string): string {
  const match = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/.exec(pemChain);
  if (!match) throw new AcmeError('the CA returned no certificate');
  return match[0];
}

export function certificateValidity(pemChain: string): { notBefore: number; notAfter: number } {
  const cert = new X509Certificate(firstCertificate(pemChain));
  return { notBefore: Date.parse(cert.validFrom), notAfter: Date.parse(cert.validTo) };
}

export function createAccountKey(): KeyObject {
  return generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey;
}

export class AcmeClient {
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly log: (message: string) => void;
  private readonly jwk: { crv: string; kty: string; x: string; y: string };
  private directory: Directory | null = null;
  private nonce: string | null = null;
  private kid: string | null;

  constructor(private readonly options: AcmeClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.log = options.log ?? (() => undefined);
    const jwk = options.accountKey.export({ format: 'jwk' }) as { crv: string; kty: string; x: string; y: string };
    this.jwk = { crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y };
    this.kid = options.accountUrl ?? null;
  }

  get accountUrl(): string | null {
    return this.kid;
  }

  /** RFC 7638 JWK 指纹:验证文件内容 = token + "." + 指纹。 */
  get thumbprint(): string {
    const { crv, kty, x, y } = this.jwk;
    return b64url(createHash('sha256').update(JSON.stringify({ crv, kty, x, y })).digest());
  }

  private async getDirectory(): Promise<Directory> {
    if (this.directory) return this.directory;
    const res = await this.fetchImpl(this.options.directoryUrl);
    const body = (await res.json().catch(() => null)) as Directory | null;
    if (!res.ok || !body?.newNonce || !body.newAccount || !body.newOrder) {
      throw new AcmeError(`certificate authority directory unavailable (${res.status})`);
    }
    this.directory = body;
    return body;
  }

  private async getNonce(): Promise<string> {
    if (this.nonce) {
      const nonce = this.nonce;
      this.nonce = null;
      return nonce;
    }
    const res = await this.fetchImpl((await this.getDirectory()).newNonce, { method: 'HEAD' });
    const nonce = res.headers.get('replay-nonce');
    if (!nonce) throw new AcmeError('certificate authority returned no nonce');
    return nonce;
  }

  /** 带 JWS 签名的 POST;payload 为 undefined 时是 POST-as-GET。 */
  private async post(url: string, payload: unknown, options: { useJwk?: boolean; accept?: string } = {}): Promise<AcmeResponse> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const header = {
        alg: 'ES256',
        nonce: await this.getNonce(),
        url,
        ...(options.useJwk || !this.kid ? { jwk: this.jwk } : { kid: this.kid }),
      };
      const protectedPart = b64url(JSON.stringify(header));
      const payloadPart = payload === undefined ? '' : b64url(JSON.stringify(payload));
      const signature = sign('sha256', Buffer.from(`${protectedPart}.${payloadPart}`), {
        key: this.options.accountKey,
        dsaEncoding: 'ieee-p1363',
      });
      const res = await this.fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/jose+json', ...(options.accept ? { Accept: options.accept } : {}) },
        body: JSON.stringify({ protected: protectedPart, payload: payloadPart, signature: b64url(signature) }),
      });
      this.nonce = res.headers.get('replay-nonce');
      const text = await res.text();
      let body: Record<string, any> | null = null;
      try {
        body = JSON.parse(text) as Record<string, any>;
      } catch {
        body = null;
      }
      if (res.status === 400 && body?.type === 'urn:ietf:params:acme:error:badNonce') continue;
      return { status: res.status, headers: res.headers, body, text };
    }
    throw new AcmeError('certificate authority kept rejecting nonces');
  }

  private async ensureAccount(): Promise<void> {
    if (this.kid) return;
    const directory = await this.getDirectory();
    const res = await this.post(directory.newAccount, { termsOfServiceAgreed: true }, { useJwk: true });
    const location = res.headers.get('location');
    if ((res.status !== 200 && res.status !== 201) || !location) {
      throw new AcmeError(`account registration failed: ${problem(res.body, String(res.status))}`);
    }
    this.kid = location;
  }

  private async pollUntil(url: string, done: (body: Record<string, any>) => boolean, what: string): Promise<Record<string, any>> {
    const deadline = Date.now() + VALIDATION_TIMEOUT_MS;
    for (;;) {
      const res = await this.post(url, undefined);
      if (res.status >= 400 || !res.body) throw new AcmeError(`${what} failed: ${problem(res.body, String(res.status))}`);
      if (res.body.status === 'invalid') {
        const failed = Array.isArray(res.body.challenges)
          ? res.body.challenges.find((c: Record<string, any>) => c.error)?.error
          : res.body.error;
        throw new AcmeError(`${what} failed: ${problem(failed ?? null, 'invalid')}`);
      }
      if (done(res.body)) return res.body;
      if (Date.now() > deadline) throw new AcmeError(`${what} timed out`);
      const retryAfter = Number(res.headers.get('retry-after'));
      await this.sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, 10) * 1000 : POLL_INTERVAL_MS);
    }
  }

  async obtainCertificate(identifier: CertificateIdentifier, challenges: Map<string, string>): Promise<IssuedCertificate> {
    const directory = await this.getDirectory();
    await this.ensureAccount();
    const profiles = directory.meta?.profiles ?? {};
    const profile = identifier.type === 'ip' && 'shortlived' in profiles ? 'shortlived' : undefined;
    this.log(`requesting a certificate for ${identifier.type} ${identifier.value}${profile ? ` (profile ${profile})` : ''}`);
    const order = await this.post(directory.newOrder, { identifiers: [identifier], ...(profile ? { profile } : {}) });
    const orderUrl = order.headers.get('location');
    if (order.status !== 201 || !order.body || !orderUrl) {
      throw new AcmeError(`order failed: ${problem(order.body, String(order.status))}`);
    }

    for (const authzUrl of order.body.authorizations as string[]) {
      const authz = await this.post(authzUrl, undefined);
      if (authz.body?.status === 'valid') continue;
      const challenge = (authz.body?.challenges as Array<Record<string, string>> | undefined)?.find((c) => c.type === 'http-01');
      if (!challenge) throw new AcmeError('the certificate authority offered no http-01 validation');
      challenges.set(challenge.token, `${challenge.token}.${this.thumbprint}`);
      try {
        const triggered = await this.post(challenge.url, {});
        if (triggered.status >= 400) throw new AcmeError(`validation failed: ${problem(triggered.body, String(triggered.status))}`);
        await this.pollUntil(authzUrl, (body) => body.status === 'valid', 'validation');
      } finally {
        challenges.delete(challenge.token);
      }
    }

    await this.pollUntil(orderUrl, (body) => body.status === 'ready' || body.status === 'valid', 'order');
    const certKey = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey;
    const finalized = await this.post(order.body.finalize as string, { csr: b64url(buildCsr(certKey, identifier)) });
    if (finalized.status >= 400) throw new AcmeError(`finalize failed: ${problem(finalized.body, String(finalized.status))}`);
    const ready = await this.pollUntil(orderUrl, (body) => body.status === 'valid' && Boolean(body.certificate), 'issuance');
    const download = await this.post(ready.certificate as string, undefined, { accept: 'application/pem-certificate-chain' });
    if (download.status !== 200 || !download.text.includes('BEGIN CERTIFICATE')) {
      throw new AcmeError(`certificate download failed (${download.status})`);
    }
    const certPem = download.text;
    return {
      certPem,
      keyPem: certKey.export({ type: 'pkcs8', format: 'pem' }) as string,
      ...certificateValidity(certPem),
    };
  }
}
