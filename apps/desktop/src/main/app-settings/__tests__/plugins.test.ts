import { expect, it } from 'vitest';
import { createAppSettingsService } from '../service';
import { createPluginSettingsSections } from '../plugins';

// Unit: actual settings service and plugin section adapter, memory-only KV.
// New contract: approved fields share existing KV, isolated by physical instance;
// the static section tests do not cover plugin defaults or revocation.
it('shares plugin overrides with KV, isolates namesakes and resets only registered fields', async () => {
  const values = new Map<string, Record<string, unknown>>([['local__example', { private: 'keep', size: 14 }]]);
  const settings = [{ id: 'size', title: 'Size', type: 'number' as const, default: 12, min: 10, max: 20 }];
  let current = true;
  const entries = ['local__example', '_root__example'].map(instance => ({ instance, title: 'Example', settings,
    assertCurrent() { if (!current) throw new Error('revoked'); } }));
  const sections = createPluginSettingsSections(entries, {
    read: instance => values.get(instance) ?? {}, write: (instance, next) => { values.set(instance, next); },
  });
  const service = createAppSettingsService(sections);
  const invoke = (operation: 'get' | 'update' | 'reset', patch?: Record<string, unknown>) =>
    service({ operation, section: 'plugins.local__example', patch }, async () => {});
  expect(await invoke('get')).toMatchObject({ state: { value: { size: 14 }, defaults: { size: 12 }, customizedKeys: ['size'] } });
  expect(await invoke('update', { size: 18 })).toMatchObject({ state: { value: { size: 18 } } });
  expect(values.get('local__example')).toEqual({ private: 'keep', size: 18 });
  expect(await service({ operation: 'get', section: 'plugins._root__example' }, async () => {})).toMatchObject({ state: { value: { size: 12 } } });
  expect(await invoke('update', { size: 30 })).toMatchObject({ ok: false, errorCode: 'INVALID_ARGS' });
  expect(await invoke('update', { private: 'changed' })).toMatchObject({ ok: false, errorCode: 'INVALID_ARGS' });
  await invoke('reset');
  expect(values.get('local__example')).toEqual({ private: 'keep' });
  current = false;
  await expect(invoke('update', { size: 16 })).rejects.toThrow('revoked');
  expect(values.get('local__example')).toEqual({ private: 'keep' });
});
