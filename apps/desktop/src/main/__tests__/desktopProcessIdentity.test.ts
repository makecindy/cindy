import { describe, expect, it, vi } from 'vitest';

import { isReusedDesktopInstancePid, readDesktopProcessIdentity } from '../desktopProcessIdentity';

// Explicit target-platform paths; no host filesystem is accessed by these probes.
const windowsIdentity = { startedAtMs: 100_000, executablePath: 'C:\\Programs\\Cindy\\Cindy.exe' };

describe('desktop process identity probes', () => {
  it('reads only OS creation time and executable from a hidden, bounded Windows query', async () => {
    const run = vi.fn(async () => ({ stdout: JSON.stringify(windowsIdentity) }));
    expect(await readDesktopProcessIdentity(4242, 'win32', run)).toEqual(windowsIdentity);
    const [file, args, options] = run.mock.calls[0] as unknown as [string, string[], Record<string, unknown>];
    expect(file).toMatch(/\\powershell\.exe$/i);
    expect(args).toContain('Hidden');
    expect(args.at(-1)).toContain('ProcessId = 4242');
    expect(args.at(-1)).not.toContain('CommandLine');
    expect(options).toMatchObject({ timeout: 5_000, maxBuffer: 16 * 1024, windowsHide: true });
  });

  it.each(['', '{', 'null', '{}', '{"startedAtMs":0,"executablePath":"C:\\\\Cindy.exe"}',
    JSON.stringify({ ...windowsIdentity, executablePath: null }),
    JSON.stringify({ ...windowsIdentity, executablePath: 'Cindy.exe' }),
  ])('keeps missing or malformed process evidence unknown: %s', async (stdout) => {
    expect(await readDesktopProcessIdentity(4242, 'win32', async () => ({ stdout }))).toBeNull();
  });

  it('does not interpret access denial or timeout as a missing process', async () => {
    const run = vi.fn().mockRejectedValue(new Error('access denied'));
    expect(await readDesktopProcessIdentity(4242, 'win32', run)).toBeNull();
  });

  it.each([0, -1, NaN, Infinity, 1.5])('rejects invalid PID %s before executing a command', async (pid) => {
    const run = vi.fn();
    expect(await readDesktopProcessIdentity(pid, 'win32', run)).toBeNull();
    expect(run).not.toHaveBeenCalled();
  });

  it('parses POSIX birth time in UTC and retains spaces in executable paths', async () => {
    const run = vi.fn(async () => ({ stdout: 'Fri Sep 11 08:00:00 2026 /Applications/Cindy App.app/Contents/MacOS/Cindy\n' }));
    expect(await readDesktopProcessIdentity(4242, 'darwin', run)).toEqual({
      startedAtMs: Date.parse('2026-09-11T08:00:00Z'),
      executablePath: '/Applications/Cindy App.app/Contents/MacOS/Cindy',
    });
    expect(run).toHaveBeenCalledWith('ps', expect.any(Array), expect.objectContaining({
      env: expect.objectContaining({ LC_ALL: 'C', TZ: 'UTC0' }),
    }));
  });

  it('keeps truncated macOS executable evidence unknown', async () => {
    expect(await readDesktopProcessIdentity(4242, 'darwin', async () => ({
      stdout: 'Fri Sep 11 08:00:00 2026 Cindy',
    }))).toBeNull();
  });

  it.each(['/usr/bin/sleep', '/opt/Other App/other'])
    ('reads Linux executable paths from procfs when procps only returns a name: %s', async (executablePath) => {
      const ps = 'Fri Sep 11 08:00:00 2026 sleep\n';
      const run = vi.fn().mockResolvedValueOnce({ stdout: ps })
        .mockResolvedValueOnce({ stdout: `${executablePath}\n` }).mockResolvedValueOnce({ stdout: ps });
      const identity = await readDesktopProcessIdentity(4242, 'linux', run);
      expect(identity).toEqual({ startedAtMs: Date.parse('2026-09-11T08:00:00Z'), executablePath });
      expect(run).toHaveBeenNthCalledWith(2, 'readlink', ['--', '/proc/4242/exe'],
        expect.objectContaining({ timeout: 5_000, maxBuffer: 16 * 1024 }));
      expect(isReusedDesktopInstancePid({ startedAtMs: 1 }, identity!, 'linux')).toBe(true);
    });

  it.each(['/usr/bin/node', '/opt/cindy/electron'])
    ('still protects a Linux runtime identified through procfs: %s', async (executablePath) => {
      const run = vi.fn().mockResolvedValue({ stdout: 'Fri Sep 11 08:00:00 2026 runtime\n' })
        .mockResolvedValueOnce({ stdout: 'Fri Sep 11 08:00:00 2026 runtime\n' })
        .mockResolvedValueOnce({ stdout: `${executablePath}\n` });
      const identity = await readDesktopProcessIdentity(4242, 'linux', run);
      expect(identity).not.toBeNull();
      expect(isReusedDesktopInstancePid({ startedAtMs: 1 }, identity!, 'linux')).toBe(false);
    });

  it.each(['', 'sleep\n', '/usr/bin/node (deleted)\n'])
    ('keeps unusable Linux executable evidence unknown: %j', async (executable) => {
      const ps = 'Fri Sep 11 08:00:00 2026 sleep\n';
      const run = vi.fn().mockResolvedValue({ stdout: ps })
        .mockResolvedValueOnce({ stdout: ps }).mockResolvedValueOnce({ stdout: executable });
      expect(await readDesktopProcessIdentity(4242, 'linux', run)).toBeNull();
    });

  it.each(['EACCES', 'ENOENT', 'timeout'])('keeps failed Linux executable queries unknown: %s', async (reason) => {
    const run = vi.fn().mockResolvedValueOnce({ stdout: 'Fri Sep 11 08:00:00 2026 sleep\n' })
      .mockRejectedValueOnce(new Error(reason));
    expect(await readDesktopProcessIdentity(4242, 'linux', run)).toBeNull();
  });

  it.each(['', 'Fri Sep 11 08:01:00 2026 sleep\n', 'Fri Sep 11 08:00:00 2026 node\n'])
    ('rejects Linux identity if the process disappears or changes during the query: %j', async (after) => {
      const run = vi.fn().mockResolvedValueOnce({ stdout: 'Fri Sep 11 08:00:00 2026 sleep\n' })
        .mockResolvedValueOnce({ stdout: '/usr/bin/sleep\n' }).mockResolvedValueOnce({ stdout: after });
      expect(await readDesktopProcessIdentity(4242, 'linux', run)).toBeNull();
    });
});

