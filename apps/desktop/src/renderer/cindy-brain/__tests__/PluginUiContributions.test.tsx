// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Editor } from '@tiptap/core';
import Document from '@tiptap/extension-document';
import Paragraph from '@tiptap/extension-paragraph';
import Text from '@tiptap/extension-text';
import { type InstalledGhost } from '../../../shared/ghost';
import { NativePluginUiState } from '../../../main/mcp-apps/nativeState';
import type { PluginUiStateChange } from '../../../shared/pluginUi';
import { getDraft, plainTextToTiptapDoc, saveDraft } from '@/lib/composerDraftStore';
import { setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import { registerPluginUiDraftEditor, pluginUiDraftSnapshot, subscribePluginUiDraft, startPluginUiComposerAction, finishPluginUiComposerAction } from '../pluginUiContext';
import { PluginUiHost } from '../PluginUiHost';
const installed = vi.hoisted(() => ({ ghosts: [] as InstalledGhost[] }));
const translation = vi.hoisted(() => ({ read: vi.fn(() => ({ t: (key: string) => key })) }));
const page = vi.hoisted(() => ({ mounted: vi.fn(), released: vi.fn(),
  bindings: [] as { id: string; contributionId: string }[], inputs: [] as unknown[] }));
vi.mock('../useInstalledGhosts', () => ({ useInstalledGhosts: (enabled = true) => enabled ? installed.ghosts : [],
  readInstalledGhostsSnapshot: () => installed.ghosts }));
vi.mock('react-i18next', () => ({ useTranslation: translation.read }));
// Presenter lifetime is covered separately at McpAppCard; replace only that boundary here.
vi.mock('../PluginUiView', async () => {
  const { useEffect } = await import('react');
  return { PluginUiView: ({ context, input, composerAction }: { context?: unknown; input?: unknown; composerAction?: (typeof page.bindings)[number] }) => {
    useEffect(() => {
      page.mounted(context);
      page.inputs.push(input);
      if (composerAction) page.bindings.push(composerAction);
      return page.released;
    }, []);
    return <div>Local page</div>;
  } };
});
import { memo } from 'react';
import { EMPTY_PLUGIN_UI_MESSAGE_CANDIDATES, PluginUiBody, PluginUiComposerActionScope, PluginUiComposerActionStatus, PluginUiProvider, PluginUiSlot, PluginUiSlotControls, PluginUiWorkdirButton, PluginUiSidebarSections, readPluginUiEntries, renderPluginUiBody, usePluginUiMessageCandidates, type PluginUiMessageCandidates } from '../PluginUiContributions';

// 生产入口：真实 Provider/正文/控件；只替换已装投影与 IPC，Main 订阅适配器不替换。
// 规则与旧回归：无候选历史行不发请求、不构造数据；原测试只覆盖 App frame。
// 最小输入：100/1000 条原文或两个可见控件共享一个源，观察原文、IPC 和源释放。tier: unit。
let receive: ((update: { epoch: string; updates: PluginUiStateChange[] }) => void) | undefined;
let receiveAction: (input: unknown) => void;
let host: NativePluginUiState;
let invoke: ReturnType<typeof vi.fn>;
beforeEach(() => {
  // jsdom has no scrolling implementation; Radix Select focuses options with it.
  Element.prototype.scrollIntoView ??= () => {};
  translation.read.mockClear();
  page.mounted.mockClear(); page.released.mockClear();
  page.bindings.length = 0;
  page.inputs.length = 0;
  installed.ghosts = [];
  const authority = {};
  host = new NativePluginUiState({ owner: () => 'owner', authority: () => authority, demand: () => {},
    send: (_caller, epoch, updates) => receive?.({ epoch, updates }) });
  invoke = vi.fn(async (_session: unknown, input: { op: string; epoch: string; entries: [] }) =>
    input.op === 'native-interest' ? { updates: host.subscribe('renderer:1', input.epoch, input.entries) } : {});
  window.electronAPI = { maker: { mcpApps: invoke, onPluginUiState: (listener: NonNullable<typeof receive>) => {
    receive = listener; return () => { receive = undefined; };
  }, onPluginUiAction: (listener: typeof receiveAction) => {
    receiveAction = listener; return () => {};
  } } } as unknown as typeof window.electronAPI;
});

// Unit: composer.header must enter the same on-demand view lifecycle as the toolbar.
it.each(['composer.toolbar', 'composer.header'] as const)('opens a %s page only on demand and releases it on close', async position => {
  const ghost: InstalledGhost = { enabled: true, dir: '/fixture',
    approval: { state: 'approved', revision: 'one' }, manifest: { schemaVersion: 3, id: 'planner', name: 'Planner',
      kind: 'chip', entry: 'main.js', version: '1', tools: [], mcpApps: {
        ui: { resources: [{ uri: 'ui://view', file: 'view.html' }], tools: {} },
        host: { views: [{ id: 'view', title: 'View', resourceUri: 'ui://view', scope: 'task' }],
          contributions: [{ id: 'open', title: 'Open here', position, view: 'view', presentation: 'popover' }] },
      } } };
  installed.ghosts = [ghost];
  render(<PluginUiProvider><PluginUiSlot position={position} sessionId="task-a" /></PluginUiProvider>);
  expect(page.mounted).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Open here' }));
  expect(await screen.findByText('Local page')).toBeTruthy();
  expect(page.mounted).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button', { name: 'Open here' }));
  await waitFor(() => expect(screen.queryByText('Local page')).toBeNull());
  expect(page.released).toHaveBeenCalledTimes(1);
});

// Unit: actual native controls, lifetime and draft receiver, with only the
// sandbox page replaced. Legacy popover tests cannot catch latent slots or a
// previous page landing a queued write after the next click. Hidden slots opt
// in through their declaration; a static action needs no state publisher.
it('reveals only configured header slots and rejects stale actions across clearing, switching and reopening', async () => {
  setDataOwnerGeneration('owner', 1);
  const sessionId = 'inline-composer-ui';
  const editor = new Editor({ extensions: [Document, Paragraph, Text], content: '<p>Original</p>' });
  const original = plainTextToTiptapDoc('Original');
  saveDraft(sessionId, { text: original, attachments: [] });
  const releaseEditor = registerPluginUiDraftEditor(sessionId, editor, () => false);
  const releaseDraft = subscribePluginUiDraft(sessionId, () => {});
  const revision = pluginUiDraftSnapshot(sessionId).revision;
  const ghost: InstalledGhost = { enabled: true, dir: '/fixture',
    approval: { state: 'approved', revision: 'one' }, manifest: { schemaVersion: 3, id: 'planner', name: 'Planner',
      kind: 'chip', entry: 'main.js', version: '1', tools: [], mcpApps: {
        ui: { resources: [{ uri: 'ui://view', file: 'view.html' }], tools: {} },
        host: { views: [{ id: 'view', title: 'View', resourceUri: 'ui://view', scope: 'task' }], contributions: [
          { id: 'quick', title: 'Empty slot', position: 'composer.header', view: 'view', composerAction: 'inline' },
          { id: 'static', title: 'Static action', position: 'composer.header', view: 'view', composerAction: 'inline', visible: true },
          { id: 'polish', title: 'AI Polish', position: 'composer.toolbar', icon: 'sparkles', view: 'view', composerAction: 'inline', visible: true },
        ] },
      } } };
  installed.ghosts = [ghost];
  const scene = (eligible: boolean, forSession?: string) => <PluginUiProvider host={<PluginUiHost />}>
    <PluginUiComposerActionScope sessionId={eligible ? sessionId : null} editor={editor} disabled={false}>
      <div data-chat-input-root>
        <PluginUiSlot position="composer.header" sessionId={forSession} />
        <span>Draft body</span>
        <PluginUiSlot position="composer.toolbar" sessionId={forSession} />
        <PluginUiComposerActionStatus />
        <button>Other control</button>
      </div>
    </PluginUiComposerActionScope>
  </PluginUiProvider>;
  const talk = async (composerAction: (typeof page.bindings)[number], action: Record<string, unknown>, openId = 'opening') => {
    await act(async () => receiveAction({ sessionId, requestId: 'action', ownerStamp: { dataOwnerId: 'owner', ownerGeneration: 1 },
      composerAction: { ...composerAction, openId, instanceId: 'planner' }, ...action }));
  };
  const showQuick = (visible: boolean) => act(async () => {
    host.publish('planner', 'quick', undefined, () => ({ title: 'Saved prompt', visible }));
  });
  const view = render(scene(false));
  try {
    for (const target of [undefined, 'remote', 'guest']) {
      view.rerender(scene(false, target));
      expect(screen.queryByRole('button', { name: 'AI Polish' })).toBeNull();
      expect(view.container.querySelector('[data-plugin-composer-header]')).toBeNull();
    }
    expect(invoke).not.toHaveBeenCalled();
    view.rerender(scene(true, sessionId));
    await waitFor(() => expect(host.consumers('planner')).toHaveLength(3));
    const toolbar = screen.getByRole('button', { name: 'AI Polish' });
    expect(screen.queryByRole('button', { name: 'Empty slot' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Static action' })).toBeTruthy();
    expect(page.mounted).not.toHaveBeenCalled();
    // A title-only or failed initial projection must not flash the configured slot.
    await act(async () => { host.publish('planner', 'quick', undefined, () => ({ title: 'No visibility state' })); });
    expect(screen.queryByRole('button', { name: 'No visibility state' })).toBeNull();
    await showQuick(true);
    const quick = screen.getByRole('button', { name: 'Saved prompt' });
    expect(page.mounted).not.toHaveBeenCalled();
    fireEvent.click(quick);
    await waitFor(() => expect(page.bindings).toHaveLength(1));
    fireEvent.click(quick);
    expect(page.bindings).toHaveLength(1);
    const cleared = page.bindings[0];
    await talk(cleared, { kind: 'composer-action-start' });
    expect(screen.getByText('Draft body')).toBeTruthy();
    expect(screen.getByRole('status').textContent).toContain('Saved prompt');
    await showQuick(false);
    expect(screen.queryByRole('button', { name: 'Saved prompt' })).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
    expect(page.released).toHaveBeenCalledTimes(1);
    expect(host.consumers('planner')).toHaveLength(3);
    await talk(cleared, { kind: 'draft', mode: 'append', text: 'Late append' });
    expect(invoke).toHaveBeenLastCalledWith(null, expect.objectContaining({ error: 'MCP_APP_ACTION_UNAVAILABLE' }));

    fireEvent.click(toolbar);
    await waitFor(() => expect(page.bindings).toHaveLength(2));
    const polish = page.bindings[1];
    await talk(polish, { kind: 'composer-action-start' });
    await showQuick(true);
    fireEvent.click(screen.getByRole('button', { name: 'Saved prompt' }));
    await waitFor(() => expect(page.bindings).toHaveLength(3));
    const next = page.bindings[2];
    await talk(next, { kind: 'composer-action-start' });
    await talk(polish, { kind: 'draft', mode: 'replace', text: 'Late rewrite', revision });
    expect(invoke).toHaveBeenLastCalledWith(null, expect.objectContaining({ error: 'MCP_APP_ACTION_UNAVAILABLE' }));
    expect(getDraft(sessionId)?.text).toEqual(original);
    await talk(polish, { kind: 'composer-action-finish', status: 'success' });
    expect(screen.getByRole('status').textContent).toContain('Saved prompt');
    await talk(next, { kind: 'composer-action-finish', status: 'success' }, 'reconnected');
    expect(screen.getByRole('status').textContent).toContain('Saved prompt');
    expect(screen.getByRole('status').classList.contains('sr-only')).toBe(true);
    expect(screen.queryByRole('button', { name: 'commonUi.confirmDialog.cancel' })).toBeNull();
    await showQuick(false);
    expect(screen.queryByRole('status')).toBeNull();

    fireEvent.click(toolbar);
    await waitFor(() => expect(page.bindings).toHaveLength(4));
    const reopened = page.bindings[3];
    await talk(reopened, { kind: 'composer-action-start' });
    installed.ghosts = [{ ...ghost, approval: { state: 'approved', revision: 'two' } }];
    view.rerender(scene(true, sessionId));
    expect(screen.queryByRole('status')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'AI Polish' }));
    await waitFor(() => expect(page.bindings).toHaveLength(5));
    const updated = page.bindings[4];
    await talk(updated, { kind: 'composer-action-start' });
    await talk(reopened, { kind: 'composer-action-finish', status: 'success' });
    expect(screen.getByRole('status').textContent).toContain('AI Polish');
    const elsewhere = screen.getByRole('button', { name: 'Other control' });
    elsewhere.focus();
    await talk(updated, { kind: 'composer-action-finish', status: 'error', message: 'Draft changed' });
    expect(screen.getByRole('status').textContent).toBe('Draft changed');
    expect(document.activeElement).toBe(elsewhere);
    expect(new Set(page.bindings.map(binding => binding.id)).size).toBe(5);
  } finally {
    view.unmount();
    releaseEditor();
    releaseDraft();
    editor.destroy();
  }
});

// Unit: a declared action template is not a placeholder. Actual items arrive
// through the existing native state channel and retain stable IDs after reorder.
it('renders only published dynamic items and dispatches their IDs through the declared action', async () => {
  installed.ghosts = [{ enabled: true, dir: '/fixture', approval: { state: 'approved', revision: 'one' },
    manifest: { schemaVersion: 3, id: 'collection', name: 'Collection', kind: 'chip', entry: 'main.js', version: '1',
      tools: [{ name: 'apply', description: 'Apply' }], mcpApps: {
        ui: { resources: [], tools: { apply: { visibility: ['app'] } } }, host: { contributions: [
          { id: 'actions', title: 'Never render this template', position: 'composer.header', tool: 'apply', dynamicItems: true },
        ] },
      } } }];
  const editor = new Editor({ extensions: [Document, Paragraph, Text] });
  const view = render(<PluginUiProvider><PluginUiComposerActionScope sessionId="task-a" editor={editor} disabled={false}>
    <PluginUiSlot position="composer.header" sessionId="task-a" />
  </PluginUiComposerActionScope></PluginUiProvider>);
  await waitFor(() => expect(host.consumers('collection')).toHaveLength(1));
  expect(screen.queryByRole('button', { name: 'Never render this template' })).toBeNull();
  const items = Array.from({ length: 12 }, (_, index) => ({ id: `item-${index}`, title: `Action ${index + 1}` }));
  await act(async () => { host.publish('collection', 'actions', { sessionId: 'task-a' }, () => ({ visible: true, items })); });
  expect(screen.getAllByRole('button', { name: /^Action / })).toHaveLength(12);
  fireEvent.click(screen.getByRole('button', { name: 'Action 10' }));
  await waitFor(() => expect(invoke).toHaveBeenCalledWith('task-a', {
    op: 'plugin-action', instanceId: 'collection', id: 'actions', value: 'item-9',
  }));
  await act(async () => { host.publish('collection', 'actions', { sessionId: 'task-a' }, () => ({
    visible: true, items: [{ ...items[9], icon: 'sparkles' }, items[0]],
  })); });
  expect(screen.getByRole('button', { name: 'Action 10' }).textContent).toBe('');
  expect(screen.getAllByRole('button', { name: /^Action / })).toHaveLength(2);
  await act(async () => { host.publish('collection', 'actions', { sessionId: 'task-a' }, () => ({ visible: true, items: [] })); });
  expect(view.container.querySelector('[data-header-control]')).toBeNull();
  expect(host.consumers('collection')).toHaveLength(1);
  view.unmount();
  editor.destroy();
});

// Unit: a collection may use the existing visible popover presentation too;
// selected item data must not disappear when the action is a View, not a tool.
it('passes a dynamic item value to an explicitly opened popover', async () => {
  installed.ghosts = [{ enabled: true, dir: '/fixture', approval: { state: 'approved', revision: 'one' },
    manifest: { schemaVersion: 3, id: 'collection', name: 'Collection', kind: 'chip', entry: 'main.js', version: '1', tools: [],
      mcpApps: { ui: { resources: [{ uri: 'ui://view', file: 'view.html' }], tools: {} }, host: {
        views: [{ id: 'view', title: 'View', resourceUri: 'ui://view', scope: 'task' }], contributions: [
          { id: 'actions', title: 'Template', position: 'composer.header', dynamicItems: true, presentation: 'popover', view: 'view',
            arguments: { fixed: 'same' } },
        ],
      } } } }];
  const editor = new Editor({ extensions: [Document, Paragraph, Text] });
  const view = render(<PluginUiProvider><PluginUiComposerActionScope sessionId="task-a" editor={editor} disabled={false}>
    <PluginUiSlot position="composer.header" sessionId="task-a" />
  </PluginUiComposerActionScope></PluginUiProvider>);
  await waitFor(() => expect(host.consumers('collection')).toHaveLength(1));
  await act(async () => { host.publish('collection', 'actions', { sessionId: 'task-a' }, () => ({ visible: true,
    items: [{ id: 'two', title: 'Second' }],
  })); });
  fireEvent.click(screen.getByRole('button', { name: 'Second' }));
  await screen.findByText('Local page');
  expect(page.inputs).toEqual([{ fixed: 'same', value: 'two' }]);
  view.unmount();
  editor.destroy();
});

// Unit: repeated items share a declaration but not a click lifetime. Opening
// another item must pass its ID and release the previous item's queued writes.
it('binds inline collection values to separate click lifetimes', async () => {
  setDataOwnerGeneration('owner', 1);
  const sessionId = 'inline-items';
  const editor = new Editor({ extensions: [Document, Paragraph, Text], content: '<p>Original</p>' });
  const releaseEditor = registerPluginUiDraftEditor(sessionId, editor, () => false);
  installed.ghosts = [{ enabled: true, dir: '/fixture', approval: { state: 'approved', revision: 'one' },
    manifest: { schemaVersion: 3, id: 'collection', name: 'Collection', kind: 'chip', entry: 'main.js', version: '1', tools: [],
      mcpApps: { ui: { resources: [{ uri: 'ui://view', file: 'view.html' }], tools: {} }, host: {
        views: [{ id: 'view', title: 'View', resourceUri: 'ui://view', scope: 'task' }], contributions: [
          { id: 'actions', title: 'Template', position: 'composer.header', dynamicItems: true, composerAction: 'inline', view: 'view' },
        ],
      } } } }];
  const view = render(<PluginUiProvider host={<PluginUiHost />}>
    <PluginUiComposerActionScope sessionId={sessionId} editor={editor} disabled={false}>
      <div data-chat-input-root><PluginUiSlot position="composer.header" sessionId={sessionId} /><PluginUiComposerActionStatus /></div>
    </PluginUiComposerActionScope>
  </PluginUiProvider>);
  try {
    await waitFor(() => expect(host.consumers('collection')).toHaveLength(1));
    await act(async () => { host.publish('collection', 'actions', { sessionId }, () => ({ visible: true,
      items: [{ id: 'one', title: 'First' }, { id: 'two', title: 'Second' }],
    })); });
    fireEvent.click(screen.getByRole('button', { name: 'First' }));
    await waitFor(() => expect(page.inputs).toEqual([{ value: 'one' }]));
    const old = page.bindings[0];
    fireEvent.click(screen.getByRole('button', { name: 'Second' }));
    await waitFor(() => expect(page.inputs).toEqual([{ value: 'one' }, { value: 'two' }]));
    expect(page.bindings[1].id).not.toBe(old.id);
    await act(async () => receiveAction({ requestId: 'old', ownerStamp: { dataOwnerId: 'owner', ownerGeneration: 1 },
      kind: 'draft', mode: 'append', text: 'Late', sessionId,
      composerAction: { ...old, openId: 'one', instanceId: 'collection' },
    }));
    expect(invoke).toHaveBeenLastCalledWith(null, expect.objectContaining({ error: 'MCP_APP_ACTION_UNAVAILABLE' }));
  } finally { view.unmount(); releaseEditor(); editor.destroy(); }
});

// Unit: consecutive declared queue actions must reach the real draft receiver
// in order. A failed action advances, and a replace action invalidates pending work.
it('serializes declared actions without dropping distinct clicks and clears them on replacement', async () => {
  setDataOwnerGeneration('owner', 1);
  const sessionId = 'queued-actions';
  const editor = new Editor({ extensions: [Document, Paragraph, Text], content: '<p>Original</p>' });
  saveDraft(sessionId, { text: editor.getJSON(), attachments: [] });
  const save = () => saveDraft(sessionId, { text: editor.getJSON(), attachments: [] }, { silent: true });
  editor.on('update', save);
  const release = registerPluginUiDraftEditor(sessionId, editor, () => false);
  installed.ghosts = [{ enabled: true, dir: '/fixture', approval: { state: 'approved', revision: 'one' },
    manifest: { schemaVersion: 3, id: 'actions', name: 'Actions', kind: 'chip', entry: 'main.js', version: '1', tools: [],
      mcpApps: { ui: { resources: [{ uri: 'ui://action', file: 'action.html' }], tools: {} }, host: {
        views: [{ id: 'action', title: 'Action', resourceUri: 'ui://action', scope: 'task' }],
        contributions: ['One', 'Two', 'Three', 'Replace'].map(title => ({ id: title.toLowerCase(), title, position: 'composer.header',
          view: 'action', composerAction: 'inline', visible: true, concurrency: title === 'Replace' ? 'replace' : 'queue' })),
      } } } }];
  const scene = (task = sessionId) => <PluginUiProvider host={<PluginUiHost />}>
    <PluginUiComposerActionScope sessionId={task} editor={editor} disabled={false}>
      <div data-chat-input-root><PluginUiSlot position="composer.header" sessionId={task} /><PluginUiComposerActionStatus /></div>
    </PluginUiComposerActionScope>
  </PluginUiProvider>;
  const view = render(scene());
  const talk = async (binding: (typeof page.bindings)[number], input: Record<string, unknown>) => act(async () => receiveAction({
    requestId: crypto.randomUUID(), ownerStamp: { dataOwnerId: 'owner', ownerGeneration: 1 }, sessionId,
    composerAction: { ...binding, openId: binding.id, instanceId: 'actions' }, ...input,
  }));
  try {
    fireEvent.click(screen.getByRole('button', { name: 'One' }));
    await waitFor(() => expect(page.bindings).toHaveLength(1));
    const one = page.bindings[0];
    await talk(one, { kind: 'composer-action-start' });
    fireEvent.click(screen.getByRole('button', { name: 'Two' }));
    fireEvent.click(screen.getByRole('button', { name: 'Two' }));
    fireEvent.click(screen.getByRole('button', { name: 'Three' }));
    expect(page.bindings).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Two' }).getAttribute('aria-busy')).toBe('true');
    await talk(one, { kind: 'draft', mode: 'append', text: 'First' });
    expect(editor.getText()).toContain('First');
    await talk(one, { kind: 'composer-action-finish', status: 'success' });
    await waitFor(() => expect(page.bindings).toHaveLength(2));
    expect(page.bindings[1].contributionId).toBe('two');
    const two = page.bindings[1];
    await talk(two, { kind: 'composer-action-start' });
    await talk(two, { kind: 'composer-action-finish', status: 'error', message: 'Failed' });
    await waitFor(() => expect(page.bindings).toHaveLength(3));
    expect(page.bindings[2].contributionId).toBe('three');
    const three = page.bindings[2];
    await talk(three, { kind: 'composer-action-start' });
    fireEvent.click(screen.getByRole('button', { name: 'One' }));
    fireEvent.click(screen.getByRole('button', { name: 'Replace' }));
    await waitFor(() => expect(page.bindings).toHaveLength(4));
    expect(page.bindings[3].contributionId).toBe('replace');
    await talk(three, { kind: 'draft', mode: 'append', text: 'Late' });
    expect(editor.getText()).not.toContain('Late');
    await talk(page.bindings[3], { kind: 'composer-action-start' });
    await talk(page.bindings[3], { kind: 'composer-action-finish', status: 'success' });
    expect(page.bindings).toHaveLength(4);
    fireEvent.click(screen.getByRole('button', { name: 'One' }));
    fireEvent.click(screen.getByRole('button', { name: 'Two' }));
    view.rerender(scene('other-task'));
    expect(screen.getByRole('button', { name: 'Two' }).getAttribute('aria-busy')).toBe('false');
    expect(page.bindings).toHaveLength(5);
  } finally { view.unmount(); release(); editor.destroy(); }
});

// Unit: queued work has no page until execution, is invalidated with its source,
// and an unresponsive action cannot hold the editor beyond the existing call ceiling.
it.each(['hidden', 'disabled', 'revoked', 'timeout'] as const)('releases queued actions on %s', async change => {
  setDataOwnerGeneration('owner', 1);
  const sessionId = 'queue-cleanup';
  const editor = new Editor({ extensions: [Document, Paragraph, Text] });
  const release = registerPluginUiDraftEditor(sessionId, editor, () => false);
  const ghost: InstalledGhost = { enabled: true, dir: '/fixture', approval: { state: 'approved', revision: 'one' }, manifest: {
    schemaVersion: 3, id: 'actions', name: 'Actions', kind: 'chip', entry: 'main.js', version: '1', tools: [], mcpApps: {
      ui: { resources: [{ uri: 'ui://action', file: 'action.html' }], tools: {} }, host: {
        views: [{ id: 'action', title: 'Action', resourceUri: 'ui://action', scope: 'task' }],
        contributions: ['one', 'two'].map(id => ({ id, title: id, position: 'composer.header', view: 'action',
          composerAction: 'inline' as const, concurrency: 'queue' as const, visible: true })),
      },
    },
  } };
  installed.ghosts = [ghost];
  const scene = () => <PluginUiProvider><PluginUiComposerActionScope sessionId={sessionId} editor={editor} disabled={false}>
    <div data-chat-input-root><PluginUiSlot position="composer.header" sessionId={sessionId} /><PluginUiComposerActionStatus /></div>
  </PluginUiComposerActionScope></PluginUiProvider>;
  const view = render(scene());
  try {
    if (change === 'timeout') vi.useFakeTimers();
    fireEvent.click(screen.getByRole('button', { name: 'one' }));
    if (change === 'timeout') await act(() => vi.advanceTimersByTimeAsync(0));
    else await waitFor(() => expect(page.bindings).toHaveLength(1));
    expect(page.bindings).toHaveLength(1);
    const binding = { ...page.bindings[0], instanceId: 'actions', openId: 'opening' };
    startPluginUiComposerAction(sessionId, binding);
    fireEvent.click(screen.getByRole('button', { name: 'two' }));
    expect(page.bindings).toHaveLength(1);
    if (change === 'timeout') {
      await act(() => vi.advanceTimersByTimeAsync(15 * 60_000));
      view.rerender(scene());
      await act(() => vi.advanceTimersByTimeAsync(15 * 60_000));
      expect(page.bindings).toHaveLength(2);
      expect(page.bindings[1].contributionId).toBe('two');
      expect(() => finishPluginUiComposerAction(sessionId, binding, { status: 'success' })).toThrow('MCP_APP_ACTION_UNAVAILABLE');
    } else if (change === 'revoked') {
      installed.ghosts = [{ ...ghost, enabled: false }];
      view.rerender(scene());
      expect(screen.queryByRole('button', { name: 'two' })).toBeNull();
      expect(() => finishPluginUiComposerAction(sessionId, binding, { status: 'success' })).toThrow('MCP_APP_ACTION_UNAVAILABLE');
      expect(page.bindings).toHaveLength(1);
    } else {
      await act(async () => { host.publish('actions', 'two', { sessionId }, () => change === 'hidden' ? { visible: false } : { disabled: true }); });
      await act(async () => finishPluginUiComposerAction(sessionId, binding, { status: 'success' }));
      expect(page.bindings).toHaveLength(1);
    }
  } finally { vi.useRealTimers(); view.unmount(); release(); editor.destroy(); }
});

// Unit: duplicated presenters (inline and overflow) are one logical entry.
// Closing only the overflow presenter must not cancel an already accepted action.
it('retains an action when one of its duplicate presenters unmounts', async () => {
  setDataOwnerGeneration('owner', 1);
  const sessionId = 'duplicate-action';
  const editor = new Editor({ extensions: [Document, Paragraph, Text] });
  const release = registerPluginUiDraftEditor(sessionId, editor, () => false);
  installed.ghosts = [{ enabled: true, dir: '/fixture', approval: { state: 'approved', revision: 'one' }, manifest: {
    schemaVersion: 3, id: 'action', name: 'Action', kind: 'chip', entry: 'main.js', version: '1', tools: [], mcpApps: {
      ui: { resources: [{ uri: 'ui://action', file: 'action.html' }], tools: {} }, host: {
        views: [{ id: 'action', title: 'Action', resourceUri: 'ui://action', scope: 'task' }],
        contributions: [{ id: 'action', title: 'Run', position: 'composer.toolbar', view: 'action', composerAction: 'inline', visible: true }],
      },
    },
  } }];
  const scene = (duplicate: boolean) => <PluginUiProvider><PluginUiComposerActionScope sessionId={sessionId} editor={editor} disabled={false}>
    <div data-chat-input-root><PluginUiSlot position="composer.toolbar" sessionId={sessionId} />
      {duplicate && <PluginUiSlot position="composer.toolbar" sessionId={sessionId} />}<PluginUiComposerActionStatus /></div>
  </PluginUiComposerActionScope></PluginUiProvider>;
  const view = render(scene(true));
  try {
    fireEvent.click(screen.getAllByRole('button', { name: 'Run' })[1]);
    await waitFor(() => expect(page.bindings).toHaveLength(1));
    view.rerender(scene(false));
    expect(screen.getByRole('button', { name: 'Run' }).getAttribute('aria-busy')).toBe('true');
  } finally { view.unmount(); release(); editor.destroy(); }
});

// Unit: the workdir chip is a native folder shortcut until a plugin contributes.
// An approved popover must open from its menu and disappear on revocation.
it('keeps the native folder action and opens a workdir plugin only after selection', async () => {
  const openDirectory = vi.fn();
  const scene = () => <PluginUiProvider><PluginUiWorkdirButton sessionId="task-a" path="/project" onOpenDirectory={openDirectory}>
    Project
  </PluginUiWorkdirButton></PluginUiProvider>;
  const view = render(scene());
  fireEvent.click(screen.getByRole('button'));
  expect(openDirectory).toHaveBeenCalledOnce();
  expect(invoke).not.toHaveBeenCalled();
  installed.ghosts = [{ enabled: true, dir: '/fixture', approval: { state: 'approved', revision: 'one' },
    manifest: { schemaVersion: 3, id: 'editor', name: 'Editor', kind: 'chip', entry: 'main.js', version: '1', tools: [],
      mcpApps: { ui: { resources: [{ uri: 'ui://open', file: 'open.html' }], tools: {} }, host: {
        views: [{ id: 'open', title: 'Open', resourceUri: 'ui://open', scope: 'task' }],
        contributions: [{ id: 'open', title: 'Open in', position: 'workdir.menu', view: 'open', presentation: 'popover' }],
      } } } }];
  view.rerender(scene());
  fireEvent.keyDown(screen.getByRole('button', { name: 'Project' }), { key: 'Enter' });
  expect(screen.getByRole('menuitem', { name: 'ccAgent.layout.openWorkingDirAria' })).toBeTruthy();
  expect(page.mounted).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('menuitem', { name: 'Open in · Editor' }));
  expect(await screen.findByText('Local page')).toBeTruthy();
  expect(page.mounted).toHaveBeenCalledWith({ workingDir: '/project' });
  installed.ghosts = [];
  view.rerender(scene());
  expect(screen.queryByText('Local page')).toBeNull();
  expect(screen.getByRole('button', { name: 'ccAgent.layout.openWorkingDirAria' })).toBeTruthy();
});

// Unit: the new header slot must leave no wrapper or IPC when empty,
// and approved native controls must disappear on disable/revocation. The toolbar
// popover regression does not exercise header tool/select dispatch.
it('exposes header controls through the existing actions and removes the empty header', async () => {
  const scene = <PluginUiProvider><PluginUiSlot position="composer.header" sessionId="task-a" /></PluginUiProvider>;
  const view = render(scene);
  const original = view.container.innerHTML;
  expect(invoke).not.toHaveBeenCalled();
  const ghost: InstalledGhost = { enabled: true, dir: '/fixture',
    approval: { state: 'approved', revision: 'one' }, manifest: { schemaVersion: 3, id: 'planner', name: 'Planner',
      kind: 'chip', entry: 'main.js', version: '1', tools: [{ name: 'refresh', description: 'Refresh' }], mcpApps: {
        ui: { resources: [], tools: { refresh: { visibility: ['app'] } } }, host: { contributions: [
          { id: 'refresh', title: 'Refresh', position: 'composer.header', icon: 'sparkles', tool: 'refresh' },
          { id: 'plain', title: 'Plain action', position: 'composer.header', tool: 'refresh' },
          { id: 'scope', title: 'Scope', position: 'composer.header', kind: 'select', tool: 'refresh', options: [{ label: 'All', value: 'all' }] },
          { id: 'progress', title: 'Ready', position: 'composer.header', kind: 'status', visible: false },
        ] },
      } } };
  installed.ghosts = [ghost];
  view.rerender(<PluginUiProvider><PluginUiSlot position="composer.header" sessionId="task-a" /></PluginUiProvider>);
  expect(screen.queryByText('Ready')).toBeNull();
  await waitFor(() => expect(host.consumers('planner')).toHaveLength(4));
  await act(async () => { host.publish('planner', 'progress', { sessionId: 'task-a' }, () => ({ title: 'Processing 40%', visible: true })); });
  expect(screen.getByText('Processing 40%')).toBeTruthy();
  await act(async () => { host.publish('planner', 'progress', { sessionId: 'task-a' }, () => ({ title: 'Check the result', visible: true })); });
  expect(screen.getByText('Check the result')).toBeTruthy();
  expect(screen.queryByText('Processing 40%')).toBeNull();
  await act(async () => { host.publish('planner', 'progress', { sessionId: 'task-a' }, () => ({ visible: false })); });
  expect(screen.queryByText('Check the result')).toBeNull();
  const iconButton = screen.getByRole('button', { name: 'Refresh' });
  expect(iconButton.querySelector('svg')).not.toBeNull();
  expect(iconButton.textContent).toBe('');
  expect(screen.getByRole('button', { name: 'Plain action' }).textContent).toBe('Plain action');
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
  await waitFor(() => expect(invoke).toHaveBeenCalledWith('task-a',
    { op: 'plugin-action', instanceId: 'planner', id: 'refresh', value: undefined }));
  fireEvent.click(screen.getByRole('combobox', { name: 'Scope' }));
  fireEvent.click(await screen.findByRole('option', { name: 'All' }));
  await waitFor(() => expect(invoke).toHaveBeenCalledWith('task-a',
    { op: 'plugin-action', instanceId: 'planner', id: 'scope', value: 'all' }));
  for (const inactive of [{ ...ghost, enabled: false }, { ...ghost, approval: { state: 'invalid' as const } }]) {
    installed.ghosts = [inactive];
    view.rerender(<PluginUiProvider><PluginUiSlot position="composer.header" sessionId="task-a" /></PluginUiProvider>);
    expect(view.container.innerHTML).toBe(original);
  }
});

// Unit, sidebar lifecycle: no page before expansion; close/revoke releases the View.
// Existing popover tests cannot cover a persistent sidebar section. Empty directory
// must keep the original aside with no native IPC. Frame protocol is tested separately.
it('keeps the sidebar view through collapse and releases it immediately on revocation', async () => {
  const Sections = () => {
    const entries = readPluginUiEntries('sidebar.section');
    return <aside><span>Original sidebar</span>{entries.length > 0 && <PluginUiSidebarSections entries={entries} sessionId={null} />}</aside>;
  };
  const view = render(<PluginUiProvider><Sections /></PluginUiProvider>);
  expect(screen.getByText('Original sidebar')).toBeTruthy(); expect(invoke).not.toHaveBeenCalled();
  const ghost: InstalledGhost = { enabled: true, dir: '/fixture',
    approval: { state: 'approved', revision: 'one' }, manifest: { schemaVersion: 3, id: 'planner', name: 'Planner',
      kind: 'chip', entry: 'main.js', version: '1', tools: [], mcpApps: {
        ui: { resources: [{ uri: 'ui://view', file: 'view.html' }], tools: {} }, host: {
          views: [{ id: 'view', title: 'View', resourceUri: 'ui://view', scope: 'global' }],
          contributions: [{ id: 'summary', title: 'Summary', position: 'sidebar.section', view: 'view' }],
        },
      } } };
  installed.ghosts = [ghost];
  view.rerender(<PluginUiProvider><Sections /></PluginUiProvider>);
  expect(page.mounted).not.toHaveBeenCalled();
  const toggle = screen.getByRole('button', { name: 'Summary · Planner' });
  fireEvent.click(toggle);
  expect(await screen.findByText('Local page')).toBeTruthy();
  fireEvent.click(toggle);
  expect(screen.getByText('Local page')).toBeTruthy();
  expect(page.released).not.toHaveBeenCalled();
  fireEvent.click(toggle);
  expect(page.mounted).toHaveBeenCalledTimes(1);
  fireEvent.click(toggle);
  await waitFor(() => expect(page.released).toHaveBeenCalledTimes(1));
  expect(screen.queryByText('Local page')).toBeNull();
  fireEvent.click(toggle);
  expect(await screen.findByText('Local page')).toBeTruthy();
  fireEvent.click(toggle);
  installed.ghosts = [{ ...ghost, approval: { state: 'invalid' as const } }];
  view.rerender(<PluginUiProvider><Sections /></PluginUiProvider>);
  expect(screen.queryByRole('button', { name: 'Summary · Planner' })).toBeNull();
  expect(page.released).toHaveBeenCalledTimes(2); expect(screen.getByText('Original sidebar')).toBeTruthy();
});

// Unit: titlebar actions use the original native action IPC and disappear on revoke.
// Existing toolbar buttons do not cover the newly approved placement. No candidate
// must add a control consumer or invoke IPC; original title content stays in place.
it('runs an approved titlebar action and restores the original chrome after revocation', async () => {
  const Chrome = () => {
    const entries = readPluginUiEntries('window.titlebar');
    return <header><span>Original chrome</span>{entries.length > 0 && <PluginUiSlotControls entries={entries} appearance="titlebar" />}</header>;
  };
  const view = render(<PluginUiProvider><Chrome /></PluginUiProvider>);
  expect(invoke).not.toHaveBeenCalled(); expect(translation.read).not.toHaveBeenCalled();
  const ghost: InstalledGhost = { enabled: true, dir: '/fixture',
    approval: { state: 'approved', revision: 'one' }, manifest: { schemaVersion: 3, id: 'planner', name: 'Planner',
      kind: 'chip', entry: 'main.js', version: '1', tools: [{ name: 'refresh', description: 'Refresh' }], mcpApps: {
        ui: { resources: [], tools: { refresh: { visibility: ['app'] } } }, host: {
          contributions: [{ id: 'refresh', title: 'Refresh', position: 'window.titlebar', tool: 'refresh' }],
        },
      } } };
  installed.ghosts = [ghost];
  view.rerender(<PluginUiProvider><Chrome /></PluginUiProvider>);
  fireEvent.click(screen.getByRole('button', { name: 'Refresh · Planner' }));
  await waitFor(() => expect(invoke).toHaveBeenCalledWith(null,
    { op: 'plugin-action', instanceId: 'planner', id: 'refresh', value: undefined }));
  installed.ghosts = [{ ...ghost, approval: { state: 'invalid' as const } }];
  view.rerender(<PluginUiProvider><Chrome /></PluginUiProvider>);
  expect(screen.queryByRole('button', { name: 'Refresh · Planner' })).toBeNull();
  expect(screen.getByText('Original chrome')).toBeTruthy();
});

it('mounts the window host only for enabled and approved host declarations', () => {
  const view = render(<PluginUiProvider host={<span>Window host</span>}>Chat</PluginUiProvider>);
  expect(screen.queryByText('Window host')).toBeNull();
  const ghost: InstalledGhost = { enabled: true, dir: '/fixture',
    approval: { state: 'approved', revision: 'one' }, manifest: { schemaVersion: 3, id: 'planner', name: 'Planner',
      kind: 'chip', entry: 'main.js', version: '1', tools: [], mcpApps: { host: { capabilities: ['draft'] } } } };
  installed.ghosts = [ghost];
  view.rerender(<PluginUiProvider host={<span>Window host</span>}>Chat</PluginUiProvider>);
  expect(screen.getByText('Window host')).toBeTruthy();
  view.rerender(<PluginUiProvider enabled={false} host={<span>Window host</span>}>Chat</PluginUiProvider>);
  expect(screen.queryByText('Window host')).toBeNull();
  installed.ghosts = [{ ...ghost, enabled: false }];
  view.rerender(<PluginUiProvider host={<span>Window host</span>}>Chat</PluginUiProvider>);
  expect(screen.queryByText('Window host')).toBeNull();
});
afterEach(async () => { cleanup(); await Promise.resolve(); await Promise.resolve(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it.each([100, 1000])('keeps %i ordinary history rows free of additional payload construction and IPC', (count) => {
  const context = vi.fn(() => ({ message: 'Should not be built' }));
  render(<PluginUiProvider>{Array.from({ length: count }, (_, index) =>
    <PluginUiBody key={index} position="message.body" sessionId="task-a" context={context}><span>Original</span></PluginUiBody>)}
  </PluginUiProvider>);
  expect(screen.getAllByText('Original')).toHaveLength(count);
  expect(context).not.toHaveBeenCalled(); expect(invoke).not.toHaveBeenCalled();
  expect(translation.read).not.toHaveBeenCalled();
});

it('keeps 500 message rows and 1000 tool bodies on their original elements with one stable candidate projection', () => {
  const rowRender = vi.fn();
  const Row = memo(({ candidates }: { candidates: PluginUiMessageCandidates }) => {
    rowRender();
    const message = <span>Original message</span>;
    const tool = <span>Original tool</span>;
    const body = renderPluginUiBody(candidates.messageBody ? { position: 'message.body' } : undefined, message);
    const toolBody = renderPluginUiBody(candidates.toolBody ? { position: 'tool.body' } : undefined, tool);
    expect(body).toBe(message); expect(toolBody).toBe(tool);
    return <article>{body}{toolBody}{toolBody}{candidates.messageActions && <PluginUiSlot position="message.actions" />}
      {candidates.turnFooter && <PluginUiSlot position="turn.footer" />}</article>;
  });
  let projection: PluginUiMessageCandidates | undefined;
  const List = () => {
    const candidates = usePluginUiMessageCandidates();
    projection = candidates;
    return <>{Array.from({ length: 500 }, (_, index) => <Row key={index} candidates={candidates} />)}</>;
  };
  const view = render(<PluginUiProvider><List /></PluginUiProvider>);
  expect(projection).toBe(EMPTY_PLUGIN_UI_MESSAGE_CANDIDATES);
  expect(rowRender).toHaveBeenCalledTimes(500);
  expect(screen.getAllByText('Original tool')).toHaveLength(1000);
  installed.ghosts = [{ enabled: false } as InstalledGhost];
  view.rerender(<PluginUiProvider><List /></PluginUiProvider>);
  expect(projection).toBe(EMPTY_PLUGIN_UI_MESSAGE_CANDIDATES);
  expect(rowRender).toHaveBeenCalledTimes(500);
  expect(invoke).not.toHaveBeenCalled(); expect(translation.read).not.toHaveBeenCalled();
});

it('does not subscribe history when the installed plugin only matches another kind of tool', () => {
  const ghost: InstalledGhost = { enabled: true, dir: '/fixture',
    approval: { state: 'approved', revision: 'one' }, manifest: { schemaVersion: 3, id: 'planner', name: 'Planner',
      kind: 'chip', entry: 'main.js', version: '1', tools: [], mcpApps: {
        ui: { resources: [{ uri: 'ui://view', file: 'view.html' }], tools: {} },
        host: { views: [{ id: 'view', title: 'View', resourceUri: 'ui://view' }],
          contributions: [{ id: 'body', title: 'Body', position: 'tool.body', view: 'view', match: { tools: ['other'] } }] },
      } } };
  installed.ghosts = [ghost];
  const context = vi.fn(() => ({}));
  render(<PluginUiProvider><PluginUiBody position="tool.body" sessionId="task-a" tool="actual" context={context}>Original</PluginUiBody></PluginUiProvider>);
  expect(screen.getByText('Original')).toBeTruthy(); expect(invoke).not.toHaveBeenCalled(); expect(context).not.toHaveBeenCalled();
});

it('shares a visible control source, applies its update, and releases it when the controls unmount', async () => {
  const ghost: InstalledGhost = { enabled: true, dir: '/fixture',
    approval: { state: 'approved', revision: 'one' }, manifest: { schemaVersion: 3, id: 'planner', name: 'Planner',
      kind: 'chip', entry: 'main.js', version: '1', tools: [], mcpApps: {
        ui: { resources: [{ uri: 'ui://view', file: 'view.html' }], tools: {} },
        host: { contributions: [{ id: 'progress', title: 'Ready', position: 'statusbar', kind: 'status' }] },
      } } };
  installed.ghosts = [ghost];
  const view = render(<PluginUiProvider><PluginUiSlot position="statusbar" sessionId="task-a" /><PluginUiSlot position="statusbar" sessionId="task-a" /></PluginUiProvider>);
  await waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
  expect(host.consumers('planner')).toHaveLength(1);
  await act(async () => { host.publish('planner', 'progress', undefined, () => ({ title: 'Working' })); });
  expect(screen.getAllByText('Working')).toHaveLength(2);
  view.unmount(); await act(async () => {});
  expect(host.consumers('planner')).toBeUndefined();
});

it.each([100, 1000])('subscribes only visible native controls among %i mounted history rows', async count => {
  let report!: IntersectionObserverCallback;
  const elements = new Set<Element>();
  const disconnect = vi.fn();
  const observe = vi.fn((element: Element) => { elements.add(element); });
  vi.stubGlobal('IntersectionObserver', class {
    constructor(callback: IntersectionObserverCallback) { report = callback; }
    observe = observe;
    unobserve(element: Element) { elements.delete(element); }
    disconnect = disconnect;
  });
  const ghost: InstalledGhost = { enabled: true, dir: '/fixture',
    approval: { state: 'approved', revision: 'one' }, manifest: { schemaVersion: 3, id: 'planner', name: 'Planner',
      kind: 'chip', entry: 'main.js', version: '1', tools: [], mcpApps: {
        ui: { resources: [{ uri: 'ui://view', file: 'view.html' }], tools: {} },
        host: { contributions: [{ id: 'progress', title: 'Ready', position: 'turn.footer', kind: 'status' }] },
      } } };
  installed.ghosts = [ghost];
  const view = render(<PluginUiProvider>{Array.from({ length: count }, (_, index) =>
    <div key={index} data-message-client-id={`message-${index}`}>
      <PluginUiSlot position="turn.footer" sessionId="task-a" clientId={`message-${index}`} />
    </div>)}
  </PluginUiProvider>);
  await act(async () => {});
  expect(invoke).not.toHaveBeenCalled();
  expect(observe).toHaveBeenCalledTimes(count);
  const visible = [...elements].slice(0, 3);
  const visibility = (intersecting: boolean) => report(visible.map(target => ({ target, isIntersecting: intersecting })) as IntersectionObserverEntry[], {} as IntersectionObserver);
  await act(async () => { visibility(true); });
  expect(host.consumers('planner')).toHaveLength(3);
  expect(invoke).toHaveBeenCalledTimes(1);
  expect(invoke.mock.calls[0][1].entries).toHaveLength(3);
  const documentVisibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
  await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
  expect(host.consumers('planner')).toBeUndefined();
  documentVisibility.mockReturnValue('visible');
  await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
  expect(host.consumers('planner')).toHaveLength(3);
  await act(async () => { host.publish('planner', 'progress', { sessionId: 'task-a', clientId: 'message-0' }, () => ({ title: 'Changed' })); });
  expect(screen.getAllByText('Changed')).toHaveLength(1);
  await act(async () => { visibility(false); });
  expect(host.consumers('planner')).toBeUndefined();
  const build = vi.fn(() => ({ title: 'Offscreen' }));
  host.publish('planner', 'progress', undefined, build);
  expect(build).not.toHaveBeenCalled();
  view.unmount();
  expect(elements.size).toBe(0);
  expect(disconnect).toHaveBeenCalledTimes(1);
});
