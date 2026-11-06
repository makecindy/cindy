import { describe, expect, it, vi } from 'vitest';
import { createPluginUiPageBridge } from '../pluginUiPageBridge.js';

function fixture(readOnly = false) {
  let current = true;
  const ops = {
    current: () => current,
    read: vi.fn(async () => ({ scope: { kind: 'session', sessionId: 'task' } })),
    capabilities: vi.fn(async () => ({ pages: ['html'] })),
    invoke: vi.fn(async (_input: unknown) => ({ status: 'completed' })),
    appearance: vi.fn(async (_input: unknown) => ({ ok: true })),
    visibility: vi.fn(async (_input: unknown) => ({ ok: true })),
  };
  const bridge = createPluginUiPageBridge(ops, { readOnly });
  const send = (id: number, op: string, input?: unknown) => bridge.handle({ op: 'message',
    message: { jsonrpc: '2.0', id, method: 'cindy/ui', params: { op, input } } });
  const poll = async (after = 0) => await bridge.handle({ op: 'poll', after }) as Array<{ seq: number; message: unknown }>;
  return { ops, bridge, send, poll, invalidate: () => { current = false; } };
}

describe('plugin UI page bridge', () => {
  it('relays only the bound page operations and acknowledges responses', async () => {
    const f = fixture();
    await f.send(1, 'read');
    const events = await f.poll();
    expect(events).toEqual([{ seq: 1, message: { jsonrpc: '2.0', id: 1,
      result: { scope: { kind: 'session', sessionId: 'task' } } } }]);
    expect(await f.poll(1)).toEqual([]);
    await f.send(2, 'invoke', { actionId: 'save', values: { title: 'hello' } });
    expect(f.ops.invoke).toHaveBeenCalledWith({ actionId: 'save', values: { title: 'hello' } });
    await f.send(3, 'appearance.read');
    expect(f.ops.appearance).toHaveBeenCalledWith({ kind: 'read' });
    await f.send(4, 'visibility.set', { patch: { workspace: false } });
    expect(f.ops.visibility).toHaveBeenCalledWith({ kind: 'set', patch: { workspace: false } });
    await f.send(5, 'other');
    expect((await f.poll(1)).at(-1)).toMatchObject({ message: { id: 5, error: { message: 'UI_UNAVAILABLE' } } });
  });
  it('cannot run actions or appearance writes from a saved renderer', async () => {
    const f = fixture(true);
    await f.send(1, 'invoke', { actionId: 'save' });
    await f.send(2, 'appearance.set', { patch: {} });
    await f.send(3, 'appearance.reset', { fields: ['theme'] });
    await f.send(5, 'visibility.set', { patch: { workspace: false } });
    expect(f.ops.invoke).not.toHaveBeenCalled();
    expect(f.ops.appearance).not.toHaveBeenCalled();
    expect(f.ops.visibility).not.toHaveBeenCalled();
    expect(await f.poll()).toHaveLength(4);
    await f.send(4, 'appearance.read');
    expect(f.ops.appearance).toHaveBeenCalledWith({ kind: 'read' });
  });
  it('drops late results and rejects further requests when the view is gone', async () => {
    const f = fixture(); let finish!: (value: unknown) => void;
    f.ops.read.mockImplementation(() => new Promise(resolve => { finish = resolve; }) as never);
    const pending = f.send(1, 'read');
    await Promise.resolve();
    f.invalidate(); finish({ private: 'late' });
    await expect(pending).rejects.toThrow('UI_UNAVAILABLE');
    await expect(f.poll()).rejects.toThrow('UI_UNAVAILABLE');
    expect(f.ops.invoke).not.toHaveBeenCalled();
  });
});
