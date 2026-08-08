import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { lockSync } from 'proper-lockfile';

import { afterEach, describe, expect, it, vi } from 'vitest';

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-provider-auth-binding-test-'));
const session = {
  dataOwnerId: 'owner-a' as string | null,
  generation: 1,
  boundaryPending: false,
};

vi.mock('electron', () => ({
  app: { getPath: () => userDataDir },
}));

vi.mock('../../appSessionState.js', () => ({
  getActiveAppSession: () => ({
    mode: session.dataOwnerId ? 'cloud' : 'signed-out',
    dataOwnerId: session.dataOwnerId,
    generation: session.generation,
  }),
  isAppSessionBoundaryPending: () => session.boundaryPending,
}));

import {
  abandonNativeProviderAuthOperation,
  beginNativeProviderAuthAuthorization,
  beginNativeProviderAuthDisconnect,
  beginNativeProviderAuthInvalidation,
  beginNativeProviderAuthRevocation,
  bindNativeProviderAuth,
  claimDetectedNativeProviderAuth,
  clearNativeProviderAuthAuthorizationPending,
  getNativeProviderAuthCredentialRejectionState,
  getNativeProviderAuthCredentialRejectionStateForBindingTransaction,
  getNativeProviderAuthBindingState,
  getNativeProviderAuthBindingStateForOperation,
  isNativeProviderAuthBound,
  isNativeProviderAuthRevoked,
  isNativeProviderAuthSelfAuthorized,
  invalidateNativeProviderAuthWithoutIntent,
  markNativeProviderAuthCredentialRejectionRecovery,
  markNativeProviderAuthCredentialRejected,
  markNativeProviderAuthRevocationPending,
  migrateLegacyNativeProviderAuthBindings,
  resolveNativeProviderAuthCredentialRejection,
  restoreNativeProviderAuthForRecovery,
  runWithNativeProviderAuthCredentialRejectionForStorageMutation,
  stageNativeProviderAuthAuthorization,
  unbindNativeProviderAuth,
  validateNativeProviderAuthRevocationPending,
} from '../nativeProviderAuthBinding.js';

const bindingFile = path.join(userDataDir, 'native-provider-auth.json');

afterEach(() => {
  session.dataOwnerId = 'owner-a';
  session.generation = 1;
  session.boundaryPending = false;
  fs.rmSync(userDataDir, { recursive: true, force: true });
});

describe('native provider auth legacy binding', () => {
  it('claims available legacy credentials for the first owner only', () => {
    migrateLegacyNativeProviderAuthBindings('owner-a', {
      anthropic: true,
      openai: false,
    });

    expect(isNativeProviderAuthBound('anthropic')).toBe(true);
    session.dataOwnerId = 'owner-b';
    expect(isNativeProviderAuthBound('anthropic')).toBe(false);
    expect(JSON.parse(fs.readFileSync(bindingFile, 'utf8'))).toMatchObject({
      anthropic: 'owner-a',
      legacyClaimOwner: 'owner-a',
    });
  });

  it('does not reclaim a legacy credential after logout', () => {
    migrateLegacyNativeProviderAuthBindings('owner-a', { xai: true });
    unbindNativeProviderAuth('xai');
    session.dataOwnerId = 'owner-b';
    migrateLegacyNativeProviderAuthBindings('owner-b', { xai: true });

    expect(isNativeProviderAuthBound('xai')).toBe(false);
  });
});

