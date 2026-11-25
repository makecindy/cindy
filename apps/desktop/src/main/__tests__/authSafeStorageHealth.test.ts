/**
 * 测试价值
 * - 生产入口与可观察结果：直接调用 authSafeStorageHealth.ts 公开函数
 *   (probeSafeStorageRoundTrip / readAtomicSafeRecord / evaluateExplicitLoginVaultRecovery)
 *   及 atomicWriteFileSync，验证显式登录遇到「旧密文永久解不开但后端健康」「后端不可用/
 *   钥匙串被拒」「文件系统 I/O 错误」三种场景的分流与原子替换/回滚结果。
 * - Bug／规则依据：CN-Q3SC-FZZG 实网登录死循环（旧密文无法解密导致每次显式登录均 503
 *   并烧尽验证码限流），以及 docs/dev-rules/credentials-and-local-storage.md 凭证恢复规则。
 * - 现有覆盖缺口：既有测试未区分 decrypt-failed / io-error / backend-unavailable，且此前
 *   未覆盖 isEncryptionAvailable()===true 但加解密往返失败（macOS 钥匙串拒绝）与旧密文替换。
 * - 最小失败输入：1) 旧密钥加密的 .enc + 新密钥可正常加解密；2) isEncryptionAvailable()===true
 *   但 encryptString 抛错；3) fs.readFileSync 抛 EACCES。
 * - tier：unit（纯内存 fake + 单用例 mkdtemp 临时目录，不触碰真实系统钥匙串或用户目录）。
 * - 实测耗时：263ms（npx vitest run src/main/__tests__/authSafeStorageHealth.test.ts）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  evaluateExplicitLoginVaultRecovery,
  probeSafeStorageRoundTrip,
  readAtomicSafeRecord,
} from '../authSafeStorageHealth';
import { atomicWriteFileSync } from '../utils/atomicWriteFile';

function makeKeyedCrypto(keyPrefix: string) {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (plainText: string) => Buffer.from(`${keyPrefix}:${plainText}`, 'utf8'),
    decryptString: (cipher: Buffer) => {
      const decoded = cipher.toString('utf8');
      if (!decoded.startsWith(`${keyPrefix}:`)) {
        throw new Error('Error while decrypting the ciphertext provided to safeStorage.decryptString.');
      }
      return decoded.slice(keyPrefix.length + 1);
    },
  };
}

describe('authSafeStorageHealth', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  describe('probeSafeStorageRoundTrip', () => {
    it('succeeds when encryptString and decryptString round-trip the probe in memory', () => {
      expect(probeSafeStorageRoundTrip(makeKeyedCrypto('k1'))).toEqual({ ok: true });
    });

    it('reports unavailable without invoking encryptString when backend is unavailable', () => {
      const encryptString = vi.fn();
      const decryptString = vi.fn();
      expect(
        probeSafeStorageRoundTrip({
          isEncryptionAvailable: () => false,
          encryptString,
          decryptString,
        }),
      ).toEqual({ ok: false, reason: 'unavailable' });
      expect(encryptString).not.toHaveBeenCalled();
      expect(decryptString).not.toHaveBeenCalled();
    });

    it('reports round-trip-failed when isEncryptionAvailable is true but encryptString throws (macOS keychain denied)', () => {
      const err = new Error('Error while encrypting the text provided to safeStorage.encryptString.');
      const result = probeSafeStorageRoundTrip({
        isEncryptionAvailable: () => true,
        encryptString: () => {
          throw err;
        },
        decryptString: () => '',
      });
      expect(result).toEqual({ ok: false, reason: 'round-trip-failed', error: err });
    });

    it('reports round-trip-failed when decrypted text does not match probe plaintext', () => {
      const result = probeSafeStorageRoundTrip({
        isEncryptionAvailable: () => true,
        encryptString: (text) => Buffer.from(text, 'utf8'),
        decryptString: () => 'corrupted-output',
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('round-trip-failed');
    });
  });

  describe('readAtomicSafeRecord', () => {
    it('reads primary .enc, falls back to .enc.bak on ENOENT, and reports absent when neither exists', () => {
      const crypto = makeKeyedCrypto('k1');
      const files = new Map<string, string>();
      const read = () =>
        readAtomicSafeRecord({
          isEncryptionAvailable: crypto.isEncryptionAvailable,
          readFileUtf8: (fp) => {
            const v = files.get(fp);
            if (v === undefined) {
              const err = new Error('ENOENT') as NodeJS.ErrnoException;
              err.code = 'ENOENT';
              throw err;
            }
            return v;
          },
          decryptBase64: (b64) => crypto.decryptString(Buffer.from(b64, 'base64')),
          filepath: '/virtual/cindy_auth_accounts_v1.enc',
        });

      expect(read()).toEqual({ status: 'absent' });

      files.set(
        '/virtual/cindy_auth_accounts_v1.enc.bak',
        crypto.encryptString('{"version":1,"bak":true}').toString('base64'),
      );
      expect(read()).toEqual({ status: 'ok', value: '{"version":1,"bak":true}' });

      files.set(
        '/virtual/cindy_auth_accounts_v1.enc',
        crypto.encryptString('{"version":1,"main":true}').toString('base64'),
      );
      expect(read()).toEqual({ status: 'ok', value: '{"version":1,"main":true}' });
    });

    it('separates backend-unavailable, fs io-error, and decrypt-failed with exact ciphertext', () => {
      expect(
        readAtomicSafeRecord({
          isEncryptionAvailable: () => false,
          readFileUtf8: () => {
            throw new Error('should not read');
          },
          decryptBase64: () => '',
          filepath: '/virtual/cindy_auth_accounts_v1.enc',
        }),
      ).toEqual({ status: 'backend-unavailable' });

      const ioErr = Object.assign(new Error('EACCES'), { code: 'EACCES' });
      expect(
        readAtomicSafeRecord({
          isEncryptionAvailable: () => true,
          readFileUtf8: () => {
            throw ioErr;
          },
          decryptBase64: () => '',
          filepath: '/virtual/cindy_auth_accounts_v1.enc',
        }),
      ).toEqual({ status: 'io-error', error: ioErr });

      const oldCrypto = makeKeyedCrypto('old-key');
      const newCrypto = makeKeyedCrypto('new-key');
      const oldCiphertext = oldCrypto.encryptString('{"version":1}').toString('base64');
      const result = readAtomicSafeRecord({
        isEncryptionAvailable: newCrypto.isEncryptionAvailable,
        readFileUtf8: () => oldCiphertext,
        decryptBase64: (b64) => newCrypto.decryptString(Buffer.from(b64, 'base64')),
        filepath: '/virtual/cindy_auth_accounts_v1.enc',
      });
      expect(result.status).toBe('decrypt-failed');
      if (result.status === 'decrypt-failed') {
        expect(result.ciphertext).toBe(oldCiphertext);
      }
    });
  });

  describe('evaluateExplicitLoginVaultRecovery', () => {
    it('allows replacement only for decrypt-failed when the live backend probe passes', () => {
      const decision = evaluateExplicitLoginVaultRecovery(
        { status: 'decrypt-failed', ciphertext: 'OLD_CIPHER', error: new Error('decrypt') },
        () => ({ ok: true }),
      );
      expect(decision).toEqual({
        recover: true,
        stage: 'decrypt-mismatch',
        probeOk: true,
        previousCiphertext: 'OLD_CIPHER',
      });
    });

    it('refuses replacement when decrypt-failed is actually a broken backend (probe fails)', () => {
      const probeErr = new Error('keychain denied');
      const decision = evaluateExplicitLoginVaultRecovery(
        { status: 'decrypt-failed', ciphertext: 'OLD_CIPHER', error: new Error('decrypt') },
        () => ({ ok: false, reason: 'round-trip-failed', error: probeErr }),
      );
      expect(decision).toEqual({
        recover: false,
        stage: 'backend',
        probeOk: false,
        error: probeErr,
      });
    });

    it('refuses replacement without probing on io-error or backend-unavailable', () => {
      const probe = vi.fn(() => ({ ok: true as const }));
      expect(
        evaluateExplicitLoginVaultRecovery(
          { status: 'io-error', error: Object.assign(new Error('EBUSY'), { code: 'EBUSY' }) },
          probe,
        ),
      ).toEqual({ recover: false, stage: 'io' });
      expect(
        evaluateExplicitLoginVaultRecovery({ status: 'backend-unavailable' }, probe),
      ).toEqual({ recover: false, stage: 'backend', probeOk: false });
      expect(probe).not.toHaveBeenCalled();
    });

    it('replaces an undecryptable legacy vault file cleanly and supports exact ciphertext rollback', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-vault-recovery-'));
      tempDirs.push(dir);
      const filepath = path.join(dir, 'cindy_auth_accounts_v1.enc');
      const oldCrypto = makeKeyedCrypto('old-keychain-key');
      const currentCrypto = makeKeyedCrypto('new-keychain-key');

      const oldCiphertext = oldCrypto.encryptString('{"version":1,"old":true}').toString('base64');
      atomicWriteFileSync(filepath, oldCiphertext);
      fs.writeFileSync(`${filepath}.bak`, oldCiphertext, 'utf8');

      const readBefore = readAtomicSafeRecord({
        isEncryptionAvailable: currentCrypto.isEncryptionAvailable,
        readFileUtf8: (fp) => fs.readFileSync(fp, 'utf8'),
        decryptBase64: (b64) => currentCrypto.decryptString(Buffer.from(b64, 'base64')),
        filepath,
      });
      expect(readBefore.status).toBe('decrypt-failed');
      if (readBefore.status !== 'decrypt-failed') throw new Error('expected decrypt-failed');

      const decision = evaluateExplicitLoginVaultRecovery(readBefore, () =>
        probeSafeStorageRoundTrip(currentCrypto),
      );
      expect(decision.recover).toBe(true);
      if (!decision.recover) throw new Error('expected recover');

      // Explicit login writes the new vault atomically, removing stale .bak.
      const nextPayload = JSON.stringify({ version: 1, activeAccountKey: '["cn","u1"]' });
      atomicWriteFileSync(filepath, currentCrypto.encryptString(nextPayload).toString('base64'));
      expect(fs.existsSync(`${filepath}.bak`)).toBe(false);

      const readAfter = readAtomicSafeRecord({
        isEncryptionAvailable: currentCrypto.isEncryptionAvailable,
        readFileUtf8: (fp) => fs.readFileSync(fp, 'utf8'),
        decryptBase64: (b64) => currentCrypto.decryptString(Buffer.from(b64, 'base64')),
        filepath,
      });
      expect(readAfter).toEqual({ status: 'ok', value: nextPayload });

      // Simulated rollback restores the exact original ciphertext bytes.
      atomicWriteFileSync(filepath, decision.previousCiphertext);
      expect(fs.readFileSync(filepath, 'utf8')).toBe(oldCiphertext);
    });
  });
});
