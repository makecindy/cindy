/**
 * Test value
 * - Production entry/result: readExternalClaudeRuntime and selected runtime.prepare either
 *   return one explicit local runtime or reject launch; no stock fallback on invalid config.
 * - Basis: credentials-and-local-storage (no secrets/checkout credentials), configuration-and-
 *   overrides (explicit opt-in), and the user's required proxy-failure launch rejection.
 * - Gap: claudeNativeCli tests cover stock discovery, not an external binary/profile/preflight.
 * - Minimal failure: enabled config with an auth env override or failed preflight must not launch.
 * - Tier: unit; bounded temp config IO, in-memory child-process transport, fake timeout clock.
 * - Runtime: targeted Vitest run ~1.4s; no real CLI, credentials, network or browser used.
 */
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ file: '', home: '', spawn: vi.fn() }));
vi.mock('../../userDataPath.js', () => ({ userDataPath: () => h.file }));
vi.mock('node:child_process', () => ({ spawn: h.spawn }));
vi.mock('node:os', async (original) => ({
  ...(await original<typeof import('node:os')>()),
  homedir: () => h.home,
}));

import {
  externalClaudeDefaultDirectory,
  externalClaudeDirectoryForAccount,
  externalClaudeRuntimeForDirectory,
  readExternalClaudeRuntime,
  peekExternalClaudeAccountId,
} from '../external-claude-runtime.js';

let root: string;
let config: Record<string, any>;
type FakeChild = EventEmitter & { kill: ReturnType<typeof vi.fn> };

function child(): FakeChild {
  const result = new EventEmitter() as FakeChild;
  result.kill = vi.fn(() => true);
  return result;
}

