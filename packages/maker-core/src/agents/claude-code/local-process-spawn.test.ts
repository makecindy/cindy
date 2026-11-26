import { EventEmitter } from 'node:events';
import { fstatSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));

vi.mock('node:child_process', () => ({ spawn: mocks.spawn }));

import { spawnObservedClaudeProcess } from './local-process-spawn.js';

function makeChild(pid = 4321) {
  const child = new EventEmitter() as EventEmitter & {
    pid: number;
    stdin: EventEmitter;
    stdout: EventEmitter;
    stderr: EventEmitter;
    killed: boolean;
    exitCode: number | null;
    kill: ReturnType<typeof vi.fn>;
  };
  child.pid = pid;
  child.stdin = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = false;
  child.exitCode = null;
  child.kill = vi.fn();
  return child;
}

function spawnProcess(overrides: {
  registerProcess?: (pid: number) => void | (() => void);
  trackDebugFile?: () => () => void;
  onStderr?: (chunk: string) => void;
  onExit?: (details: {
    pid: number | undefined;
    exitCode: number | null;
    signal: NodeJS.Signals | null;
    abortRequested: boolean;
  }) => void;
  signal?: AbortSignal;
  oauthTokenFile?: string;
  onOAuthTokenVersion?: (version: string | null) => void;
} = {}) {
  return spawnObservedClaudeProcess({
    spawnOptions: {
      command: '/claude',
      args: ['--output-format', 'stream-json'],
      cwd: '/work',
      env: {},
      signal: overrides.signal ?? new AbortController().signal,
    },
    ...overrides,
  });
}

beforeEach(() => {
  mocks.spawn.mockReset();
});

describe('spawnObservedClaudeProcess', () => {
  it('releases debug tracking once even when the process observer fails', () => {
    const child = makeChild();
    mocks.spawn.mockReturnValue(child);
    const release = vi.fn();
    const trackDebugFile = vi.fn(() => release);
    spawnProcess({ registerProcess: () => { throw new Error('observer'); }, trackDebugFile });
    expect(trackDebugFile).toHaveBeenCalledOnce();
    child.emit('error', new Error('spawn'));
    child.emit('exit', 1, null);
    expect(release).toHaveBeenCalledOnce();
  });
  it('registers the concrete PID and disposes that generation once', () => {
    const child = makeChild();
    mocks.spawn.mockReturnValue(child);
    const dispose = vi.fn();
    const registerProcess = vi.fn(() => dispose);

    spawnProcess({ registerProcess });
    expect(registerProcess).toHaveBeenCalledWith(4321);

    child.emit('exit', 0, null);
    child.emit('error', new Error('late error'));
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('drains and forwards stderr without making observer failures fatal', () => {
    const child = makeChild();
    mocks.spawn.mockReturnValue(child);
    const onStderr = vi.fn();

    expect(() =>
      spawnProcess({
        registerProcess: () => {
          throw new Error('observer failed');
        },
        onStderr,
      }),
    ).not.toThrow();
    child.stderr.emit('data', Buffer.from('diagnostic'));
    expect(onStderr).toHaveBeenCalledWith('diagnostic');
  });

  it('reports process exit details and whether a signal was requested by the host', () => {
    const child = makeChild(9876);
    mocks.spawn.mockReturnValue(child);
    const onExit = vi.fn();
    const controller = new AbortController();

    spawnProcess({ onExit, signal: controller.signal });
    child.emit('exit', null, 'SIGTERM');

    expect(onExit).toHaveBeenCalledWith({
      pid: 9876,
      exitCode: null,
      signal: 'SIGTERM',
      abortRequested: false,
    });

    const requestedChild = makeChild(9877);
    mocks.spawn.mockReturnValue(requestedChild);
    const requestedExit = vi.fn();
    const requestedController = new AbortController();
    requestedController.abort();

    spawnProcess({ onExit: requestedExit, signal: requestedController.signal });
    requestedChild.emit('exit', null, 'SIGTERM');

    expect(requestedExit).toHaveBeenCalledWith({
      pid: 9877,
      exitCode: null,
      signal: 'SIGTERM',
      abortRequested: true,
    });
  });

  // Unit, 2026-11-24 long-lived Claude token (credentials-and-local-storage.md): the CLI must get
  // the account's token as an inherited descriptor, never as an environment value, and this
  // process must not keep the file open. No earlier case passes anything but the three pipes.
  // Minimal failing input: a token file and a launch that hands over only stdin/stdout/stderr.
  it('hands the token file to the CLI as descriptor 3 and keeps no copy open', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'cindy-token-spawn-'));
    const file = path.join(directory, 'cindy-long-lived-token');
    writeFileSync(file, 'sk-ant-oat01-not-a-real-token\n', { mode: 0o600 });
    try {
      const versions: Array<string | null> = [];
      mocks.spawn.mockReturnValueOnce(makeChild());
      spawnProcess({ oauthTokenFile: file, onOAuthTokenVersion: (v) => versions.push(v) });
      const options = mocks.spawn.mock.calls[0][2] as { stdio: unknown[]; env: Record<string, string> };
      expect(options.stdio.slice(0, 3)).toEqual(['pipe', 'pipe', 'pipe']);
      expect(typeof options.stdio[3]).toBe('number');
      expect(options.env).toEqual({ CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR: '3' });
      expect(JSON.stringify(options.env)).not.toContain('sk-ant-');
      expect(() => fstatSync(options.stdio[3] as number)).toThrow();
      expect(versions[0]).toMatch(/^descriptor:/);
      expect(versions[0]).not.toContain('sk-ant-');

      // Replacing the token file atomically changes the spawned process's token version.
      const replacement = path.join(directory, 'cindy-long-lived-token.tmp');
      writeFileSync(replacement, 'sk-ant-oat01-second-fake-token\n', { mode: 0o600 });
      renameSync(replacement, file);
      mocks.spawn.mockReturnValueOnce(makeChild());
      spawnProcess({ oauthTokenFile: file, onOAuthTokenVersion: (v) => versions.push(v) });
      expect(versions[1]).toMatch(/^descriptor:/);
      expect(versions[1]).not.toBe(versions[0]);

      // The file was removed between account selection and launch: the CLI starts on its stored login.
      mocks.spawn.mockReturnValueOnce(makeChild());
      spawnProcess({ oauthTokenFile: path.join(directory, 'missing'), onOAuthTokenVersion: (v) => versions.push(v) });
      const fallback = mocks.spawn.mock.calls[2][2] as { stdio: unknown[]; env: Record<string, string> };
      expect(fallback.stdio).toEqual(['pipe', 'pipe', 'pipe']);
      expect(fallback.env).toEqual({});
      expect(versions[2]).toBeNull();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
