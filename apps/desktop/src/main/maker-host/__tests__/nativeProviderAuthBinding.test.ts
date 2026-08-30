import fs from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createBetterSqliteDatabase } from '../../localDb/betterSqliteFactory.js';

const userDataDir = '/tmp/native-provider-auth-binding-test';
const session = { dataOwnerId: 'owner-a' as string | null, boundaryPending: false };

vi.mock('electron', () => ({
  app: { getPath: () => userDataDir },
}));

vi.mock('../../appSessionState.js', () => ({
  LOCAL_DATA_OWNER_ID: 'local-v1',
  getActiveAppSession: () => ({
    mode: session.dataOwnerId ? 'cloud' : 'signed-out',
    dataOwnerId: session.dataOwnerId,
    generation: 1,
  }),
  isAppSessionBoundaryPending: () => session.boundaryPending,
}));

import {
  bindNativeProviderAuth,
  claimDetectedNativeProviderAuth,
  getNativeProviderAuthSource,
  isNativeProviderAuthBound,
  isNativeProviderAuthRevoked,
  isNativeProviderAuthSelfAuthorized,
  migrateLocalNativeProviderAuthBindings,
  migrateLegacyNativeProviderAuthBindings,
  readLegacyNativeProviderAuthOwner,
  recoverPendingLegacyNativeProviderAuthOwner,
  reserveCommittedLegacyNativeProviderAuthOwner,
  reserveLegacyNativeProviderAuthOwner,
  reserveLegacyNativeProviderAuthOwnerDetailed,
  releaseLegacyNativeProviderAuthOwner,
  restoreNativeProviderAuthForRecovery,
  unbindNativeProviderAuth,
} from '../nativeProviderAuthBinding.js';

const bindingFile = path.join(userDataDir, 'native-provider-auth.json');
const bindingLockDb = `${bindingFile}.mutation-lock.db`;

afterEach(() => {
  vi.restoreAllMocks();
  session.dataOwnerId = 'owner-a';
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
      sources: { anthropic: 'native-harness-inherited' },
    });
  });

  it('migrates an old Cindy xAI token as explicit provider OAuth, never CLI inheritance', () => {
    migrateLegacyNativeProviderAuthBindings('owner-a', { xai: true });
    expect(getNativeProviderAuthSource('xai')).toBe('explicit-provider-oauth');
    expect(isNativeProviderAuthSelfAuthorized('xai')).toBe(true);

    unbindNativeProviderAuth('xai');
    session.dataOwnerId = 'owner-b';
    migrateLegacyNativeProviderAuthBindings('owner-b', { xai: true });

    expect(isNativeProviderAuthBound('xai')).toBe(false);
  });

  it('lets the reserved owner finish legacy migration after credentials become available', () => {
    expect(reserveLegacyNativeProviderAuthOwner('owner-a')).toBe('claimed');

    migrateLegacyNativeProviderAuthBindings('owner-a', { xai: true });

    expect(isNativeProviderAuthBound('xai')).toBe(true);
    expect(getNativeProviderAuthSource('xai')).toBe('explicit-provider-oauth');
    expect(isNativeProviderAuthSelfAuthorized('xai')).toBe(true);
  });

  it('does not rewrite an unchanged legacy binding for the reserved owner', () => {
    expect(reserveLegacyNativeProviderAuthOwner('owner-a')).toBe('claimed');
    const renameSpy = vi.spyOn(fs, 'renameSync');
    fs.rmSync(bindingLockDb, { force: true });

    migrateLegacyNativeProviderAuthBindings('owner-a', {});

    expect(renameSpy).not.toHaveBeenCalledWith(expect.any(String), bindingFile);
    expect(fs.existsSync(bindingLockDb)).toBe(false);
  });

  it('treats a malformed provider owner slot as occupied during repeatable migration', () => {
    fs.mkdirSync(userDataDir, { recursive: true });
    fs.writeFileSync(
      bindingFile,
      JSON.stringify({ legacyClaimOwner: 'owner-a', openai: '' }),
    );

    migrateLegacyNativeProviderAuthBindings('owner-a', { openai: true });

    expect(JSON.parse(fs.readFileSync(bindingFile, 'utf8'))).toEqual({
      legacyClaimOwner: 'owner-a',
      openai: '',
    });
  });

  it('does not acquire the mutation lock for a known no-op claim', () => {
    expect(claimDetectedNativeProviderAuth('openai', () => true)).toBe(true);
    fs.rmSync(bindingLockDb, { force: true });
    const hasCredential = vi.fn(() => true);

    expect(claimDetectedNativeProviderAuth('openai', hasCredential)).toBe(false);

    expect(hasCredential).not.toHaveBeenCalled();
    expect(fs.existsSync(bindingLockDb)).toBe(false);
  });
});

