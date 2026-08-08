import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

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

  it.each(['linux', 'darwin'] as const)(
    'treats a missing config directory as absent without creating it on %s',
    async (platform) => {
      const root = makeRoot();
      const missing = path.join(root, 'missing-claude-dir');
      const execFileSync = vi.fn(() => JSON.stringify({ claudeAiOauth: oauth }));
      const lockSync = vi.fn(() => vi.fn());
      const {
        readClaudeAiOAuth,
        hasClaudeAiOAuth,
        getClaudeAiOAuthCredentialMatchState,
      } = await importStore({
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
    expect(writeTargets.some((target) => target.startsWith(`${file}.`) && target.endsWith('.tmp')))
      .toBe(true);
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
    expect(logger.warn).toHaveBeenCalledWith('failed to remove staged claude credential temp file', {
      code: 'EPERM',
    });

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

  it('removes its unique temporary file when an update rename fails', async () => {
    const root = makeRoot();
    const file = path.join(root, '.credentials.json');
    fs.writeFileSync(file, JSON.stringify({ claudeAiOauth: { accessToken: 'old-token' } }));
    const { writeClaudeAiOAuth } = await importStore({ platform: 'linux', configDir: root });
    const renameSpy = vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' });
    });

    try {
      expect(() => writeClaudeAiOAuth(oauth)).toThrow(/EBUSY/);
    } finally {
      renameSpy.mockRestore();
    }
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

    const next = { accessToken: 'at-next', refreshToken: 'rt-next' };
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