describe('PID reuse evidence', () => {
  it('recognizes a legacy Cindy PID reused by Chrome after the record was written', () => {
    expect(isReusedDesktopInstancePid({ startedAtMs: 10_000 }, {
      startedAtMs: 100_000, executablePath: 'C:\\Chrome\\chrome.exe',
    }, 'win32')).toBe(true);
  });

  it.each([{}, { startedAtMs: null }, { startedAtMs: '1000' }, { startedAtMs: NaN },
    { startedAtMs: 0 }, { startedAtMs: 100_000 }, { startedAtMs: 200_000 },
    { startedAtMs: 99_000 }, { startedAtMs: 10_000, processIdentity: {} },
  ])('does not infer reuse from missing, overlapping, or malformed evidence: %j', (record) => {
    expect(isReusedDesktopInstancePid(record, {
      ...windowsIdentity, executablePath: 'C:\\Chrome\\chrome.exe',
    }, 'win32')).toBe(false);
  });

  it('uses the recorded OS birth rather than a later readiness heartbeat', () => {
    const identity = { startedAtMs: 100_000, executablePath: 'C:\\custom.exe' };
    expect(isReusedDesktopInstancePid({ processIdentity: identity, startedAtMs: 500_000 }, {
      ...identity, startedAtMs: 200_000,
    }, 'win32')).toBe(true);
  });

  it.each(['C:\\Programs\\Cindy\\Cindy.exe', 'C:\\tools\\electron.exe', 'C:\\nodejs\\node.exe'])
    ('keeps a possible replacement runtime protective even with a newer birth: %s', (executablePath) => {
      expect(isReusedDesktopInstancePid({ startedAtMs: 1 }, {
        startedAtMs: 100_000, executablePath,
      }, 'win32')).toBe(false);
    });

  it('preserves renamed packaged runtimes within the registered app installation', () => {
    expect(isReusedDesktopInstancePid({ startedAtMs: 1, rootDir: 'C:\\Custom App\\resources\\app.asar' }, {
      startedAtMs: 100_000, executablePath: 'C:\\Custom App\\custom.exe',
    }, 'win32')).toBe(false);
  });

  it('does not mistake Windows executable path casing for PID reuse', () => {
    const identity = { startedAtMs: 100_000, executablePath: 'C:\\Programs\\custom.exe' };
    expect(isReusedDesktopInstancePid({ processIdentity: identity }, {
      ...identity, executablePath: 'c:/programs/CUSTOM.EXE',
    }, 'win32')).toBe(false);
  });

  it('recognizes a different Windows executable even within timestamp precision', () => {
    expect(isReusedDesktopInstancePid({ processIdentity: windowsIdentity }, {
      ...windowsIdentity, executablePath: 'C:\\Chrome\\chrome.exe',
    }, 'win32')).toBe(true);
  });

  it('does not treat POSIX exec as proof that the process exited', () => {
    expect(isReusedDesktopInstancePid({ processIdentity: {
      startedAtMs: 100_000, executablePath: '/Applications/Cindy',
    } }, { startedAtMs: 100_000, executablePath: '/usr/bin/other' }, 'darwin')).toBe(false);
  });
});
