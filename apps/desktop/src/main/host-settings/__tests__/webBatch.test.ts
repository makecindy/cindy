import { describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readSettingsBatch } from '../webBatch.js';
import { SETTINGS_WEB_MAX_BYTES, settingsWebResultSchema } from '../../../shared/settingsWeb.js';

const ready = (domain: 'modelFavorites' | 'modelVisibility', count: number) => ({ ok: true, settings: {
  domain, status: 'ready', revision: 'fixture', operationId: randomUUID(), customizedKeys: [], isCustomized: false,
  value: { entries: [] }, defaults: { entries: [] },
  choices: { entries: Array.from({length: count}, (_, i) => ({ value: { harness: 'codex', providerId: 'example', modelId: `model-${i}` }, label: '界'.repeat(80) })) },
} });
describe('bounded Host batch reads', () => {
  it('splits at complete UTF-8 domains without losing large model choices', async () => {
    const domains = ['modelFavorites', 'modelVisibility'] as const;
    const read = vi.fn(async (domain: Parameters<Parameters<typeof readSettingsBatch>[1]>[0]) => ready(domain === 'modelVisibility' ? domain : 'modelFavorites', 110));
    const page = await readSettingsBatch([...domains], read, () => {});
    expect(page.entries.map(item => item.domain)).toEqual(['modelFavorites']);
    expect(page.remainingDomains).toEqual(['modelVisibility']);
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(SETTINGS_WEB_MAX_BYTES - 512);
    expect(settingsWebResultSchema.safeParse(page).success).toBe(true);
    const next = await readSettingsBatch(page.remainingDomains, async () => ready('modelVisibility', 110), () => {});
    expect(next.remainingDomains).toEqual([]);
    expect(next.entries[0]?.result).toMatchObject({settings:{choices:{entries:expect.arrayContaining([{value:{harness:'codex',providerId:'example',modelId:'model-109'},label:'界'.repeat(80)}])}}});
  });
  it('reports an oversized individual domain explicitly and continues other reads', async () => {
    const page = await readSettingsBatch(['modelFavorites', 'personalization'], async domain => domain === 'modelFavorites'
      ? ready('modelFavorites', 250) : {ok:false,code:'UNREADABLE'}, () => {});
    expect(page.entries.map(item => item.result)).toEqual([{ok:false,code:'SETTINGS_RESPONSE_TOO_LARGE'},{ok:false,code:'UNREADABLE'}]);
    expect(page.remainingDomains).toEqual([]);
    expect(settingsWebResultSchema.safeParse(page).success).toBe(true);
  });
  it('isolates reader errors but aborts the entire batch when identity expires', async () => {
    const result = await readSettingsBatch(['appearance','personalization'], async () => { throw new Error('private detail'); }, () => {});
    expect(result.entries.every(entry => !entry.result.ok && entry.result.code === 'SETTINGS_REQUEST_FAILED')).toBe(true);
    let valid = true;
    const read = vi.fn(async () => { valid = false; return {ok:false,code:'UNREADABLE'}; });
    await expect(readSettingsBatch(['appearance','personalization'], read, () => { if (!valid) throw new Error('identity changed'); })).rejects.toThrow('identity changed');
    expect(read).toHaveBeenCalledTimes(1);
  });
  it('yields after a slow domain so remaining domains receive a fresh request deadline', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1);
    try {
      const result = await readSettingsBatch(['appearance','personalization'], async () => { clock.mockReturnValue(5_002); return {ok:false,code:'UNREADABLE'}; }, () => {});
      expect(result.entries).toHaveLength(1); expect(result.remainingDomains).toEqual(['personalization']);
    } finally { clock.mockRestore(); }
  });
});