function write(value: unknown = config): void {
  writeFileSync(h.file, JSON.stringify(value));
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'cindy-external-claude-test-'));
  h.home = path.join(root, 'fake-home');
  h.file = path.join(root, 'external-claude-runtime.json');
  config = {
    schema: 1, enabled: true, accountId: 'default',
    executablePath: process.execPath,
    configDir: path.join(root, 'external-profile'),
    env: {
      HTTP_PROXY: 'http://127.0.0.1:17890', HTTPS_PROXY: 'http://127.0.0.1:17890',
      ALL_PROXY: 'http://127.0.0.1:17890', NO_PROXY: 'localhost,127.0.0.1,::1',
      BROWSER: process.execPath, DISABLE_AUTOUPDATER: '1',
    },
    preflight: { command: process.execPath, args: ['preflight-test-only'], timeoutMs: 200 },
  };
  h.spawn.mockReset();
  h.spawn.mockImplementation(() => {
    const spawned = child();
    queueMicrotask(() => spawned.emit('close', 0));
    return spawned;
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

describe('external Claude runtime opt-in', () => {
  it('does not treat a broken optional config as a stock-account selection or weaken strict launch checks', () => {
    writeFileSync(h.file, '{broken-json');
    expect(peekExternalClaudeAccountId()).toBeUndefined();
    expect(readExternalClaudeRuntime).toThrow('configuration is unreadable or invalid');
    write();
    expect(peekExternalClaudeAccountId()).toBe('default');
  });
  it('keeps the stock runtime when the override is absent or explicitly disabled', () => {
    expect(readExternalClaudeRuntime()).toBeNull();
    expect(externalClaudeRuntimeForDirectory()).toBeUndefined();
    write({ schema: 1, enabled: false });
    expect(externalClaudeDefaultDirectory()).toBeUndefined();
    expect(h.spawn).not.toHaveBeenCalled();
  });

  it('binds only the default or selected external profile and pins both proxy spellings without mutating ambient env', async () => {
    vi.stubEnv('HTTPS_PROXY', 'http://127.0.0.1:19999');
    vi.stubEnv('https_proxy', 'http://127.0.0.1:18888');
    vi.stubEnv('ANTHROPIC_API_KEY', 'test-only-not-a-real-key');
    const ambientProxy = process.env.HTTPS_PROXY; // Windows environment names are case insensitive.
    write();
    const runtime = externalClaudeRuntimeForDirectory(path.join(homedir(), '.claude'))!;
    expect(runtime.executablePath).toBe(process.execPath);
    expect(runtime.env).toMatchObject({
      CLAUDE_CONFIG_DIR: config.configDir,
      HTTPS_PROXY: 'http://127.0.0.1:17890', https_proxy: 'http://127.0.0.1:17890',
    });
    expect(externalClaudeDefaultDirectory()).toBe(config.configDir);
    expect(externalClaudeRuntimeForDirectory(config.configDir)?.env.CLAUDE_CONFIG_DIR).toBe(config.configDir);
    expect(externalClaudeRuntimeForDirectory(path.join(root, 'unrelated-account'))).toBeUndefined();
    await runtime.prepare();
    const [command, args, options] = h.spawn.mock.calls[0];
    expect(command).toBe(process.execPath);
    expect(args).toEqual(['preflight-test-only']);
    expect(options).toMatchObject({ shell: false, windowsHide: true, stdio: 'ignore' });
    expect(options.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(options.env.HTTPS_PROXY).toBe('http://127.0.0.1:17890');
    expect(process.env.HTTPS_PROXY).toBe(ambientProxy);
    expect(process.env.ANTHROPIC_API_KEY).toBe('test-only-not-a-real-key');
  });

  it.each([
    ['credential environment', (c: typeof config) => { c.env.ANTHROPIC_API_KEY = 'test-only-secret'; }],
    ['provider base URL', (c: typeof config) => { c.env.ANTHROPIC_BASE_URL = 'https://test.invalid'; }],
    ['script injection environment', (c: typeof config) => { c.env.NODE_OPTIONS = '--require test-only'; }],
    ['proxy credentials', (c: typeof config) => { c.env.HTTP_PROXY = c.env.HTTPS_PROXY = c.env.ALL_PROXY = 'http://test:test@127.0.0.1:17890'; }],
    ['proxy bypass', (c: typeof config) => { c.env.NO_PROXY = '*'; }],
    ['incomplete proxy', (c: typeof config) => { delete c.env.ALL_PROXY; }],
    ['other account', (c: typeof config) => { c.accountId = 'another'; }],
    ['relative binary', (c: typeof config) => { c.executablePath = 'claude.exe'; }],
    ['missing binary', (c: typeof config) => { c.executablePath = path.join(root, 'missing.exe'); }],
    ['missing browser', (c: typeof config) => { c.env.BROWSER = path.join(root, 'missing-browser.exe'); }],
    ['unbounded preflight', (c: typeof config) => { c.preflight.timeoutMs = 30001; }],
  ])('rejects %s without falling back or exposing input values', (_label, change) => {
    change(config);
    write();
    let error: unknown;
    try { externalClaudeRuntimeForDirectory(); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain('test-only-secret');
    expect(h.spawn).not.toHaveBeenCalled();
  });

  it('rejects malformed, oversized and non-file configuration without modifying it', () => {
    writeFileSync(h.file, '{broken');
    expect(() => readExternalClaudeRuntime()).toThrow('External Claude runtime');
    writeFileSync(h.file, ' '.repeat(33 * 1024));
    expect(() => readExternalClaudeRuntime()).toThrow('External Claude runtime');
    rmSync(h.file);
    mkdirSync(h.file);
    expect(() => readExternalClaudeRuntime()).toThrow('External Claude runtime');
  });

  it('refuses a profile inside a Git checkout without creating the profile', () => {
    const checkout = path.join(root, 'checkout');
    mkdirSync(checkout);
    writeFileSync(path.join(checkout, '.git'), 'gitdir: test-only');
    config.configDir = path.join(checkout, 'not-created', 'profile');
    write();
    expect(() => externalClaudeDefaultDirectory()).toThrow('outside a Git checkout');
    expect(h.spawn).not.toHaveBeenCalled();
  });

  it('rejects a preflight error without surfacing its potentially sensitive message', async () => {
    h.spawn.mockImplementation(() => {
      const spawned = child();
      queueMicrotask(() => spawned.emit('error', new Error('test-only-secret in process arguments')));
      return spawned;
    });
    write();
    await expect(externalClaudeRuntimeForDirectory()!.prepare()).rejects.toThrow('preflight could not start');
  });

  it('rejects nonzero preflight exit and never launches a fallback', async () => {
    h.spawn.mockImplementation(() => {
      const spawned = child();
      queueMicrotask(() => spawned.emit('close', 7));
      return spawned;
    });
    write();
    await expect(externalClaudeRuntimeForDirectory()!.prepare()).rejects.toThrow('preflight rejected launch');
    expect(h.spawn).toHaveBeenCalledTimes(1);
  });

  it('kills a timed-out preflight and rejects even if a late success arrives', async () => {
    vi.useFakeTimers();
    const spawned = child();
    h.spawn.mockReturnValue(spawned);
    write();
    const preparation = externalClaudeRuntimeForDirectory()!.prepare();
    const rejected = expect(preparation).rejects.toThrow('preflight timed out');
    await vi.advanceTimersByTimeAsync(200);
    await rejected;
    expect(spawned.kill).toHaveBeenCalledWith('SIGKILL');
    spawned.emit('close', 0);
    expect(h.spawn).toHaveBeenCalledTimes(1);
  });

  it('rejects a stale selection before preflight or a config change during preflight', async () => {
    write();
    const stale = externalClaudeRuntimeForDirectory()!;
    write({ schema: 1, enabled: false });
    await expect(stale.prepare()).rejects.toThrow('configuration changed');
    expect(h.spawn).not.toHaveBeenCalled();
    write();
    const runtime = externalClaudeRuntimeForDirectory()!;
    h.spawn.mockImplementation(() => {
      const spawned = child();
      queueMicrotask(() => {
        write({ schema: 1, enabled: false });
        spawned.emit('close', 0);
      });
      return spawned;
    });
    await expect(runtime.prepare()).rejects.toThrow('configuration changed during preflight');
  });

  it('never spawns a preflight for an already cancelled launch', async () => {
    write();
    const controller = new AbortController();
    controller.abort();
    await expect(externalClaudeRuntimeForDirectory()!.prepare(controller.signal)).rejects.toThrow('preflight cancelled');
    expect(h.spawn).not.toHaveBeenCalled();
  });

  it('keeps a host-owned secondary account usable when the external default configuration is broken', () => {
    const secondary = path.join(h.home, '.claude-cindy-a1b2c3d4e5f6-12345678-1234-4234-8234-123456789abc');
    writeFileSync(h.file, '{broken');
    expect(externalClaudeRuntimeForDirectory(secondary)).toBeUndefined();
    expect(() => externalClaudeRuntimeForDirectory()).toThrow('External Claude runtime');
    config.executablePath = path.join(root, 'missing.exe');
    write();
    expect(externalClaudeRuntimeForDirectory(secondary)).toBeUndefined();
    expect(() => externalClaudeRuntimeForDirectory()).toThrow('executablePath is unavailable');
    expect(h.spawn).not.toHaveBeenCalled();
  });

  it('does not let the default override claim another host-owned account directory', () => {
    config.configDir = path.join(h.home, '.claude-cindy-a1b2c3d4e5f6-12345678-1234-4234-8234-123456789abc');
    write();
    expect(() => externalClaudeDefaultDirectory()).toThrow('another subscription account directory');
  });

  it('selects an explicitly configured host account without redirecting the default account or legacy profile', async () => {
    const accountId = 'cindy-a1b2c3d4e5f6-12345678-1234-4234-8234-123456789abc';
    config.accountId = accountId;
    write();
    expect(externalClaudeDirectoryForAccount(accountId)).toBe(config.configDir);
    expect(externalClaudeDirectoryForAccount('default')).toBeUndefined();
    expect(externalClaudeDefaultDirectory()).toBeUndefined();
    expect(externalClaudeDirectoryForAccount('cindy-a1b2c3d4e5f6-12345678-1234-4234-8234-123456789abd')).toBeUndefined();
    expect(externalClaudeRuntimeForDirectory()).toBeUndefined();
    expect(externalClaudeRuntimeForDirectory(path.join(h.home, '.claude'))).toBeUndefined();
    const runtime = externalClaudeRuntimeForDirectory(config.configDir)!;
    expect(runtime.env.CLAUDE_CONFIG_DIR).toBe(config.configDir);
    await runtime.prepare();
    expect(h.spawn).toHaveBeenCalledTimes(1);
  });

  it('keeps existing account routes independent of an unavailable custom runtime but refuses the selected account', () => {
    const accountId = 'cindy-a1b2c3d4e5f6-12345678-1234-4234-8234-123456789abc';
    config.accountId = accountId;
    config.executablePath = path.join(root, 'missing.exe');
    write();
    expect(externalClaudeDefaultDirectory()).toBeUndefined();
    expect(externalClaudeRuntimeForDirectory()).toBeUndefined();
    expect(externalClaudeRuntimeForDirectory(path.join(h.home, '.claude'))).toBeUndefined();
    expect(externalClaudeRuntimeForDirectory(path.join(root, 'unrelated-custom-profile'))).toBeUndefined();
    expect(() => externalClaudeDirectoryForAccount(accountId)).toThrow('executablePath is unavailable');
    expect(() => externalClaudeRuntimeForDirectory(config.configDir)).toThrow('executablePath is unavailable');
    expect(h.spawn).not.toHaveBeenCalled();
  });

  it.each(['deleted', 'disabled', 'profile changed', 'account changed'])(
    'refuses bundled fallback when external config is %s between directory selection and launch', change => {
      const accountId = 'cindy-a1b2c3d4e5f6-12345678-1234-4234-8234-123456789abc';
      config.accountId = accountId;
      write();
      const selected = externalClaudeDirectoryForAccount(accountId)!;
      if (change === 'deleted') rmSync(h.file);
      else if (change === 'disabled') write({ schema: 1, enabled: false });
      else if (change === 'profile changed') write({ ...config, configDir: path.join(root, 'different-profile') });
      else write({ ...config, accountId: 'default' });
      expect(() => externalClaudeRuntimeForDirectory(selected)).toThrow('refusing bundled fallback');
      expect(h.spawn).not.toHaveBeenCalled();
    },
  );

  it('records direct runtime selection and its default alias without granting later fallback', () => {
    write();
    const selected = externalClaudeRuntimeForDirectory()!;
    rmSync(h.file);
    expect(() => externalClaudeRuntimeForDirectory(selected.env.CLAUDE_CONFIG_DIR)).toThrow('refusing bundled fallback');
    expect(() => externalClaudeRuntimeForDirectory()).toThrow('refusing bundled fallback');
    expect(() => externalClaudeRuntimeForDirectory(path.join(h.home, '.claude'))).toThrow('refusing bundled fallback');
    expect(externalClaudeRuntimeForDirectory(path.join(root, 'unrelated-account'))).toBeUndefined();
  });

  it('scopes rejection witnesses to their host config file and preserves unrelated account routes', () => {
    config.accountId = 'cindy-a1b2c3d4e5f6-12345678-1234-4234-8234-123456789abc';
    write();
    const selected = externalClaudeDirectoryForAccount(config.accountId)!;
    rmSync(h.file);
    expect(() => externalClaudeRuntimeForDirectory(selected)).toThrow('refusing bundled fallback');
    expect(externalClaudeRuntimeForDirectory(path.join(h.home, '.claude-cindy-a1b2c3d4e5f6-12345678-1234-4234-8234-123456789abd'))).toBeUndefined();
    const firstFile = h.file;
    h.file = path.join(root, 'other-host', 'external-claude-runtime.json');
    expect(externalClaudeRuntimeForDirectory(selected)).toBeUndefined();
    h.file = firstFile;
    expect(() => externalClaudeRuntimeForDirectory(selected)).toThrow('refusing bundled fallback');
  });

  it('cancels the active preflight without accepting a late successful exit', async () => {
    const spawned = child();
    h.spawn.mockReturnValue(spawned);
    write();
    const controller = new AbortController();
    const preparation = externalClaudeRuntimeForDirectory()!.prepare(controller.signal);
    controller.abort();
    await expect(preparation).rejects.toThrow('preflight cancelled');
    expect(spawned.kill).toHaveBeenCalledWith('SIGKILL');
    spawned.emit('close', 0);
    expect(h.spawn).toHaveBeenCalledTimes(1);
  });
});
