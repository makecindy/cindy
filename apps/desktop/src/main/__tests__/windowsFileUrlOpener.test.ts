import { describe, expect, it, vi } from 'vitest';

import { createWindowsFileUrlOpener } from '../windowsFileUrlOpener.js';

describe('createWindowsFileUrlOpener', () => {
  it('does not create a Windows launcher on other platforms', () => {
    expect(
      createWindowsFileUrlOpener({
        platform: 'darwin',
        execFile: vi.fn(),
      }),
    ).toBeUndefined();
  });

  it('passes the complete URL as one argv value without cmd expansion', async () => {
    const execFile = vi.fn((_file, _args, _options, callback) => {
      callback(null, '', '');
    });
    const openUrl = createWindowsFileUrlOpener({
      platform: 'win32',
      windowsDir: 'C:\\Windows',
      execFile,
    });
    const fileUrl = 'file:///C:/tmp/preview.html?mode=review#%PATH%';

    await expect(openUrl?.(fileUrl)).resolves.toBeUndefined();

    expect(execFile).toHaveBeenCalledWith(
      'C:\\Windows\\System32\\rundll32.exe',
      ['url.dll,FileProtocolHandler', fileUrl],
      { windowsHide: true },
      expect.any(Function),
    );
  });

  it('returns the Windows handler error without exposing a shell command', async () => {
    const execFile = vi.fn((_file, _args, _options, callback) => {
      callback(new Error('handler failed'), '', 'URL handler unavailable');
    });
    const openUrl = createWindowsFileUrlOpener({
      platform: 'win32',
      execFile,
    });

    await expect(openUrl?.('file:///C:/tmp/preview.html')).rejects.toThrow(
      'URL handler unavailable',
    );

    expect(execFile).toHaveBeenCalledWith(
      'C:\\Windows\\System32\\rundll32.exe',
      ['url.dll,FileProtocolHandler', 'file:///C:/tmp/preview.html'],
      { windowsHide: true },
      expect.any(Function),
    );
  });
});
