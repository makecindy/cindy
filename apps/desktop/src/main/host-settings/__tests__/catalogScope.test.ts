import { describe, expect, it, vi } from 'vitest';
import { sharedSettingsModelCatalog, withSharedSettingsModelCatalog } from '../catalogScope.js';
import { readSettingsBatch } from '../webBatch.js';

// Unit: the six IM groups of one batch read the model catalog once, and only within that batch.
describe('model catalog shared by one settings batch', () => {
  it('reads the catalog once for all domains of a batch', async () => {
    const read = vi.fn(async () => ({ providers: [] }));
    const domains = ['imFeishu', 'imDiscord', 'imWechat', 'imTelegram', 'imDingtalk', 'imWecom'] as const;
    const result = await readSettingsBatch([...domains], async () => { await sharedSettingsModelCatalog(read); return { ok: false, code: 'SETTINGS_REQUEST_FAILED' }; }, () => {});
    expect(result.entries).toHaveLength(6);
    expect(read).toHaveBeenCalledOnce();
    await sharedSettingsModelCatalog(read);
    await sharedSettingsModelCatalog(read);
    expect(read).toHaveBeenCalledTimes(3);
  });
  it('reads again after a failed read', async () => {
    const read = vi.fn().mockRejectedValueOnce(new Error('unavailable')).mockResolvedValue({ providers: [] });
    await withSharedSettingsModelCatalog(async () => {
      await expect(sharedSettingsModelCatalog(read)).rejects.toThrow('unavailable');
      await sharedSettingsModelCatalog(read);
      await sharedSettingsModelCatalog(read);
    });
    expect(read).toHaveBeenCalledTimes(2);
  });
});
