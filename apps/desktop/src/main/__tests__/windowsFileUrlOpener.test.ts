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

  it.each([
    ['C:\\CustomWindows', 'C:\\CustomWindows\\System32\\rundll32.exe'],
    ['C:\\Windows\\System32', 'C:\\Windows\\System32\\rundll32.exe'],
    ['\\\\server\\share', 'C:\\Windows\\System32\\rundll32.exe'],
    ['//server/share', 'C:\\Windows\\System32\\rundll32.exe'],
    ['relative\\windows', 'C:\\Windows\\System32\\rundll32.exe'],
  ])('resolves %s to a trusted rundll32 path', (windowsDir, expectedPath) => {
    const execFile = vi.fn((_file, _args, _options, callback) => {
      callback(null, '', '');
    });
    const openUrl = createWindowsFileUrlOpener({
      platform: 'win32',
      windowsDir,
      execFile,
    });

    void openUrl?.('file:///C:/tmp/preview.html');

    expect(execFile).toHaveBeenCalledWith(
      expectedPath,
      ['url.dll,FileProtocolHandler', 'file:///C:/tmp/preview.html'],
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
