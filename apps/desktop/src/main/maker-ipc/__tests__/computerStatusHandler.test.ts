import { describe, expect, it, vi } from 'vitest';
import { readComputerStatusForSettings } from '../computerStatusHandler.js';

const status = {
  installed: false,
  executablePath: null,
  version: null,
  daemonRunning: false,
  installCommand: 'install cua-driver',
  docsUrl: 'https://cua.ai/docs/cua-driver',
};

describe('readComputerStatusForSettings', () => {
  it('returns background probe results without publishing them to other windows', async () => {
    const getStatus = vi.fn().mockResolvedValue(status);
    const refreshPermissionGuide = vi.fn();
    expect(await readComputerStatusForSettings({
      refreshPermissionGuide: false,
      forcePermissionProbe: true,
      bypassPermissionProbeCache: true,
      passivePermissionProbeOnly: true,
    }, { getStatus, refreshPermissionGuide })).toBe(status);
    expect(getStatus).toHaveBeenCalledWith({
      forcePermissionProbe: true,
      bypassPermissionProbeCache: true,
      passivePermissionProbeOnly: true,
    });
    expect(refreshPermissionGuide).not.toHaveBeenCalled();
  });

  it.each([{ forcePermissionProbe: true }, { freshPermissionProbe: true }])(
    'preserves existing guide refreshes for %j', async (options) => {
      const refreshPermissionGuide = vi.fn();
      expect(await readComputerStatusForSettings(options, {
        getStatus: vi.fn().mockResolvedValue(status),
        refreshPermissionGuide,
      })).toBe(status);
      expect(refreshPermissionGuide).toHaveBeenCalledExactlyOnceWith(status);
    },
  );

  it('keeps ordinary reads private and does not publish failed probes', async () => {
    const refreshPermissionGuide = vi.fn();
    await readComputerStatusForSettings(undefined, {
      getStatus: vi.fn().mockResolvedValue(status),
      refreshPermissionGuide,
    });
    await expect(readComputerStatusForSettings({ forcePermissionProbe: true }, {
      getStatus: vi.fn().mockRejectedValue(new Error('probe failed')),
      refreshPermissionGuide,
    })).rejects.toThrow('probe failed');
    expect(refreshPermissionGuide).not.toHaveBeenCalled();
  });
});
