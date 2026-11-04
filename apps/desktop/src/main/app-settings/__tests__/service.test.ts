import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createAppSettingsService } from '../service';

// Unit: settings tools must retain unspecified overrides, reject unknown fields,
// and recheck caller authority before committing. The previous UI-only surface
// had no reusable domain contract to exercise these conditions.
describe('app settings service', () => {
  it('discovers fields, preserves unrelated settings and reads committed state after reset', async () => {
    let value = { font: 14, animation: true };
    const update = vi.fn((patch: Record<string, unknown>) => { value = { ...value, ...patch }; return { effective: 'next-session' }; });
    const service = createAppSettingsService([{ id: 'test', title: '外观', description: '字体', effective: 'immediate',
      schema: z.strictObject({ font: z.number().min(10).optional(), animation: z.boolean().optional() }),
      read: () => value, update, reset: () => { value = { font: 14, animation: true }; } }]);
    const guard = vi.fn(async () => {});
    expect(await service({ operation: 'list', query: '字体' }, guard)).toMatchObject({ sections: [{ id: 'test', operations: ['get', 'update', 'reset'] }] });
    expect(await service({ operation: 'update', section: 'test', patch: { font: 18 } }, guard)).toMatchObject({ state: { font: 18, animation: true }, result: { effective: 'next-session' } });
    for (const patch of [{}, { typo: true }, { font: 2 }]) expect(await service({ operation: 'update', section: 'test', patch }, guard)).toMatchObject({ ok: false, errorCode: 'INVALID_ARGS' });
    expect(update).toHaveBeenCalledTimes(1);
    expect(await service({ operation: 'reset', section: 'test' }, guard)).toMatchObject({ state: { font: 14, animation: true } });
  });
  it('rejects revoked calls before writes and does not claim success after a persistence failure', async () => {
    const update = vi.fn(() => { throw new Error('disk unavailable'); });
    const service = createAppSettingsService([{ id: 'test', title: 'test', description: '', effective: 'immediate',
      schema: z.strictObject({ enabled: z.boolean() }), read: () => ({}), update }]);
    const guard = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValue(new Error('revoked'));
    await expect(service({ operation: 'update', section: 'test', patch: { enabled: true } }, guard)).rejects.toThrow('revoked');
    expect(update).not.toHaveBeenCalled();
    await expect(service({ operation: 'update', section: 'test', patch: { enabled: true } }, async () => {})).rejects.toThrow('disk unavailable');
    expect(await service({ operation: 'reset', section: 'test' }, async () => {})).toMatchObject({ ok: false, errorCode: 'RESET_NOT_SUPPORTED' });
  });
});
