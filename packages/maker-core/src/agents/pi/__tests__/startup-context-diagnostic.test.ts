import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { findPiCloudContextFile, piCloudContextDisplayPath } from '../startup-context-diagnostic.js';

vi.mock('node:child_process', () => ({ execFile: vi.fn() }));

// #9855, unit: production metadata scan and its bounded failure exit. Existing
// startSession cleanup tests do not distinguish dataless flags from sparse files,
// shadows or blocked diagnostic processes. No file content or real iCloud used.
describe('Pi startup context metadata diagnosis', () => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  const cwd = path.join(os.tmpdir(), 'pi-cloud-project', 'child');
  const parent = path.dirname(cwd);
  let replies: Map<string, string | 'missing' | 'denied'>;
  let kill: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    replies = new Map();
    kill = vi.fn();
    vi.mocked(execFile).mockReset();
    vi.mocked(execFile).mockImplementation(((_command: string, args: string[], options: { signal: AbortSignal }, callback: (error: Error | null, stdout: string, stderr: string) => void) => {
      const file = args.at(-1)!;
      const reply = replies.get(file) ?? 'missing';
      options.signal.addEventListener('abort', kill, { once: true });
      queueMicrotask(() => {
        options.signal.removeEventListener('abort', kill);
        if (reply === 'missing' || reply === 'denied') {
          callback(new Error(reply), '', `stat: ${reply === 'missing' ? 'No such file or directory' : 'Permission denied'}\n`);
        } else callback(null, reply, '');
      });
      return { kill };
    }) as unknown as typeof execFile);
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', originalPlatform);
    vi.useRealTimers();
  });

  it('finds a dataless ancestor without reading contents or evaluating a shell', async () => {
    const file = path.join(parent, 'AGENTS.md');
    replies.set(file, '1073741858:Regular File\n');
    expect(await findPiCloudContextFile(cwd)).toBe(file);
    expect(execFile).toHaveBeenCalledWith('/usr/bin/stat', ['-L', '-f', '%f:%HT', file],
      expect.objectContaining({ killSignal: 'SIGKILL', maxBuffer: 512, env: { LC_ALL: 'C' } }), expect.any(Function));
  });

  it.each(['0:Regular File\n', '32:Regular File\n', '1073741824:Directory\n', 'invalid', 'denied'])(
    'does not infer a cloud file from non-dataless or unverified metadata: %s', async (metadata) => {
      replies.set(path.join(cwd, 'AGENTS.md'), metadata);
      expect(await findPiCloudContextFile(cwd)).toBeUndefined();
    },
  );

  it.each(['0:Regular File\n', 'denied'])(
    'does not diagnose a shadowed candidate when the override is %s', async (metadata) => {
      replies.set(path.join(cwd, 'AGENTS.override.md'), metadata);
      replies.set(path.join(cwd, 'AGENTS.md'), '1073741824:Regular File\n');
      expect(await findPiCloudContextFile(cwd)).toBeUndefined();
      expect(vi.mocked(execFile).mock.calls.map((call) => call[1])).not.toContainEqual(
        ['-L', '-f', '%f:%HT', path.join(cwd, 'AGENTS.md')],
      );
    },
  );

  it('bounds a stalled metadata child and aborts it without waiting for its close', async () => {
    vi.useFakeTimers();
    vi.mocked(execFile).mockImplementation((() => ({ kill })) as unknown as typeof execFile);
    const result = findPiCloudContextFile(cwd);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await result).toBeUndefined();
    expect(kill).toHaveBeenCalledWith('SIGKILL');
    expect(kill).toHaveBeenCalledTimes(1);
    expect(execFile).toHaveBeenCalledTimes(1);
  });

  it.each(['win32', 'linux'])('leaves %s startup diagnosis untouched', async (platform) => {
    Object.defineProperty(process, 'platform', { value: platform });
    expect(await findPiCloudContextFile(cwd)).toBeUndefined();
    expect(execFile).not.toHaveBeenCalled();
  });

  it('escapes display paths and hides the home prefix', () => {
    const value = piCloudContextDisplayPath(path.join(os.homedir(), 'cloud\nfolder', 'AGENTS.md'));
    expect(value).toContain('\\n');
    expect(value).not.toContain('\n');
    expect(value).not.toContain(os.homedir());
    expect(value).toContain('AGENTS.md');
  });
});