describe('native provider auth atomic write retries', () => {
  it.each(['EBUSY', 'EACCES', 'ENOTEMPTY'])(
    'recovers from transient %s while publishing an owner fence',
    (code) => {
      const realRename = fs.renameSync;
      let failures = 2;
      let attempts = 0;
      const renameSpy = vi.spyOn(fs, 'renameSync').mockImplementation(((from, to) => {
        if (String(from).endsWith('.tmp') && String(to) === bindingFile) {
          attempts += 1;
          if (failures > 0) {
            failures -= 1;
            throw Object.assign(new Error(code), { code });
          }
        }
        return realRename(from, to);
      }) as typeof fs.renameSync);

      try {
        expect(() =>
          migrateLegacyNativeProviderAuthBindings('owner-a', { anthropic: true }),
        ).not.toThrow();
      } finally {
        renameSpy.mockRestore();
      }
      expect(attempts).toBe(3);
      expect(JSON.parse(fs.readFileSync(bindingFile, 'utf8'))).toMatchObject({
        anthropic: 'owner-a',
        legacyClaimOwner: 'owner-a',
      });
    },
  );

  it('preserves the old owner fence and removes its temp after persistent contention', () => {
    migrateLegacyNativeProviderAuthBindings('owner-a', { anthropic: true });
    const before = fs.readFileSync(bindingFile, 'utf8');
    const realRename = fs.renameSync;
    let attempts = 0;
    const renameSpy = vi.spyOn(fs, 'renameSync').mockImplementation(((from, to) => {
      if (String(from).endsWith('.tmp') && String(to) === bindingFile) {
        attempts += 1;
        throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' });
      }
      return realRename(from, to);
    }) as typeof fs.renameSync);

    try {
      expect(() => unbindNativeProviderAuth('anthropic')).toThrow(/EBUSY/);
    } finally {
      renameSpy.mockRestore();
    }
    expect(attempts).toBe(4);
    expect(fs.readFileSync(bindingFile, 'utf8')).toBe(before);
    expect(
      fs.readdirSync(userDataDir).filter((name) => name.startsWith('native-provider-auth.json.')),
    ).toEqual([]);
  });

  it.each(['EPERM', 'EEXIST'])(
    'uses a rollback-safe backup swap for Windows %s owner-fence replacement',
    (code) => {
      migrateLegacyNativeProviderAuthBindings('owner-a', { anthropic: true });
      const realRename = fs.renameSync;
      let firstPublish = true;
      let publishes = 0;
      const renameSpy = vi.spyOn(fs, 'renameSync').mockImplementation(((from, to) => {
        if (String(from).endsWith('.tmp') && String(to) === bindingFile) {
          publishes += 1;
          if (firstPublish) {
            firstPublish = false;
            throw Object.assign(new Error(code), { code });
          }
        }
        return realRename(from, to);
      }) as typeof fs.renameSync);

      try {
        expect(() => unbindNativeProviderAuth('anthropic', { revoked: true })).not.toThrow();
      } finally {
        renameSpy.mockRestore();
      }
      expect(publishes).toBe(2);
      expect(JSON.parse(fs.readFileSync(bindingFile, 'utf8'))).toMatchObject({
        revoked: { anthropic: 'owner-a' },
      });
      expect(fs.existsSync(`${bindingFile}.bak`)).toBe(false);
      expect(
        fs.readdirSync(userDataDir).filter((name) => name.startsWith('native-provider-auth.json.')),
      ).toEqual([]);
    },
  );

  it.each(['EPERM', 'EEXIST'])(
    'uses the same Windows %s backup protocol for an existing operation sidecar',
    (code) => {
      bindNativeProviderAuth('anthropic');
      const owner = { dataOwnerId: 'owner-a', generation: 1 };
      beginNativeProviderAuthAuthorization('anthropic', owner);
      const intentFile = path.join(userDataDir, 'native-provider-auth.intent', 'anthropic.json');
      const realRename = fs.renameSync;
      let firstPublish = true;
      const renameSpy = vi.spyOn(fs, 'renameSync').mockImplementation(((from, to) => {
        if (String(from).endsWith('.tmp') && String(to) === intentFile && firstPublish) {
          firstPublish = false;
          throw Object.assign(new Error(code), { code });
        }
        return realRename(from, to);
      }) as typeof fs.renameSync);

      let revocation: ReturnType<typeof beginNativeProviderAuthRevocation> = null;
      try {
        revocation = beginNativeProviderAuthRevocation('anthropic', owner);
      } finally {
        renameSpy.mockRestore();
      }
      expect(revocation?.intent).toBe('revoke');
      expect(JSON.parse(fs.readFileSync(intentFile, 'utf8'))).toMatchObject({
        intent: 'revoke',
        operationId: revocation?.operationId,
      });
      expect(fs.existsSync(`${intentFile}.bak`)).toBe(false);
    },
  );

  it('keeps a backup-only owner state closed until a locked mutation restores it', () => {
    migrateLegacyNativeProviderAuthBindings('owner-a', { anthropic: true });
    fs.renameSync(bindingFile, `${bindingFile}.bak`);
    const renameSpy = vi.spyOn(fs, 'renameSync');

    expect(getNativeProviderAuthBindingState('anthropic')).toBe('unreadable');
    expect(isNativeProviderAuthRevoked('anthropic')).toBe(true);
    expect(renameSpy).not.toHaveBeenCalled();
    expect(fs.existsSync(bindingFile)).toBe(false);
    expect(fs.existsSync(`${bindingFile}.bak`)).toBe(true);

    expect(unbindNativeProviderAuth('anthropic', { revoked: true })).toBe(true);
    expect(renameSpy).toHaveBeenCalledWith(`${bindingFile}.bak`, bindingFile);
    expect(JSON.parse(fs.readFileSync(bindingFile, 'utf8'))).toMatchObject({
      revoked: { anthropic: 'owner-a' },
    });
    expect(fs.existsSync(`${bindingFile}.bak`)).toBe(false);
    renameSpy.mockRestore();
  });

  it('keeps a backup-only operation closed until a locked cleanup restores it', () => {
    bindNativeProviderAuth('anthropic');
    const operation = beginNativeProviderAuthAuthorization('anthropic', {
      dataOwnerId: 'owner-a',
      generation: 1,
    })!;
    const intentFile = path.join(userDataDir, 'native-provider-auth.intent', 'anthropic.json');
    fs.renameSync(intentFile, `${intentFile}.bak`);
    const renameSpy = vi.spyOn(fs, 'renameSync');

    expect(isNativeProviderAuthRevoked('anthropic')).toBe(true);
    expect(renameSpy).not.toHaveBeenCalled();
    expect(fs.existsSync(intentFile)).toBe(false);
    expect(abandonNativeProviderAuthOperation('anthropic', operation)).toBe(true);
    expect(renameSpy).toHaveBeenCalledWith(`${intentFile}.bak`, intentFile);

    renameSpy.mockRestore();
    expect(fs.existsSync(intentFile)).toBe(false);
    expect(fs.existsSync(`${intentFile}.bak`)).toBe(false);
  });

  it('keeps a backup-only pending fence closed until a locked rewrite restores it', () => {
    bindNativeProviderAuth('anthropic');
    expect(
      markNativeProviderAuthRevocationPending('anthropic', {
        dataOwnerId: 'owner-a',
        generation: 1,
      }),
    ).toBe(true);
    const pendingFile = path.join(userDataDir, 'native-provider-auth.pending', 'anthropic.json');
    fs.renameSync(pendingFile, `${pendingFile}.bak`);
    const renameSpy = vi.spyOn(fs, 'renameSync');

    expect(getNativeProviderAuthBindingState('anthropic')).toBe('unreadable');
    expect(isNativeProviderAuthRevoked('anthropic')).toBe(true);
    expect(renameSpy).not.toHaveBeenCalled();
    expect(
      markNativeProviderAuthRevocationPending('anthropic', {
        dataOwnerId: 'owner-a',
        generation: 1,
      }),
    ).toBe(true);
    expect(renameSpy).toHaveBeenCalledWith(`${pendingFile}.bak`, pendingFile);
    expect(fs.existsSync(pendingFile)).toBe(true);
    expect(fs.existsSync(`${pendingFile}.bak`)).toBe(false);
    renameSpy.mockRestore();
  });

  it('does not recover an unrelated provider sidecar during an anthropic read', () => {
    bindNativeProviderAuth('anthropic');
    const openAiOperation = beginNativeProviderAuthAuthorization('openai', {
      dataOwnerId: 'owner-a',
      generation: 1,
    })!;
    const openAiIntentFile = path.join(userDataDir, 'native-provider-auth.intent', 'openai.json');
    fs.renameSync(openAiIntentFile, `${openAiIntentFile}.bak`);
    const realRename = fs.renameSync;
    const renameSpy = vi.spyOn(fs, 'renameSync').mockImplementation(((from, to) => {
      if (String(from) === `${openAiIntentFile}.bak` && String(to) === openAiIntentFile) {
        throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
      }
      return realRename(from, to);
    }) as typeof fs.renameSync);

    try {
      expect(getNativeProviderAuthBindingState('anthropic')).toBe('bound');
      expect(isNativeProviderAuthRevoked('anthropic')).toBe(false);
      expect(renameSpy).not.toHaveBeenCalledWith(`${openAiIntentFile}.bak`, openAiIntentFile);
    } finally {
      renameSpy.mockRestore();
    }

    expect(abandonNativeProviderAuthOperation('openai', openAiOperation)).toBe(true);
  });

  it('fails closed when a backup cannot be restored and releases the lock for a later retry', () => {
    migrateLegacyNativeProviderAuthBindings('owner-a', { anthropic: true });
    fs.renameSync(bindingFile, `${bindingFile}.bak`);
    const realRename = fs.renameSync;
    const renameSpy = vi.spyOn(fs, 'renameSync').mockImplementation(((from, to) => {
      if (String(from) === `${bindingFile}.bak` && String(to) === bindingFile) {
        throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' });
      }
      return realRename(from, to);
    }) as typeof fs.renameSync);
    const hasCredential = vi.fn(() => true);

    expect(claimDetectedNativeProviderAuth('anthropic', hasCredential)).toBe(false);
    expect(hasCredential).not.toHaveBeenCalled();
    expect(fs.existsSync(bindingFile)).toBe(false);
    expect(fs.existsSync(`${bindingFile}.bak`)).toBe(true);
    renameSpy.mockRestore();

    expect(unbindNativeProviderAuth('anthropic', { revoked: true })).toBe(true);
    expect(fs.existsSync(bindingFile)).toBe(true);
    expect(fs.existsSync(`${bindingFile}.bak`)).toBe(false);
    expect(JSON.parse(fs.readFileSync(bindingFile, 'utf8'))).toMatchObject({
      revoked: { anthropic: 'owner-a' },
    });
  });

  it('clears a stale backup before its live operation and preserves the live fence on failure', () => {
    bindNativeProviderAuth('anthropic');
    const owner = { dataOwnerId: 'owner-a', generation: 1 };
    const first = beginNativeProviderAuthAuthorization('anthropic', owner)!;
    const intentFile = path.join(userDataDir, 'native-provider-auth.intent', 'anthropic.json');
    fs.writeFileSync(`${intentFile}.bak`, fs.readFileSync(intentFile, 'utf8'));
    const realUnlink = fs.unlinkSync;
    const unlinkSpy = vi.spyOn(fs, 'unlinkSync').mockImplementation(((target) => {
      if (String(target) === `${intentFile}.bak`) {
        throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
      }
      return realUnlink(target);
    }) as typeof fs.unlinkSync);

    expect(() => abandonNativeProviderAuthOperation('anthropic', first)).toThrow(/EACCES/);
    expect(fs.existsSync(intentFile)).toBe(true);
    expect(fs.existsSync(`${intentFile}.bak`)).toBe(true);
    unlinkSpy.mockRestore();

    expect(abandonNativeProviderAuthOperation('anthropic', first)).toBe(true);
    expect(fs.existsSync(intentFile)).toBe(false);
    expect(fs.existsSync(`${intentFile}.bak`)).toBe(false);
  });
});