describe('local → cloud native provider binding migration', () => {
  it('flushes the binding file and parent directory before reporting a reservation', () => {
    const openSpy = vi.spyOn(fs, 'openSync');
    const fsyncSpy = vi.spyOn(fs, 'fsyncSync');

    expect(reserveLegacyNativeProviderAuthOwner('owner-a')).toBe('claimed');

    expect(openSpy).toHaveBeenCalledWith(bindingFile, 'r+');
    if (process.platform !== 'win32') {
      expect(openSpy).toHaveBeenCalledWith(userDataDir, 'r');
    }
    expect(fsyncSpy).toHaveBeenCalled();
  });

  it('retries transient Windows-style binding publication locks', () => {
    expect(reserveLegacyNativeProviderAuthOwner('owner-a')).toBe('claimed');
    const originalRenameSync = fs.renameSync.bind(fs);
    let blocked = false;
    const renameSpy = vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (!blocked && to === bindingFile) {
        blocked = true;
        throw Object.assign(new Error('file is temporarily busy'), { code: 'EBUSY' });
      }
      return originalRenameSync(from, to);
    });

    expect(recoverPendingLegacyNativeProviderAuthOwner('owner-a')).toBe('finalized');
    expect(blocked).toBe(true);
    expect(renameSpy.mock.calls.filter(([, to]) => to === bindingFile)).toHaveLength(2);
    expect(JSON.parse(fs.readFileSync(bindingFile, 'utf8'))).toMatchObject({
      legacyClaimOwner: 'owner-a',
    });
    expect(JSON.parse(fs.readFileSync(bindingFile, 'utf8'))).not.toHaveProperty(
      'legacyClaimToken',
    );
  });

  it('restores the atomic backup before deriving a binding update', () => {
    const retained = {
      openai: 'owner-a',
      legacyClaimOwner: 'owner-a',
      revoked: { anthropic: 'owner-a' },
    };
    fs.mkdirSync(userDataDir, { recursive: true });
    fs.writeFileSync(`${bindingFile}.bak`, JSON.stringify(retained));

    bindNativeProviderAuth('xai');

    expect(fs.existsSync(`${bindingFile}.bak`)).toBe(false);
    expect(JSON.parse(fs.readFileSync(bindingFile, 'utf8'))).toMatchObject({
      ...retained,
      xai: 'owner-a',
      selfAuthorized: { xai: 'owner-a' },
    });
  });

  it('restores a backup only while holding the shared mutation lock', () => {
    fs.mkdirSync(userDataDir, { recursive: true });
    fs.writeFileSync(
      `${bindingFile}.bak`,
      JSON.stringify({ openai: 'owner-a', legacyClaimOwner: 'owner-a' }),
    );
    const originalRenameSync = fs.renameSync.bind(fs);
    const lockObserved: boolean[] = [];
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (from === `${bindingFile}.bak` && to === bindingFile) {
        const contender = createBetterSqliteDatabase(bindingLockDb);
        contender.pragma('busy_timeout = 1');
        try {
          contender.exec('BEGIN IMMEDIATE');
          contender.exec('ROLLBACK');
          lockObserved.push(false);
        } catch (error) {
          lockObserved.push((error as { code?: string }).code === 'SQLITE_BUSY');
        } finally {
          contender.close();
        }
      }
      return originalRenameSync(from, to);
    });

    expect(isNativeProviderAuthBound('openai')).toBe(true);
    expect(lockObserved).toEqual([true]);
  });

  it('uses a crash-released SQLite transaction lock instead of a reclaimable lease file', () => {
    expect(reserveLegacyNativeProviderAuthOwner('owner-a')).toBe('claimed');

    expect(fs.existsSync(bindingLockDb)).toBe(true);
    expect(fs.existsSync(`${bindingFile}.legacy-claim-lease`)).toBe(false);
  });

  it('surfaces mutation-lock acquisition failure during explicit unbind', () => {
    fs.mkdirSync(bindingLockDb, { recursive: true });

    expect(() => unbindNativeProviderAuth('openai', { revoked: true })).toThrow(
      'failed to acquire native provider binding mutation lock',
    );
  });

  it('avoids the mutation lock for a known no-op invalidation unbind', () => {
    expect(claimDetectedNativeProviderAuth('openai', () => true)).toBe(true);
    unbindNativeProviderAuth('openai');
    fs.rmSync(bindingLockDb, { force: true });

    unbindNativeProviderAuth('openai');

    expect(fs.existsSync(bindingLockDb)).toBe(false);
  });

  it('removes a stale source field even when the provider slot is already absent', () => {
    fs.mkdirSync(userDataDir, { recursive: true });
    fs.writeFileSync(
      bindingFile,
      JSON.stringify({ sources: { openai: 'native-harness-inherited' } }),
    );

    unbindNativeProviderAuth('openai');

    expect(JSON.parse(fs.readFileSync(bindingFile, 'utf8'))).toEqual({ sources: {} });
  });

  it('reads every binding mutation while holding the shared SQLite writer lock', () => {
    const originalReadFileSync = fs.readFileSync.bind(fs);
    const leaseObserved: boolean[] = [];
    vi.spyOn(fs, 'readFileSync').mockImplementation(((file, ...args: unknown[]) => {
      if (file === bindingFile) {
        const contender = createBetterSqliteDatabase(bindingLockDb);
        contender.pragma('busy_timeout = 1');
        try {
          contender.exec('BEGIN IMMEDIATE');
          contender.exec('ROLLBACK');
          leaseObserved.push(false);
        } catch (error) {
          leaseObserved.push((error as { code?: string }).code === 'SQLITE_BUSY');
        } finally {
          contender.close();
        }
      }
      return originalReadFileSync(file as fs.PathOrFileDescriptor, ...(args as []));
    }) as typeof fs.readFileSync);

    bindNativeProviderAuth('anthropic');
    unbindNativeProviderAuth('anthropic', { revoked: true });

    expect(leaseObserved.length).toBeGreaterThanOrEqual(2);
    expect(leaseObserved.every(Boolean)).toBe(true);
  });

  it('reserves the first cloud owner even when no local provider slot exists', () => {
    expect(reserveLegacyNativeProviderAuthOwner('owner-a')).toBe('claimed');
    expect(JSON.parse(fs.readFileSync(bindingFile, 'utf8'))).toMatchObject({
      legacyClaimOwner: 'owner-a',
    });
    expect(JSON.parse(fs.readFileSync(bindingFile, 'utf8')).legacyClaimToken).toEqual(
      expect.any(String),
    );

    session.dataOwnerId = 'owner-b';
    expect(reserveLegacyNativeProviderAuthOwner('owner-b')).toBe('owned-by-other');
  });

  it('releases only the native reservation created by the matching claim token', () => {
    const reservation = reserveLegacyNativeProviderAuthOwnerDetailed('owner-a');
    expect(reservation).toMatchObject({ status: 'claimed', claimToken: expect.any(String) });
    expect(reserveLegacyNativeProviderAuthOwnerDetailed('owner-a')).toEqual({
      status: 'already-owned',
    });
    const beforeWrongToken = fs.readFileSync(bindingFile, 'utf8');
    expect(releaseLegacyNativeProviderAuthOwner('owner-a', 'wrong-token')).toBe(false);
    expect(fs.readFileSync(bindingFile, 'utf8')).toBe(beforeWrongToken);
    session.dataOwnerId = 'owner-b';
    expect(reserveLegacyNativeProviderAuthOwner('owner-b')).toBe('owned-by-other');
    session.dataOwnerId = 'owner-a';
    expect(releaseLegacyNativeProviderAuthOwner('owner-a', reservation.claimToken!)).toBe(true);
    session.dataOwnerId = 'owner-b';
    expect(reserveLegacyNativeProviderAuthOwner('owner-b')).toBe('claimed');
  });

  it('finalizes a pending native reservation for the committed owner', () => {
    const reservation = reserveLegacyNativeProviderAuthOwnerDetailed('owner-a');
    expect(reservation).toMatchObject({ status: 'claimed', claimToken: expect.any(String) });

    expect(recoverPendingLegacyNativeProviderAuthOwner('owner-a')).toBe('finalized');
    expect(releaseLegacyNativeProviderAuthOwner('owner-a', reservation.claimToken!)).toBe(false);
    session.dataOwnerId = 'owner-b';
    expect(reserveLegacyNativeProviderAuthOwner('owner-b')).toBe('owned-by-other');
  });

  it('creates a tokenless native reservation for an already durable cloud owner', () => {
    expect(reserveCommittedLegacyNativeProviderAuthOwner('owner-a')).toBe('claimed');
    const bindings = JSON.parse(fs.readFileSync(bindingFile, 'utf8'));
    expect(bindings).toMatchObject({ legacyClaimOwner: 'owner-a' });
    expect(bindings).not.toHaveProperty('legacyClaimToken');
    expect(recoverPendingLegacyNativeProviderAuthOwner(null)).toBe('none');
    session.dataOwnerId = 'owner-b';
    expect(reserveLegacyNativeProviderAuthOwner('owner-b')).toBe('owned-by-other');
  });

  it('exposes only a valid tokenless native owner for profile-marker bootstrap', () => {
    expect(readLegacyNativeProviderAuthOwner()).toEqual({ status: 'none' });
    expect(reserveCommittedLegacyNativeProviderAuthOwner('owner-a')).toBe('claimed');
    expect(readLegacyNativeProviderAuthOwner()).toEqual({ status: 'owned', ownerId: 'owner-a' });

    fs.writeFileSync(bindingFile, JSON.stringify({ legacyClaimOwner: '' }));
    expect(readLegacyNativeProviderAuthOwner()).toEqual({ status: 'failed' });
  });

  it.each([
    ['owner-a', 'already-owned'],
    ['owner-b', 'owned-by-other'],
  ] as const)('avoids the mutation lock for a stable-owner no-op (%s)', (ownerId, expected) => {
    expect(reserveCommittedLegacyNativeProviderAuthOwner('owner-a')).toBe('claimed');
    fs.rmSync(bindingLockDb, { force: true });

    expect(reserveCommittedLegacyNativeProviderAuthOwner(ownerId)).toBe(expected);
    expect(fs.existsSync(bindingLockDb)).toBe(false);
  });

  it.each([
    ['owner-a', 'already-owned'],
    ['owner-b', 'owned-by-other'],
  ] as const)('avoids the mutation lock for a provisional no-op (%s)', (ownerId, expected) => {
    expect(reserveCommittedLegacyNativeProviderAuthOwner('owner-a')).toBe('claimed');
    fs.rmSync(bindingLockDb, { force: true });

    expect(reserveLegacyNativeProviderAuthOwnerDetailed(ownerId)).toEqual({ status: expected });
    expect(fs.existsSync(bindingLockDb)).toBe(false);
  });

  it('avoids the mutation lock when there is no pending native claim to recover', () => {
    expect(reserveCommittedLegacyNativeProviderAuthOwner('owner-a')).toBe('claimed');
    fs.rmSync(bindingLockDb, { force: true });

    expect(recoverPendingLegacyNativeProviderAuthOwner('owner-a')).toBe('none');
    expect(fs.existsSync(bindingLockDb)).toBe(false);
  });

  it('recovers an interrupted native reservation before a different owner commits', () => {
    expect(reserveLegacyNativeProviderAuthOwner('owner-a')).toBe('claimed');

    expect(recoverPendingLegacyNativeProviderAuthOwner(null)).toBe('released');
    session.dataOwnerId = 'owner-b';
    expect(reserveLegacyNativeProviderAuthOwner('owner-b')).toBe('claimed');
  });

  it('keeps a pending native reservation recoverable after a binding write failure', () => {
    expect(reserveLegacyNativeProviderAuthOwner('owner-a')).toBe('claimed');
    const renameSpy = vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => {
      throw Object.assign(new Error('binding write failed'), { code: 'EIO' });
    });

    expect(recoverPendingLegacyNativeProviderAuthOwner(null)).toBe('failed');
    expect(JSON.parse(fs.readFileSync(bindingFile, 'utf8'))).toMatchObject({
      legacyClaimOwner: 'owner-a',
      legacyClaimToken: expect.any(String),
    });

    renameSpy.mockRestore();
    expect(recoverPendingLegacyNativeProviderAuthOwner(null)).toBe('released');
    session.dataOwnerId = 'owner-b';
    expect(reserveLegacyNativeProviderAuthOwner('owner-b')).toBe('claimed');
  });

  it('persists the local claim when the first cloud owner has no credential to migrate', () => {
    expect(migrateLocalNativeProviderAuthBindings('owner-a')).toBe(false);
    expect(JSON.parse(fs.readFileSync(bindingFile, 'utf8'))).toEqual({
      legacyClaimOwner: 'owner-a',
    });

    session.dataOwnerId = 'owner-b';
    expect(claimDetectedNativeProviderAuth('openai', () => true)).toBe(false);
  });

  it('moves local-mode Harness bindings to the first cloud owner and preserves source metadata', () => {
    session.dataOwnerId = 'local-v1';
    expect(claimDetectedNativeProviderAuth('openai', () => true)).toBe(true);
    expect(JSON.parse(fs.readFileSync(bindingFile, 'utf8'))).toMatchObject({
      openai: 'local-v1',
      sources: { openai: 'native-harness-inherited' },
    });

    session.dataOwnerId = 'owner-a';
    expect(migrateLocalNativeProviderAuthBindings('owner-a')).toBe(true);
    expect(JSON.parse(fs.readFileSync(bindingFile, 'utf8'))).toMatchObject({
      openai: 'owner-a',
      legacyClaimOwner: 'owner-a',
      sources: { openai: 'native-harness-inherited' },
    });
    expect(isNativeProviderAuthBound('openai')).toBe(true);
  });

  it('avoids the mutation lock when no local binding can move', () => {
    expect(reserveCommittedLegacyNativeProviderAuthOwner('owner-a')).toBe('claimed');
    fs.rmSync(bindingLockDb, { force: true });

    expect(migrateLocalNativeProviderAuthBindings('owner-a')).toBe(false);
    expect(fs.existsSync(bindingLockDb)).toBe(false);
  });

  it('does not let a later cloud owner migrate local residue after another owner won the claim', () => {
    session.dataOwnerId = 'local-v1';
    expect(claimDetectedNativeProviderAuth('openai', () => true)).toBe(true);
    const current = JSON.parse(fs.readFileSync(bindingFile, 'utf8')) as Record<string, unknown>;
    fs.writeFileSync(
      bindingFile,
      JSON.stringify({ ...current, openai: 'local-v1', legacyClaimOwner: 'owner-a' }),
    );

    session.dataOwnerId = 'owner-b';
    expect(migrateLocalNativeProviderAuthBindings('owner-b')).toBe(false);
    expect(JSON.parse(fs.readFileSync(bindingFile, 'utf8'))).toMatchObject({
      openai: 'local-v1',
      legacyClaimOwner: 'owner-a',
    });
    expect(isNativeProviderAuthBound('openai')).toBe(false);
  });

  it('keeps explicitly revoked local credentials suppressed', () => {
    session.dataOwnerId = 'local-v1';
    expect(claimDetectedNativeProviderAuth('openai', () => true)).toBe(true);
    unbindNativeProviderAuth('openai', { revoked: true });

    session.dataOwnerId = 'owner-a';
    expect(migrateLocalNativeProviderAuthBindings('owner-a')).toBe(false);
    expect(JSON.parse(fs.readFileSync(bindingFile, 'utf8'))).toMatchObject({
      revoked: { openai: 'local-v1' },
    });
    expect(isNativeProviderAuthBound('openai')).toBe(false);
  });

  it('does not write for a different active owner or while the session boundary is pending', () => {
    session.dataOwnerId = 'local-v1';
    expect(claimDetectedNativeProviderAuth('openai', () => true)).toBe(true);
    session.dataOwnerId = 'owner-a';
    session.boundaryPending = true;
    expect(migrateLocalNativeProviderAuthBindings('owner-a')).toBe(false);
    session.boundaryPending = false;
    expect(migrateLocalNativeProviderAuthBindings('owner-b')).toBe(false);
    expect(JSON.parse(fs.readFileSync(bindingFile, 'utf8'))).toMatchObject({
      openai: 'local-v1',
    });
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

  it('claims only native Harness credentials and records their inherited source', () => {
    expect(claimDetectedNativeProviderAuth('anthropic', () => true)).toBe(true);
    expect(claimDetectedNativeProviderAuth('openai', () => true)).toBe(true);
    expect(isNativeProviderAuthBound('anthropic')).toBe(true);
    expect(getNativeProviderAuthSource('anthropic')).toBe('native-harness-inherited');
    expect(getNativeProviderAuthSource('openai')).toBe('native-harness-inherited');

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

  it('xAI 再次显式授权清除撤销标记，但仍保持 provider OAuth 来源', () => {
    unbindNativeProviderAuth('xai', { revoked: true });

    bindNativeProviderAuth('xai');
    expect(isNativeProviderAuthBound('xai')).toBe(true);
    expect(getNativeProviderAuthSource('xai')).toBe('explicit-provider-oauth');
    expect(JSON.parse(fs.readFileSync(bindingFile, 'utf8'))).not.toHaveProperty('revoked.xai');
  });

  it('凭证失效(非用户登出)不留标记 —— 本机重新登录后仍按设计自动继承', () => {
    expect(claimDetectedNativeProviderAuth('anthropic', () => true)).toBe(true);
    unbindNativeProviderAuth('anthropic'); // invalidate 路径:不传 revoked

    expect(JSON.parse(fs.readFileSync(bindingFile, 'utf8'))).not.toHaveProperty('revoked');
    expect(claimDetectedNativeProviderAuth('anthropic', () => true)).toBe(true);
  });

  it('绑定文件读不出来时不认领,也不覆盖它', () => {
    // 「归属信息丢失」不等于「没人绑过」。把损坏当空,等于在最不该下判断的时刻把共享
    // keychain 里的凭证判给当前账号,随后的写入还会把原有归属彻底盖掉(PR #548 review)。
    fs.mkdirSync(userDataDir, { recursive: true });
    fs.writeFileSync(bindingFile, '{ this is not json');

    expect(claimDetectedNativeProviderAuth('anthropic', () => true)).toBe(false);
    expect(isNativeProviderAuthBound('anthropic')).toBe(false);
    expect(fs.readFileSync(bindingFile, 'utf8')).toBe('{ this is not json');

    // 一次性 legacy 迁移同样不推进 —— 它还会顺手消费掉 legacyClaimOwner 名额。
    migrateLegacyNativeProviderAuthBindings('owner-a', { anthropic: true });
    expect(fs.readFileSync(bindingFile, 'utf8')).toBe('{ this is not json');

    // JSON 合法但根不是对象(数组 / 标量)同样按不可读处理。
    fs.writeFileSync(bindingFile, '["owner-a"]');
    expect(claimDetectedNativeProviderAuth('anthropic', () => true)).toBe(false);
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
    expect(isNativeProviderAuthBound('xai')).toBe(false);
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
  it('avoids the mutation lock when recovery has no credential to restore', () => {
    fs.mkdirSync(userDataDir, { recursive: true });
    fs.writeFileSync(bindingFile, JSON.stringify({ legacyClaimOwner: 'owner-a' }));
    fs.rmSync(bindingLockDb, { force: true });

    expect(restoreNativeProviderAuthForRecovery('openai', 'owner-a', () => false)).toBe(false);
    expect(fs.existsSync(bindingLockDb)).toBe(false);
  });

  it.each([
    ['owner-a', true],
    ['owner-b', false],
  ] as const)(
    'avoids the mutation lock when recovery finds an existing slot for %s',
    (slotOwner, expected) => {
      fs.mkdirSync(userDataDir, { recursive: true });
      fs.writeFileSync(bindingFile, JSON.stringify({ openai: slotOwner }));
      fs.rmSync(bindingLockDb, { force: true });

      expect(restoreNativeProviderAuthForRecovery('openai', 'owner-a', () => true)).toBe(expected);
      expect(fs.existsSync(bindingLockDb)).toBe(false);
    },
  );

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

describe('凭证来路(selfAuthorized)—— 显式授权 vs 自动继承', () => {
  // 存在的理由:两者结果相同(绑到当前 owner、凭证可用),但用户可见文案的依据不同 ——
  // 「已沿用这台电脑上登录的账号」只对继承成立(PR #1076 review 第三轮)。

  it('显式授权记下来路,自动认领不记', () => {
    bindNativeProviderAuth('anthropic');
    expect(isNativeProviderAuthSelfAuthorized('anthropic')).toBe(true);
    expect(getNativeProviderAuthSource('anthropic')).toBe('explicit-provider-oauth');

    expect(claimDetectedNativeProviderAuth('openai', () => true)).toBe(true);
    expect(isNativeProviderAuthSelfAuthorized('openai')).toBe(false);
    expect(getNativeProviderAuthSource('openai')).toBe('native-harness-inherited');
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
