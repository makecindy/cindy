import { describe, expect, it, vi } from 'vitest';

import { pickNativeAtResource } from '../nativeAtResourcePicker.js';

describe('pickNativeAtResource', () => {
  it('opens a combined file and directory picker on macOS', async () => {
    const showOpenDialog = vi.fn().mockResolvedValue({
      canceled: false,
      filePaths: ['/repo/docs'],
    });

    await expect(pickNativeAtResource({
      platform: 'darwin',
      showOpenDialog,
      isDirectory: () => true,
    }, '/repo')).resolves.toEqual({ path: '/repo/docs', kind: 'directory' });
    expect(showOpenDialog).toHaveBeenCalledWith({
      properties: ['openFile', 'openDirectory'],
      defaultPath: '/repo',
    });
  });

  it('opens a file picker on Windows', async () => {
    const showOpenDialog = vi.fn().mockResolvedValue({
      canceled: false,
      filePaths: ['D:\\repo\\README.md'],
    });

    await expect(pickNativeAtResource({
      platform: 'win32',
      showOpenDialog,
      isDirectory: () => false,
    }, 'D:\\repo')).resolves.toEqual({
      path: 'D:\\repo\\README.md',
      kind: 'file',
    });
    expect(showOpenDialog).toHaveBeenCalledWith({
      properties: ['openFile'],
      defaultPath: 'D:\\repo',
    });
  });

  it('returns an empty result when the user cancels', async () => {
    await expect(pickNativeAtResource({
      platform: 'win32',
      showOpenDialog: vi.fn().mockResolvedValue({ canceled: true, filePaths: [] }),
      isDirectory: vi.fn(),
    })).resolves.toEqual({ path: null, kind: null });
  });
});