describe('claimDetectedNativeProviderAuth', () => {
  it('repairs the binding when the one-shot migration consumed the claim before the credential appeared', () => {
    // 复现主 bug:legacy 迁移在 reconcile 硬链建立之前跑掉,openai 名额以 false 被消费。
    migrateLegacyNativeProviderAuthBindings('owner-a', { openai: false });
    expect(isNativeProviderAuthBound('openai')).toBe(false);

    expect(claimDetectedNativeProviderAuth('openai', () => true)).toBe(true);
    expect(isNativeProviderAuthBound('openai')).toBe(true);
    expect(JSON.parse(fs.readFileSync(bindingFile, 'utf8'))).toMatchObject({
      openai: 'owner-a',
      legacyClaimOwner: 'owner-a',
    });
  });

  it('claims for the current owner when no legacy claim ever ran (local mode path)', () => {
    expect(claimDetectedNativeProviderAuth('openai', () => true)).toBe(true);
    expect(JSON.parse(fs.readFileSync(bindingFile, 'utf8'))).toMatchObject({ openai: 'owner-a' });
  });

  it('stays fail-closed for an account that did not win the legacy claim', () => {
    migrateLegacyNativeProviderAuthBindings('owner-a', {});
    session.dataOwnerId = 'owner-b';

    expect(claimDetectedNativeProviderAuth('openai', () => true)).toBe(false);
    expect(isNativeProviderAuthBound('openai')).toBe(false);
  });

  it('never overwrites a binding held by another owner', () => {
    migrateLegacyNativeProviderAuthBindings('owner-a', { openai: true });
    session.dataOwnerId = 'owner-b';

    expect(claimDetectedNativeProviderAuth('openai', () => true)).toBe(false);
    session.dataOwnerId = 'owner-a';
    expect(isNativeProviderAuthBound('openai')).toBe(true);
  });

  it('writes nothing without a committed owner or without a credential', () => {
    session.dataOwnerId = null;
    expect(claimDetectedNativeProviderAuth('openai', () => true)).toBe(false);

    session.dataOwnerId = 'owner-a';
    expect(claimDetectedNativeProviderAuth('openai', () => false)).toBe(false);
    expect(fs.existsSync(bindingFile)).toBe(false);
  });

  it('writes nothing while a session boundary is in flight', () => {
    // owner 正在被换掉:此刻写入等于把上一个账号的凭证交给下一个账号。
    session.boundaryPending = true;
    expect(claimDetectedNativeProviderAuth('anthropic', () => true)).toBe(false);
    expect(fs.existsSync(bindingFile)).toBe(false);

    session.boundaryPending = false;
    expect(claimDetectedNativeProviderAuth('anthropic', () => true)).toBe(true);
  });

  it('claims anthropic and xai on the same terms as openai', () => {
    // 三家 native provider 共用一套认领口径:凭证在场 + 名额未被占 → 绑给当前 owner。
    expect(claimDetectedNativeProviderAuth('anthropic', () => true)).toBe(true);
    expect(claimDetectedNativeProviderAuth('xai', () => true)).toBe(true);
    expect(isNativeProviderAuthBound('anthropic')).toBe(true);
    expect(isNativeProviderAuthBound('xai')).toBe(true);

    session.dataOwnerId = 'owner-b';
    expect(isNativeProviderAuthBound('anthropic')).toBe(false);
    expect(claimDetectedNativeProviderAuth('anthropic', () => true)).toBe(false);
  });

  it('显式登出留下的撤销标记挡住自动认领(凭证删除失败也不会被绑回来)', () => {
    // 登出会先删凭证再解绑,但删除是 best-effort 的;删失败时 slot 已空、凭证还在,
    // 没有标记就会在下一次读连接态时被认领回来,等于悄悄撤销用户刚做的登出。
    expect(claimDetectedNativeProviderAuth('anthropic', () => true)).toBe(true);
    unbindNativeProviderAuth('anthropic', { revoked: true });

    expect(isNativeProviderAuthBound('anthropic')).toBe(false);
    expect(claimDetectedNativeProviderAuth('anthropic', () => true)).toBe(false);
    expect(JSON.parse(fs.readFileSync(bindingFile, 'utf8'))).toMatchObject({
      revoked: { anthropic: 'owner-a' },
    });
  });

  it('撤销标记跨 owner 依然有效 —— 残留凭证仍属于登出的那个账号', () => {
    // 按 owner 比对会给下一个账号开继承别人凭证的口子:凭证在共享的系统 keychain / CLI
    // 里,换个 owner 它还是 A 的凭证(PR #548 review)。
    unbindNativeProviderAuth('anthropic', { revoked: true });
    expect(claimDetectedNativeProviderAuth('anthropic', () => true)).toBe(false);

    session.dataOwnerId = 'owner-b';
    expect(claimDetectedNativeProviderAuth('anthropic', () => true)).toBe(false);
  });

  it('撤销标记在还没有 active owner 的启动阶段也会阻断凭证', () => {
    unbindNativeProviderAuth('openai', { revoked: true });
    expect(isNativeProviderAuthRevoked('openai')).toBe(true);

    session.dataOwnerId = null;
    expect(isNativeProviderAuthBound('openai')).toBe(false);
  });

  it('一次性 legacy 迁移同样尊重撤销标记', () => {
    unbindNativeProviderAuth('anthropic', { revoked: true });
    session.dataOwnerId = 'owner-b';
    migrateLegacyNativeProviderAuthBindings('owner-b', { anthropic: true, xai: true });

    expect(isNativeProviderAuthBound('anthropic')).toBe(false);
    // 没被撤销的 provider 不受影响。
    expect(isNativeProviderAuthBound('xai')).toBe(true);
  });

  it('用户再次显式授权即清除撤销标记,恢复自动继承语义', () => {
    unbindNativeProviderAuth('xai', { revoked: true });
    expect(claimDetectedNativeProviderAuth('xai', () => true)).toBe(false);

    bindNativeProviderAuth('xai');
    expect(isNativeProviderAuthBound('xai')).toBe(true);
    unbindNativeProviderAuth('xai');
    // 上一次的撤销标记已随显式授权作废,这次(非显式登出)不该再挡。
    expect(claimDetectedNativeProviderAuth('xai', () => true)).toBe(true);
  });

  it('凭证失效(非用户登出)不留标记 —— 本机重新登录后仍按设计自动继承', () => {
    expect(claimDetectedNativeProviderAuth('anthropic', () => true)).toBe(true);
    unbindNativeProviderAuth('anthropic'); // invalidate 路径:不传 revoked

    expect(JSON.parse(fs.readFileSync(bindingFile, 'utf8'))).not.toHaveProperty('revoked');
    expect(claimDetectedNativeProviderAuth('anthropic', () => true)).toBe(true);
  });

  it('归属从不可读恢复后只允许条件解绑当前 owner,不删除别人的绑定', () => {
    fs.mkdirSync(userDataDir, { recursive: true });
    fs.writeFileSync(bindingFile, JSON.stringify({ anthropic: 'owner-b' }));

    unbindNativeProviderAuth('anthropic', {
      revoked: true,
      ifOwnedByCurrentSession: true,
    });
    expect(JSON.parse(fs.readFileSync(bindingFile, 'utf8'))).toEqual({ anthropic: 'owner-b' });

    fs.writeFileSync(bindingFile, JSON.stringify({ anthropic: 'owner-a' }));
    unbindNativeProviderAuth('anthropic', {
      revoked: true,
      ifOwnedByCurrentSession: true,
    });
    expect(JSON.parse(fs.readFileSync(bindingFile, 'utf8'))).toMatchObject({
      revoked: { anthropic: 'owner-a' },
    });
    expect(JSON.parse(fs.readFileSync(bindingFile, 'utf8'))).not.toHaveProperty('anthropic');
  });

  it('same owner 的旧 generation 也不能解绑新会话绑定', () => {
    fs.mkdirSync(userDataDir, { recursive: true });
    fs.writeFileSync(bindingFile, JSON.stringify({ anthropic: 'owner-a' }));
    const oldFence = { dataOwnerId: 'owner-a', generation: 1 };

    session.generation = 2;
    expect(unbindNativeProviderAuth('anthropic', { revoked: true, expectedOwner: oldFence })).toBe(
      false,
    );
    expect(JSON.parse(fs.readFileSync(bindingFile, 'utf8'))).toEqual({ anthropic: 'owner-a' });

    expect(
      unbindNativeProviderAuth('anthropic', {
        revoked: true,
        expectedOwner: { dataOwnerId: 'owner-a', generation: 2 },
      }),
    ).toBe(true);
    expect(JSON.parse(fs.readFileSync(bindingFile, 'utf8'))).toMatchObject({
      revoked: { anthropic: 'owner-a' },
    });
  });

  it('迟到回调不能在另一进程的新 owner binding 上写全局 pending tombstone', () => {
    fs.mkdirSync(userDataDir, { recursive: true });
    fs.writeFileSync(bindingFile, JSON.stringify({ anthropic: 'owner-b' }));

    expect(
      markNativeProviderAuthRevocationPending('anthropic', {
        dataOwnerId: 'owner-a',
        generation: 1,
      }),
    ).toBe(false);
    expect(
      fs.existsSync(path.join(userDataDir, 'native-provider-auth.pending', 'anthropic.json')),
    ).toBe(false);
    expect(JSON.parse(fs.readFileSync(bindingFile, 'utf8'))).toEqual({ anthropic: 'owner-b' });
  });

  it('另一 owner 的显式授权 staging 可以有意替换旧 binding,且可修复损坏 sidecar', () => {
    fs.mkdirSync(userDataDir, { recursive: true });
    fs.writeFileSync(bindingFile, JSON.stringify({ anthropic: 'owner-a' }));
    const pendingFile = path.join(userDataDir, 'native-provider-auth.pending', 'anthropic.json');
    fs.mkdirSync(path.dirname(pendingFile), { recursive: true });
    fs.writeFileSync(pendingFile, '{ corrupt pending');
    session.dataOwnerId = 'owner-b';
    session.generation = 2;

    const operation = beginNativeProviderAuthAuthorization('anthropic', {
      dataOwnerId: 'owner-b',
      generation: 2,
    })!;
    expect(stageNativeProviderAuthAuthorization('anthropic', operation)).toBe(true);
    expect(bindNativeProviderAuth('anthropic', operation)).toBe(true);
    expect(getNativeProviderAuthBindingState('anthropic')).toBe('bound');
    expect(JSON.parse(fs.readFileSync(bindingFile, 'utf8'))).toMatchObject({
      anthropic: 'owner-b',
    });
    expect(fs.existsSync(pendingFile)).toBe(false);
  });

  it('带 owner fence 的 bind 只消费完全匹配的 authorize marker', () => {
    fs.mkdirSync(userDataDir, { recursive: true });
    const ownerA = { dataOwnerId: 'owner-a', generation: 1 };
    const ownerB = { dataOwnerId: 'owner-b', generation: 2 };

    const operationA = beginNativeProviderAuthAuthorization('anthropic', ownerA)!;
    session.dataOwnerId = 'owner-b';
    session.generation = 2;
    const operationB = beginNativeProviderAuthAuthorization('anthropic', ownerB)!;
    expect(stageNativeProviderAuthAuthorization('anthropic', operationB)).toBe(true);

    session.dataOwnerId = 'owner-a';
    session.generation = 1;
    expect(bindNativeProviderAuth('anthropic', operationA)).toBe(false);
    const pendingFile = path.join(userDataDir, 'native-provider-auth.pending', 'anthropic.json');
    expect(JSON.parse(fs.readFileSync(pendingFile, 'utf8'))).toMatchObject({
      intent: 'authorize',
      dataOwnerId: 'owner-b',
      generation: 2,
    });
    expect(fs.existsSync(bindingFile)).toBe(false);
  });

  it('rolled-back login cleanup never removes a newer staged authorization marker', () => {
    fs.mkdirSync(userDataDir, { recursive: true });
    const owner = { dataOwnerId: 'owner-a', generation: 1 };
    const operationA = beginNativeProviderAuthAuthorization('anthropic', owner)!;
    expect(stageNativeProviderAuthAuthorization('anthropic', operationA)).toBe(true);

    const operationB = beginNativeProviderAuthAuthorization('anthropic', owner)!;
    expect(stageNativeProviderAuthAuthorization('anthropic', operationB)).toBe(true);
    expect(clearNativeProviderAuthAuthorizationPending('anthropic', operationA)).toBe(true);

    const pendingFile = path.join(userDataDir, 'native-provider-auth.pending', 'anthropic.json');
    const pending = JSON.parse(fs.readFileSync(pendingFile, 'utf8')) as Record<string, unknown>;
    expect(pending).toMatchObject({
      intent: 'authorize',
      operationId: operationB.operationId,
    });
    expect(pending).not.toHaveProperty('fallbackAuthorizations');
  });

  it('rolling back the newest staged login does not turn an older authorize marker into revoke', () => {
    fs.mkdirSync(userDataDir, { recursive: true });
    const owner = { dataOwnerId: 'owner-a', generation: 1 };
    expect(bindNativeProviderAuth('anthropic')).toBe(true);

    const operationA = beginNativeProviderAuthAuthorization('anthropic', owner)!;
    expect(stageNativeProviderAuthAuthorization('anthropic', operationA)).toBe(true);
    const operationB = beginNativeProviderAuthAuthorization('anthropic', owner)!;
    expect(stageNativeProviderAuthAuthorization('anthropic', operationB)).toBe(true);

    expect(clearNativeProviderAuthAuthorizationPending('anthropic', operationB)).toBe(true);
    const pendingFile = path.join(userDataDir, 'native-provider-auth.pending', 'anthropic.json');
    expect(JSON.parse(fs.readFileSync(pendingFile, 'utf8'))).toMatchObject({
      intent: 'authorize',
      operationId: operationA.operationId,
    });
    expect(clearNativeProviderAuthAuthorizationPending('anthropic', operationA)).toBe(true);
    expect(fs.existsSync(pendingFile)).toBe(false);
    expect(getNativeProviderAuthBindingState('anthropic')).toBe('bound');
  });

  it('explicit logout may supersede only its own in-flight authorization marker', () => {
    fs.mkdirSync(userDataDir, { recursive: true });
    const ownerA = { dataOwnerId: 'owner-a', generation: 1 };
    const ownerB = { dataOwnerId: 'owner-b', generation: 2 };
    expect(bindNativeProviderAuth('anthropic')).toBe(true);
    const authorization = beginNativeProviderAuthAuthorization('anthropic', ownerA)!;
    expect(stageNativeProviderAuthAuthorization('anthropic', authorization)).toBe(true);
    const revocation = beginNativeProviderAuthRevocation('anthropic', ownerA)!;

    expect(
      markNativeProviderAuthRevocationPending('anthropic', ownerA, {
        supersedeMatchingAuthorization: true,
        operation: revocation,
      }),
    ).toBe(true);
    const pendingFile = path.join(userDataDir, 'native-provider-auth.pending', 'anthropic.json');
    expect(JSON.parse(fs.readFileSync(pendingFile, 'utf8'))).toMatchObject({
      intent: 'revoke',
      dataOwnerId: 'owner-a',
      generation: 1,
    });

    session.dataOwnerId = 'owner-b';
    session.generation = 2;
    expect(
      markNativeProviderAuthRevocationPending('anthropic', ownerB, {
        supersedeMatchingAuthorization: true,
      }),
    ).toBe(false);
  });

  it('a later logout overrides another process login intent and is fail-closed before pending stage', () => {
    fs.mkdirSync(userDataDir, { recursive: true });
    expect(bindNativeProviderAuth('anthropic')).toBe(true);

    session.dataOwnerId = 'owner-b';
    session.generation = 2;
    const earlierLogin = beginNativeProviderAuthAuthorization('anthropic', {
      dataOwnerId: 'owner-b',
      generation: 2,
    })!;

    // Browser authorization intent alone does not interrupt owner A's existing
    // credential while the user is still deciding in the browser.
    session.dataOwnerId = 'owner-a';
    session.generation = 1;
    expect(getNativeProviderAuthBindingState('anthropic')).toBe('bound');
    const laterLogout = beginNativeProviderAuthRevocation('anthropic', {
      dataOwnerId: 'owner-a',
      generation: 1,
    });
    expect(laterLogout).not.toBeNull();

    // Simulated crash immediately after begin: revoke intent itself is already
    // a read/claim tombstone, before the pending sidecar exists.
    expect(getNativeProviderAuthBindingState('anthropic')).toBe('unreadable');
    expect(claimDetectedNativeProviderAuth('anthropic', () => true)).toBe(false);

    session.dataOwnerId = 'owner-b';
    session.generation = 2;
    expect(stageNativeProviderAuthAuthorization('anthropic', earlierLogin)).toBe(false);
  });

  it('initial-login logout is ordered even when no main OAuth binding exists yet', () => {
    fs.mkdirSync(userDataDir, { recursive: true });
    const owner = { dataOwnerId: 'owner-a', generation: 1 };
    const earlierLogin = beginNativeProviderAuthAuthorization('anthropic', owner)!;
    const laterLogout = beginNativeProviderAuthDisconnect('anthropic', owner);
    expect(laterLogout).not.toBe('confirmed-unbound');
    expect(laterLogout).not.toBeNull();
    if (!laterLogout || laterLogout === 'confirmed-unbound') {
      throw new Error('expected a logout operation');
    }

    expect(getNativeProviderAuthBindingStateForOperation('anthropic', laterLogout)).toBe('unbound');
    expect(abandonNativeProviderAuthOperation('anthropic', laterLogout)).toBe(true);
    expect(stageNativeProviderAuthAuthorization('anthropic', earlierLogin)).toBe(false);
    expect(getNativeProviderAuthBindingState('anthropic')).toBe('unbound');
  });

  it('same-owner logout cancels a different-process generation initial login', () => {
    fs.mkdirSync(userDataDir, { recursive: true });
    session.generation = 2;
    const earlierLogin = beginNativeProviderAuthAuthorization('anthropic', {
      dataOwnerId: 'owner-a',
      generation: 2,
    })!;

    session.generation = 1;
    const laterLogout = beginNativeProviderAuthDisconnect('anthropic', {
      dataOwnerId: 'owner-a',
      generation: 1,
    });
    expect(laterLogout).not.toBe('confirmed-unbound');
    expect(laterLogout).not.toBeNull();
    if (!laterLogout || laterLogout === 'confirmed-unbound') {
      throw new Error('expected a logout operation');
    }
    expect(getNativeProviderAuthBindingStateForOperation('anthropic', laterLogout)).toBe('unbound');
    expect(abandonNativeProviderAuthOperation('anthropic', laterLogout)).toBe(true);

    session.generation = 2;
    expect(stageNativeProviderAuthAuthorization('anthropic', earlierLogin)).toBe(false);
  });

  it('another owner OAuth binding does not block the current owner gateway logout', () => {
    fs.mkdirSync(userDataDir, { recursive: true });
    session.dataOwnerId = 'owner-b';
    session.generation = 2;
    expect(bindNativeProviderAuth('anthropic')).toBe(true);

    session.dataOwnerId = 'owner-a';
    session.generation = 1;
    expect(
      beginNativeProviderAuthDisconnect('anthropic', {
        dataOwnerId: 'owner-a',
        generation: 1,
      }),
    ).toBe('confirmed-unbound');
    expect(JSON.parse(fs.readFileSync(bindingFile, 'utf8'))).toMatchObject({
      anthropic: 'owner-b',
    });
  });

  it('gateway logout cancels this owner in-flight login over a foreign OAuth binding', () => {
    fs.mkdirSync(userDataDir, { recursive: true });
    session.dataOwnerId = 'owner-b';
    session.generation = 2;
    expect(bindNativeProviderAuth('anthropic')).toBe(true);

    session.dataOwnerId = 'owner-a';
    session.generation = 1;
    const ownerA = { dataOwnerId: 'owner-a', generation: 1 };
    const earlierLogin = beginNativeProviderAuthAuthorization('anthropic', ownerA)!;
    const laterLogout = beginNativeProviderAuthDisconnect('anthropic', ownerA);
    expect(laterLogout).not.toBe('confirmed-unbound');
    expect(laterLogout).not.toBeNull();
    if (!laterLogout || laterLogout === 'confirmed-unbound') {
      throw new Error('expected a logout operation');
    }

    expect(getNativeProviderAuthBindingStateForOperation('anthropic', laterLogout)).toBe('unbound');
    expect(abandonNativeProviderAuthOperation('anthropic', laterLogout)).toBe(true);
    expect(stageNativeProviderAuthAuthorization('anthropic', earlierLogin)).toBe(false);
    expect(JSON.parse(fs.readFileSync(bindingFile, 'utf8'))).toMatchObject({
      anthropic: 'owner-b',
    });
  });

  it('a failed login after a begin-only logout crash cannot resurrect the residual credential', () => {
    fs.mkdirSync(userDataDir, { recursive: true });
    const owner = { dataOwnerId: 'owner-a', generation: 1 };
    expect(bindNativeProviderAuth('anthropic')).toBe(true);

    const crashedLogout = beginNativeProviderAuthRevocation('anthropic', owner)!;
    expect(getNativeProviderAuthBindingState('anthropic')).toBe('unreadable');

    // Simulate restart followed by a browser login that is cancelled before
    // stage. Beginning it may replace the operation nonce, but must first turn
    // the crashed logout into a persistent tombstone.
    const cancelledLogin = beginNativeProviderAuthAuthorization('anthropic', owner)!;
    const pendingFile = path.join(userDataDir, 'native-provider-auth.pending', 'anthropic.json');
    expect(JSON.parse(fs.readFileSync(pendingFile, 'utf8'))).toMatchObject({
      intent: 'revoke',
      dataOwnerId: 'owner-a',
      generation: 1,
      operationId: crashedLogout.operationId,
    });
    expect(abandonNativeProviderAuthOperation('anthropic', cancelledLogin)).toBe(true);

    expect(getNativeProviderAuthBindingState('anthropic')).toBe('unreadable');
    expect(claimDetectedNativeProviderAuth('anthropic', () => true)).toBe(false);
    expect(JSON.parse(fs.readFileSync(bindingFile, 'utf8'))).toMatchObject({
      anthropic: 'owner-a',
    });
  });

  it('a corrupt operation intent does not rewrite a readable pending owner', () => {
    fs.mkdirSync(userDataDir, { recursive: true });
    const ownerA = { dataOwnerId: 'owner-a', generation: 1 };
    expect(bindNativeProviderAuth('anthropic')).toBe(true);
    const revoke = beginNativeProviderAuthRevocation('anthropic', ownerA)!;
    expect(
      markNativeProviderAuthRevocationPending('anthropic', ownerA, { operation: revoke }),
    ).toBe(true);
    const operationFile = path.join(userDataDir, 'native-provider-auth.intent', 'anthropic.json');
    fs.writeFileSync(operationFile, '{ corrupt operation');

    session.dataOwnerId = 'owner-b';
    session.generation = 2;
    const recoveryLogin = beginNativeProviderAuthAuthorization('anthropic', {
      dataOwnerId: 'owner-b',
      generation: 2,
    })!;
    expect(abandonNativeProviderAuthOperation('anthropic', recoveryLogin)).toBe(true);

    const pendingFile = path.join(userDataDir, 'native-provider-auth.pending', 'anthropic.json');
    expect(JSON.parse(fs.readFileSync(pendingFile, 'utf8'))).toMatchObject({
      intent: 'revoke',
      dataOwnerId: 'owner-a',
      generation: 1,
      operationId: revoke.operationId,
    });
  });

  it('reports unreadable invalidation state as an error instead of a newer-auth null', () => {
    fs.mkdirSync(userDataDir, { recursive: true });
    const owner = { dataOwnerId: 'owner-a', generation: 1 };
    expect(bindNativeProviderAuth('anthropic')).toBe(true);
    const operationFile = path.join(userDataDir, 'native-provider-auth.intent', 'anthropic.json');
    fs.mkdirSync(path.dirname(operationFile), { recursive: true });
    fs.writeFileSync(operationFile, '{ corrupt operation');

    expect(() => beginNativeProviderAuthInvalidation('anthropic', owner)).toThrow(
      /operation intent is unreadable during invalidation/,
    );

    fs.rmSync(operationFile);
    fs.writeFileSync(bindingFile, '{ corrupt ownership');
    expect(() => beginNativeProviderAuthInvalidation('anthropic', owner)).toThrow(
      /ownership is unreadable during invalidation/,
    );
  });

  it('still returns null when a real newer authorization supersedes invalidation', () => {
    fs.mkdirSync(userDataDir, { recursive: true });
    const owner = { dataOwnerId: 'owner-a', generation: 1 };
    expect(bindNativeProviderAuth('anthropic')).toBe(true);
    expect(beginNativeProviderAuthAuthorization('anthropic', owner)).not.toBeNull();

    expect(beginNativeProviderAuthInvalidation('anthropic', owner)).toBeNull();
  });

  it('clears and unbinds a rejected credential without publishing an invalidate intent', () => {
    fs.mkdirSync(userDataDir, { recursive: true });
    const owner = { dataOwnerId: 'owner-a', generation: 1 };
    expect(bindNativeProviderAuth('anthropic')).toBe(true);
    const operationFile = path.join(userDataDir, 'native-provider-auth.intent', 'anthropic.json');
    const clearCredential = vi.fn(() => {
      expect(fs.existsSync(operationFile)).toBe(false);
      return 'cleared' as const;
    });

    expect(invalidateNativeProviderAuthWithoutIntent('anthropic', owner, clearCredential)).toEqual({
      state: 'committed',
      value: 'cleared',
    });
    expect(clearCredential).toHaveBeenCalledOnce();
    expect(fs.existsSync(operationFile)).toBe(false);
    expect(JSON.parse(fs.readFileSync(bindingFile, 'utf8'))).not.toHaveProperty('anthropic');
  });

  it('does not touch the credential when a newer explicit auth intent already exists', () => {
    fs.mkdirSync(userDataDir, { recursive: true });
    const owner = { dataOwnerId: 'owner-a', generation: 1 };
    expect(bindNativeProviderAuth('anthropic')).toBe(true);
    expect(beginNativeProviderAuthAuthorization('anthropic', owner)).not.toBeNull();
    const clearCredential = vi.fn(() => 'cleared' as const);

    expect(invalidateNativeProviderAuthWithoutIntent('anthropic', owner, clearCredential)).toEqual({
      state: 'changed',
    });
    expect(clearCredential).not.toHaveBeenCalled();
    expect(JSON.parse(fs.readFileSync(bindingFile, 'utf8'))).toMatchObject({
      anthropic: 'owner-a',
    });
  });

  it('a crash during credential clear leaves no provider-global invalidation intent', () => {
    fs.mkdirSync(userDataDir, { recursive: true });
    const owner = { dataOwnerId: 'owner-a', generation: 1 };
    expect(bindNativeProviderAuth('anthropic')).toBe(true);
    const operationFile = path.join(userDataDir, 'native-provider-auth.intent', 'anthropic.json');

    expect(() =>
      invalidateNativeProviderAuthWithoutIntent('anthropic', owner, () => {
        throw new Error('simulated process crash boundary');
      }),
    ).toThrow('simulated process crash boundary');
    expect(fs.existsSync(operationFile)).toBe(false);
    expect(JSON.parse(fs.readFileSync(bindingFile, 'utf8'))).toMatchObject({
      anthropic: 'owner-a',
    });
  });

  it('retries a revoke committed before crash and clears the leftover sidecar', () => {
    fs.mkdirSync(userDataDir, { recursive: true });
    const owner = { dataOwnerId: 'owner-a', generation: 1 };
    expect(bindNativeProviderAuth('anthropic')).toBe(true);
    const operation = beginNativeProviderAuthRevocation('anthropic', owner)!;
    expect(markNativeProviderAuthRevocationPending('anthropic', owner, { operation })).toBe(true);
    expect(validateNativeProviderAuthRevocationPending('anthropic', operation)).toBe(true);
    fs.writeFileSync(
      bindingFile,
      JSON.stringify({ revoked: { anthropic: 'owner-a' }, selfAuthorized: {} }),
    );
    expect(validateNativeProviderAuthRevocationPending('anthropic', operation)).toBe(true);

    expect(
      unbindNativeProviderAuth('anthropic', {
        revoked: true,
        expectedOperation: operation,
        requirePendingRevocation: true,
      }),
    ).toBe(true);
    expect(
      fs.existsSync(path.join(userDataDir, 'native-provider-auth.pending', 'anthropic.json')),
    ).toBe(false);
    expect(getNativeProviderAuthBindingState('anthropic')).toBe('unbound');
  });

  it('不可读期间留下 pending revocation,恢复为空和重启式重读后仍禁止自动认领', () => {
    fs.mkdirSync(userDataDir, { recursive: true });
    fs.writeFileSync(bindingFile, '{ broken ownership');

    markNativeProviderAuthRevocationPending('anthropic', {
      dataOwnerId: 'owner-a',
      generation: 1,
    });
    expect(getNativeProviderAuthBindingState('anthropic')).toBe('unreadable');

    // 模拟用户修复/恢复文件后再次启动：主 binding 变成空，但 pending sidecar 仍在。
    fs.writeFileSync(bindingFile, '{}');
    session.dataOwnerId = 'owner-b';
    session.generation = 2;
    expect(claimDetectedNativeProviderAuth('anthropic', () => true)).toBe(false);
    expect(getNativeProviderAuthBindingState('anthropic')).toBe('unreadable');

    // 另一账号也只有自己完成一次新的显式授权，才能解除 pending。
    bindNativeProviderAuth('anthropic');
    expect(getNativeProviderAuthBindingState('anthropic')).toBe('bound');
  });

  it('另一进程持有 binding mutation lock 时拒绝并发覆盖但保留只读快照', () => {
    fs.mkdirSync(userDataDir, { recursive: true });
    fs.writeFileSync(
      bindingFile,
      JSON.stringify({
        anthropic: 'owner-a',
        selfAuthorized: { anthropic: 'owner-a' },
      }),
    );
    const release = lockSync(path.join(userDataDir, '.native-provider-auth.write'), {
      realpath: false,
      stale: 15_000,
    });
    try {
      expect(() => claimDetectedNativeProviderAuth('anthropic', () => true)).toThrow();
      expect(getNativeProviderAuthBindingState('anthropic')).toBe('bound');
      expect(isNativeProviderAuthBound('anthropic')).toBe(true);
      expect(isNativeProviderAuthRevoked('anthropic')).toBe(false);
      expect(isNativeProviderAuthSelfAuthorized('anthropic')).toBe(true);
      expect(JSON.parse(fs.readFileSync(bindingFile, 'utf8'))).toMatchObject({
        anthropic: 'owner-a',
      });
    } finally {
      release();
    }

    expect(getNativeProviderAuthBindingState('anthropic')).toBe('bound');
    expect(isNativeProviderAuthBound('anthropic')).toBe(true);
    expect(isNativeProviderAuthRevoked('anthropic')).toBe(false);
    expect(isNativeProviderAuthSelfAuthorized('anthropic')).toBe(true);
  });

  it('绑定文件读不出来时不认领,也不覆盖它', () => {
    // 「归属信息丢失」不等于「没人绑过」。把损坏当空,等于在最不该下判断的时刻把共享
    // keychain 里的凭证判给当前账号,随后的写入还会把原有归属彻底盖掉(PR #548 review)。
    fs.mkdirSync(userDataDir, { recursive: true });
    fs.writeFileSync(bindingFile, '{ this is not json');

    expect(claimDetectedNativeProviderAuth('anthropic', () => true)).toBe(false);
    expect(isNativeProviderAuthBound('anthropic')).toBe(false);
    expect(getNativeProviderAuthBindingState('anthropic')).toBe('unreadable');
    expect(fs.readFileSync(bindingFile, 'utf8')).toBe('{ this is not json');

    // 一次性 legacy 迁移同样不推进 —— 它还会顺手消费掉 legacyClaimOwner 名额。
    migrateLegacyNativeProviderAuthBindings('owner-a', { anthropic: true });
    expect(fs.readFileSync(bindingFile, 'utf8')).toBe('{ this is not json');

    // JSON 合法但根不是对象(数组 / 标量)同样按不可读处理。
    fs.writeFileSync(bindingFile, '["owner-a"]');
    expect(claimDetectedNativeProviderAuth('anthropic', () => true)).toBe(false);
    expect(getNativeProviderAuthBindingState('anthropic')).toBe('unreadable');
  });

  it.each(['EACCES', 'EIO'])('%s 读取失败保持 unreadable,不会当成 ENOENT 空状态', (code) => {
    fs.mkdirSync(userDataDir, { recursive: true });
    fs.writeFileSync(bindingFile, JSON.stringify({ anthropic: 'owner-a' }));
    const realRead = fs.readFileSync;
    const spy = vi.spyOn(fs, 'readFileSync').mockImplementation(((file, ...args: unknown[]) => {
      if (String(file) === bindingFile) {
        throw Object.assign(new Error(`simulated ${code}`), { code });
      }
      return realRead(file, ...(args as []));
    }) as typeof fs.readFileSync);
    try {
      expect(getNativeProviderAuthBindingState('anthropic')).toBe('unreadable');
      expect(claimDetectedNativeProviderAuth('anthropic', () => true)).toBe(false);
    } finally {
      spy.mockRestore();
    }
    expect(JSON.parse(fs.readFileSync(bindingFile, 'utf8'))).toEqual({ anthropic: 'owner-a' });
  });

  it('绑定文件读不出来时,显式登出也不覆盖它', () => {
    // 用户要的是「登出这一个 provider」。覆盖损坏文件 = 写出一份只剩撤销标记的新文件,
    // 其余 provider 从此无主,下一次可信读取就会把它们的残留凭证认领给当前账号 ——
    // 正是上一条刚堵掉的那个洞的另一个入口(PR #548 review)。
    fs.mkdirSync(userDataDir, { recursive: true });
    fs.writeFileSync(bindingFile, '{ this is not json');

    unbindNativeProviderAuth('anthropic', { revoked: true });
    expect(fs.readFileSync(bindingFile, 'utf8')).toBe('{ this is not json');
    // 不写标记不等于放开:同一条件下认领本来就被拒,用户看到的也一直是未连接。
    expect(claimDetectedNativeProviderAuth('anthropic', () => true)).toBe(false);
    expect(isNativeProviderAuthBound('anthropic')).toBe(false);
  });

  it('revoked 字段被改坏时按不可读处理,而不是抛穿', () => {
    // `provider in bindings.revoked` 的右操作数是原始值时直接抛 TypeError —— 一个手工
    // 改坏的字段会让认领、迁移、登出全炸在这里(PR #548 review)。
    fs.mkdirSync(userDataDir, { recursive: true });
    for (const bad of ['{"revoked":"anthropic"}', '{"revoked":1}', '{"revoked":["anthropic"]}']) {
      fs.writeFileSync(bindingFile, bad);
      expect(() => claimDetectedNativeProviderAuth('anthropic', () => true)).not.toThrow();
      expect(claimDetectedNativeProviderAuth('anthropic', () => true)).toBe(false);
      expect(getNativeProviderAuthBindingState('anthropic')).toBe('unreadable');
      expect(() => unbindNativeProviderAuth('anthropic', { revoked: true })).not.toThrow();
      expect(() =>
        migrateLegacyNativeProviderAuthBindings('owner-a', { anthropic: true }),
      ).not.toThrow();
      expect(fs.readFileSync(bindingFile, 'utf8')).toBe(bad); // 一律不改写
    }

    // 用户再次显式授权仍能把文件修回来 —— 否则坏字段会把这个 provider 永久锁死。
    fs.writeFileSync(bindingFile, '{"revoked":"anthropic"}');
    expect(() => bindNativeProviderAuth('anthropic')).not.toThrow();
    expect(isNativeProviderAuthBound('anthropic')).toBe(true);
  });

  it('整份读不出来时,显式授权也不写出一份「只有我」的干净文件', () => {
    // legacyClaimOwner 与各家 owner 一起没了,无可保留;但就这么写一份干净文件,等于让其余
    // provider 的残留凭证在文件恢复可读后立刻可被认领(PR #548 review)。
    fs.mkdirSync(userDataDir, { recursive: true });
    fs.writeFileSync(bindingFile, '{ not json at all');

    bindNativeProviderAuth('xai');
    const after = JSON.parse(fs.readFileSync(bindingFile, 'utf8'));
    expect(after.xai).toBe('owner-a');
    expect(after.revoked).toMatchObject({ anthropic: 'owner-a', openai: 'owner-a' });
    expect(claimDetectedNativeProviderAuth('anthropic', () => true)).toBe(false);
    expect(claimDetectedNativeProviderAuth('openai', () => true)).toBe(false);
  });

  it('修 revoked 时保住别人的归属,并对其余 provider 保守抑制', () => {
    // 直接重写成「只有本次授权的这家」会抹掉 openai 的 owner-b,那份残留凭证下一次就会被
    // 认领给 owner-a —— 用一次修复换来一个新的越权口子(PR #548 review)。
    fs.mkdirSync(userDataDir, { recursive: true });
    fs.writeFileSync(bindingFile, JSON.stringify({ openai: 'owner-b', revoked: 1 }));

    bindNativeProviderAuth('anthropic');
    const after = JSON.parse(fs.readFileSync(bindingFile, 'utf8'));
    expect(after.openai).toBe('owner-b'); // 别人的归属原样保留
    expect(after.anthropic).toBe('owner-a');

    // 坏掉的 revoked 无从得知谁被撤销过,不能直接丢弃(丢弃 = 给所有残留凭证放行)。
    expect(after.revoked).toMatchObject({ openai: 'owner-a', xai: 'owner-a' });
    expect(after.revoked).not.toHaveProperty('anthropic');
    expect(claimDetectedNativeProviderAuth('xai', () => true)).toBe(false);
    // 本次授权的这家不受抑制,且 owner-b 的 openai 依然轮不到 owner-a。
    expect(isNativeProviderAuthBound('anthropic')).toBe(true);
    expect(isNativeProviderAuthBound('openai')).toBe(false);
  });

  it('文件确实不存在 = 合法首次状态,照常认领', () => {
    // 与「读失败」必须分开:ENOENT 是全新安装的正常形态,挡掉它等于把自动继承整条废掉。
    expect(fs.existsSync(bindingFile)).toBe(false);
    expect(claimDetectedNativeProviderAuth('anthropic', () => true)).toBe(true);
  });

  it('treats corrupted falsy slot values as claimed-by-unknown and fails closed', () => {
    // 键存在但值为假(损坏 / 异常写入):按「归属不明」拒绝,绝不重认领。
    fs.mkdirSync(userDataDir, { recursive: true });
    fs.writeFileSync(bindingFile, JSON.stringify({ openai: '' }));
    expect(claimDetectedNativeProviderAuth('openai', () => true)).toBe(false);

    fs.writeFileSync(bindingFile, JSON.stringify({ legacyClaimOwner: '' }));
    expect(claimDetectedNativeProviderAuth('openai', () => true)).toBe(false);
    expect(JSON.parse(fs.readFileSync(bindingFile, 'utf8'))).toEqual({ legacyClaimOwner: '' });
  });
});

