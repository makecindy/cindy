import { describe, expect, it, vi } from 'vitest';
import { PluginUiPageHost } from '../pluginUiPageHost.js';

function fixture(readOnly = false) {
  let current = true;
  const capabilities = { version: 1 as const, points: [], primitives: [], effects: [], pages: ['html'] };
  const page = { instanceId: 'instance-a', contributionId: 'view', readOnly,
    current: () => current, assertCurrent: async () => { if (!current) throw new Error('CONTEXT_CHANGED'); },
    read: vi.fn(async () => ({ scope: { kind: 'session' as const, sessionId: 'task' }, capabilities })), capabilities: vi.fn(async () => capabilities),
    invoke: vi.fn(async () => ({ status: 'completed' as const })) };
  let dispatch!: (input: unknown) => Promise<unknown>, dispose!: () => void;
  let asset!: (relativePath: string) => Promise<Response>;
  const deps = {
    bind: vi.fn(async () => page),
    instance: vi.fn(() => ({ dir: '/plugin-a', ui: { version: 1 } })),
    readFile: vi.fn(async (_source: unknown, request: { kind: string; path?: string }) => ({
      path: request.kind === 'entry' ? 'ui/view.html' : request.path!, mimeType: 'text/html', bytes: Buffer.from('page') })),
    appearance: vi.fn(async () => ({ ok: true })),
    visibility: vi.fn(async () => ({ ok: true })),
    mount: vi.fn((_input: unknown, _caller: string, onMessage: typeof dispatch, onAsset: typeof asset, onDispose: typeof dispose) => {
      dispatch = onMessage; asset = onAsset; dispose = onDispose; return 'sandbox-id';
    }),
    unmount: vi.fn(() => dispose()),
  };
  const host = new PluginUiPageHost(deps);
  return { host, deps, page, revoke: () => { current = false; }, dispatch: (raw: unknown) => dispatch(raw), asset: (name: string) => asset(name) };
}

describe('plugin UI page host', () => {
  it('mounts only the bound instance and closes its sandbox with the view', async () => {
    const f = fixture();
    expect(await f.host.open('local:42', 'task', 'view-id', '1', () => true)).toBe('sandbox-id');
    expect(f.deps.bind).toHaveBeenCalledWith('local:42', 'task', 'view-id', '1', expect.any(Function));
    expect(f.deps.instance).toHaveBeenCalledExactlyOnceWith('instance-a');
    expect(f.deps.mount).toHaveBeenCalledWith({ html: 'page', entry: 'ui/view.html' }, 'renderer:42', expect.any(Function), expect.any(Function), expect.any(Function));
    expect(await (await f.asset('ui/view.js')).text()).toBe('page');
    await expect(f.host.close('local:99', 'sandbox-id')).rejects.toThrow();
    f.host.releaseBinding('view-id');
    expect(f.deps.unmount).toHaveBeenCalledExactlyOnceWith('sandbox-id', 'renderer:42');
    await expect(f.dispatch({ op: 'poll', after: 0 })).rejects.toThrow();
  });
  it('discards a pending mount when its original binding disappears', async () => {
    const f = fixture();
    f.deps.readFile.mockImplementationOnce(async () => { f.revoke(); return { path: 'ui/view.html', mimeType: 'text/html', bytes: Buffer.from('page') }; });
    await expect(f.host.open('local:42', 'task', 'view-id', '1', () => true)).rejects.toThrow();
    expect(f.deps.mount).not.toHaveBeenCalled();
  });
  it('does not permit a historical page to modify appearance', async () => {
    const f = fixture(true);
    await f.host.open('local:42', 'task', 'view-id', '1', () => true);
    await f.dispatch({ op: 'message', message: { jsonrpc: '2.0', id: 1, method: 'cindy/ui',
      params: { op: 'appearance.set', input: { patch: { uiFont: { size: 18 } } } } } });
    expect(f.deps.appearance).not.toHaveBeenCalled();
  });
});
