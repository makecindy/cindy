import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { describeErrorChain } from '../../utils/errorChain.js';

const originalPlatform = process.platform;
const originalConfigDir = process.env.CLAUDE_CONFIG_DIR;
const originalUser = process.env.USER;
const roots: string[] = [];

const logger = {
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
};

type ExecFileSyncMock = ReturnType<typeof vi.fn>;
type LockSyncMock = ReturnType<typeof vi.fn>;

const oauth = {
  accessToken: 'new-access-token',
  refreshToken: 'new-refresh-token',
  expiresAt: 1_800_000_000_000,
};

function createCredentialRejectionRegistry() {
  const records = new Map<
    string,
    { revision: string | null; rejected: boolean; rejectionObserved: boolean }
  >();
  const normalize = (revision?: string | null): string | null =>
    typeof revision === 'string' && revision.length > 0 ? revision : null;
  const decision = (fingerprint: string, rawRevision?: string | null) => {
    const raw = normalize(rawRevision);
    const current = records.get(fingerprint);
    if (!current) {
      return { state: 'allowed' as const, effectiveAuthorizationRevision: raw };
    }
    if (current.rejected) {
      return {
        state: 'rejected' as const,
        effectiveAuthorizationRevision: current.revision,
      };
    }
    if (raw === null && current.rejectionObserved) {
      return {
        state: 'rejected' as const,
        effectiveAuthorizationRevision: current.revision,
      };
    }
    if (raw !== null && raw !== current.revision) {
      return { state: 'rejected' as const, effectiveAuthorizationRevision: raw };
    }
    return {
      state: 'allowed' as const,
      effectiveAuthorizationRevision: current.revision,
    };
  };
  return {
    accept: (fingerprint: string, revision: string) => {
      records.set(fingerprint, {
        revision,
        rejected: false,
        rejectionObserved: records.get(fingerprint)?.rejectionObserved ?? false,
      });
    },
    decision,
    state: (fingerprint: string, revision?: string | null) => decision(fingerprint, revision).state,
    mark: (fingerprint: string, revision?: string | null) => {
      const rejectedRevision = normalize(revision);
      const current = records.get(fingerprint);
      if (current && current.revision !== rejectedRevision) {
        if (current.rejectionObserved) return false;
        records.set(fingerprint, { ...current, rejectionObserved: true });
        return true;
      }
      if (current?.rejected && current.rejectionObserved) return false;
      records.set(fingerprint, {
        revision: rejectedRevision,
        rejected: true,
        rejectionObserved: true,
      });
      return true;
    },
  };
}

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
}

function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-claude-credentials-'));
  roots.push(root);
  return root;
}

function macError(status: number, stderr: string): Error & { status: number; stderr: string } {
  return Object.assign(new Error(stderr.trim()), { status, stderr });
}

function macNotFoundError(): Error & { status: number; stderr: string } {
  return macError(
    44,
    'security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.\n',
  );
}

async function importStore(options: {
  platform: NodeJS.Platform;
  execFileSync?: ExecFileSyncMock;
  lockSync?: LockSyncMock;
  realLock?: boolean;
  configDir?: string;
  bound?: boolean;
  bindingState?: 'bound' | 'unbound' | 'unreadable';
  bindingStateForCredentialTransaction?: () => 'bound' | 'unbound' | 'unreadable';
  credentialRejectionState?: (
    fingerprint: string,
    revision?: string | null,
  ) => 'allowed' | 'rejected' | 'unreadable';
  credentialRejectionDecision?: (
    fingerprint: string,
    revision?: string | null,
  ) => {
    state: 'allowed' | 'rejected' | 'unreadable';
    effectiveAuthorizationRevision: string | null;
  };
  credentialRejectionStateForBindingTransaction?: (
    fingerprint: string,
    revision?: string | null,
  ) => 'allowed' | 'rejected' | 'unreadable';
  markCredentialRejected?: (fingerprint: string, revision?: string | null) => boolean;
}) {
  vi.resetModules();
  setPlatform(options.platform);
  process.env.USER = 'cindy-test-user';
  process.env.CLAUDE_CONFIG_DIR = options.configDir ?? makeRoot();
  vi.doMock('../logger-adapter.js', () => ({
    desktopMakerLogger: { child: () => logger },
  }));
  vi.doMock('../nativeProviderAuthBinding.js', () => ({
    isNativeProviderAuthBound: () => options.bound ?? true,
    getNativeProviderAuthBindingState: () =>
      options.bindingState ?? (options.bound === false ? 'unbound' : 'bound'),
    getNativeProviderAuthBindingStateForCredentialTransaction: () =>
      options.bindingStateForCredentialTransaction?.() ??
      options.bindingState ??
      (options.bound === false ? 'unbound' : 'bound'),
    getNativeProviderAuthCredentialRejectionState: (
      _provider: string,
      fingerprint: string,
      revision?: string | null,
    ) => options.credentialRejectionState?.(fingerprint, revision) ?? 'allowed',
    resolveNativeProviderAuthCredentialRejection: (
      _provider: string,
      fingerprint: string,
      revision?: string | null,
    ) =>
      options.credentialRejectionDecision?.(fingerprint, revision) ?? {
        state: options.credentialRejectionState?.(fingerprint, revision) ?? 'allowed',
        effectiveAuthorizationRevision:
          typeof revision === 'string' && revision.length > 0 ? revision : null,
      },
    resolveNativeProviderAuthCredentialRejectionForStorageMutation: (
      _provider: string,
      fingerprint: string,
      revision?: string | null,
    ) =>
      options.credentialRejectionDecision?.(fingerprint, revision) ?? {
        state: options.credentialRejectionState?.(fingerprint, revision) ?? 'allowed',
        effectiveAuthorizationRevision:
          typeof revision === 'string' && revision.length > 0 ? revision : null,
      },
    runWithNativeProviderAuthCredentialRejectionForStorageMutation: <T>(
      _provider: string,
      fingerprint: string,
      revision: string | null | undefined,
      action: (decision: {
        state: 'allowed' | 'rejected' | 'unreadable';
        effectiveAuthorizationRevision: string | null;
      }) => T,
    ) =>
      action(
        options.credentialRejectionDecision?.(fingerprint, revision) ?? {
          state: options.credentialRejectionState?.(fingerprint, revision) ?? 'allowed',
          effectiveAuthorizationRevision:
            typeof revision === 'string' && revision.length > 0 ? revision : null,
        },
      ),
    runWithNativeProviderAuthCredentialRejectionForStorageSnapshot: <T>(
      _provider: string,
      fingerprint: string,
      revision: string | null | undefined,
      action: (decision: {
        state: 'allowed' | 'rejected' | 'unreadable';
        effectiveAuthorizationRevision: string | null;
      }) => T,
    ) =>
      action(
        options.credentialRejectionDecision?.(fingerprint, revision) ?? {
          state: options.credentialRejectionState?.(fingerprint, revision) ?? 'allowed',
          effectiveAuthorizationRevision:
            typeof revision === 'string' && revision.length > 0 ? revision : null,
        },
      ),
    getNativeProviderAuthCredentialRejectionStateForBindingTransaction: (
      _provider: string,
      fingerprint: string,
      revision?: string | null,
    ) =>
      options.credentialRejectionStateForBindingTransaction?.(fingerprint, revision) ??
      options.credentialRejectionState?.(fingerprint, revision) ??
      'allowed',
    resolveNativeProviderAuthCredentialRejectionForBindingTransaction: (
      _provider: string,
      fingerprint: string,
      revision?: string | null,
    ) =>
      options.credentialRejectionDecision?.(fingerprint, revision) ?? {
        state:
          options.credentialRejectionStateForBindingTransaction?.(fingerprint, revision) ??
          options.credentialRejectionState?.(fingerprint, revision) ??
          'allowed',
        effectiveAuthorizationRevision:
          typeof revision === 'string' && revision.length > 0 ? revision : null,
      },
    markNativeProviderAuthCredentialRejected: (
      _provider: string,
      fingerprint: string,
      revision?: string | null,
    ) => options.markCredentialRejected?.(fingerprint, revision) ?? true,
    markNativeProviderAuthCredentialRejectionRecovery: () => true,
  }));
  vi.doMock('node:child_process', () => ({
    execFileSync: options.execFileSync ?? vi.fn(),
  }));
  if (options.realLock) vi.doUnmock('proper-lockfile');
  else {
    vi.doMock('proper-lockfile', () => ({
      lockSync: options.lockSync ?? vi.fn(() => vi.fn()),
    }));
  }
  return import('../claude-credentials-store.js');
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.doUnmock('../logger-adapter.js');
  vi.doUnmock('../nativeProviderAuthBinding.js');
  vi.doUnmock('node:child_process');
  vi.doUnmock('proper-lockfile');
  Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
  if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = originalConfigDir;
  if (originalUser === undefined) delete process.env.USER;
  else process.env.USER = originalUser;
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  logger.info.mockReset();
  logger.warn.mockReset();
});

