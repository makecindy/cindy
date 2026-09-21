import { describe, expect, it, vi } from 'vitest';

import {
  MAC_FULL_DISK_ACCESS_SETTINGS_URL,
  confirmEnableRealProfile,
  guideFullDiskAccessAfterReadDenied,
  realProfileEnableConfirmOptions,
  realProfileEnableDescriptionKey,
} from '../realProfilePermissionGuide';

const t = (key: string) => key;

describe('realProfilePermissionGuide', () => {
  it('names Full Disk Access in the first-enable confirm on macOS', () => {
    expect(realProfileEnableDescriptionKey('darwin')).toBe(
      'settings.computerUse.realProfile.confirmDescriptionMac',
    );
    expect(realProfileEnableConfirmOptions('darwin', t).description).toBe(
      'settings.computerUse.realProfile.confirmDescriptionMac',
    );
  });

  it('keeps the generic first-enable confirm off macOS', () => {
    expect(realProfileEnableDescriptionKey('win32')).toBe(
      'settings.computerUse.realProfile.confirmDescription',
    );
  });

  it('opens Full Disk Access only after the dedicated action on macOS', async () => {
    const openExternal = vi.fn().mockResolvedValue({ success: true });
    const confirm = vi
      .fn()
      .mockResolvedValueOnce(true)
      .mockImplementationOnce(async (opts) => {
        expect(opts).toEqual(
          expect.objectContaining({
            title: 'settings.computerUse.realProfile.readDeniedTitle',
            confirmText: 'settings.computerUse.realProfile.openFullDiskAccess',
          }),
        );
        expect(openExternal).not.toHaveBeenCalled();
        return true;
      });
    await expect(
      confirmEnableRealProfile({
        platform: 'darwin',
        t,
        confirm,
        openExternal,
      }),
    ).resolves.toBe(true);
    expect(confirm).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        description: 'settings.computerUse.realProfile.confirmDescriptionMac',
      }),
    );
    expect(openExternal).toHaveBeenCalledTimes(1);
    expect(openExternal).toHaveBeenCalledWith(MAC_FULL_DISK_ACCESS_SETTINGS_URL);
  });

  it('does not open System Settings when the user cancels enable', async () => {
    const openExternal = vi.fn();
    await expect(
      confirmEnableRealProfile({
        platform: 'darwin',
        t,
        confirm: vi.fn().mockResolvedValue(false),
        openExternal,
      }),
    ).resolves.toBe(false);
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('does not open Full Disk Access when enabling on other platforms', async () => {
    const openExternal = vi.fn();
    await expect(
      confirmEnableRealProfile({
        platform: 'linux',
        t,
        confirm: vi.fn().mockResolvedValue(true),
        openExternal,
      }),
    ).resolves.toBe(true);
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('skips the Full Disk Access prompt when the source profile is already readable', async () => {
    const openExternal = vi.fn();
    const confirm = vi.fn().mockResolvedValue(true);
    await expect(
      confirmEnableRealProfile({
        platform: 'darwin',
        t,
        confirm,
        openExternal,
        hasDiskAccess: async () => true,
      }),
    ).resolves.toBe(true);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        description: 'settings.computerUse.realProfile.confirmDescriptionMac',
      }),
    );
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('still shows Full Disk Access when the probe says not readable', async () => {
    const openExternal = vi.fn().mockResolvedValue({ success: true });
    const confirm = vi.fn().mockResolvedValue(true);
    await confirmEnableRealProfile({
      platform: 'darwin',
      t,
      confirm,
      openExternal,
      hasDiskAccess: async () => false,
    });
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(confirm).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        title: 'settings.computerUse.realProfile.readDeniedTitle',
      }),
    );
    expect(openExternal).toHaveBeenCalledWith(MAC_FULL_DISK_ACCESS_SETTINGS_URL);
  });

  it('shows Full Disk Access when the probe throws', async () => {
    const openExternal = vi.fn().mockResolvedValue({ success: true });
    const confirm = vi.fn().mockResolvedValue(true);
    await confirmEnableRealProfile({
      platform: 'darwin',
      t,
      confirm,
      openExternal,
      hasDiskAccess: async () => {
        throw new Error('ipc down');
      },
    });
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(openExternal).toHaveBeenCalledTimes(1);
  });

  it('does not open System Settings before the dedicated action', async () => {
    const openExternal = vi.fn().mockResolvedValue({ success: true });
    await guideFullDiskAccessAfterReadDenied({
      platform: 'darwin',
      t,
      confirm: vi.fn().mockResolvedValue(false),
      openExternal,
    });
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('opens Full Disk Access when the user chooses the dedicated action', async () => {
    const openExternal = vi.fn().mockResolvedValue({ success: true });
    await guideFullDiskAccessAfterReadDenied({
      platform: 'darwin',
      t,
      confirm: vi.fn().mockResolvedValue(true),
      openExternal,
    });
    expect(openExternal).toHaveBeenCalledTimes(1);
    expect(openExternal).toHaveBeenCalledWith(MAC_FULL_DISK_ACCESS_SETTINGS_URL);
  });
});
