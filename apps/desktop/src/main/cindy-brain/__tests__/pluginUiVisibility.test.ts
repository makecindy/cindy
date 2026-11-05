import { describe, expect, it } from 'vitest';
import { PluginUiVisibilityService } from '../pluginUiVisibility.js';

function fixture() {
  const instances = new Map<string, { id: string; token: string; ui: unknown }>();
  for (const id of ['first', 'second']) instances.set(id, {
    id, token: `${id}-runtime`, ui: { version: 1, appearance: { fields: ['visibility'] } },
  });
  const windows = new Set([1, 2]);
  const applied = new Map<number, Record<string, boolean>>();
  const service = new PluginUiVisibilityService({
    current: id => instances.get(id) ?? null,
    window: id => windows.has(id ?? 1) ? id ?? 1 : null,
    apply: async (id, values) => { applied.set(id, { ...values }); return 'applied'; },
  });
  return { service, instances, windows, applied };
}

describe('plugin UI visibility', () => {
  it('hides and restores named areas without changing the other areas', async () => {
    const h = fixture();
    expect(await h.service.handle('first', { kind: 'set', patch: { sidebar: false, workspace: false } }))
      .toMatchObject({ ok: true, data: { values: { sidebar: false, workspace: false, composer: true }, application: { status: 'applied' } } });
    expect(h.applied.get(1)).toMatchObject({ sidebar: false, workspace: false, composer: true });
    expect(await h.service.handle('first', { kind: 'set', patch: { workspace: true } }))
      .toMatchObject({ ok: true, data: { values: { workspace: true, sidebar: false } } });
  });
  it('rejects undeclared access and invalid element names without changing the window', async () => {
    const h = fixture();
    h.instances.set('first', { id: 'first', token: 'first-runtime', ui: { version: 1, appearance: { fields: ['wallpaper'] } } });
    expect(await h.service.handle('first', { kind: 'set', patch: { workspace: false } }))
      .toMatchObject({ ok: false, error: { code: 'VISIBILITY_UNAVAILABLE' } });
    expect(await h.service.handle('second', { kind: 'set', patch: { arbitraryCss: false } }))
      .toMatchObject({ ok: false, error: { code: 'INVALID_PARAMS' } });
    expect(h.applied.size).toBe(0);
  });
  it('keeps windows independent and restores only the stopped plugin’s hidden areas', async () => {
    const h = fixture();
    await h.service.handle('first', { kind: 'set', patch: { sidebar: false } }, { windowId: 1 });
    await h.service.handle('second', { kind: 'set', patch: { composer: false } }, { windowId: 1 });
    await h.service.handle('first', { kind: 'set', patch: { workspace: false } }, { windowId: 2 });
    await h.service.release('first');
    expect(h.applied.get(1)).toMatchObject({ sidebar: true, composer: false });
    expect(h.applied.get(2)).toMatchObject({ workspace: true });
  });
  it('restores stale runtime state when plugin approval or ownership changes', async () => {
    const h = fixture();
    await h.service.handle('first', { kind: 'set', patch: { header: false } });
    const original = h.instances.get('first')!;
    h.instances.set('first', { ...original, token: 'replacement-runtime' });
    await h.service.reconcile();
    expect(h.applied.get(1)).toMatchObject({ header: true });
    expect(await h.service.handle('first', { kind: 'set', patch: { sidebar: false } },
      { assertCurrent: () => { throw new Error('CONTEXT_CHANGED'); } }))
      .toMatchObject({ ok: false, error: { code: 'CONTEXT_CHANGED' } });
    expect(h.applied.get(1)).toMatchObject({ sidebar: true });
  });
  it('does not report a successful application after its window disappears', async () => {
    const h = fixture(); h.windows.delete(1);
    expect(await h.service.handle('first', { kind: 'set', patch: { workspace: false } }))
      .toMatchObject({ ok: false, error: { code: 'VISIBILITY_UNAVAILABLE' } });
    expect(h.applied.size).toBe(0);
  });
});