describe('Claude credential shared write lock', () => {
  it('holds Claude Code .storage-write lock across read, write, and verification', async () => {
    const root = makeRoot();
    let held = false;
    const release = vi.fn(() => {
      held = false;
    });
    const lockSync = vi.fn(() => {
      held = true;
      return release;
    });
    const expected = { claudeAiOauth: oauth };
    const execFileSync = vi
      .fn()
      .mockImplementationOnce(() => {
        expect(held).toBe(true);
        throw macNotFoundError();
      })
      .mockImplementationOnce(() => {
        expect(held).toBe(true);
        return '';
      })
      .mockImplementationOnce(() => {
        expect(held).toBe(true);
        return JSON.stringify(expected);
      });
    const { writeClaudeAiOAuth } = await importStore({
      platform: 'darwin',
      configDir: root,
      execFileSync,
      lockSync,
    });

    writeClaudeAiOAuth(oauth);

    expect(lockSync).toHaveBeenCalledWith(path.join(root, '.storage-write'), {
      realpath: false,
      stale: 15_000,
      update: 5_000,
      onCompromised: expect.any(Function),
    });
    expect(release).toHaveBeenCalledOnce();
    expect(held).toBe(false);
  });

  it('fails before reading or writing when Claude Code holds the shared lock', async () => {
    const execFileSync = vi.fn();
    const lockSync = vi.fn(() => {
      throw Object.assign(new Error('Lock file is already being held'), { code: 'ELOCKED' });
    });
    const { writeClaudeAiOAuth } = await importStore({
      platform: 'darwin',
      execFileSync,
      lockSync,
    });

    expect(() => writeClaudeAiOAuth(oauth)).toThrow(/credential store is busy/i);
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it('fails closed without throwing when another process holds the snapshot lock', async () => {
    const execFileSync = vi.fn();
    const lockSync = vi.fn(() => {
      throw Object.assign(new Error('Lock file is already being held'), { code: 'ELOCKED' });
    });
    const { readClaudeAiOAuth, hasClaudeAiOAuth } = await importStore({
      platform: 'darwin',
      execFileSync,
      lockSync,
    });

    expect(() => readClaudeAiOAuth()).not.toThrow();
    expect(readClaudeAiOAuth()).toBeNull();
    expect(hasClaudeAiOAuth()).toBe(false);
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it.each(['linux', 'win32'] as const)(
    'treats a missing config directory as absent without creating it on %s',
    async (platform) => {
      const root = makeRoot();
      const missing = path.join(root, 'missing-claude-dir');
      const execFileSync = vi.fn(() => JSON.stringify({ claudeAiOauth: oauth }));
      const lockSync = vi.fn(() => vi.fn());
      const { readClaudeAiOAuth, hasClaudeAiOAuth, getClaudeAiOAuthCredentialMatchState } =
        await importStore({
          platform,
          configDir: missing,
          execFileSync,
          lockSync,
        });

      expect(readClaudeAiOAuth()).toBeNull();
      expect(hasClaudeAiOAuth()).toBe(false);
      expect(getClaudeAiOAuthCredentialMatchState(oauth)).toBe('absent');
      expect(fs.existsSync(missing)).toBe(false);
      expect(lockSync).not.toHaveBeenCalled();
      expect(execFileSync).not.toHaveBeenCalled();
    },
  );

  it('reads a legacy macOS Keychain credential when the config directory is missing', async () => {
    const root = makeRoot();
    const missing = path.join(root, 'missing-claude-dir');
    const execFileSync = vi.fn(() => JSON.stringify({ claudeAiOauth: oauth }));
    const lockSync = vi.fn(() => vi.fn());
    const { readClaudeAiOAuth, hasClaudeAiOAuth, getClaudeAiOAuthCredentialMatchState } =
      await importStore({
        platform: 'darwin',
        configDir: missing,
        execFileSync,
        lockSync,
      });

    expect(readClaudeAiOAuth()).toEqual(oauth);
    expect(hasClaudeAiOAuth()).toBe(true);
    expect(getClaudeAiOAuthCredentialMatchState(oauth)).toBe('same');
    expect(fs.existsSync(missing)).toBe(false);
    expect(lockSync).not.toHaveBeenCalled();
    expect(execFileSync).toHaveBeenCalledTimes(3);
  });

  it('keeps a read-only current guard atomic without creating a missing Claude directory', async () => {
    const root = makeRoot();
    const missing = path.join(root, 'missing-claude-dir');
    const credential = {
      ...oauth,
      cindyAuthorizationRevision: 'login-revision-1',
    };
    const execFileSync = vi.fn(() => JSON.stringify({ claudeAiOauth: credential }));
    const lockSync = vi.fn(() => vi.fn());
    const store = await importStore({
      platform: 'darwin',
      configDir: missing,
      execFileSync,
      lockSync,
    });
    const action = vi.fn(() => 'projected');

    expect(store.runWithClaudeAiOAuthCredentialSnapshotCurrent(credential, action)).toEqual({
      state: 'current',
      value: 'projected',
    });
    expect(action).toHaveBeenCalledOnce();
    expect(fs.existsSync(missing)).toBe(false);
    expect(lockSync).not.toHaveBeenCalled();
  });

  it('read-only current guard preserves projection errors instead of misclassifying a switch', async () => {
    const root = makeRoot();
    const file = path.join(root, '.credentials.json');
    const credential = {
      ...oauth,
      cindyAuthorizationRevision: 'login-revision-1',
    };
    fs.writeFileSync(file, JSON.stringify({ claudeAiOauth: credential }));
    const store = await importStore({ platform: 'linux', configDir: root });
    const projectionError = new Error('projection failed');

    expect(() =>
      store.runWithClaudeAiOAuthCredentialSnapshotCurrent(credential, () => {
        throw projectionError;
      }),
    ).toThrow(projectionError);
  });

  it('treats a missing macOS config directory and Keychain item as absent', async () => {
    const root = makeRoot();
    const missing = path.join(root, 'missing-claude-dir');
    const execFileSync = vi.fn(() => {
      throw macNotFoundError();
    });
    const lockSync = vi.fn(() => vi.fn());
    const { readClaudeAiOAuth, hasClaudeAiOAuth, getClaudeAiOAuthCredentialMatchState } =
      await importStore({
        platform: 'darwin',
        configDir: missing,
        execFileSync,
        lockSync,
      });

    expect(readClaudeAiOAuth()).toBeNull();
    expect(hasClaudeAiOAuth()).toBe(false);
    expect(getClaudeAiOAuthCredentialMatchState(oauth)).toBe('absent');
    expect(fs.existsSync(missing)).toBe(false);
    expect(lockSync).not.toHaveBeenCalled();
    expect(execFileSync).toHaveBeenCalledTimes(3);
  });

  it('discards an unlocked macOS Keychain snapshot when a writer creates the lock directory', async () => {
    const root = makeRoot();
    const missing = path.join(root, 'missing-claude-dir');
    const execFileSync = vi.fn(() => {
      fs.mkdirSync(missing, { recursive: true });
      return JSON.stringify({ claudeAiOauth: oauth });
    });
    const lockSync = vi.fn(() => vi.fn());
    const { readClaudeAiOAuth } = await importStore({
      platform: 'darwin',
      configDir: missing,
      execFileSync,
      lockSync,
    });

    expect(readClaudeAiOAuth()).toBeNull();
    expect(fs.existsSync(missing)).toBe(true);
    expect(lockSync).not.toHaveBeenCalled();
    expect(execFileSync).toHaveBeenCalledOnce();
  });

  it('reports an unreadable credential match when a writer creates the missing macOS directory', async () => {
    const root = makeRoot();
    const missing = path.join(root, 'missing-claude-dir');
    const execFileSync = vi.fn(() => {
      fs.mkdirSync(missing, { recursive: true });
      return JSON.stringify({ claudeAiOauth: oauth });
    });
    const lockSync = vi.fn(() => vi.fn());
    const { getClaudeAiOAuthCredentialMatchState } = await importStore({
      platform: 'darwin',
      configDir: missing,
      execFileSync,
      lockSync,
    });

    expect(getClaudeAiOAuthCredentialMatchState(oauth)).toBe('unreadable');
    expect(lockSync).not.toHaveBeenCalled();
    expect(execFileSync).toHaveBeenCalledOnce();
  });

  it('fails closed without logging a local path when the macOS directory recheck fails', async () => {
    const root = makeRoot();
    const missing = path.join(root, 'missing-claude-dir');
    const secretPath = '/private/secret-user-path/.claude';
    const execFileSync = vi.fn(() => JSON.stringify({ claudeAiOauth: oauth }));
    const lockSync = vi.fn(() => vi.fn());
    const { readClaudeAiOAuth } = await importStore({
      platform: 'darwin',
      configDir: missing,
      execFileSync,
      lockSync,
    });
    const statSpy = vi
      .spyOn(fs, 'statSync')
      .mockImplementationOnce(() => {
        throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      })
      .mockImplementationOnce(() => {
        throw Object.assign(new Error(`permission denied: ${secretPath}`), { code: 'EACCES' });
      });

    try {
      expect(readClaudeAiOAuth()).toBeNull();
    } finally {
      statSpy.mockRestore();
    }
    expect(logger.warn).toHaveBeenCalledWith(
      'claude credential snapshot directory recheck unavailable',
      { code: 'EACCES' },
    );
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain(secretPath);
    expect(lockSync).not.toHaveBeenCalled();
    expect(execFileSync).toHaveBeenCalledOnce();
  });

  it('does not log a local path when snapshot directory access fails', async () => {
    const root = makeRoot();
    const secretPath = '/private/secret-user-path/.claude';
    const execFileSync = vi.fn();
    const lockSync = vi.fn(() => vi.fn());
    const { readClaudeAiOAuth } = await importStore({
      platform: 'linux',
      configDir: root,
      execFileSync,
      lockSync,
    });
    const statSpy = vi.spyOn(fs, 'statSync').mockImplementation(() => {
      throw Object.assign(new Error(`permission denied: ${secretPath}`), { code: 'EACCES' });
    });

    try {
      expect(readClaudeAiOAuth()).toBeNull();
    } finally {
      statSpy.mockRestore();
    }
    expect(logger.warn).toHaveBeenCalledWith('claude credential snapshot directory unavailable', {
      code: 'EACCES',
    });
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain(secretPath);
    expect(lockSync).not.toHaveBeenCalled();
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it('holds storage before both binding checks and the token read', async () => {
    let held = false;
    let bindingChecks = 0;
    const release = vi.fn(() => {
      held = false;
    });
    const lockSync = vi.fn(() => {
      held = true;
      return release;
    });
    const execFileSync = vi.fn(() => {
      expect(held).toBe(true);
      return JSON.stringify({ claudeAiOauth: oauth });
    });
    const { readClaudeAiOAuth } = await importStore({
      platform: 'darwin',
      execFileSync,
      lockSync,
      bindingStateForCredentialTransaction: () => {
        expect(held).toBe(true);
        bindingChecks += 1;
        return 'bound';
      },
    });

    expect(readClaudeAiOAuth()).toEqual(oauth);
    expect(bindingChecks).toBe(2);
    expect(release).toHaveBeenCalledOnce();
  });

  it('reports non-contention lock acquisition failures without calling them busy', async () => {
    const execFileSync = vi.fn();
    const lockSync = vi.fn(() => {
      throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
    });
    const { writeClaudeAiOAuth } = await importStore({
      platform: 'darwin',
      execFileSync,
      lockSync,
    });

    let thrown: unknown;
    try {
      writeClaudeAiOAuth(oauth);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toMatch(/failed to acquire.*write lock/i);
    expect((thrown as Error).message).not.toMatch(/store is busy/i);
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it('interoperates with the real proper-lockfile directory used by Claude Code', async () => {
    const root = makeRoot();
    const target = path.join(root, '.storage-write');
    const actual = await vi.importActual<typeof import('proper-lockfile')>('proper-lockfile');
    const externalRelease = actual.lockSync(target, { realpath: false, stale: 15_000 });
    const { writeClaudeAiOAuth } = await importStore({
      platform: 'linux',
      configDir: root,
      realLock: true,
    });

    try {
      expect(() => writeClaudeAiOAuth(oauth)).toThrow(/credential store is busy/i);
      expect(fs.existsSync(path.join(root, '.credentials.json'))).toBe(false);
    } finally {
      externalRelease();
    }

    expect(() => writeClaudeAiOAuth(oauth)).not.toThrow();
    expect(JSON.parse(fs.readFileSync(path.join(root, '.credentials.json'), 'utf8'))).toEqual({
      claudeAiOauth: oauth,
    });
  });

  it('releases the shared lock when a fail-closed read aborts the mutation', async () => {
    const release = vi.fn();
    const lockSync = vi.fn(() => release);
    const execFileSync = vi.fn(() => {
      throw macError(1, 'security: User interaction is not allowed.\n');
    });
    const { clearClaudeAiOAuth } = await importStore({
      platform: 'darwin',
      execFileSync,
      lockSync,
    });

    expect(() => clearClaudeAiOAuth()).toThrow(/credential store.*read/i);
    expect(release).toHaveBeenCalledOnce();
  });

  it('keeps the mutation error and logs details when lock release also fails', async () => {
    const release = vi.fn(() => {
      throw new Error('release failed');
    });
    const lockSync = vi.fn(() => release);
    const execFileSync = vi.fn(() => {
      throw macError(1, 'security: User interaction is not allowed.\n');
    });
    const { writeClaudeAiOAuth } = await importStore({
      platform: 'darwin',
      execFileSync,
      lockSync,
    });

    expect(() => writeClaudeAiOAuth(oauth)).toThrow(/credential store.*read/i);
    expect(logger.warn).toHaveBeenCalledWith(
      'claude credential write lock release failed after mutation error',
      { error: 'release failed' },
    );
  });
});

describe('Claude credential exact server-rejection fence', () => {
  it('fences every access-token backup that shares the revoked refresh grant', async () => {
    const root = makeRoot();
    const file = path.join(root, '.credentials.json');
    const rejected = {
      accessToken: 'access-after-refresh',
      refreshToken: 'shared-revoked-refresh',
    };
    const olderBackup = {
      accessToken: 'access-before-refresh',
      refreshToken: 'shared-revoked-refresh',
    };
    fs.writeFileSync(file, JSON.stringify({ claudeAiOauth: rejected }));
    const store = await importStore({ platform: 'linux', configDir: root });

    expect(store.fingerprintClaudeAiOAuthCredentialIdentity(rejected)).toBe(
      store.fingerprintClaudeAiOAuthCredentialIdentity(olderBackup),
    );
    expect(store.rejectClaudeAiOAuthCredentialIdentity(rejected)).toBe(true);
    fs.writeFileSync(file, JSON.stringify({ claudeAiOauth: olderBackup }));
    expect(store.readClaudeAiOAuth()).toBeNull();
    expect(store.getClaudeAiOAuthCredentialMatchState(rejected)).toBe('same');
    expect(store.clearClaudeAiOAuthIfMatches(rejected)).toBe('cleared');
    expect(fs.existsSync(file)).toBe(false);
  });

  it('runs a guarded action only before a same-token authorization revision is replaced', async () => {
    const root = makeRoot();
    const file = path.join(root, '.credentials.json');
    const revision1 = { ...oauth, cindyAuthorizationRevision: 'login-revision-1' };
    fs.writeFileSync(file, JSON.stringify({ claudeAiOauth: revision1 }));
    const store = await importStore({ platform: 'linux', configDir: root });
    const action = vi.fn(() => 'started');

    expect(store.runWithClaudeAiOAuthCredentialNotReplaced(revision1, action)).toEqual({
      state: 'current',
      value: 'started',
    });
    expect(action).toHaveBeenCalledOnce();

    const revision2 = { ...oauth, cindyAuthorizationRevision: 'login-revision-2' };
    fs.writeFileSync(file, JSON.stringify({ claudeAiOauth: revision2 }));
    expect(store.runWithClaudeAiOAuthCredentialNotReplaced(revision1, action)).toEqual({
      state: 'changed',
    });
    expect(action).toHaveBeenCalledOnce();
  });

  it('current-credential guard requires positive presence and accepts access rotation within one grant', async () => {
    const root = makeRoot();
    const file = path.join(root, '.credentials.json');
    const revision1 = {
      accessToken: 'access-a1',
      refreshToken: 'shared-refresh',
      cindyAuthorizationRevision: 'login-revision-1',
    };
    fs.writeFileSync(file, JSON.stringify({ claudeAiOauth: revision1 }));
    const store = await importStore({ platform: 'linux', configDir: root });
    const action = vi.fn(() => 'committed');

    expect(store.runWithClaudeAiOAuthCredentialCurrent(revision1, action)).toEqual({
      state: 'current',
      value: 'committed',
    });

    fs.writeFileSync(
      file,
      JSON.stringify({
        claudeAiOauth: { ...revision1, accessToken: 'access-a2' },
      }),
    );
    expect(store.runWithClaudeAiOAuthCredentialCurrent(revision1, action)).toEqual({
      state: 'current',
      value: 'committed',
    });

    expect(store.rejectClaudeAiOAuthCredentialIdentity(revision1)).toBe(true);
    expect(store.runWithClaudeAiOAuthCredentialCurrent(revision1, action)).toEqual({
      state: 'changed',
    });

    fs.unlinkSync(file);
    expect(store.runWithClaudeAiOAuthCredentialCurrent(revision1, action)).toEqual({
      state: 'changed',
    });
    expect(action).toHaveBeenCalledTimes(2);
  });

  it('absent-credential guard runs cleanup only while no credential is present', async () => {
    const root = makeRoot();
    const file = path.join(root, '.credentials.json');
    const store = await importStore({ platform: 'linux', configDir: root });
    const action = vi.fn(() => 'cleaned');

    expect(store.runWithClaudeAiOAuthCredentialAbsent(action)).toEqual({
      state: 'current',
      value: 'cleaned',
    });
    fs.writeFileSync(file, JSON.stringify({ claudeAiOauth: oauth }));
    expect(store.runWithClaudeAiOAuthCredentialAbsent(action)).toEqual({ state: 'changed' });
    expect(action).toHaveBeenCalledOnce();
  });

  it('hides only the rejected identity from every public reader until explicit authorization', async () => {
    const root = makeRoot();
    const file = path.join(root, '.credentials.json');
    const firstGrant = { ...oauth, cindyAuthorizationRevision: 'login-revision-1' };
    fs.writeFileSync(file, JSON.stringify({ claudeAiOauth: firstGrant }));
    const store = await importStore({ platform: 'linux', configDir: root });

    expect(store.readClaudeAiOAuth()).toEqual(firstGrant);
    expect(store.hasClaudeAiOAuth()).toBe(true);
    expect(store.getBoundClaudeAiOAuthState()).toBe('present');
    expect(store.hasClaudeAiOAuthUnbound()).toBe(true);
    expect(store.getClaudeAiOAuthCredentialMatchState(firstGrant)).toBe('same');

    expect(store.rejectClaudeAiOAuthCredentialIdentity(firstGrant)).toBe(true);
    expect(store.readClaudeAiOAuth()).toBeNull();
    expect(store.hasClaudeAiOAuth()).toBe(false);
    expect(store.getBoundClaudeAiOAuthState()).toBe('absent');
    expect(store.hasClaudeAiOAuthUnbound()).toBe(false);
    // Recovery code must still be able to prove and conditionally delete the
    // hidden identity without exposing its bytes to ordinary consumers.
    expect(store.getClaudeAiOAuthCredentialMatchState(firstGrant)).toBe('same');

    const replacement = {
      accessToken: 'replacement-access-token',
      refreshToken: 'replacement-refresh-token',
      expiresAt: oauth.expiresAt,
    };
    fs.writeFileSync(file, JSON.stringify({ claudeAiOauth: replacement }));
    expect(store.readClaudeAiOAuth()).toEqual(replacement);
    expect(store.hasClaudeAiOAuth()).toBe(true);

    for (let index = 0; index < 9; index += 1) {
      store.rejectClaudeAiOAuthCredentialIdentity({
        accessToken: `other-rejected-access-${index}`,
        refreshToken: `other-rejected-refresh-${index}`,
      });
    }

    // A non-cooperating external writer can roll the old blob back. Observing
    // the replacement — or later rejections — must not retire the old fence.
    fs.writeFileSync(file, JSON.stringify({ claudeAiOauth: firstGrant }));
    expect(store.readClaudeAiOAuth()).toBeNull();

    const explicitlyReauthorized = {
      ...firstGrant,
      cindyAuthorizationRevision: 'login-revision-2',
    };
    fs.writeFileSync(file, JSON.stringify({ claudeAiOauth: explicitlyReauthorized }));
    expect(store.readClaudeAiOAuth()).toEqual(explicitlyReauthorized);
    expect(store.getClaudeAiOAuthCredentialMatchState(firstGrant)).toBe('changed');
    expect(store.clearClaudeAiOAuthIfMatches(firstGrant)).toBe('changed');
    expect(store.readClaudeAiOAuth()).toEqual(explicitlyReauthorized);

    // The new authorization must not forgive an external rollback to the
    // exact server-rejected grant revision.
    fs.writeFileSync(file, JSON.stringify({ claudeAiOauth: firstGrant }));
    expect(store.readClaudeAiOAuth()).toBeNull();

    store.acceptClaudeAiOAuthCredentialIdentity(firstGrant);
    expect(store.readClaudeAiOAuth()).toEqual(firstGrant);
    expect(store.hasClaudeAiOAuth()).toBe(true);
  });

  it('persists a markerless rejection across process reload and blocks an r1 rollback after r2', async () => {
    const root = makeRoot();
    const file = path.join(root, '.credentials.json');
    const registry = createCredentialRejectionRegistry();
    const importOptions = {
      platform: 'linux' as const,
      configDir: root,
      credentialRejectionDecision: registry.decision,
      credentialRejectionState: registry.state,
      markCredentialRejected: registry.mark,
    };
    const revision1 = 'login-revision-1';
    const explicitR1 = { ...oauth, cindyAuthorizationRevision: revision1 };
    fs.writeFileSync(file, JSON.stringify({ claudeAiOauth: explicitR1 }));
    const process1 = await importStore(importOptions);
    const fingerprint = process1.fingerprintClaudeAiOAuthCredentialIdentity(explicitR1);
    registry.accept(fingerprint, revision1);

    // Claude's SDK rewrites the known fields and strips Cindy's revision. The
    // read still captures r1 under the sidecar lock before the request starts.
    const markerlessR1 = { ...oauth };
    fs.writeFileSync(file, JSON.stringify({ claudeAiOauth: markerlessR1 }));
    const requestCredential = process1.readClaudeAiOAuth();
    expect(requestCredential).toEqual(markerlessR1);
    expect(process1.rejectClaudeAiOAuthCredentialIdentity(requestCredential!)).toBe(true);

    fs.writeFileSync(file, JSON.stringify({ claudeAiOauth: explicitR1 }));
    expect(process1.readClaudeAiOAuth()).toBeNull();
    const process2 = await importStore(importOptions);
    expect(process2.readClaudeAiOAuth()).toBeNull();

    const revision2 = 'login-revision-2';
    const explicitR2 = { ...oauth, cindyAuthorizationRevision: revision2 };
    registry.accept(fingerprint, revision2);
    fs.writeFileSync(file, JSON.stringify({ claudeAiOauth: explicitR2 }));
    expect(process1.readClaudeAiOAuth()).toEqual(explicitR2);
    expect(process2.readClaudeAiOAuth()).toEqual(explicitR2);

    // Once this fingerprint has ever been rejected, a markerless copy is
    // information-theoretically ambiguous with an r1 backup and stays closed.
    fs.writeFileSync(file, JSON.stringify({ claudeAiOauth: markerlessR1 }));
    expect(process1.readClaudeAiOAuth()).toBeNull();
    expect(process2.readClaudeAiOAuth()).toBeNull();

    // A non-cooperating backup restore cannot resurrect the old epoch in
    // either the existing process or a newly loaded module.
    fs.writeFileSync(file, JSON.stringify({ claudeAiOauth: explicitR1 }));
    expect(process1.readClaudeAiOAuth()).toBeNull();
    expect(process2.readClaudeAiOAuth()).toBeNull();
  });

  it('does not let a markerless r1 invalid_grant revoke same-token r2 committed in flight', async () => {
    const root = makeRoot();
    const file = path.join(root, '.credentials.json');
    const registry = createCredentialRejectionRegistry();
    const store = await importStore({
      platform: 'linux',
      configDir: root,
      credentialRejectionDecision: registry.decision,
      credentialRejectionState: registry.state,
      markCredentialRejected: registry.mark,
    });
    const fingerprint = store.fingerprintClaudeAiOAuthCredentialIdentity(oauth);
    registry.accept(fingerprint, 'login-revision-1');
    fs.writeFileSync(file, JSON.stringify({ claudeAiOauth: oauth }));
    const r1Request = store.readClaudeAiOAuth();
    expect(r1Request).toEqual(oauth);

    const r2 = { ...oauth, cindyAuthorizationRevision: 'login-revision-2' };
    registry.accept(fingerprint, r2.cindyAuthorizationRevision);
    fs.writeFileSync(file, JSON.stringify({ claudeAiOauth: r2 }));
    expect(store.rejectClaudeAiOAuthCredentialIdentity(r1Request!)).toBe(true);
    expect(store.readClaudeAiOAuth()).toEqual(r2);
  });

  it('treats an in-flight SDK marker strip as the same epoch for exact cleanup', async () => {
    const root = makeRoot();
    const file = path.join(root, '.credentials.json');
    const registry = createCredentialRejectionRegistry();
    const store = await importStore({
      platform: 'linux',
      configDir: root,
      credentialRejectionDecision: registry.decision,
      credentialRejectionState: registry.state,
      markCredentialRejected: registry.mark,
    });
    const r1 = { ...oauth, cindyAuthorizationRevision: 'login-revision-1' };
    const fingerprint = store.fingerprintClaudeAiOAuthCredentialIdentity(r1);
    registry.accept(fingerprint, r1.cindyAuthorizationRevision);
    fs.writeFileSync(file, JSON.stringify({ claudeAiOauth: r1 }));
    const requestCredential = store.readClaudeAiOAuth()!;

    fs.writeFileSync(file, JSON.stringify({ claudeAiOauth: oauth }));
    store.rejectClaudeAiOAuthCredentialIdentity(requestCredential);
    expect(store.getClaudeAiOAuthCredentialMatchState(requestCredential)).toBe('same');
    expect(store.clearClaudeAiOAuthIfMatches(requestCredential)).toBe('cleared');
    expect(fs.existsSync(file)).toBe(false);
  });

  it('reports an unreadable rejection epoch instead of pretending the credential changed', async () => {
    const root = makeRoot();
    const file = path.join(root, '.credentials.json');
    fs.writeFileSync(file, JSON.stringify({ claudeAiOauth: oauth }));
    const store = await importStore({
      platform: 'linux',
      configDir: root,
      credentialRejectionDecision: () => ({
        state: 'unreadable',
        effectiveAuthorizationRevision: null,
      }),
    });

    expect(store.getClaudeAiOAuthCredentialMatchState(oauth)).toBe('unreadable');
    expect(() => store.clearClaudeAiOAuthIfMatches(oauth)).toThrow(/epoch is unreadable/i);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ claudeAiOauth: oauth });
  });
});

describe('macOS Claude credential store fail-closed reads', () => {
  it('exposes present, absent, and unreadable states to mutation callers', async () => {
    const presentExec = vi.fn(() => JSON.stringify({ claudeAiOauth: oauth }));
    const present = await importStore({ platform: 'darwin', execFileSync: presentExec });
    expect(present.getBoundClaudeAiOAuthState()).toBe('present');

    const absentExec = vi.fn(() => {
      throw macNotFoundError();
    });
    const absent = await importStore({ platform: 'darwin', execFileSync: absentExec });
    expect(absent.getBoundClaudeAiOAuthState()).toBe('absent');

    const unreadableExec = vi.fn(() => {
      throw macError(1, 'security: User interaction is not allowed.\n');
    });
    const unreadable = await importStore({ platform: 'darwin', execFileSync: unreadableExec });
    expect(unreadable.getBoundClaudeAiOAuthState()).toBe('unreadable');

    const unboundExec = vi.fn();
    const unbound = await importStore({
      platform: 'darwin',
      execFileSync: unboundExec,
      bound: false,
    });
    expect(unbound.getBoundClaudeAiOAuthState()).toBe('absent');
    expect(unboundExec).not.toHaveBeenCalled();

    const unreadableBindingExec = vi.fn();
    const unreadableBinding = await importStore({
      platform: 'darwin',
      execFileSync: unreadableBindingExec,
      bindingState: 'unreadable',
    });
    expect(unreadableBinding.getBoundClaudeAiOAuthState()).toBe('binding-unreadable');
    expect(unreadableBindingExec).not.toHaveBeenCalled();
  });

  it('does not write when Keychain is locked or permission is denied', async () => {
    const execFileSync = vi.fn(() => {
      throw macError(1, 'security: SecKeychainSearchCopyNext: User interaction is not allowed.\n');
    });
    const { writeClaudeAiOAuth } = await importStore({ platform: 'darwin', execFileSync });

    expect(() => writeClaudeAiOAuth(oauth)).toThrow(/credential store.*read/i);
    expect(execFileSync).toHaveBeenCalledTimes(1);
    expect(execFileSync).toHaveBeenCalledWith(
      'security',
      expect.arrayContaining(['find-generic-password']),
      expect.objectContaining({
        env: expect.objectContaining({ LC_ALL: 'C', LANG: 'C' }),
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    );
  });

  it('does not treat exit status 44 alone as proof that the item is absent', async () => {
    const execFileSync = vi.fn(() => {
      throw macError(44, 'security: an unrelated status-44 failure\n');
    });
    const { writeClaudeAiOAuth } = await importStore({ platform: 'darwin', execFileSync });

    expect(() => writeClaudeAiOAuth(oauth)).toThrow(/credential store.*read/i);
    expect(execFileSync).toHaveBeenCalledTimes(1);
  });

  it('creates an explicitly absent item without the destructive -U flag', async () => {
    const expected = { claudeAiOauth: oauth };
    const execFileSync = vi
      .fn()
      .mockImplementationOnce(() => {
        throw macNotFoundError();
      })
      .mockImplementationOnce(() => '')
      .mockImplementationOnce(() => JSON.stringify(expected));
    const { writeClaudeAiOAuth } = await importStore({ platform: 'darwin', execFileSync });

    expect(() => writeClaudeAiOAuth(oauth)).not.toThrow();
    expect(execFileSync).toHaveBeenCalledTimes(3);
    const createArgs = execFileSync.mock.calls[1]?.[1] as string[];
    const createOptions = execFileSync.mock.calls[1]?.[2] as { input?: string };
    expect(createArgs).toEqual(['-i']);
    expect(createOptions.input).toContain('add-generic-password');
    expect(createOptions.input).not.toMatch(/(?:^|\s)-U(?:\s|$)/);
  });

  it.each([
    ['quote/backslash', 'quoted"user\\name -U'],
    ['newline', 'line\nbreak'],
    ['carriage return', 'line\rbreak'],
    ['semicolon', 'user; delete-generic-password'],
    ['shell syntax', 'user`cmd`$(cmd)'],
    ['unicode', '用户'],
  ])('uses literal argv for an unsafe Keychain account containing %s', async (_case, account) => {
    const expected = { claudeAiOauth: oauth };
    const execFileSync = vi
      .fn()
      .mockImplementationOnce(() => {
        throw macNotFoundError();
      })
      .mockImplementationOnce(() => '')
      .mockImplementationOnce(() => JSON.stringify(expected));
    const { writeClaudeAiOAuth } = await importStore({ platform: 'darwin', execFileSync });
    process.env.USER = account;

    writeClaudeAiOAuth(oauth);

    const createArgs = execFileSync.mock.calls[1]?.[1] as string[];
    const createOptions = execFileSync.mock.calls[1]?.[2] as { input?: string };
    expect(createArgs[0]).toBe('add-generic-password');
    expect(createArgs).toContain(account);
    expect(createArgs.filter((arg) => arg === '-U')).toHaveLength(0);
    expect(createOptions.input).toBeUndefined();
    const hex = createArgs.at(-1);
    expect(JSON.parse(Buffer.from(hex!, 'hex').toString('utf8'))).toEqual(expected);
  });

  it('keeps a safe boundary Keychain account on the private interactive path', async () => {
    const safeAccount = 'a.b_c+tag@test-user';
    const expected = { claudeAiOauth: oauth };
    const execFileSync = vi
      .fn()
      .mockImplementationOnce(() => {
        throw macNotFoundError();
      })
      .mockImplementationOnce(() => '')
      .mockImplementationOnce(() => JSON.stringify(expected));
    const { writeClaudeAiOAuth } = await importStore({ platform: 'darwin', execFileSync });
    process.env.USER = safeAccount;

    writeClaudeAiOAuth(oauth);

    const createArgs = execFileSync.mock.calls[1]?.[1] as string[];
    const createOptions = execFileSync.mock.calls[1]?.[2] as { input?: string };
    expect(createArgs).toEqual(['-i']);
    expect(createOptions.input).toContain(`-a "${safeAccount}"`);
  });

  it('uses exactly one real update flag when an unsafe Keychain account is updated', async () => {
    const unsafeAccount = 'quoted"user -U';
    const before = { claudeAiOauth: { accessToken: 'old-token' } };
    const expected = { claudeAiOauth: oauth };
    const execFileSync = vi
      .fn()
      .mockImplementationOnce(() => JSON.stringify(before))
      .mockImplementationOnce(() => JSON.stringify(before))
      .mockImplementationOnce(() => '')
      .mockImplementationOnce(() => JSON.stringify(expected));
    const { writeClaudeAiOAuth } = await importStore({ platform: 'darwin', execFileSync });
    process.env.USER = unsafeAccount;

    writeClaudeAiOAuth(oauth);

    const updateArgs = execFileSync.mock.calls[2]?.[1] as string[];
    const updateOptions = execFileSync.mock.calls[2]?.[2] as { input?: string };
    expect(updateArgs[0]).toBe('add-generic-password');
    expect(updateArgs.filter((arg) => arg === '-U')).toHaveLength(1);
    expect(updateArgs).toContain(unsafeAccount);
    expect(updateOptions.input).toBeUndefined();
  });

  it('creates a large explicitly absent item through argv without -U', async () => {
    const largeOauth = { ...oauth, padding: 'x'.repeat(3_000) };
    const expected = { claudeAiOauth: largeOauth };
    const execFileSync = vi
      .fn()
      .mockImplementationOnce(() => {
        throw macNotFoundError();
      })
      .mockImplementationOnce(() => '')
      .mockImplementationOnce(() => JSON.stringify(expected));
    const { writeClaudeAiOAuth } = await importStore({ platform: 'darwin', execFileSync });

    writeClaudeAiOAuth(largeOauth);

    const createArgs = execFileSync.mock.calls[1]?.[1] as string[];
    expect(createArgs[0]).toBe('add-generic-password');
    expect(createArgs).not.toContain('-U');
    const hex = createArgs.at(-1);
    expect(JSON.parse(Buffer.from(hex!, 'hex').toString('utf8'))).toEqual(expected);
  });

  it('fails rather than overwriting when an item appears between the absent read and create', async () => {
    const execFileSync = vi
      .fn()
      .mockImplementationOnce(() => {
        throw macNotFoundError();
      })
      .mockImplementationOnce((_file: string, _args: string[], options: { input?: string }) => {
        expect(options.input).not.toMatch(/(?:^|\s)-U(?:\s|$)/);
        throw macError(
          45,
          'security: SecKeychainAddGenericPassword: The specified item already exists.\n',
        );
      })
      .mockImplementationOnce(() => {
        throw macError(1, 'security: User interaction is not allowed.\n');
      });
    const { writeClaudeAiOAuth } = await importStore({ platform: 'darwin', execFileSync });

    expect(() => writeClaudeAiOAuth(oauth)).toThrow();
    expect(execFileSync).toHaveBeenCalledTimes(3);
  });

  it('rereads and preserves a concurrently-created item before updating it', async () => {
    const raced = { mcpOAuth: { newServer: { accessToken: 'keep-me' } }, futureField: true };
    const expected = { ...raced, claudeAiOauth: oauth };
    const execFileSync = vi
      .fn()
      .mockImplementationOnce(() => {
        throw macNotFoundError();
      })
      .mockImplementationOnce(() => {
        throw macError(
          45,
          'security: SecKeychainAddGenericPassword: The specified item already exists.\n',
        );
      })
      .mockImplementationOnce(() => JSON.stringify(raced))
      .mockImplementationOnce(() => JSON.stringify(raced))
      .mockImplementationOnce(() => '')
      .mockImplementationOnce(() => JSON.stringify(expected));
    const { writeClaudeAiOAuth } = await importStore({ platform: 'darwin', execFileSync });

    expect(() => writeClaudeAiOAuth(oauth)).not.toThrow();
    const updateOptions = execFileSync.mock.calls[4]?.[2] as { input?: string };
    expect(updateOptions.input).toMatch(/(?:^|\s)-U(?:\s|$)/);
    const hex = updateOptions.input?.match(/-X "([0-9a-f]+)"/)?.[1];
    expect(JSON.parse(Buffer.from(hex!, 'hex').toString('utf8'))).toEqual(expected);
  });

  it('updates a readable item with -U and preserves every unrelated field', async () => {
    const before = {
      claudeAiOauth: { accessToken: 'old-token' },
      mcpOAuth: { github: { accessToken: 'mcp-token' } },
      futureField: { nested: true },
    };
    const expected = { ...before, claudeAiOauth: oauth };
    const execFileSync = vi
      .fn()
      .mockImplementationOnce(() => JSON.stringify(before))
      .mockImplementationOnce(() => JSON.stringify(before))
      .mockImplementationOnce(() => '')
      .mockImplementationOnce(() => JSON.stringify(expected));
    const { writeClaudeAiOAuth } = await importStore({ platform: 'darwin', execFileSync });

    writeClaudeAiOAuth(oauth);

    const updateOptions = execFileSync.mock.calls[2]?.[2] as { input?: string };
    expect(updateOptions.input).toMatch(/(?:^|\s)-U(?:\s|$)/);
    const hex = updateOptions.input?.match(/-X "([0-9a-f]+)"/)?.[1];
    expect(hex).toBeDefined();
    expect(JSON.parse(Buffer.from(hex!, 'hex').toString('utf8'))).toEqual(expected);
  });

  it('updates a large readable item through argv with -U and preserved fields', async () => {
    const before = { mcpOAuth: { payload: 'x'.repeat(3_000) }, futureField: true };
    const expected = { ...before, claudeAiOauth: oauth };
    const execFileSync = vi
      .fn()
      .mockImplementationOnce(() => JSON.stringify(before))
      .mockImplementationOnce(() => JSON.stringify(before))
      .mockImplementationOnce(() => '')
      .mockImplementationOnce(() => JSON.stringify(expected));
    const { writeClaudeAiOAuth } = await importStore({ platform: 'darwin', execFileSync });

    writeClaudeAiOAuth(oauth);

    const updateArgs = execFileSync.mock.calls[2]?.[1] as string[];
    expect(updateArgs[0]).toBe('add-generic-password');
    expect(updateArgs).toContain('-U');
    const hex = updateArgs.at(-1);
    expect(JSON.parse(Buffer.from(hex!, 'hex').toString('utf8'))).toEqual(expected);
  });

  it('never propagates credential hex from a failed large argv Keychain write', async () => {
    const leakedToken = 'must-not-appear-in-error-or-logs';
    const before = {
      claudeAiOauth: { accessToken: 'old-token' },
      mcpOAuth: { payload: 'x'.repeat(3_000) },
    };
    let leakedHex = '';
    const execFileSync = vi
      .fn()
      .mockImplementationOnce(() => JSON.stringify(before))
      .mockImplementationOnce(() => JSON.stringify(before))
      .mockImplementationOnce((_file: string, args: string[]) => {
        leakedHex = args.at(-1) ?? '';
        throw Object.assign(new Error(`Command failed: security ${args.join(' ')}`), {
          status: 1,
          stderr: Buffer.from(
            'security: SecKeychainAddGenericPassword: User interaction is not allowed.\n',
          ),
        });
      });
    const { writeClaudeAiOAuth } = await importStore({ platform: 'darwin', execFileSync });

    let thrown: unknown;
    try {
      writeClaudeAiOAuth({ ...oauth, accessToken: leakedToken });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe(
      'claude keychain credential write failed (status=1, reason=interaction-not-allowed)',
    );
    expect((thrown as Error).message).not.toContain(leakedToken);
    expect((thrown as Error).message).not.toContain(leakedHex);
    expect((thrown as Error).cause).toBeUndefined();
    expect(describeErrorChain(thrown)).toBe(
      'claude keychain credential write failed (status=1, reason=interaction-not-allowed)',
    );
    expect(describeErrorChain(thrown)).not.toContain(leakedToken);
    expect(describeErrorChain(thrown)).not.toContain(leakedHex);
  });

  it.each(['{', '[]', '"text"', 'null'])(
    'refuses to overwrite malformed or non-object JSON: %s',
    async (stored) => {
      const execFileSync = vi.fn(() => stored);
      const { writeClaudeAiOAuth } = await importStore({ platform: 'darwin', execFileSync });

      expect(() => writeClaudeAiOAuth(oauth)).toThrow(/credential store.*read/i);
      expect(execFileSync).toHaveBeenCalledTimes(1);
    },
  );

  it('returns null to read-only status callers when stored JSON is malformed', async () => {
    const execFileSync = vi.fn(() => '{');
    const { readClaudeAiOAuth } = await importStore({ platform: 'darwin', execFileSync });

    expect(() => readClaudeAiOAuth()).not.toThrow();
    expect(readClaudeAiOAuth()).toBeNull();
  });

  it('refuses to clear malformed data and never issues a delete or write', async () => {
    const execFileSync = vi.fn(() => '{');
    const { clearClaudeAiOAuth } = await importStore({ platform: 'darwin', execFileSync });

    expect(() => clearClaudeAiOAuth()).toThrow(/credential store.*read/i);
    expect(execFileSync).toHaveBeenCalledTimes(1);
  });

  it('rechecks before clear and preserves MCP credentials added by another process', async () => {
    const before = { claudeAiOauth: { accessToken: 'old-token' } };
    const raced = { ...before, mcpOAuth: { lateServer: { accessToken: 'keep-me' } } };
    const expected = { mcpOAuth: raced.mcpOAuth };
    const execFileSync = vi
      .fn()
      .mockImplementationOnce(() => JSON.stringify(before))
      .mockImplementationOnce(() => JSON.stringify(raced))
      .mockImplementationOnce(() => JSON.stringify(raced))
      .mockImplementationOnce(() => '')
      .mockImplementationOnce(() => JSON.stringify(expected));
    const { clearClaudeAiOAuth } = await importStore({ platform: 'darwin', execFileSync });

    clearClaudeAiOAuth();

    const mutationArgs = execFileSync.mock.calls[3]?.[1] as string[];
    expect(mutationArgs).toEqual(['-i']);
    const input = (execFileSync.mock.calls[3]?.[2] as { input?: string }).input;
    expect(input).toContain('-U');
    expect(execFileSync.mock.calls.flatMap((call) => call[1] as string[])).not.toContain(
      'delete-generic-password',
    );
    const hex = input?.match(/-X "([0-9a-f]+)"/)?.[1];
    expect(JSON.parse(Buffer.from(hex!, 'hex').toString('utf8'))).toEqual(expected);
  });
});

describe('file-backed Claude credential store fail-closed reads', () => {
  it('creates a new file only when the initial read is ENOENT', async () => {
    const root = makeRoot();
    const file = path.join(root, '.credentials.json');
    const { writeClaudeAiOAuth } = await importStore({ platform: 'linux', configDir: root });
    const writeTargets: string[] = [];
    const realWrite = fs.writeFileSync;
    const writeSpy = vi.spyOn(fs, 'writeFileSync').mockImplementation(((target, data, options) => {
      writeTargets.push(String(target));
      return realWrite(target, data, options);
    }) as typeof fs.writeFileSync);

    try {
      writeClaudeAiOAuth(oauth);
    } finally {
      writeSpy.mockRestore();
    }

    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ claudeAiOauth: oauth });
    expect(writeTargets).not.toContain(file);
    expect(
      writeTargets.some((target) => target.startsWith(`${file}.`) && target.endsWith('.tmp')),
    ).toBe(true);
    // Windows does not preserve POSIX permission bits even when mode is supplied.
    if (originalPlatform !== 'win32') {
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    }
  });

  it('leaves no malformed final file when an initial temp write fails partway', async () => {
    const root = makeRoot();
    const file = path.join(root, '.credentials.json');
    const { writeClaudeAiOAuth } = await importStore({ platform: 'linux', configDir: root });
    const realWrite = fs.writeFileSync;
    const writeSpy = vi.spyOn(fs, 'writeFileSync').mockImplementation(((target, data, options) => {
      if (String(target).endsWith('.tmp')) {
        realWrite(target, String(data).slice(0, 8), options);
        throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' });
      }
      return realWrite(target, data, options);
    }) as typeof fs.writeFileSync);

    try {
      expect(() => writeClaudeAiOAuth(oauth)).toThrow(/ENOSPC/);
    } finally {
      writeSpy.mockRestore();
    }
    expect(fs.existsSync(file)).toBe(false);
    expect(fs.readdirSync(root)).toEqual([]);

    expect(() => writeClaudeAiOAuth(oauth)).not.toThrow();
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ claudeAiOauth: oauth });
  });

  it('keeps the final path absent when atomic create publication fails', async () => {
    const root = makeRoot();
    const file = path.join(root, '.credentials.json');
    const { writeClaudeAiOAuth } = await importStore({ platform: 'linux', configDir: root });
    const linkSpy = vi.spyOn(fs, 'linkSync').mockImplementation(() => {
      throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
    });

    try {
      expect(() => writeClaudeAiOAuth(oauth)).toThrow(/EPERM/);
    } finally {
      linkSpy.mockRestore();
    }
    expect(fs.existsSync(file)).toBe(false);
    expect(fs.readdirSync(root)).toEqual([]);
  });

  it('keeps snapshot reads side-effect-free and reaps stale managed temps on mutation', async () => {
    const root = makeRoot();
    const file = path.join(root, '.credentials.json');
    const { readClaudeAiOAuth, hasClaudeAiOAuth, writeClaudeAiOAuth } = await importStore({
      platform: 'linux',
      configDir: root,
    });
    const realUnlink = fs.unlinkSync;
    const unlinkSpy = vi.spyOn(fs, 'unlinkSync').mockImplementation(((target) => {
      if (String(target).endsWith('.tmp')) {
        throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
      }
      return realUnlink(target);
    }) as typeof fs.unlinkSync);

    try {
      expect(() => writeClaudeAiOAuth(oauth)).not.toThrow();
    } finally {
      unlinkSpy.mockRestore();
    }
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ claudeAiOauth: oauth });
    expect(logger.warn).toHaveBeenCalledWith(
      'failed to remove staged claude credential temp file',
      {
        code: 'EPERM',
      },
    );

    const staged = fs
      .readdirSync(root)
      .find((name) => name.startsWith('.credentials.json.') && name.endsWith('.tmp'));
    expect(staged).toBeDefined();
    const stagedPath = path.join(root, staged!);
    const unrelatedPath = path.join(root, '.credentials.json.not-managed.tmp');
    fs.writeFileSync(unrelatedPath, 'do-not-delete');
    const old = new Date(Date.now() - 120_000);
    fs.utimesSync(stagedPath, old, old);
    fs.utimesSync(unrelatedPath, old, old);

    expect(hasClaudeAiOAuth()).toBe(true);
    expect(readClaudeAiOAuth()?.accessToken).toBe(oauth.accessToken);
    expect(fs.existsSync(stagedPath)).toBe(true);
    expect(fs.readFileSync(unrelatedPath, 'utf8')).toBe('do-not-delete');

    writeClaudeAiOAuth({ ...oauth, accessToken: 'replacement-access-token' });
    expect(fs.existsSync(stagedPath)).toBe(false);
    expect(fs.readFileSync(unrelatedPath, 'utf8')).toBe('do-not-delete');
  });

  it('never overwrites malformed JSON and leaves no temporary file behind', async () => {
    const root = makeRoot();
    const file = path.join(root, '.credentials.json');
    const original = '{"mcpOAuth":{"github":';
    fs.writeFileSync(file, original);
    const { writeClaudeAiOAuth } = await importStore({ platform: 'linux', configDir: root });

    expect(() => writeClaudeAiOAuth(oauth)).toThrow(/credential store.*read/i);
    expect(fs.readFileSync(file, 'utf8')).toBe(original);
    expect(fs.existsSync(`${file}.tmp`)).toBe(false);
  });

  it('never exposes token bytes from a malformed JSON parser error', async () => {
    const root = makeRoot();
    const file = path.join(root, '.credentials.json');
    const leakedToken = 'parser-must-not-echo-this-secret-token';
    fs.writeFileSync(file, `{"claudeAiOauth":{"accessToken":"${leakedToken}"`);
    const { writeClaudeAiOAuth } = await importStore({ platform: 'linux', configDir: root });

    let thrown: unknown;
    try {
      writeClaudeAiOAuth(oauth);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect(describeErrorChain(thrown)).toContain('malformed JSON');
    expect(describeErrorChain(thrown)).not.toContain(leakedToken);
  });

  it('treats non-ENOENT file errors as unreadable and performs zero writes', async () => {
    const root = makeRoot();
    const file = path.join(root, '.credentials.json');
    fs.mkdirSync(file);
    const { writeClaudeAiOAuth } = await importStore({ platform: 'linux', configDir: root });

    expect(() => writeClaudeAiOAuth(oauth)).toThrow(/credential store.*read/i);
    expect(fs.statSync(file).isDirectory()).toBe(true);
    expect(fs.existsSync(`${file}.tmp`)).toBe(false);
  });

  it('preserves unrelated fields while replacing claudeAiOauth', async () => {
    const root = makeRoot();
    const file = path.join(root, '.credentials.json');
    const before = {
      claudeAiOauth: { accessToken: 'old-token' },
      mcpOAuth: { github: { accessToken: 'mcp-token' } },
      futureField: ['keep', 'all', 'fields'],
    };
    fs.writeFileSync(file, JSON.stringify(before));
    const { writeClaudeAiOAuth } = await importStore({ platform: 'linux', configDir: root });

    writeClaudeAiOAuth(oauth);

    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ ...before, claudeAiOauth: oauth });
  });

  it('rechecks an existing file before update and preserves fields added concurrently', async () => {
    const root = makeRoot();
    const file = path.join(root, '.credentials.json');
    const before = { claudeAiOauth: { accessToken: 'old-token' } };
    const raced = { ...before, mcpOAuth: { lateServer: { accessToken: 'keep-me' } } };
    fs.writeFileSync(file, JSON.stringify(before));
    const { writeClaudeAiOAuth } = await importStore({ platform: 'linux', configDir: root });
    const realRead = fs.readFileSync;
    let reads = 0;
    const readSpy = vi.spyOn(fs, 'readFileSync').mockImplementation(((target, options) => {
      if (String(target) === file) {
        reads += 1;
        if (reads === 2) fs.writeFileSync(file, JSON.stringify(raced));
      }
      return realRead(target, options);
    }) as typeof fs.readFileSync);

    try {
      writeClaudeAiOAuth(oauth);
    } finally {
      readSpy.mockRestore();
    }
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({
      ...raced,
      claudeAiOauth: oauth,
    });
  });

  it('uses exclusive creation then rereads so a concurrent creator is preserved', async () => {
    const root = makeRoot();
    const file = path.join(root, '.credentials.json');
    const rival = JSON.stringify({ mcpOAuth: { rival: true } });
    const { writeClaudeAiOAuth } = await importStore({ platform: 'linux', configDir: root });
    const realWrite = fs.writeFileSync;
    let injected = false;
    const writeSpy = vi.spyOn(fs, 'writeFileSync').mockImplementation(((target, data, options) => {
      if (!injected) {
        injected = true;
        realWrite(file, rival);
      }
      return realWrite(target, data, options);
    }) as typeof fs.writeFileSync);

    try {
      expect(() => writeClaudeAiOAuth(oauth)).not.toThrow();
    } finally {
      writeSpy.mockRestore();
    }
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({
      mcpOAuth: { rival: true },
      claudeAiOauth: oauth,
    });
    expect(fs.existsSync(`${file}.tmp`)).toBe(false);
  });

  it.each(['EBUSY', 'EACCES', 'ENOTEMPTY'])(
    'retries a transient %s while publishing a credential update',
    async (code) => {
      const root = makeRoot();
      const file = path.join(root, '.credentials.json');
      fs.writeFileSync(file, JSON.stringify({ claudeAiOauth: { accessToken: 'old-token' } }));
      const { writeClaudeAiOAuth } = await importStore({ platform: 'win32', configDir: root });
      const realRename = fs.renameSync;
      let failures = 2;
      let attempts = 0;
      const renameSpy = vi.spyOn(fs, 'renameSync').mockImplementation(((from, to) => {
        if (String(from).endsWith('.tmp') && String(to) === file) {
          attempts += 1;
          if (failures > 0) {
            failures -= 1;
            throw Object.assign(new Error(code), { code });
          }
        }
        return realRename(from, to);
      }) as typeof fs.renameSync);

      try {
        expect(() => writeClaudeAiOAuth(oauth)).not.toThrow();
      } finally {
        renameSpy.mockRestore();
      }
      expect(attempts).toBe(3);
      expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ claudeAiOauth: oauth });
      expect(fs.readdirSync(root)).toEqual(['.credentials.json']);
    },
  );

  it.each(['EPERM', 'EEXIST'])(
    'uses a recoverable backup swap when Windows cannot overwrite an existing file with %s',
    async (code) => {
      const root = makeRoot();
      const file = path.join(root, '.credentials.json');
      const before = { claudeAiOauth: { accessToken: 'old-token' }, futureField: 'preserve' };
      fs.writeFileSync(file, JSON.stringify(before));
      const { writeClaudeAiOAuth } = await importStore({ platform: 'win32', configDir: root });
      const realRename = fs.renameSync.bind(fs);
      let publications = 0;
      const renameSpy = vi.spyOn(fs, 'renameSync').mockImplementation(((from, to) => {
        if (String(from).endsWith('.tmp') && String(to) === file) {
          publications += 1;
          if (publications === 1) throw Object.assign(new Error(code), { code });
        }
        return realRename(from, to);
      }) as typeof fs.renameSync);

      try {
        expect(() => writeClaudeAiOAuth(oauth)).not.toThrow();
      } finally {
        renameSpy.mockRestore();
      }

      expect(publications).toBe(2);
      expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({
        ...before,
        claudeAiOauth: oauth,
      });
      expect(fs.existsSync(`${file}.bak`)).toBe(false);
    },
  );

  it('leaves a backup-only credential untouched in snapshots and recovers it only for mutation', async () => {
    const root = makeRoot();
    const file = path.join(root, '.credentials.json');
    const backup = `${file}.bak`;
    const backupBytes = JSON.stringify({ claudeAiOauth: oauth });
    fs.writeFileSync(backup, backupBytes);
    const store = await importStore({ platform: 'win32', configDir: root });

    expect(store.hasClaudeAiOAuthUnbound()).toBe(false);
    expect(fs.existsSync(file)).toBe(false);
    expect(fs.existsSync(backup)).toBe(true);

    expect(store.readClaudeAiOAuth()).toBeNull();
    expect(fs.existsSync(file)).toBe(false);
    expect(fs.readFileSync(backup, 'utf8')).toBe(backupBytes);

    store.writeClaudeAiOAuth(oauth);
    expect(fs.existsSync(file)).toBe(true);
    expect(fs.existsSync(backup)).toBe(false);
    expect(store.readClaudeAiOAuth()).toEqual(oauth);
  });

  it('snapshot reads keep a stale backup beside a valid main credential for the next mutation', async () => {
    const root = makeRoot();
    const file = path.join(root, '.credentials.json');
    const backup = `${file}.bak`;
    const backupBytes = JSON.stringify({ claudeAiOauth: { accessToken: 'older' } });
    fs.writeFileSync(file, JSON.stringify({ claudeAiOauth: oauth }));
    fs.writeFileSync(backup, backupBytes);
    const store = await importStore({ platform: 'win32', configDir: root });

    expect(store.readClaudeAiOAuth()).toEqual(oauth);
    expect(fs.readFileSync(backup, 'utf8')).toBe(backupBytes);

    store.writeClaudeAiOAuth({ ...oauth, accessToken: 'new-token' });
    expect(fs.existsSync(backup)).toBe(false);
    expect(store.readClaudeAiOAuth()?.accessToken).toBe('new-token');
  });

  it('retries backup deletion before removing the main credential', async () => {
    const root = makeRoot();
    const file = path.join(root, '.credentials.json');
    const backup = `${file}.bak`;
    fs.writeFileSync(file, JSON.stringify({ claudeAiOauth: oauth }));
    fs.writeFileSync(backup, JSON.stringify({ claudeAiOauth: { accessToken: 'older' } }));
    const { clearClaudeAiOAuth } = await importStore({ platform: 'win32', configDir: root });
    const realUnlink = fs.unlinkSync.bind(fs);
    const events: string[] = [];
    let transientFailures = 2;
    const unlinkSpy = vi.spyOn(fs, 'unlinkSync').mockImplementation(((target) => {
      events.push(String(target));
      if (String(target) === backup && transientFailures > 0) {
        transientFailures -= 1;
        throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
      }
      return realUnlink(target);
    }) as typeof fs.unlinkSync);

    try {
      expect(() => clearClaudeAiOAuth()).not.toThrow();
    } finally {
      unlinkSpy.mockRestore();
    }

    expect(events.filter((target) => target === backup).length).toBeGreaterThanOrEqual(3);
    expect(events.indexOf(file)).toBeGreaterThan(events.indexOf(backup));
    expect(fs.existsSync(file)).toBe(false);
    expect(fs.existsSync(backup)).toBe(false);
  });

  it('keeps the main credential intact when its backup cannot be deleted safely', async () => {
    const root = makeRoot();
    const file = path.join(root, '.credentials.json');
    const backup = `${file}.bak`;
    fs.writeFileSync(file, JSON.stringify({ claudeAiOauth: oauth }));
    fs.writeFileSync(backup, JSON.stringify({ claudeAiOauth: { accessToken: 'older' } }));
    const { clearClaudeAiOAuth } = await importStore({ platform: 'win32', configDir: root });
    const realUnlink = fs.unlinkSync.bind(fs);
    const unlinkSpy = vi.spyOn(fs, 'unlinkSync').mockImplementation(((target) => {
      if (String(target) === backup) {
        throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
      }
      return realUnlink(target);
    }) as typeof fs.unlinkSync);

    try {
      expect(() => clearClaudeAiOAuth()).toThrow(/EPERM/);
    } finally {
      unlinkSpy.mockRestore();
    }

    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ claudeAiOauth: oauth });
    expect(fs.existsSync(backup)).toBe(true);
  });

  it('preserves the old credential and removes its temp after persistent update contention', async () => {
    const root = makeRoot();
    const file = path.join(root, '.credentials.json');
    const before = { claudeAiOauth: { accessToken: 'old-token' } };
    fs.writeFileSync(file, JSON.stringify(before));
    const { writeClaudeAiOAuth } = await importStore({ platform: 'win32', configDir: root });
    let attempts = 0;
    const renameSpy = vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      attempts += 1;
      throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' });
    });

    try {
      expect(() => writeClaudeAiOAuth(oauth)).toThrow(/EBUSY/);
    } finally {
      renameSpy.mockRestore();
    }
    expect(attempts).toBe(4);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual(before);
    expect(fs.readdirSync(root)).toEqual(['.credentials.json']);
  });

  it('rechecks before clear and preserves fields added concurrently', async () => {
    const root = makeRoot();
    const file = path.join(root, '.credentials.json');
    const before = { claudeAiOauth: { accessToken: 'old-token' } };
    const raced = { ...before, mcpOAuth: { lateServer: { accessToken: 'keep-me' } } };
    fs.writeFileSync(file, JSON.stringify(before));
    const { clearClaudeAiOAuth } = await importStore({ platform: 'linux', configDir: root });
    const realRead = fs.readFileSync;
    let reads = 0;
    const readSpy = vi.spyOn(fs, 'readFileSync').mockImplementation(((target, options) => {
      if (String(target) === file) {
        reads += 1;
        if (reads === 2) fs.writeFileSync(file, JSON.stringify(raced));
      }
      return realRead(target, options);
    }) as typeof fs.readFileSync);

    try {
      clearClaudeAiOAuth();
    } finally {
      readSpy.mockRestore();
    }
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ mcpOAuth: raced.mcpOAuth });
  });

  it('commits stale ownership but reports absent when the blob only has unrelated fields', async () => {
    const root = makeRoot();
    const file = path.join(root, '.credentials.json');
    const original = JSON.stringify({ mcpOAuth: { keep: true } });
    fs.writeFileSync(file, original);
    const { clearClaudeAiOAuthWithBindingCommit } = await importStore({
      platform: 'linux',
      configDir: root,
    });
    const validate = vi.fn(() => true);
    const commit = vi.fn(() => true);

    expect(clearClaudeAiOAuthWithBindingCommit(validate, commit)).toBe('absent');

    expect(validate).toHaveBeenCalledOnce();
    expect(commit).toHaveBeenCalledOnce();
    expect(fs.readFileSync(file, 'utf8')).toBe(original);
  });

  it('refuses to clear unreadable JSON and keeps the original bytes', async () => {
    const root = makeRoot();
    const file = path.join(root, '.credentials.json');
    const original = '{';
    fs.writeFileSync(file, original);
    const { clearClaudeAiOAuth } = await importStore({ platform: 'linux', configDir: root });

    expect(() => clearClaudeAiOAuth()).toThrow(/credential store.*read/i);
    expect(fs.readFileSync(file, 'utf8')).toBe(original);
  });

  it('clears only claudeAiOauth and preserves MCP credentials', async () => {
    const root = makeRoot();
    const file = path.join(root, '.credentials.json');
    const before = {
      claudeAiOauth: { accessToken: 'old-token' },
      mcpOAuth: { github: { accessToken: 'mcp-token' } },
    };
    fs.writeFileSync(file, JSON.stringify(before));
    const { clearClaudeAiOAuth } = await importStore({ platform: 'linux', configDir: root });

    clearClaudeAiOAuth();

    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ mcpOAuth: before.mcpOAuth });
  });

  it('compare-and-clear only removes the exact rejected OAuth credential', async () => {
    const root = makeRoot();
    const file = path.join(root, '.credentials.json');
    const replacement = {
      accessToken: 'at-new-account',
      refreshToken: 'rt-new-account',
      expiresAt: 1_900_000_000_000,
    };
    fs.writeFileSync(
      file,
      JSON.stringify({ claudeAiOauth: replacement, mcpOAuth: { server: { token: 'keep-me' } } }),
    );
    const store = await importStore({ platform: 'linux', configDir: root });

    expect(
      store.clearClaudeAiOAuthIfMatches({
        accessToken: 'at-old-account',
        refreshToken: 'rt-old-account',
      }),
    ).toBe('changed');
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({
      claudeAiOauth: replacement,
      mcpOAuth: { server: { token: 'keep-me' } },
    });

    expect(
      store.clearClaudeAiOAuthIfMatches({
        accessToken: replacement.accessToken,
        refreshToken: replacement.refreshToken,
      }),
    ).toBe('cleared');
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({
      mcpOAuth: { server: { token: 'keep-me' } },
    });
  });

  it('compare-and-replace never overwrites a credential changed before the storage lock', async () => {
    const root = makeRoot();
    const file = path.join(root, '.credentials.json');
    const current = { accessToken: 'at-current', refreshToken: 'rt-current' };
    fs.writeFileSync(file, JSON.stringify({ claudeAiOauth: current, unknown: { preserve: true } }));
    const store = await importStore({ platform: 'linux', configDir: root });

    expect(
      store.replaceClaudeAiOAuthIfMatches(
        { accessToken: 'at-old', refreshToken: 'rt-old' },
        { accessToken: 'at-refreshed-old-account', refreshToken: 'rt-refreshed' },
      ),
    ).toBe('changed');
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({
      claudeAiOauth: current,
      unknown: { preserve: true },
    });

    const sameGrantWithRotatedAccess = {
      accessToken: 'at-rotated-by-other-process',
      refreshToken: current.refreshToken,
    };
    fs.writeFileSync(
      file,
      JSON.stringify({ claudeAiOauth: sameGrantWithRotatedAccess, unknown: { preserve: true } }),
    );
    expect(
      store.replaceClaudeAiOAuthIfMatches(current, {
        accessToken: 'at-must-not-overwrite-rotation',
        refreshToken: 'rt-refreshed',
      }),
    ).toBe('changed');
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({
      claudeAiOauth: sameGrantWithRotatedAccess,
      unknown: { preserve: true },
    });

    const next = { accessToken: 'at-next', refreshToken: 'rt-next' };
    fs.writeFileSync(file, JSON.stringify({ claudeAiOauth: current, unknown: { preserve: true } }));
    expect(store.replaceClaudeAiOAuthIfMatches(current, next)).toBe('written');
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({
      claudeAiOauth: next,
      unknown: { preserve: true },
    });
  });

  it('refresh patch preserves same-token metadata written by another process', async () => {
    const root = makeRoot();
    const file = path.join(root, '.credentials.json');
    const current = {
      accessToken: 'at-current',
      refreshToken: 'rt-current',
      expiresAt: 100,
      scopes: ['old-scope'],
      subscriptionType: 'team',
      rateLimitTier: 'tier-concurrent',
      futureOAuthField: { preserve: true },
    };
    fs.writeFileSync(file, JSON.stringify({ claudeAiOauth: current }));
    const store = await importStore({ platform: 'linux', configDir: root });

    expect(
      store.replaceClaudeAiOAuthIfMatches(
        { accessToken: 'at-current', refreshToken: 'rt-current' },
        {
          accessToken: 'at-refreshed',
          refreshToken: 'rt-refreshed',
          expiresAt: 200,
          scopes: ['new-scope'],
          subscriptionType: 'stale-profile',
          rateLimitTier: 'stale-tier',
          futureOAuthField: { overwrite: true },
        },
        'refresh',
      ),
    ).toBe('written');
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).claudeAiOauth).toEqual({
      ...current,
      accessToken: 'at-refreshed',
      refreshToken: 'rt-refreshed',
      expiresAt: 200,
      scopes: ['new-scope'],
    });
  });

  it('profile patch fills only missing profile fields and preserves all token metadata', async () => {
    const root = makeRoot();
    const file = path.join(root, '.credentials.json');
    const current = {
      accessToken: 'at-current',
      refreshToken: 'rt-current',
      expiresAt: 100,
      subscriptionType: 'team',
      rateLimitTier: null,
      futureOAuthField: 'keep-me',
    };
    fs.writeFileSync(file, JSON.stringify({ claudeAiOauth: current }));
    const store = await importStore({ platform: 'linux', configDir: root });

    expect(
      store.replaceClaudeAiOAuthIfMatches(
        current,
        {
          ...current,
          subscriptionType: 'stale-pro',
          rateLimitTier: 'tier-profile',
          futureOAuthField: 'stale-value',
        },
        'profile',
      ),
    ).toBe('written');
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).claudeAiOauth).toEqual({
      ...current,
      rateLimitTier: 'tier-profile',
    });
  });

  it('login transaction rolls its token back when the authorization marker no longer matches', async () => {
    const root = makeRoot();
    const file = path.join(root, '.credentials.json');
    const before = {
      claudeAiOauth: { accessToken: 'at-before', refreshToken: 'rt-before' },
      mcpOAuth: { keep: true },
    };
    fs.writeFileSync(file, JSON.stringify(before));
    const store = await importStore({ platform: 'linux', configDir: root });

    expect(
      store.writeClaudeAiOAuthWithBindingCommit(
        { accessToken: 'at-rejected', refreshToken: 'rt-rejected' },
        () => false,
      ),
    ).toBe(false);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual(before);
  });

  it('logout transaction validates before clear, finalizes after it, and stops on marker mismatch', async () => {
    const root = makeRoot();
    const file = path.join(root, '.credentials.json');
    const before = { claudeAiOauth: { accessToken: 'at-current', refreshToken: 'rt-current' } };
    fs.writeFileSync(file, JSON.stringify(before));
    const store = await importStore({ platform: 'linux', configDir: root });
    const events: string[] = [];

    expect(
      store.clearClaudeAiOAuthWithBindingCommit(
        () => {
          events.push('binding-check');
          return false;
        },
        () => {
          throw new Error('must not finalize a mismatched marker');
        },
      ),
    ).toBe('binding-changed');
    expect(events).toEqual(['binding-check']);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual(before);

    expect(
      store.clearClaudeAiOAuthWithBindingCommit(
        () => {
          events.push('binding-validated');
          expect(fs.existsSync(file)).toBe(true);
          return true;
        },
        () => {
          events.push('binding-commit');
          expect(fs.existsSync(file)).toBe(false);
          return true;
        },
      ),
    ).toBe('cleared');
    expect(events).toEqual(['binding-check', 'binding-validated', 'binding-commit']);
    expect(fs.existsSync(file)).toBe(false);
  });
});