describe('restoreNativeProviderAuthForRecovery', () => {
  it('restores the invalidated owner even when another owner won the legacy claim', () => {
    fs.mkdirSync(userDataDir, { recursive: true });
    fs.writeFileSync(bindingFile, JSON.stringify({ legacyClaimOwner: 'owner-a' }));
    session.dataOwnerId = 'owner-b';

    expect(restoreNativeProviderAuthForRecovery('openai', 'owner-b', () => true)).toBe(true);
    expect(JSON.parse(fs.readFileSync(bindingFile, 'utf8'))).toMatchObject({
      legacyClaimOwner: 'owner-a',
      openai: 'owner-b',
    });
  });

  it('does not restore after the active owner changes', () => {
    fs.mkdirSync(userDataDir, { recursive: true });
    fs.writeFileSync(bindingFile, JSON.stringify({ legacyClaimOwner: 'owner-a' }));
    session.dataOwnerId = 'owner-c';

    expect(restoreNativeProviderAuthForRecovery('openai', 'owner-b', () => true)).toBe(false);
    expect(JSON.parse(fs.readFileSync(bindingFile, 'utf8'))).toEqual({
      legacyClaimOwner: 'owner-a',
    });
  });

  it('keeps explicit revocation and session boundaries fail-closed', () => {
    fs.mkdirSync(userDataDir, { recursive: true });
    fs.writeFileSync(
      bindingFile,
      JSON.stringify({
        legacyClaimOwner: 'owner-a',
        revoked: { openai: 'owner-b' },
      }),
    );
    session.dataOwnerId = 'owner-b';

    expect(restoreNativeProviderAuthForRecovery('openai', 'owner-b', () => true)).toBe(false);
    session.boundaryPending = true;
    expect(restoreNativeProviderAuthForRecovery('openai', 'owner-b', () => true)).toBe(false);
    expect(JSON.parse(fs.readFileSync(bindingFile, 'utf8'))).not.toHaveProperty('openai');
  });
});

