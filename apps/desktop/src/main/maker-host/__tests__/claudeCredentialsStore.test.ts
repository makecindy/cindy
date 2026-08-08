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
}) {
  vi.resetModules();
  setPlatform(options.platform);
  process.env.USER = 'cindy-test-user';
  process.env.CLAUDE_CONFIG_DIR = options.configDir ?? makeRoot();
  vi.doMock('../logger-adapter.js', () => ({
    desktopMakerLogger: { child: () => logger },
  }));
  vi.doMock('../nativeProviderAuthBinding.js', () => ({
    isNativeProviderAuthBound: () => true,
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
});

describe('macOS Claude credential store fail-closed reads', () => {
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

    writeClaudeAiOAuth(oauth);

    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ claudeAiOauth: oauth });
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
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
});
