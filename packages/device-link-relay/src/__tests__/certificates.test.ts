/**
 * 测试价值
 * - 生产入口：CertificateManager.obtain/load；续期落盘失败后仍能加载上一代有效 TLS 身份。
 * - Bug/规则依据：HTTPS 自动续期与旧证书兜底；分别提交 key/cert 会在中断后留下不匹配的一对。
 * - 覆盖缺口/最小输入：已存一对证书，下一次原子提交失败；或旧分立文件的 key 与 cert 不匹配。
 * - tier：unit；文件系统与 CA 为内存桩，crypto 只模拟证书配对判断，验证持久化代次而非密码算法。
 *   与 relay.test.ts 的真实 socket/文件 fixture 不能共享这些模块 mock，故独立文件。
 * - 单文件实测：0.457 秒（3 例，测试体 5ms，Windows）。
 */
import path from 'node:path';
import { beforeEach, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  files: new Map<string, string>(),
  failCommit: false,
  issued: { certPem: 'cert-key-one', keyPem: 'key-one', notBefore: 0, notAfter: 100_000 },
}));

vi.mock('node:fs/promises', () => ({
  mkdir: vi.fn(async () => {}),
  readFile: vi.fn(async (file: string) => {
    if (!h.files.has(file)) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    return h.files.get(file)!;
  }),
  writeFile: vi.fn(async (file: string, value: string) => { h.files.set(file, value); }),
  rename: vi.fn(async (source: string, target: string) => {
    if (h.failCommit && target.endsWith('material.json')) throw new Error('commit interrupted');
    h.files.set(target, h.files.get(source)!);
    h.files.delete(source);
  }),
  rm: vi.fn(async (file: string) => { h.files.delete(file); }),
}));
vi.mock('node:crypto', async importOriginal => ({
  ...await importOriginal<typeof import('node:crypto')>(),
  createPrivateKey: (value: string) => value,
  X509Certificate: class {
    constructor(private readonly cert: string) {}
    checkPrivateKey(key: string) { return this.cert === `cert-${key}`; }
  },
}));
vi.mock('../acme', () => ({
  AcmeClient: class {
    accountUrl = null;
    async obtainCertificate() { return h.issued; }
  },
  createAccountKey: () => ({ export: () => 'test-account-key' }),
  certificateValidity: () => ({ notBefore: 0, notAfter: 100_000 }),
  LETS_ENCRYPT_DIRECTORY: 'https://ca.invalid/directory',
}));

import { CertificateManager } from '../certificates';

const dataDir = path.resolve('in-memory-relay');
const identifier = { type: 'dns' as const, value: 'relay.invalid' };
const manager = () => new CertificateManager({
  dataDir, identifier, now: () => 10_000,
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
});

beforeEach(() => {
  h.files.clear();
  h.failCommit = false;
  h.issued = { certPem: 'cert-key-one', keyPem: 'key-one', notBefore: 0, notAfter: 100_000 };
});

it('preserves the previous complete TLS identity when committing a renewal fails', async () => {
  await manager().obtain();
  h.issued = { ...h.issued, certPem: 'cert-key-two', keyPem: 'key-two' };
  h.failCommit = true;
  await expect(manager().obtain()).rejects.toThrow('commit interrupted');
  expect(await manager().load()).toMatchObject({ cert: 'cert-key-one', key: 'key-one' });
});

it('reads a valid legacy PEM pair and rejects a mismatched one', async () => {
  h.files.set(path.join(dataDir, 'tls', 'cert.pem'), 'cert-key-one');
  h.files.set(path.join(dataDir, 'tls', 'key.pem'), 'key-one');
  h.files.set(path.join(dataDir, 'tls', 'meta.json'), JSON.stringify({ identifier }));
  expect(await manager().load()).toMatchObject({ cert: 'cert-key-one', key: 'key-one' });
  h.files.set(path.join(dataDir, 'tls', 'key.pem'), 'key-two');
  expect(await manager().load()).toBeNull();
});

it('keeps the saved identity if a new certificate does not match its key', async () => {
  await manager().obtain();
  h.issued = { ...h.issued, certPem: 'cert-another-key', keyPem: 'key-two' };
  await expect(manager().obtain()).rejects.toThrow('certificate does not match its private key');
  expect(await manager().load()).toMatchObject({ cert: 'cert-key-one', key: 'key-one' });
});
