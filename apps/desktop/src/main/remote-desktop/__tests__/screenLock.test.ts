import { describe, expect, it, vi } from 'vitest';
import { readScreenLockState } from '../screenLock';

const plist = (consoleUser: string) => `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><array><dict>
  <key>IOConsoleUsers</key>
  <array><dict>
    <key>kCGSSessionOnConsoleKey</key><true/>
    ${consoleUser}
  </dict></array>
</dict></array></plist>`;

const run = (stdout: string, platform: NodeJS.Platform = 'darwin') =>
  readScreenLockState({ platform, exec: vi.fn(async () => ({ stdout })) });

describe('readScreenLockState', () => {
  it('reads the console session flag from the IORegistry plist', async () => {
    const locked = plist('<key>CGSSessionScreenIsLocked</key>\n\t\t\t<true/>');
    expect(await run(locked)).toBe('locked');
    expect(await run(plist('<key>CGSSessionScreenIsLocked</key><false/>'))).toBe('unlocked');
    // The key is only present while locked: a console session without it is unlocked.
    expect(await run(plist(''))).toBe('unlocked');
  });

  it('does not call a missing session, a failing read or another platform locked', async () => {
    expect(await run('<plist><dict></dict></plist>')).toBe('unknown');
    expect(
      await readScreenLockState({
        platform: 'darwin',
        exec: async () => {
          throw new Error('ioreg missing');
        },
      }),
    ).toBe('unknown');
    const exec = vi.fn();
    expect(await readScreenLockState({ platform: 'win32', exec })).toBe('unknown');
    expect(await readScreenLockState({ platform: 'linux', exec })).toBe('unknown');
    expect(exec).not.toHaveBeenCalled();
  });
});