describe('durable native credential rejection fence', () => {
  const fingerprint = 'a'.repeat(64);

  function authorizeSameFingerprint(): string {
    const owner = { dataOwnerId: 'owner-a', generation: 1 };
    const operation = beginNativeProviderAuthAuthorization('anthropic', owner)!;
    expect(stageNativeProviderAuthAuthorization('anthropic', operation)).toBe(true);
    expect(bindNativeProviderAuth('anthropic', operation, fingerprint)).toBe(true);
    return operation.operationId;
  }

  it('keeps an invalid grant rejected across restart while allowing only a later explicit revision', async () => {
    const revision1 = authorizeSameFingerprint();
    expect(getNativeProviderAuthCredentialRejectionState('anthropic', fingerprint, revision1)).toBe(
      'allowed',
    );
    expect(getNativeProviderAuthCredentialRejectionState('anthropic', fingerprint, null)).toBe(
      'allowed',
    );

    expect(markNativeProviderAuthCredentialRejected('anthropic', fingerprint, revision1)).toBe(
      true,
    );
    expect(getNativeProviderAuthCredentialRejectionState('anthropic', fingerprint, revision1)).toBe(
      'rejected',
    );
    expect(getNativeProviderAuthCredentialRejectionState('anthropic', fingerprint, null)).toBe(
      'rejected',
    );

    const revision2 = authorizeSameFingerprint();
    expect(getNativeProviderAuthCredentialRejectionState('anthropic', fingerprint, revision2)).toBe(
      'allowed',
    );
    expect(getNativeProviderAuthCredentialRejectionState('anthropic', fingerprint, revision1)).toBe(
      'rejected',
    );
    expect(getNativeProviderAuthCredentialRejectionState('anthropic', fingerprint, null)).toBe(
      'rejected',
    );

    vi.resetModules();
    const restarted = await import('../nativeProviderAuthBinding.js');
    expect(
      restarted.getNativeProviderAuthCredentialRejectionState('anthropic', fingerprint, revision2),
    ).toBe('allowed');
    expect(
      restarted.getNativeProviderAuthCredentialRejectionState('anthropic', fingerprint, revision1),
    ).toBe('rejected');
    expect(
      restarted.getNativeProviderAuthCredentialRejectionState('anthropic', fingerprint, null),
    ).toBe('rejected');
  });

  it('recovery sidecar survives restart when the primary rejection record is unreadable', async () => {
    const revision1 = authorizeSameFingerprint();
    const rejectionFile = path.join(
      userDataDir,
      'native-provider-auth.rejected',
      'anthropic',
      `${fingerprint}.json`,
    );
    fs.writeFileSync(rejectionFile, '{ unreadable primary rejection state');

    expect(() =>
      markNativeProviderAuthCredentialRejected('anthropic', fingerprint, revision1),
    ).toThrow(/rejection state is unreadable/i);
    expect(
      markNativeProviderAuthCredentialRejectionRecovery('anthropic', fingerprint, revision1),
    ).toBe(true);
    expect(getNativeProviderAuthCredentialRejectionState('anthropic', fingerprint, revision1)).toBe(
      'rejected',
    );

    vi.resetModules();
    const restarted = await import('../nativeProviderAuthBinding.js');
    expect(
      restarted.getNativeProviderAuthCredentialRejectionState('anthropic', fingerprint, revision1),
    ).toBe('rejected');

    const owner = { dataOwnerId: 'owner-a', generation: 1 };
    const operation = restarted.beginNativeProviderAuthAuthorization('anthropic', owner)!;
    expect(restarted.stageNativeProviderAuthAuthorization('anthropic', operation)).toBe(true);
    expect(restarted.bindNativeProviderAuth('anthropic', operation, fingerprint)).toBe(true);
    const revision2 = operation.operationId;
    expect(
      restarted.getNativeProviderAuthCredentialRejectionState('anthropic', fingerprint, revision2),
    ).toBe('allowed');
    expect(
      restarted.getNativeProviderAuthCredentialRejectionState('anthropic', fingerprint, revision1),
    ).toBe('rejected');
  });

  it('attributes a stripped marker to its read-time epoch and a stale rejection cannot kill r2', () => {
    const revision1 = authorizeSameFingerprint();
    const markerless = resolveNativeProviderAuthCredentialRejection('anthropic', fingerprint, null);
    expect(markerless).toEqual({
      state: 'allowed',
      effectiveAuthorizationRevision: revision1,
    });

    const revision2 = authorizeSameFingerprint();
    expect(
      markNativeProviderAuthCredentialRejected(
        'anthropic',
        fingerprint,
        markerless.effectiveAuthorizationRevision,
      ),
    ).toBe(true);
    expect(getNativeProviderAuthCredentialRejectionState('anthropic', fingerprint, revision2)).toBe(
      'allowed',
    );
    expect(getNativeProviderAuthCredentialRejectionState('anthropic', fingerprint, revision1)).toBe(
      'rejected',
    );
    expect(getNativeProviderAuthCredentialRejectionState('anthropic', fingerprint, null)).toBe(
      'rejected',
    );
  });

  it('a markerless invalid_grant rejects rollback of its original explicit revision', () => {
    const revision = authorizeSameFingerprint();
    const markerless = resolveNativeProviderAuthCredentialRejection('anthropic', fingerprint, null);
    expect(
      markNativeProviderAuthCredentialRejected(
        'anthropic',
        fingerprint,
        markerless.effectiveAuthorizationRevision,
      ),
    ).toBe(true);
    expect(getNativeProviderAuthCredentialRejectionState('anthropic', fingerprint, revision)).toBe(
      'rejected',
    );
    expect(getNativeProviderAuthCredentialRejectionState('anthropic', fingerprint, null)).toBe(
      'rejected',
    );
  });

  it('repairs a corrupt rejection record only through an explicit authorization', () => {
    const firstRevision = authorizeSameFingerprint();
    markNativeProviderAuthCredentialRejected('anthropic', fingerprint, firstRevision);
    const rejectionFile = path.join(
      userDataDir,
      'native-provider-auth.rejected',
      'anthropic',
      `${fingerprint}.json`,
    );
    fs.writeFileSync(rejectionFile, '{ corrupt rejection state');

    expect(getNativeProviderAuthCredentialRejectionState('anthropic', fingerprint, null)).toBe(
      'unreadable',
    );
    const repairedRevision = authorizeSameFingerprint();
    expect(
      getNativeProviderAuthCredentialRejectionState('anthropic', fingerprint, repairedRevision),
    ).toBe('allowed');
    expect(
      getNativeProviderAuthCredentialRejectionState('anthropic', fingerprint, firstRevision),
    ).toBe('rejected');
    expect(JSON.parse(fs.readFileSync(rejectionFile, 'utf8'))).toMatchObject({
      authorizationRevision: repairedRevision,
      rejected: false,
      rejectionObserved: true,
    });
  });

  it('a late r1 rejection cannot repair unreadable state and delete r2', () => {
    const revision1 = authorizeSameFingerprint();
    const revision2 = authorizeSameFingerprint();
    const rejectionFile = path.join(
      userDataDir,
      'native-provider-auth.rejected',
      'anthropic',
      `${fingerprint}.json`,
    );
    fs.writeFileSync(rejectionFile, '{ corrupt rejection state');

    expect(() =>
      markNativeProviderAuthCredentialRejected('anthropic', fingerprint, revision1),
    ).toThrow(/rejection state is unreadable/i);
    expect(getNativeProviderAuthCredentialRejectionState('anthropic', fingerprint, revision2)).toBe(
      'unreadable',
    );
    expect(fs.readFileSync(rejectionFile, 'utf8')).toBe('{ corrupt rejection state');
  });

  it.each(['EPERM', 'EEXIST'])(
    'uses the rollback-safe Windows %s protocol when updating a rejection sidecar',
    (code) => {
      const revision = authorizeSameFingerprint();
      const rejectionFile = path.join(
        userDataDir,
        'native-provider-auth.rejected',
        'anthropic',
        `${fingerprint}.json`,
      );
      const realRename = fs.renameSync;
      let firstPublish = true;
      let publishes = 0;
      const renameSpy = vi.spyOn(fs, 'renameSync').mockImplementation(((from, to) => {
        if (String(from).endsWith('.tmp') && String(to) === rejectionFile) {
          publishes += 1;
          if (firstPublish) {
            firstPublish = false;
            throw Object.assign(new Error(code), { code });
          }
        }
        return realRename(from, to);
      }) as typeof fs.renameSync);

      try {
        expect(markNativeProviderAuthCredentialRejected('anthropic', fingerprint, revision)).toBe(
          true,
        );
      } finally {
        renameSpy.mockRestore();
      }
      expect(publishes).toBe(2);
      expect(JSON.parse(fs.readFileSync(rejectionFile, 'utf8'))).toMatchObject({
        authorizationRevision: revision,
        rejected: true,
        rejectionObserved: true,
      });
      expect(fs.existsSync(`${rejectionFile}.bak`)).toBe(false);
    },
  );

  it('reads the rejection sidecar inside an auto-claim binding transaction without re-locking', () => {
    const revision = authorizeSameFingerprint();
    unbindNativeProviderAuth('anthropic');
    expect(
      claimDetectedNativeProviderAuth(
        'anthropic',
        () =>
          getNativeProviderAuthCredentialRejectionStateForBindingTransaction(
            'anthropic',
            fingerprint,
            revision,
          ) === 'allowed',
      ),
    ).toBe(true);
  });

  it('keeps the binding lock through a storage-transaction rejection decision and callback', () => {
    const revision = authorizeSameFingerprint();

    const result = runWithNativeProviderAuthCredentialRejectionForStorageMutation(
      'anthropic',
      fingerprint,
      revision,
      (decision) => ({
        decision,
        nestedState: getNativeProviderAuthCredentialRejectionStateForBindingTransaction(
          'anthropic',
          fingerprint,
          revision,
        ),
      }),
    );

    expect(result).toEqual({
      decision: { state: 'allowed', effectiveAuthorizationRevision: revision },
      nestedState: 'allowed',
    });
  });
});

