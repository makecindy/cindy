import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  userDataDir: '',
  ownerId: 'owner-a' as string | null,
  generation: 1,
  boundaryPending: false,
}));

vi.mock('electron', () => ({
  app: { getPath: () => h.userDataDir },
}));

vi.mock('../../appSessionState.js', () => ({
  getActiveAppSession: () => ({
    mode: h.ownerId ? 'cloud' : 'signed-out',
    dataOwnerId: h.ownerId,
    generation: h.generation,
  }),
  isAppSessionBoundaryPending: () => h.boundaryPending,
}));

vi.mock('../logger-adapter.js', () => ({
  desktopMakerLogger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  },
}));

const originalPlatform = process.platform;
const originalConfigDir = process.env.CLAUDE_CONFIG_DIR;
let root = '';

beforeEach(() => {
  vi.resetModules();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-claude-owner-recovery-'));
  h.userDataDir = path.join(root, 'user-data');
  h.ownerId = 'owner-a';
  h.generation = 1;
  h.boundaryPending = false;
  process.env.CLAUDE_CONFIG_DIR = path.join(root, 'claude');
  Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
});

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
  if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = originalConfigDir;
  fs.rmSync(root, { recursive: true, force: true });
});

describe('Claude credential + ownership recovery integration', () => {
  it('persists markerless invalid_grant epochs across restart and same-token reauthorization', async () => {
    let binding = await import('../nativeProviderAuthBinding.js');
    let store = await import('../claude-credentials-store.js');
    const owner = { dataOwnerId: 'owner-a', generation: 1 };
    const operation1 = binding.beginNativeProviderAuthAuthorization('anthropic', owner)!;
    expect(binding.stageNativeProviderAuthAuthorization('anthropic', operation1)).toBe(true);
    const r1 = {
      accessToken: 'same-access-token',
      refreshToken: 'same-refresh-token',
      cindyAuthorizationRevision: operation1.operationId,
    };
    const fingerprint = store.fingerprintClaudeAiOAuthCredentialIdentity(r1);
    expect(
      store.writeClaudeAiOAuthWithBindingCommit(r1, () =>
        binding.bindNativeProviderAuth('anthropic', operation1, fingerprint),
      ),
    ).toBe(true);

    const credentialFile = path.join(process.env.CLAUDE_CONFIG_DIR!, '.credentials.json');
    const markerless = {
      accessToken: r1.accessToken,
      refreshToken: r1.refreshToken,
    };
    fs.writeFileSync(credentialFile, JSON.stringify({ claudeAiOauth: markerless }));
    const requestCredential = store.readClaudeAiOAuth();
    expect(requestCredential).toEqual(markerless);
    expect(store.rejectClaudeAiOAuthCredentialIdentity(requestCredential!)).toBe(true);
    expect(store.readClaudeAiOAuth()).toBeNull();

    vi.resetModules();
    binding = await import('../nativeProviderAuthBinding.js');
    store = await import('../claude-credentials-store.js');
    expect(store.readClaudeAiOAuth()).toBeNull();

    const operation2 = binding.beginNativeProviderAuthAuthorization('anthropic', owner)!;
    expect(binding.stageNativeProviderAuthAuthorization('anthropic', operation2)).toBe(true);
    const r2 = { ...r1, cindyAuthorizationRevision: operation2.operationId };
    expect(
      store.writeClaudeAiOAuthWithBindingCommit(r2, () =>
        binding.bindNativeProviderAuth('anthropic', operation2, fingerprint),
      ),
    ).toBe(true);
    expect(store.readClaudeAiOAuth()).toEqual(r2);

    fs.writeFileSync(credentialFile, JSON.stringify({ claudeAiOauth: markerless }));
    expect(store.readClaudeAiOAuth()).toBeNull();
    fs.writeFileSync(credentialFile, JSON.stringify({ claudeAiOauth: r1 }));
    expect(store.readClaudeAiOAuth()).toBeNull();
  });

  it('signed-out and boundary-pending processes cannot read an owner-bound shared token', async () => {
    const binding = await import('../nativeProviderAuthBinding.js');
    const store = await import('../claude-credentials-store.js');

    expect(binding.bindNativeProviderAuth('anthropic')).toBe(true);
    store.writeClaudeAiOAuth({ accessToken: 'at-owner-a', refreshToken: 'rt-owner-a' });
    expect(store.readClaudeAiOAuth()?.accessToken).toBe('at-owner-a');

    h.ownerId = null;
    expect(store.readClaudeAiOAuth()).toBeNull();
    expect(store.hasClaudeAiOAuth()).toBe(false);
    expect(store.hasClaudeAiOAuthUnbound()).toBe(true);

    h.ownerId = 'owner-a';
    h.boundaryPending = true;
    expect(store.readClaudeAiOAuth()).toBeNull();
    expect(store.hasClaudeAiOAuth()).toBe(false);

    h.boundaryPending = false;
    expect(store.readClaudeAiOAuth()?.accessToken).toBe('at-owner-a');
  });

  it('read-only credential snapshots leave backup-only ownership state untouched', async () => {
    const binding = await import('../nativeProviderAuthBinding.js');
    const store = await import('../claude-credentials-store.js');

    expect(binding.bindNativeProviderAuth('anthropic')).toBe(true);
    store.writeClaudeAiOAuth({ accessToken: 'at-owner-a', refreshToken: 'rt-owner-a' });
    const bindingFile = path.join(h.userDataDir, 'native-provider-auth.json');
    const backupFile = `${bindingFile}.bak`;
    fs.renameSync(bindingFile, backupFile);
    const renameSpy = vi.spyOn(fs, 'renameSync');

    expect(store.hasClaudeAiOAuth()).toBe(false);
    expect(renameSpy).not.toHaveBeenCalled();
    expect(fs.existsSync(bindingFile)).toBe(false);
    expect(fs.existsSync(backupFile)).toBe(true);

    renameSpy.mockRestore();
  });

  it('pending revocation survives module reload and blocks another owner from claiming a residual token', async () => {
    let binding = await import('../nativeProviderAuthBinding.js');
    let store = await import('../claude-credentials-store.js');
    const oldCredential = { accessToken: 'at-owner-a', refreshToken: 'rt-owner-a' };

    expect(binding.bindNativeProviderAuth('anthropic')).toBe(true);
    store.writeClaudeAiOAuth(oldCredential);

    const bindingFile = path.join(h.userDataDir, 'native-provider-auth.json');
    fs.writeFileSync(bindingFile, '{ corrupt ownership');
    expect(
      binding.markNativeProviderAuthRevocationPending('anthropic', {
        dataOwnerId: 'owner-a',
        generation: 1,
      }),
    ).toBe(true);

    // Main ownership data recovers as empty and the app restarts under owner B.
    fs.writeFileSync(bindingFile, '{}');
    h.ownerId = 'owner-b';
    h.generation = 2;
    vi.resetModules();
    binding = await import('../nativeProviderAuthBinding.js');
    store = await import('../claude-credentials-store.js');

    expect(store.hasClaudeAiOAuthUnbound()).toBe(true);
    expect(store.hasClaudeAiOAuth()).toBe(false);
    expect(
      binding.claimDetectedNativeProviderAuth('anthropic', () => store.hasClaudeAiOAuthUnbound()),
    ).toBe(false);
    expect(fs.readFileSync(bindingFile, 'utf8')).toBe('{}');

    // A real explicit login stages B's operation, then holds the credential
    // lock until the exact marker is consumed by the binding commit.
    const ownerB = { dataOwnerId: 'owner-b', generation: 2 };
    const operationB = binding.beginNativeProviderAuthAuthorization('anthropic', ownerB)!;
    expect(binding.stageNativeProviderAuthAuthorization('anthropic', operationB)).toBe(true);
    expect(
      store.writeClaudeAiOAuthWithBindingCommit(
        { accessToken: 'at-owner-b', refreshToken: 'rt-owner-b' },
        () => binding.bindNativeProviderAuth('anthropic', operationB),
      ),
    ).toBe(true);
    expect(store.readClaudeAiOAuth()?.accessToken).toBe('at-owner-b');
  });

  it('two process-style login finalizers cannot pair token B with owner A', async () => {
    const binding = await import('../nativeProviderAuthBinding.js');
    const store = await import('../claude-credentials-store.js');
    const ownerA = { dataOwnerId: 'owner-a', generation: 1 };
    const ownerB = { dataOwnerId: 'owner-b', generation: 2 };

    const operationA = binding.beginNativeProviderAuthAuthorization('anthropic', ownerA)!;
    h.ownerId = 'owner-b';
    h.generation = 2;
    const operationB = binding.beginNativeProviderAuthAuthorization('anthropic', ownerB)!;
    expect(binding.stageNativeProviderAuthAuthorization('anthropic', operationB)).toBe(true);

    // Process A resumes after B replaced the staging marker. Its token write is
    // rolled back under .storage-write when the binding marker check fails.
    h.ownerId = 'owner-a';
    h.generation = 1;
    expect(
      store.writeClaudeAiOAuthWithBindingCommit(
        { accessToken: 'at-owner-a', refreshToken: 'rt-owner-a' },
        () => binding.bindNativeProviderAuth('anthropic', operationA),
      ),
    ).toBe(false);
    expect(store.hasClaudeAiOAuthUnbound()).toBe(false);

    h.ownerId = 'owner-b';
    h.generation = 2;
    expect(
      store.writeClaudeAiOAuthWithBindingCommit(
        { accessToken: 'at-owner-b', refreshToken: 'rt-owner-b' },
        () => binding.bindNativeProviderAuth('anthropic', operationB),
      ),
    ).toBe(true);
    expect(store.readClaudeAiOAuth()?.accessToken).toBe('at-owner-b');
    expect(
      JSON.parse(fs.readFileSync(path.join(h.userDataDir, 'native-provider-auth.json'), 'utf8')),
    ).toMatchObject({ anthropic: 'owner-b' });
  });

  it('a losing staged login restores the old credential without leaving a stale tombstone', async () => {
    const binding = await import('../nativeProviderAuthBinding.js');
    const store = await import('../claude-credentials-store.js');
    const owner = { dataOwnerId: 'owner-a', generation: 1 };
    const oldCredential = { accessToken: 'at-existing', refreshToken: 'rt-existing' };

    expect(binding.bindNativeProviderAuth('anthropic')).toBe(true);
    store.writeClaudeAiOAuth(oldCredential);
    const operationA = binding.beginNativeProviderAuthAuthorization('anthropic', owner)!;
    expect(binding.stageNativeProviderAuthAuthorization('anthropic', operationA)).toBe(true);

    // A second browser flow begins but is cancelled before staging. Its newer
    // nonce makes A's binding commit lose; the storage transaction restores the
    // old credential, then A may clear only its own still-pending marker.
    const operationB = binding.beginNativeProviderAuthAuthorization('anthropic', owner)!;
    expect(
      store.writeClaudeAiOAuthWithBindingCommit(
        { accessToken: 'at-loser', refreshToken: 'rt-loser' },
        () => binding.bindNativeProviderAuth('anthropic', operationA),
      ),
    ).toBe(false);
    expect(binding.clearNativeProviderAuthAuthorizationPending('anthropic', operationA)).toBe(true);
    expect(binding.abandonNativeProviderAuthOperation('anthropic', operationB)).toBe(true);

    expect(store.readClaudeAiOAuth()?.accessToken).toBe('at-existing');
    expect(binding.getNativeProviderAuthBindingState('anthropic')).toBe('bound');
    expect(
      fs.existsSync(path.join(h.userDataDir, 'native-provider-auth.pending', 'anthropic.json')),
    ).toBe(false);
  });

  it('two failed logins cannot erase the crash tombstone from an earlier logout', async () => {
    const binding = await import('../nativeProviderAuthBinding.js');
    const store = await import('../claude-credentials-store.js');
    const ownerA = { dataOwnerId: 'owner-a', generation: 1 };
    const ownerB = { dataOwnerId: 'owner-b', generation: 2 };
    const residual = { accessToken: 'at-before-logout', refreshToken: 'rt-before-logout' };

    expect(binding.bindNativeProviderAuth('anthropic')).toBe(true);
    store.writeClaudeAiOAuth(residual);
    expect(binding.beginNativeProviderAuthRevocation('anthropic', ownerA)).not.toBeNull();

    // Owner B's first retry stages and temporarily supersedes owner A's
    // crash-only revoke. A second B flow wins the nonce but is cancelled.
    h.ownerId = 'owner-b';
    h.generation = 2;
    const firstLogin = binding.beginNativeProviderAuthAuthorization('anthropic', ownerB)!;
    expect(binding.stageNativeProviderAuthAuthorization('anthropic', firstLogin)).toBe(true);
    const secondLogin = binding.beginNativeProviderAuthAuthorization('anthropic', ownerB)!;

    expect(
      store.writeClaudeAiOAuthWithBindingCommit(
        { accessToken: 'at-first-retry', refreshToken: 'rt-first-retry' },
        () => binding.bindNativeProviderAuth('anthropic', firstLogin),
      ),
    ).toBe(false);
    expect(binding.clearNativeProviderAuthAuthorizationPending('anthropic', firstLogin)).toBe(true);
    expect(binding.abandonNativeProviderAuthOperation('anthropic', secondLogin)).toBe(true);

    // The old blob was restored by the credential transaction, but the earlier
    // logout tombstone also survives with owner A's original provenance.
    expect(store.hasClaudeAiOAuthUnbound()).toBe(true);
    expect(store.readClaudeAiOAuth()).toBeNull();
    const pendingFile = path.join(h.userDataDir, 'native-provider-auth.pending', 'anthropic.json');
    expect(JSON.parse(fs.readFileSync(pendingFile, 'utf8'))).toMatchObject({
      intent: 'revoke',
      dataOwnerId: 'owner-a',
      generation: 1,
    });
    expect(binding.getNativeProviderAuthBindingState('anthropic')).toBe('unreadable');
    expect(binding.claimDetectedNativeProviderAuth('anthropic', () => true)).toBe(false);

    // Owner A can still retry the interrupted logout; provenance was not
    // rewritten to B, so the residual token is not permanently wedged.
    h.ownerId = 'owner-a';
    h.generation = 1;
    const retriedLogout = binding.beginNativeProviderAuthDisconnect('anthropic', ownerA);
    expect(retriedLogout).not.toBe('confirmed-unbound');
    expect(retriedLogout).not.toBeNull();
    if (!retriedLogout || retriedLogout === 'confirmed-unbound') {
      throw new Error('expected retried owner A logout operation');
    }
    expect(
      binding.markNativeProviderAuthRevocationPending('anthropic', ownerA, {
        supersedeMatchingAuthorization: true,
        operation: retriedLogout,
      }),
    ).toBe(true);
    expect(
      store.clearClaudeAiOAuthWithBindingCommit(
        () => binding.validateNativeProviderAuthRevocationPending('anthropic', retriedLogout),
        () =>
          binding.unbindNativeProviderAuth('anthropic', {
            revoked: true,
            expectedOperation: retriedLogout,
            requirePendingRevocation: true,
          }),
      ),
    ).toBe('cleared');
    expect(store.readClaudeAiOAuth()).toBeNull();
  });

  it('later failed logins never expose an orphan token from a crashed staged login', async () => {
    const binding = await import('../nativeProviderAuthBinding.js');
    const store = await import('../claude-credentials-store.js');
    const tokenA = { accessToken: 'at-owner-a', refreshToken: 'rt-owner-a' };

    expect(binding.bindNativeProviderAuth('anthropic')).toBe(true);
    store.writeClaudeAiOAuth(tokenA);

    // Owner B crashes after replacing the shared token but before binding it.
    // Its authorize pending is the only proof that main=A must not read token B.
    h.ownerId = 'owner-b';
    h.generation = 2;
    const loginB = binding.beginNativeProviderAuthAuthorization('anthropic', {
      dataOwnerId: 'owner-b',
      generation: 2,
    })!;
    expect(binding.stageNativeProviderAuthAuthorization('anthropic', loginB)).toBe(true);
    store.writeClaudeAiOAuth({ accessToken: 'at-orphan-b', refreshToken: 'rt-orphan-b' });

    // C stages over B, then D begins and is cancelled. C's deterministic
    // rollback restores the token B snapshot it observed on entry; cleanup must
    // therefore restore B's authorization suppression rather than inventing a
    // logout tombstone or removing every sidecar.
    h.ownerId = 'owner-c';
    h.generation = 3;
    const loginC = binding.beginNativeProviderAuthAuthorization('anthropic', {
      dataOwnerId: 'owner-c',
      generation: 3,
    })!;
    expect(binding.stageNativeProviderAuthAuthorization('anthropic', loginC)).toBe(true);
    h.ownerId = 'owner-d';
    h.generation = 4;
    const loginD = binding.beginNativeProviderAuthAuthorization('anthropic', {
      dataOwnerId: 'owner-d',
      generation: 4,
    })!;

    h.ownerId = 'owner-c';
    h.generation = 3;
    expect(
      store.writeClaudeAiOAuthWithBindingCommit(
        { accessToken: 'at-owner-c', refreshToken: 'rt-owner-c' },
        () => binding.bindNativeProviderAuth('anthropic', loginC),
      ),
    ).toBe(false);
    expect(binding.clearNativeProviderAuthAuthorizationPending('anthropic', loginC)).toBe(true);
    h.ownerId = 'owner-d';
    h.generation = 4;
    expect(binding.abandonNativeProviderAuthOperation('anthropic', loginD)).toBe(true);

    h.ownerId = 'owner-a';
    h.generation = 1;
    expect(store.hasClaudeAiOAuthUnbound()).toBe(true);
    expect(store.readClaudeAiOAuth()).toBeNull();
    expect(binding.getNativeProviderAuthBindingState('anthropic')).toBe('unreadable');
    expect(
      JSON.parse(
        fs.readFileSync(
          path.join(h.userDataDir, 'native-provider-auth.pending', 'anthropic.json'),
          'utf8',
        ),
      ),
    ).toMatchObject({
      intent: 'authorize',
      dataOwnerId: 'owner-b',
      generation: 2,
      operationId: loginB.operationId,
    });

    // The main owner can still complete a later explicit logout, even though
    // the conservative suppression correctly remembers the orphan came from B.
    const ownerA = { dataOwnerId: 'owner-a', generation: 1 };
    const logoutA = binding.beginNativeProviderAuthDisconnect('anthropic', ownerA);
    expect(logoutA).not.toBe('confirmed-unbound');
    expect(logoutA).not.toBeNull();
    if (!logoutA || logoutA === 'confirmed-unbound') {
      throw new Error('expected owner A logout operation');
    }
    expect(
      binding.markNativeProviderAuthRevocationPending('anthropic', ownerA, {
        supersedeMatchingAuthorization: true,
        operation: logoutA,
      }),
    ).toBe(true);
    expect(
      store.clearClaudeAiOAuthWithBindingCommit(
        () => binding.validateNativeProviderAuthRevocationPending('anthropic', logoutA),
        () =>
          binding.unbindNativeProviderAuth('anthropic', {
            revoked: true,
            expectedOperation: logoutA,
            requirePendingRevocation: true,
          }),
      ),
    ).toBe('cleared');
    expect(store.hasClaudeAiOAuthUnbound()).toBe(false);
  });

  it('same-owner logout supersedes a staged login from another process generation', async () => {
    const binding = await import('../nativeProviderAuthBinding.js');
    const store = await import('../claude-credentials-store.js');

    expect(binding.bindNativeProviderAuth('anthropic')).toBe(true);
    store.writeClaudeAiOAuth({ accessToken: 'at-existing', refreshToken: 'rt-existing' });

    h.generation = 2;
    const otherProcessLogin = binding.beginNativeProviderAuthAuthorization('anthropic', {
      dataOwnerId: 'owner-a',
      generation: 2,
    })!;
    expect(binding.stageNativeProviderAuthAuthorization('anthropic', otherProcessLogin)).toBe(true);

    h.generation = 1;
    const logout = binding.beginNativeProviderAuthDisconnect('anthropic', {
      dataOwnerId: 'owner-a',
      generation: 1,
    });
    expect(logout).not.toBe('confirmed-unbound');
    expect(logout).not.toBeNull();
    if (!logout || logout === 'confirmed-unbound') {
      throw new Error('expected a logout operation');
    }
    expect(
      binding.markNativeProviderAuthRevocationPending(
        'anthropic',
        { dataOwnerId: 'owner-a', generation: 1 },
        { supersedeMatchingAuthorization: true, operation: logout },
      ),
    ).toBe(true);
    expect(
      store.clearClaudeAiOAuthWithBindingCommit(
        () => binding.validateNativeProviderAuthRevocationPending('anthropic', logout),
        () =>
          binding.unbindNativeProviderAuth('anthropic', {
            revoked: true,
            expectedOperation: logout,
            requirePendingRevocation: true,
          }),
      ),
    ).toBe('cleared');
    expect(store.readClaudeAiOAuth()).toBeNull();
    expect(binding.getNativeProviderAuthBindingState('anthropic')).toBe('unbound');

    h.generation = 2;
    expect(binding.stageNativeProviderAuthAuthorization('anthropic', otherProcessLogin)).toBe(
      false,
    );
  });

  it('the bound owner logout supersedes another owner staged replacement login', async () => {
    const binding = await import('../nativeProviderAuthBinding.js');
    const store = await import('../claude-credentials-store.js');

    expect(binding.bindNativeProviderAuth('anthropic')).toBe(true);
    store.writeClaudeAiOAuth({ accessToken: 'at-owner-a', refreshToken: 'rt-owner-a' });

    h.ownerId = 'owner-b';
    h.generation = 2;
    const ownerBLogin = binding.beginNativeProviderAuthAuthorization('anthropic', {
      dataOwnerId: 'owner-b',
      generation: 2,
    })!;
    expect(binding.stageNativeProviderAuthAuthorization('anthropic', ownerBLogin)).toBe(true);

    h.ownerId = 'owner-a';
    h.generation = 1;
    const ownerALogout = binding.beginNativeProviderAuthDisconnect('anthropic', {
      dataOwnerId: 'owner-a',
      generation: 1,
    });
    expect(ownerALogout).not.toBe('confirmed-unbound');
    expect(ownerALogout).not.toBeNull();
    if (!ownerALogout || ownerALogout === 'confirmed-unbound') {
      throw new Error('expected owner A logout operation');
    }
    expect(
      binding.markNativeProviderAuthRevocationPending(
        'anthropic',
        { dataOwnerId: 'owner-a', generation: 1 },
        { supersedeMatchingAuthorization: true, operation: ownerALogout },
      ),
    ).toBe(true);
    expect(
      store.clearClaudeAiOAuthWithBindingCommit(
        () => binding.validateNativeProviderAuthRevocationPending('anthropic', ownerALogout),
        () =>
          binding.unbindNativeProviderAuth('anthropic', {
            revoked: true,
            expectedOperation: ownerALogout,
            requirePendingRevocation: true,
          }),
      ),
    ).toBe('cleared');
    expect(store.readClaudeAiOAuth()).toBeNull();

    h.ownerId = 'owner-b';
    h.generation = 2;
    expect(binding.stageNativeProviderAuthAuthorization('anthropic', ownerBLogin)).toBe(false);
  });

  it('a replacement login supersedes an in-flight invalid_grant before it can unbind the owner', async () => {
    const binding = await import('../nativeProviderAuthBinding.js');
    const store = await import('../claude-credentials-store.js');
    const ownerA = { dataOwnerId: 'owner-a', generation: 1 };
    const oldCredential = { accessToken: 'at-old', refreshToken: 'rt-old' };

    expect(binding.bindNativeProviderAuth('anthropic')).toBe(true);
    store.writeClaudeAiOAuth(oldCredential);
    const invalidation = binding.beginNativeProviderAuthInvalidation('anthropic', ownerA);
    expect(invalidation).not.toBeNull();
    if (!invalidation) throw new Error('expected invalidation operation');

    let replacement: ReturnType<typeof binding.beginNativeProviderAuthAuthorization> = null;
    const cleanup = store.clearClaudeAiOAuthIfMatchesWithBindingCommit(
      oldCredential,
      () => binding.validateNativeProviderAuthInvalidation('anthropic', invalidation),
      () => {
        // Another process starts a newer explicit login after the old token is
        // cleared but before the stale invalid_grant can unbind. Its operation
        // nonce must win even though both actions use the same owner generation.
        replacement = binding.beginNativeProviderAuthAuthorization('anthropic', ownerA);
        return binding.unbindNativeProviderAuth('anthropic', {
          expectedOperation: invalidation,
        });
      },
    );

    expect(cleanup).toBe('binding-changed');
    expect(store.readClaudeAiOAuth()).toBeNull();
    expect(
      JSON.parse(fs.readFileSync(path.join(h.userDataDir, 'native-provider-auth.json'), 'utf8')),
    ).toMatchObject({ anthropic: 'owner-a' });
    expect(replacement).not.toBeNull();
    if (!replacement) throw new Error('expected replacement authorization operation');

    expect(binding.stageNativeProviderAuthAuthorization('anthropic', replacement)).toBe(true);
    expect(
      store.writeClaudeAiOAuthWithBindingCommit(
        { accessToken: 'at-new', refreshToken: 'rt-new' },
        () => binding.bindNativeProviderAuth('anthropic', replacement!),
      ),
    ).toBe(true);
    expect(store.readClaudeAiOAuth()?.accessToken).toBe('at-new');
    expect(
      JSON.parse(fs.readFileSync(path.join(h.userDataDir, 'native-provider-auth.json'), 'utf8')),
    ).toMatchObject({ anthropic: 'owner-a' });
  });

  it('invalid_grant clears the rejected grant and owner in one intentless transaction', async () => {
    const binding = await import('../nativeProviderAuthBinding.js');
    const store = await import('../claude-credentials-store.js');
    const owner = { dataOwnerId: 'owner-a', generation: 1 };
    const rejected = {
      accessToken: 'at-rejected',
      refreshToken: 'rt-rejected',
      cindyAuthorizationRevision: 'rejected-revision',
    };

    expect(binding.bindNativeProviderAuth('anthropic')).toBe(true);
    store.writeClaudeAiOAuth(rejected);

    expect(store.clearClaudeAiOAuthIfMatchesWithBindingInvalidation(rejected, owner)).toBe(
      'cleared',
    );
    expect(store.readClaudeAiOAuth()).toBeNull();
    expect(binding.getNativeProviderAuthBindingState('anthropic')).toBe('unbound');
    expect(
      fs.existsSync(path.join(h.userDataDir, 'native-provider-auth.intent', 'anthropic.json')),
    ).toBe(false);
  });

  it('a newer authorization intent prevents intentless invalid_grant cleanup', async () => {
    const binding = await import('../nativeProviderAuthBinding.js');
    const store = await import('../claude-credentials-store.js');
    const owner = { dataOwnerId: 'owner-a', generation: 1 };
    const rejected = {
      accessToken: 'at-rejected',
      refreshToken: 'rt-rejected',
      cindyAuthorizationRevision: 'rejected-revision',
    };

    expect(binding.bindNativeProviderAuth('anthropic')).toBe(true);
    store.writeClaudeAiOAuth(rejected);
    expect(binding.beginNativeProviderAuthAuthorization('anthropic', owner)).not.toBeNull();

    expect(store.clearClaudeAiOAuthIfMatchesWithBindingInvalidation(rejected, owner)).toBe(
      'binding-changed',
    );
    expect(store.readClaudeAiOAuth()).toEqual(rejected);
    expect(binding.getNativeProviderAuthBindingState('anthropic')).toBe('bound');
  });

  it('a crash after revoke staging leaves residual credentials unusable after restart', async () => {
    let binding = await import('../nativeProviderAuthBinding.js');
    let store = await import('../claude-credentials-store.js');

    expect(binding.bindNativeProviderAuth('anthropic')).toBe(true);
    store.writeClaudeAiOAuth({ accessToken: 'residual-at', refreshToken: 'residual-rt' });
    expect(
      binding.markNativeProviderAuthRevocationPending('anthropic', {
        dataOwnerId: 'owner-a',
        generation: 1,
      }),
    ).toBe(true);

    // Simulate process death before credential clear / main revoked commit.
    vi.resetModules();
    binding = await import('../nativeProviderAuthBinding.js');
    store = await import('../claude-credentials-store.js');
    expect(store.hasClaudeAiOAuthUnbound()).toBe(true);
    expect(store.hasClaudeAiOAuth()).toBe(false);
    expect(binding.claimDetectedNativeProviderAuth('anthropic', () => true)).toBe(false);
    expect(binding.getNativeProviderAuthBindingState('anthropic')).toBe('unreadable');
  });
});
