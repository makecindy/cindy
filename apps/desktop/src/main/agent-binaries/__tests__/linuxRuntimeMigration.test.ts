import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { olderStableVersion, PINNED_CLAUDE_VERSION, PINNED_CODEX_VERSION } from './runtimeVersionFixtures';

const { appMock, downloadMock, execFileMock } = vi.hoisted(() => ({
  appMock: { isPackaged: true, getPath: vi.fn<(name: string) => string>() },
  downloadMock: vi.fn(),
  execFileMock: vi.fn(),
}));

vi.mock('node:child_process', () => ({ execFile: execFileMock }));
vi.mock('electron', () => ({
  app: appMock,
  net: { request: vi.fn() },
}));
vi.mock('../../downloader/index.js', () => ({ download: downloadMock }));

const originalPlatform = process.platform;
let fallback: typeof import('../linux-runtime-fallback');
let tempDir = '';

function claudeVersionOutput(version = PINNED_CLAUDE_VERSION): string {
  return `${version} (Claude Code)\n`;
}

function claudeExecutable(version = PINNED_CLAUDE_VERSION): string {
  return `#!/bin/sh\necho "${version} (Claude Code)"\n`;
}

beforeAll(async () => {
  Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
  fallback = await import('../linux-runtime-fallback');
});

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-linux-runtime-migration-'));
  appMock.getPath.mockReturnValue(tempDir);
  downloadMock.mockReset().mockRejectedValue(new Error('network download must not run during migration'));
  execFileMock.mockReset().mockImplementation((
    command: string,
    _args: string[],
    _options: unknown,
    callback: (error: Error | null, stdout: string, stderr: string) => void,
  ) => {
    if (command === '/bin/sh') {
      callback(new Error('system lookup disabled in migration test'), '', '');
      return;
    }
    callback(null, claudeVersionOutput(), '');
  });
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

afterAll(() => {
  Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
});

describe('legacy managed binary migration', () => {
  // Unit regression, PR #9481: the real Linux fallback entry bypassed isolated
  // version probing. Existing migration tests only checked Claude selection.
  it.each([false, true])('isolates Codex fallback verification and cleans up on cancellation=%s', async (cancel) => {
    const binaryPath = fallback.privateBinaryPath(tempDir, 'codex');
    fs.mkdirSync(path.dirname(binaryPath), { recursive: true });
    fs.writeFileSync(binaryPath, 'mock executable', { mode: 0o755 });
    const controller = new AbortController();
    let home = '';
    execFileMock.mockImplementation((command, args, options, callback) => {
      expect(command).toBe(binaryPath);
      expect(args).toEqual(['--version']);
      home = options.env?.CODEX_HOME;
      expect(home).toBeTruthy();
      expect(home).not.toBe(process.env.CODEX_HOME);
      expect(fs.existsSync(home)).toBe(true);
      expect(options.timeout).toBe(15_000);
      // Reproduce a CLI writing before the caller cancels, without real waits.
      fs.writeFileSync(path.join(home, 'helper'), 'temporary');
      if (cancel) controller.abort();
      expect(options.signal.aborted).toBe(cancel);
      callback(cancel ? new Error('aborted') : null, `codex-cli ${PINNED_CODEX_VERSION}`, '');
    });
    const result = fallback.prepareLinuxRuntimeFallback('codex', { signal: controller.signal });
    if (cancel) await expect(result).rejects.toThrow('codex install cancelled');
    else await expect(result).resolves.toMatchObject({ ready: true, source: 'private', binaryPath });
    expect(home).toBeTruthy();
    expect(fs.existsSync(home)).toBe(false);
    expect(downloadMock).not.toHaveBeenCalled();
  });

  it('allows an older verified private runtime only when startup upgrade checks are disabled', () => {
    const binaryPath = fallback.privateBinaryPath(tempDir, 'claude-code');
    fs.mkdirSync(path.dirname(binaryPath), { recursive: true });
    fs.writeFileSync(binaryPath, 'local runtime', { mode: 0o755 });
    const versionMarker = path.join(fallback.runtimeInstallRoot(tempDir, 'claude-code'), '.version');
    fs.writeFileSync(versionMarker, olderStableVersion(PINNED_CLAUDE_VERSION));
    expect(fallback.findCachedLinuxRuntimeFallbackBinary('claude-code')).toBeNull();
    expect(fallback.findCachedLinuxRuntimeFallbackBinary('claude-code', false)).toBe(binaryPath);
    fs.unlinkSync(versionMarker);
    expect(fallback.findCachedLinuxRuntimeFallbackBinary('claude-code', false)).toBeNull();
  });

  it('reuses and atomically migrates the exact pinned Claude cache without network access', async () => {
    const legacyPath = fallback.legacyManagedBinaryPath(tempDir, 'claude-code');
    fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
    fs.writeFileSync(legacyPath, claudeExecutable(), { mode: 0o755 });
    fs.writeFileSync(path.join(path.dirname(legacyPath), '.verified'), '');

    const result = await fallback.prepareLinuxRuntimeFallback('claude-code');

    expect(result).toMatchObject({ ready: true, installed: false, source: 'legacy' });
    expect(result.binaryPath).toBe(fallback.privateBinaryPath(tempDir, 'claude-code'));
    expect(fs.readFileSync(result.binaryPath, 'utf8')).toContain(PINNED_CLAUDE_VERSION);
    expect(downloadMock).not.toHaveBeenCalled();
  });

  it('installs the pin instead of selecting an older system Claude runtime', async () => {
    const systemClaude = '/usr/local/bin/claude';
    execFileMock.mockImplementation((
      command: string,
      _args: string[],
      _options: unknown,
      callback: (error: Error | null, stdout: string, stderr: string) => void,
    ) => {
      if (command === '/bin/sh') {
        callback(null, `${systemClaude}\n`, '');
        return;
      }
      callback(
        null,
        command === systemClaude
          ? claudeVersionOutput(olderStableVersion(PINNED_CLAUDE_VERSION))
          : claudeVersionOutput(),
        '',
      );
    });
    downloadMock.mockImplementationOnce(async ({ targetPath }: { targetPath: string }) => {
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      fs.writeFileSync(targetPath, claudeExecutable(), { mode: 0o755 });
      return {
        path: targetPath,
        size: fs.statSync(targetPath).size,
        sha256: 'test',
        fromCache: false,
        durationMs: 0,
        resumedFromBytes: 0,
      };
    });

    const result = await fallback.prepareLinuxRuntimeFallback('claude-code');

    expect(result).toMatchObject({ ready: true, installed: true, source: 'installed' });
    expect(result.binaryPath).toBe(fallback.privateBinaryPath(tempDir, 'claude-code'));
    expect(downloadMock).toHaveBeenCalledOnce();
  });
});