describe('凭证来路(selfAuthorized)—— 显式授权 vs 自动继承', () => {
  // 存在的理由:两者结果相同(绑到当前 owner、凭证可用),但用户可见文案的依据不同 ——
  // 「已沿用这台电脑上登录的账号」只对继承成立(PR #1076 review 第三轮)。

  it('显式授权记下来路,自动认领不记', () => {
    bindNativeProviderAuth('anthropic');
    expect(isNativeProviderAuthSelfAuthorized('anthropic')).toBe(true);

    expect(claimDetectedNativeProviderAuth('openai', () => true)).toBe(true);
    expect(isNativeProviderAuthSelfAuthorized('openai')).toBe(false);
  });

  it('来路按 provider 分别记账,不互相串味', () => {
    bindNativeProviderAuth('anthropic');
    expect(claimDetectedNativeProviderAuth('openai', () => true)).toBe(true);
    expect(isNativeProviderAuthSelfAuthorized('anthropic')).toBe(true);
    expect(isNativeProviderAuthSelfAuthorized('openai')).toBe(false);
  });

  it('登出清掉来路 —— 之后残留凭证对 Cindy 重新是「外部已有的」', () => {
    bindNativeProviderAuth('anthropic');
    expect(isNativeProviderAuthSelfAuthorized('anthropic')).toBe(true);

    unbindNativeProviderAuth('anthropic');
    expect(isNativeProviderAuthSelfAuthorized('anthropic')).toBe(false);
  });

  it('显式登出(带 revoked 标记)同样清掉来路', () => {
    bindNativeProviderAuth('openai');
    unbindNativeProviderAuth('openai', { revoked: true });
    expect(isNativeProviderAuthSelfAuthorized('openai')).toBe(false);
  });

  it('从没绑定过的 provider 不算自己授权过', () => {
    expect(isNativeProviderAuthSelfAuthorized('xai')).toBe(false);
  });

  it('绑定文件读不出来时保守按「自己授权过」——说不清来路就不要声称是继承', () => {
    fs.mkdirSync(userDataDir, { recursive: true });
    fs.writeFileSync(bindingFile, '{ this is not json');
    expect(isNativeProviderAuthSelfAuthorized('anthropic')).toBe(true);
  });
});
