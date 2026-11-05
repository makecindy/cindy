// @vitest-environment jsdom
import { createElement } from 'react';
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PluginUiView } from '@cindy/maker-shared';
import { sharedTaskHostPeer } from '@cindy/device-link';
import { invokePluginUi, readPluginUi } from '../pluginUiClient';
import { usePluginUiContributions, inspectPluginUiSubscriptions } from '../usePluginUiContributions';
import { setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import { pluginUiComposerAccess, pluginUiComposerKey } from '../pluginUiComposerActions';
import { PluginUiStatusBar } from '../PluginUiStatusBar';
import { PluginUiRendererView } from '../PluginUiRendererView';
import { PluginUiContributionControls } from '../PluginUiControls';
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
/* C1-C4: exercise production adapters/hooks, rather than echoing wire literals.
 * Minimal regression: a remote task falls back to this computer, or a switched owner
 * can dispatch before React rerenders. Tier: unit (DOM). */
const view: PluginUiView = { version: 1, viewId: 'v', revision: '1', contributionId: 'format', point: 'composer.tools',
  controls: [{ id: 'save', kind: 'button', label: 'Save', actionId: 'save' }], blocks: [],
  actions: [{ id: 'save', label: 'Save' }], fallbackMarkdown: 'Save' };
const target = { sessionId: 'task', point: 'composer.tools' };
const input = { viewId: 'v', expectedRevision: '1', invocationId: 'click', actionId: 'save', values: {} };
let read: ReturnType<typeof vi.fn>, invoke: ReturnType<typeof vi.fn>, remote: ReturnType<typeof vi.fn>, release: ReturnType<typeof vi.fn>, chooseRenderer: ReturnType<typeof vi.fn>;
beforeEach(() => {
  setDataOwnerGeneration('owner');
  read = vi.fn(async () => ({ views: [view], revision: 'aggregate' }));
  invoke = vi.fn(async () => ({ invocationId: 'click', status: 'completed' })); remote = vi.fn(); release = vi.fn(async () => {});
  chooseRenderer = vi.fn(async () => {});
  Object.assign(window, { electronAPI: { ghosts: { ui: { read, invoke, release, chooseRenderer, onChanged: () => () => {} } },
    deviceLink: { invoke: remote, onRemotePush: () => () => {} } } });
});
afterEach(cleanup);
describe('plugin UI viewing clients', () => {
  // R9: the real contribution hook disables stale actions while rereading, but
  // must not discard an open page's DOM/input. One deferred read reproduces the
  // missing lifecycle coverage; DOM unit tier, no real waits.
  it('preserves an open contribution page during a background refresh and closes it on removal', async () => {
    const pageView: PluginUiView = { ...view, page: true };
    read.mockResolvedValue({ views: [pageView], revision: 'aggregate' });
    const openPage = vi.fn().mockResolvedValue('98a39be7-0e86-4bb4-a3ad-57b04035bc57');
    const closePage = vi.fn().mockResolvedValue(undefined);
    window.electronAPI.ghosts.ui.openPage = openPage;
    window.electronAPI.ghosts.ui.closePage = closePage;
    let changed!: (event: { sessionId?: string }) => void;
    window.electronAPI.ghosts.ui.onChanged = handler => { changed = handler; return () => {}; };
    const page = render(createElement(PluginUiContributionControls, target));
    fireEvent.click(await screen.findByRole('button', { name: 'Save' }));
    const frame = await screen.findByTitle('format');
    let finish!: (value: unknown) => void;
    read.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    act(() => changed({}));
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByTitle('format')).toBe(frame);
    expect(closePage).not.toHaveBeenCalled();
    await act(async () => finish({ views: [pageView], revision: 'aggregate' }));
    expect(screen.getByTitle('format')).toBe(frame);
    expect(openPage).toHaveBeenCalledOnce();
    expect(closePage).not.toHaveBeenCalled();
    read.mockResolvedValue({ views: [], revision: 'removed' });
    act(() => changed({ sessionId: 'task' }));
    await waitFor(() => expect(screen.queryByTitle('format')).toBeNull());
    expect(closePage).toHaveBeenCalledExactlyOnceWith({ pageId: '98a39be7-0e86-4bb4-a3ad-57b04035bc57' });
    page.unmount();
  });
  // User report: a plugin update briefly replaced saved-record content with the
  // original. Existing tests cover removal, not an in-flight reread. Exercise
  // the real renderer/hook with one deferred read; DOM tier, no real waits.
  it('keeps the selected renderer mounted during a reread and falls back on failure', async () => {
    const rendered: PluginUiView = { ...view, contributionId: 'body', point: 'message.body', actions: [],
      controls: [{ id: 'text', kind: 'status', label: 'Content', text: 'Plugin text' }] };
    const renderer = { candidates: [{ instanceId: 'plugin', contributionId: 'body', pluginName: 'Plugin' }],
      selected: { instanceId: 'plugin', contributionId: 'body' }, preference: 'selected' };
    read.mockResolvedValue({ views: [rendered], revision: '1', renderer });
    let changed!: (event: { sessionId?: string }) => void;
    window.electronAPI.ghosts.ui.onChanged = handler => { changed = handler; return () => {}; };
    const page = render(createElement(PluginUiRendererView, { sessionId: 'task', point: 'message.body',
      target: { kind: 'message', id: 'first' }, children: createElement('p', {}, 'Original text') }));
    const content = await screen.findByText('Plugin text');
    const original = screen.getByText('Original text').closest('details');
    expect(original).toBeTruthy();
    let finish!: (value: unknown) => void;
    read.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    act(() => changed({ sessionId: 'task' }));
    expect(screen.getByText('Plugin text')).toBe(content);
    expect(screen.getByText('Original text').closest('details')).toBe(original);
    await act(async () => finish({ views: [{ ...rendered, revision: '2', controls: [
      { id: 'text', kind: 'status', label: 'Content', text: 'Updated plugin text' },
    ] }], revision: '2', renderer }));
    expect(screen.getByText('Updated plugin text')).toBe(content);
    read.mockRejectedValueOnce(new Error('unavailable'));
    act(() => changed({ sessionId: 'task' }));
    await waitFor(() => expect(screen.queryByText('Updated plugin text')).toBeNull());
    expect(screen.getByText('Original text').closest('details')).toBeNull();
    page.unmount();
  });
  // 4.3 unit: exercise the real action hook. Combined local effects retain draft
  // revision checks and order; only the Host ticket can open a named view.
  it('applies the captured draft before navigating and keeps navigation separate from business completion', async () => {
    const order: string[] = [];
    const off = pluginUiComposerAccess.register(pluginUiComposerKey(target), { current: () => true,
      snapshot: () => ({ draftKey: 'local', revision: '1', selection: { start: 0, end: 0 } }), apply: () => { order.push('draft'); } });
    const editable: PluginUiView = { ...view, editor: { operations: ['append'], readSelection: false } };
    read.mockResolvedValue({ views: [editable], revision: '1' });
    const navigate = vi.fn(async () => { order.push('navigate'); return { tab: 'opened' as const, page: 'received' as const }; });
    window.electronAPI.ghosts.ui.tabViews = { navigate } as never;
    invoke.mockImplementation(async ({ input: action }) => ({ invocationId: action.invocationId, status: 'completed',
      effects: [{ kind: 'composer-edit', operationId: 'op', draftKey: 'local', expectedDraftRevision: '1',
        selection: { start: 0, end: 0 }, operation: 'append', text: 'hello' }], navigation: { requestId: 'host-ticket' } }));
    const { result, unmount } = renderHook(() => usePluginUiContributions(target));
    try {
      await waitFor(() => expect(result.current.disabled).toBe(false));
      await act(async () => { await result.current.invoke(result.current.views[0], 'save', {}); });
      expect(order).toEqual(['draft', 'navigate']); expect(navigate).toHaveBeenCalledExactlyOnceWith('host-ticket');
      expect(result.current.error).toBeUndefined();
    } finally { unmount(); off(); }
  });
  // User's footer example: production component + adapter/hook display plugin
  // text, apply only its click, refresh, and return space after unregistering.
  // Existing generic controls never render this footer. Minimum one item; unit.
  it.each([false, true])('renders a statusbar contribution and releases it after removal (readOnly=%s)', async readOnly => {
    const statusView: PluginUiView = { ...view, point: 'session.statusbar', controls: [
      { id: 'state', kind: 'status', label: 'Plugin state', text: 'Ready' },
      { id: 'toggle', kind: 'button', label: 'Toggle', actionId: 'save' },
    ] };
    read.mockResolvedValue({ views: [], revision: 'empty' });
    let changed!: (event: { sessionId?: string }) => void;
    window.electronAPI.ghosts.ui.onChanged = handler => { changed = handler; return () => {}; };
    invoke.mockImplementation(async ({ input: action }) => {
      read.mockResolvedValue({ views: [{ ...statusView, revision: '2', controls: [
        { id: 'state', kind: 'status', label: 'Plugin state', text: 'Paused' }, ...statusView.controls.slice(1),
      ] }], revision: '2' });
      return { invocationId: action.invocationId, status: 'completed' };
    });
    const page = render(createElement(PluginUiStatusBar, { sessionId: 'task', readOnly }));
    await waitFor(() => expect(read).toHaveBeenCalledOnce());
    expect(page.container.childElementCount).toBe(0);
    read.mockResolvedValue({ views: [statusView], revision: '1' });
    act(() => changed({ sessionId: 'task' }));
    expect(await screen.findByText('Ready')).toBeTruthy();
    const toggle = screen.getByRole('button', { name: 'Toggle' }) as HTMLButtonElement;
    expect(toggle.disabled).toBe(readOnly);
    expect(invoke).not.toHaveBeenCalled();
    fireEvent.click(toggle);
    if (readOnly) expect(invoke).not.toHaveBeenCalled();
    else {
      expect(await screen.findByText('Paused')).toBeTruthy();
      expect(invoke).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ sessionId: 'task',
        input: expect.objectContaining({ viewId: 'v', actionId: 'save', values: {} }) }));
    }
    read.mockResolvedValue({ views: [], revision: 'removed' });
    act(() => changed({ sessionId: 'task' }));
    await waitFor(() => expect(page.container.childElementCount).toBe(0));
    page.unmount();
    expect(release).toHaveBeenCalledOnce();
  });
  // The existing footer cannot host a page, multiline blocks or draft editing.
  // Exercise the real adapter with a composer present; unit, minimal one read.
  it('requests only compact statusbar content even when the task has an editor', async () => {
    const status = { sessionId: 'task', point: 'session.statusbar' };
    const off = pluginUiComposerAccess.register(pluginUiComposerKey(status), { current: () => true,
      snapshot: () => ({ draftKey: 'local', revision: '1', selection: { start: 0, end: 0 } }), apply: vi.fn() });
    try {
      await readPluginUi(status);
      expect(read).toHaveBeenCalledWith(expect.objectContaining({ point: 'session.statusbar',
        capabilities: expect.objectContaining({ primitives: ['button', 'status'], effects: [], pages: [] }) }));
    } finally { off(); }
  });
  it('lets a local user select an offered renderer and never forwards a choice after owner change', async () => {
    const body = { sessionId: 'task', point: 'tool.body', target: { kind: 'tool', id: 'call' } };
    const candidate = { instanceId: 'plugin', contributionId: 'body', pluginName: 'Plugin' };
    read.mockResolvedValue({ views: [], revision: '1', renderer: { candidates: [candidate], preference: 'automatic' } });
    const { result, unmount } = renderHook(() => usePluginUiContributions(body));
    await waitFor(() => expect(result.current.renderer?.candidates).toEqual([candidate]));
    await act(async () => { await result.current.chooseRenderer({ instanceId: 'plugin', contributionId: 'body' }); });
    expect(chooseRenderer).toHaveBeenCalledWith(expect.objectContaining({ choice: { instanceId: 'plugin', contributionId: 'body' },
      request: expect.objectContaining({ sessionId: 'task', point: 'tool.body', target: body.target }) }));
    setDataOwnerGeneration('other');
    await act(async () => { await result.current.chooseRenderer(null); });
    expect(chooseRenderer).toHaveBeenCalledOnce();
    unmount();
  });
  it.each(['mac', sharedTaskHostPeer('share', 'mac')])('keeps existing remote plugin behavior without a native UI request (%s)', async deviceId => {
    const remoteTarget = { ...target, deviceId };
    expect(await readPluginUi(remoteTarget)).toEqual({ views: [], revision: '' });
    expect(await invokePluginUi(remoteTarget, input)).toMatchObject({ status: 'rejected' });
    expect(remote).not.toHaveBeenCalled(); expect(read).not.toHaveBeenCalled(); expect(invoke).not.toHaveBeenCalled();
    const { result, unmount } = renderHook(() => usePluginUiContributions(remoteTarget));
    expect(result.current.views).toEqual([]); expect(result.current.disabled).toBe(true);
    expect(remote).not.toHaveBeenCalled(); expect(read).not.toHaveBeenCalled(); unmount();
  });
  it('consumes only the original invocation result and never retries an unknown write', async () => {
    invoke.mockResolvedValue({ invocationId: 'another', status: 'completed' });
    expect(await invokePluginUi(target, input)).toMatchObject({ status: 'outcome-unknown' });
    invoke.mockRejectedValue(new Error('offline'));
    expect(await invokePluginUi(target, input)).toMatchObject({ status: 'outcome-unknown' });
    expect(invoke).toHaveBeenCalledTimes(2);
  });
  it('clears pending at a terminal result, and rejects an old owner before rerender', async () => {
    const { result, unmount } = renderHook(() => usePluginUiContributions(target));
    await waitFor(() => expect(result.current.disabled).toBe(false));
    expect(inspectPluginUiSubscriptions()).toEqual([expect.objectContaining(target)]);
    let resolve!: (value: unknown) => void; invoke.mockImplementation(() => new Promise(r => { resolve = r; }));
    let action!: Promise<void>; act(() => { action = result.current.invoke(view, 'save', {}); });
    expect(result.current.pending.has('v')).toBe(true);
    await act(async () => { resolve({ invocationId: invoke.mock.calls[0][0].input.invocationId, status: 'rejected' }); await action; });
    expect(result.current.pending.size).toBe(0); expect(result.current.error).toBe('rejected');
    setDataOwnerGeneration('other');
    await act(async () => { await result.current.invoke(view, 'save', {}); });
    expect(invoke).toHaveBeenCalledTimes(1);
    const original = read.mock.calls[0][0].subscriptionId;
    unmount(); expect(inspectPluginUiSubscriptions()).toEqual([]);
    expect(release).toHaveBeenCalledExactlyOnceWith({ subscriptionId: original });
  });
  it('releases a hidden outlet and reads with a new binding when visible without repeating actions', async () => {
    const { result, unmount } = renderHook(() => usePluginUiContributions(target));
    await waitFor(() => expect(result.current.disabled).toBe(false));
    const original = read.mock.calls[0][0].subscriptionId;
    const visibility = vi.spyOn(document, 'visibilityState', 'get');
    try {
      act(() => { visibility.mockReturnValue('hidden'); document.dispatchEvent(new Event('visibilitychange')); });
      expect(release).toHaveBeenCalledWith({ subscriptionId: original }); expect(result.current.disabled).toBe(true);
      await act(async () => { visibility.mockReturnValue('visible'); document.dispatchEvent(new Event('visibilitychange')); });
      await waitFor(() => expect(result.current.disabled).toBe(false));
      expect(read.mock.calls.at(-1)![0].subscriptionId).not.toBe(original);
      expect(invoke).not.toHaveBeenCalled();
    } finally { unmount(); visibility.mockRestore(); }
  });
  it('does not apply a queued result from the previous visible lifetime after reopening', async () => {
    const apply = vi.fn();
    const off = pluginUiComposerAccess.register(pluginUiComposerKey(target), { current: () => true,
      snapshot: () => ({ draftKey: 'local', revision: '1', selection: { start: 0, end: 0 } }), apply });
    const editable: PluginUiView = { ...view, editor: { operations: ['append'], readSelection: false } };
    read.mockResolvedValue({ views: [editable], revision: '1' });
    let resolve!: (value: unknown) => void;
    invoke.mockImplementation(() => new Promise(r => { resolve = r; }));
    const { result, unmount } = renderHook(() => usePluginUiContributions(target));
    const visibility = vi.spyOn(document, 'visibilityState', 'get');
    try {
      await waitFor(() => expect(result.current.disabled).toBe(false));
      let action!: Promise<void>; act(() => { action = result.current.invoke(result.current.views[0], 'save', {}); });
      act(() => { visibility.mockReturnValue('hidden'); document.dispatchEvent(new Event('visibilitychange')); });
      await act(async () => { visibility.mockReturnValue('visible'); document.dispatchEvent(new Event('visibilitychange')); });
      await waitFor(() => expect(result.current.disabled).toBe(false));
      await act(async () => {
        resolve({ invocationId: invoke.mock.calls[0][0].input.invocationId, status: 'completed', effects: [{
          kind: 'composer-edit', operationId: 'late', draftKey: 'local', expectedDraftRevision: '1',
          selection: { start: 0, end: 0 }, operation: 'append', text: 'late' }] });
        await action;
      });
      expect(apply).not.toHaveBeenCalled();
    } finally { unmount(); off(); visibility.mockRestore(); }
  });
  it.each([false, true])('applies an edit only to the captured draft (new input=%s)', async changed => {
    let revision = '1'; const apply = vi.fn();
    const off = pluginUiComposerAccess.register(pluginUiComposerKey(target), { current: () => true,
      snapshot: () => ({ draftKey: 'local-draft', revision, selection: { start: 0, end: 3 }, selectedText: 'old' }), apply });
    const editable: PluginUiView = { ...view, editor: { operations: ['append'], readSelection: true } };
    read.mockResolvedValue({ views: [editable], revision: 'aggregate' });
    invoke.mockImplementation(async ({ input: action }) => {
      expect(action.editor).toEqual({ draftKey: 'local-draft', revision: '1', selection: { start: 0, end: 3 }, selectedText: 'old' });
      if (changed) revision = '2';
      return { invocationId: action.invocationId, status: 'completed', effects: [{ kind: 'composer-edit', operationId: 'effect',
        draftKey: 'local-draft', expectedDraftRevision: '1', selection: { start: 0, end: 3 }, operation: 'append', text: 'new' }] };
    });
    try {
      const { result, unmount } = renderHook(() => usePluginUiContributions(target));
      await waitFor(() => expect(result.current.disabled).toBe(false));
      await act(async () => { await result.current.invoke(result.current.views[0], 'save', {}); });
      expect(apply).toHaveBeenCalledTimes(changed ? 0 : 1);
      expect(result.current.error).toBe(changed ? 'draftChanged' : undefined);
      expect(result.current.pending.size).toBe(0); unmount();
    } finally { off(); }
  });
});
