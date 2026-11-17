// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react';
import { Editor } from '@tiptap/core';
import Document from '@tiptap/extension-document';
import Paragraph from '@tiptap/extension-paragraph';
import Text from '@tiptap/extension-text';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { getDraft, plainTextToTiptapDoc, registerDraftFlush, saveDraft } from '@/lib/composerDraftStore';
import { createComposerDraftSaveScheduler } from '@/lib/composerDraftSaveScheduler';
import { setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import { pluginUiDraftSnapshot, subscribePluginUiDraft, registerPluginUiDraftEditor, readPluginUiDraftDocument } from '../pluginUiContext';
vi.mock('../PluginUiContributions', () => ({ usePluginUiLaunchers: () => [], runPluginUiLauncher: vi.fn() }));
vi.mock('@/features/right-sidebar/lib/openPluginUiView', () => ({ openPluginUiView: vi.fn() }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
import { PluginUiHost } from '../PluginUiHost';
import { InteractionPromptHost } from '@/components/interaction-portal/InteractionPromptHost';
import { setSlotElement } from '@/components/interaction-portal/store';
import { McpAppPermissionPrompt } from '@/components/chat/McpAppPermissionPrompt';
import { isPluginUiElementVisible } from '../pluginUiVisibility';
const appPermission = vi.hoisted(() => ({ respond: vi.fn(), snapshot: { pendingAppPermissions: [{
  requestId: 'app-approval', toolName: 'save', input: {},
  mcpApp: { clientId: 'app', title: 'Example', serverId: 'plugin', scope: 'view' },
}] } }));
vi.mock('@/lib/makerChatStore', () => ({ makerChatStore: {
  subscribe: () => () => {}, getSnapshot: () => appPermission.snapshot, respondToPermission: appPermission.respond,
} }));

// 生产入口：实际 PluginUiHost、草稿 store 和原输入调度器，仅替换窗口 IPC。
// PR review：120ms 未落库的键入会被追加或旧 revision 覆盖；旧 Host 测试只覆盖 Main。
// 最小输入：先保存旧文档，再排队用户键入，立即收到插件草稿请求。tier: unit。
let receive: (input: unknown) => void;
const invoke = vi.fn(async () => ({}));
const stops: Array<() => void> = [];
beforeEach(() => {
  setDataOwnerGeneration('owner', 1); invoke.mockClear();
  window.electronAPI = { maker: { mcpApps: invoke, onPluginUiAction: (callback: typeof receive) => {
    receive = callback; return () => {};
  } } } as unknown as typeof window.electronAPI;
});
afterEach(() => { cleanup(); stops.splice(0).forEach(stop => stop()); vi.restoreAllMocks(); });

function draftWithPendingTyping(sessionId: string) {
  saveDraft(sessionId, { text: plainTextToTiptapDoc('Saved'), attachments: [] });
  stops.push(subscribePluginUiDraft(sessionId, () => {}));
  const revision = pluginUiDraftSnapshot(sessionId).revision;
  const timers = new Map<number, () => void>();
  const scheduler = createComposerDraftSaveScheduler({
    setTimer: callback => { timers.set(1, callback); return 1; },
    clearTimer: handle => { timers.delete(handle); },
  });
  stops.push(registerDraftFlush(sessionId, () => scheduler.flush()));
  scheduler.schedule(() => saveDraft(sessionId, { text: plainTextToTiptapDoc('Latest typing'), attachments: [] }, { silent: true }));
  return { revision, timers };
}

it('appends after synchronously flushing the pending editor save', async () => {
  const { timers } = draftWithPendingTyping('append-task');
  render(<PluginUiHost />);
  await act(async () => receive({ requestId: 'append', ownerStamp: { dataOwnerId: 'owner', ownerGeneration: 1 },
    kind: 'draft', sessionId: 'append-task', mode: 'append', text: 'Plugin text' }));
  expect(getDraft('append-task')?.text?.content).toEqual([
    ...plainTextToTiptapDoc('Latest typing').content!, ...plainTextToTiptapDoc('Plugin text').content!,
  ]);
  expect(timers.size).toBe(0);
  expect(invoke).toHaveBeenCalledWith(null, expect.objectContaining({ op: 'host-result', error: undefined }));
});

// PR #9496: append/replace bypassed the registered composer's send lock.
// Real Host + store + Tiptap registration; existing selection tests only guarded
// replace-selection. Minimal input: a locked editor and one draft write. Tier: unit.
it.each(['append', 'replace'])('rejects %s while the actual composer is locked for sending', async mode => {
  const sessionId = `send-locked-${mode}`;
  const original = plainTextToTiptapDoc('Message chosen by the user');
  const editor = new Editor({ element: document.createElement('div'), extensions: [Document, Paragraph, Text], content: original });
  let locked = true;
  const release = registerPluginUiDraftEditor(sessionId, editor, () => locked);
  saveDraft(sessionId, { text: original, attachments: [] });
  stops.push(subscribePluginUiDraft(sessionId, () => {}));
  render(<PluginUiHost />);
  const write = () => receive({ requestId: 'send-locked', ownerStamp: { dataOwnerId: 'owner', ownerGeneration: 1 },
    kind: 'draft', sessionId, mode, text: 'Plugin text', revision: pluginUiDraftSnapshot(sessionId).revision });
  try {
    await act(async () => write());
    expect(getDraft(sessionId)?.text).toEqual(original);
    expect(editor.getText()).toBe('Message chosen by the user');
    expect(invoke).toHaveBeenLastCalledWith(null, expect.objectContaining({ error: 'MCP_APP_DRAFT_UNAVAILABLE' }));
    locked = false;
    await act(async () => write());
    expect(getDraft(sessionId)?.text?.content).toEqual(mode === 'append'
      ? [...original.content!, ...plainTextToTiptapDoc('Plugin text').content!]
      : plainTextToTiptapDoc('Plugin text').content);
    expect(invoke).toHaveBeenLastCalledWith(null, expect.objectContaining({ error: undefined }));
  } finally { release(); editor.destroy(); }
});

it('applies and restores layout visibility through the original window command owner', async () => {
  render(<PluginUiHost />);
  await act(async () => receive({ requestId: 'regions', ownerStamp: { dataOwnerId: 'owner', ownerGeneration: 1 },
    kind: 'regions', values: { workspace: true, sidebar: true, header: false, messages: true, composer: false, tools: true, windowControls: true } }));
  expect(document.documentElement.dataset.pluginUiHidden).toBe('header composer');
  await act(async () => receive({ ownerStamp: { dataOwnerId: 'owner', ownerGeneration: 1 }, kind: 'regions-sync',
    values: { workspace: true, sidebar: true, header: true, messages: true, composer: true, tools: true, windowControls: true } }));
  expect(document.documentElement.dataset.pluginUiHidden).toBeUndefined();
});

it('keeps approval prompts inline when their preferred tool region is hidden', async () => {
  const slot = document.createElement('div');
  slot.dataset.pluginUiElement = 'tools'; document.body.append(slot); setSlotElement(slot);
  try {
    const view = render(<><PluginUiHost /><InteractionPromptHost hasInteraction><span>Approval required</span></InteractionPromptHost></>);
    expect(slot.textContent).toBe('Approval required');
    await act(async () => receive({ requestId: 'hide-tools', ownerStamp: { dataOwnerId: 'owner', ownerGeneration: 1 },
      kind: 'regions', values: { workspace: true, sidebar: true, header: true, messages: true, composer: true, tools: false, windowControls: true } }));
    expect(slot.textContent).toBe('');
    expect(view.container.textContent).toBe('Approval required');
  } finally { await act(async () => setSlotElement(null)); slot.remove(); }
});

// PR #9496: workspace hiding retained generic prompts but hid the floating App
// approval. The real prompt must remain visible and answer the original request. tier: unit.
it('keeps floating MCP Apps approval visible when the workspace is hidden', async () => {
  const view = render(<><PluginUiHost /><div data-plugin-ui-element="workspace"><McpAppPermissionPrompt sessionId="approval-task" floating /></div></>);
  await act(async () => receive({ requestId: 'hide-workspace', ownerStamp: { dataOwnerId: 'owner', ownerGeneration: 1 },
    kind: 'regions', values: { workspace: false, sidebar: true, header: true, messages: true, composer: true, tools: true, windowControls: true } }));
  const prompt = view.getByRole('region', { name: 'mcpApps.awaitingApproval' });
  expect(isPluginUiElementVisible(prompt)).toBe(true);
  await act(async () => view.getByRole('button', { name: 'agentIsland.native.allowOnce' }).click());
  expect(appPermission.respond).toHaveBeenCalledWith('approval-task', { behavior: 'allow' }, 'app-approval');
});

// 能力对齐：原版支持替换选区；完整草稿替换不能替代它。真实 Tiptap 编辑器验证文本边界，
// 并验证无页面需求不监听选区、选区变化撤销旧 revision、关闭后释放。tier: unit。
it('replaces only the current editor selection and observes selection changes only while a View consumes them', async () => {
  const sessionId = 'selection-task';
  const editor = new Editor({ element: document.createElement('div'), extensions: [Document, Paragraph, Text],
    content: plainTextToTiptapDoc('Before target after') });
  const on = vi.spyOn(editor, 'on'), off = vi.spyOn(editor, 'off');
  const release = registerPluginUiDraftEditor(sessionId, editor, () => false);
  const scheduler = createComposerDraftSaveScheduler();
  try {
    expect(on).not.toHaveBeenCalled();
    saveDraft(sessionId, { text: editor.getJSON(), attachments: [] });
    editor.on('update', () => scheduler.schedule(() => saveDraft(sessionId, { text: editor.getJSON(), attachments: [] }, { silent: true })));
    stops.push(registerDraftFlush(sessionId, () => scheduler.flush()));
    editor.commands.setTextSelection({ from: 8, to: 14 });
    const stop = subscribePluginUiDraft(sessionId, () => {});
    stops.push(stop);
    expect(on).toHaveBeenCalledWith('selectionUpdate', expect.any(Function));
    const before = pluginUiDraftSnapshot(sessionId);
    expect(before.selection).toMatchObject({ text: 'target', from: 8, to: 14 });
    render(<PluginUiHost />);
    await act(async () => receive({ requestId: 'selection', ownerStamp: { dataOwnerId: 'owner', ownerGeneration: 1 },
      kind: 'draft', sessionId, mode: 'replace-selection', text: 'changed', revision: before.revision }));
    expect(invoke).toHaveBeenLastCalledWith(null, expect.objectContaining({ requestId: 'selection', error: undefined }));
    expect(editor.getText()).toBe('Before changed after');
    expect(getDraft(sessionId)?.text).toEqual(editor.getJSON());
    const current = pluginUiDraftSnapshot(sessionId);
    editor.commands.setTextSelection({ from: 1, to: 7 });
    await act(async () => receive({ requestId: 'stale-selection', ownerStamp: { dataOwnerId: 'owner', ownerGeneration: 1 },
      kind: 'draft', sessionId, mode: 'replace-selection', text: 'Must not overwrite', revision: current.revision }));
    expect(editor.getText()).toBe('Before changed after');
    expect(invoke).toHaveBeenLastCalledWith(null, expect.objectContaining({ error: 'MCP_APP_DRAFT_CHANGED' }));
    stop(); stops.pop();
    expect(off).toHaveBeenCalledWith('selectionUpdate', expect.any(Function));
  } finally { scheduler.cancel(); release(); editor.destroy(); }
});

it('rejects an old replacement revision after flushing newer typing', async () => {
  const { revision, timers } = draftWithPendingTyping('replace-task');
  render(<PluginUiHost />);
  await act(async () => receive({ requestId: 'replace', ownerStamp: { dataOwnerId: 'owner', ownerGeneration: 1 },
    kind: 'draft', sessionId: 'replace-task', mode: 'replace', text: 'Must not overwrite', revision }));
  expect(getDraft('replace-task')?.text).toEqual(plainTextToTiptapDoc('Latest typing'));
  expect(timers.size).toBe(0);
  expect(invoke).toHaveBeenCalledWith(null, expect.objectContaining({ op: 'host-result', error: 'MCP_APP_DRAFT_CHANGED' }));
});

it('keeps the mounted editor registered across a same-owner projection refresh', () => {
  const editor = new Editor({ element: document.createElement('div'), extensions: [Document, Paragraph, Text],
    content: plainTextToTiptapDoc('Selected text') });
  const release = registerPluginUiDraftEditor('owner-refresh-task', editor, () => false);
  try {
    editor.commands.setTextSelection({ from: 1, to: 9 });
    expect(pluginUiDraftSnapshot('owner-refresh-task').selection?.text).toBe('Selected');
    setDataOwnerGeneration('owner', 2);
    expect(pluginUiDraftSnapshot('owner-refresh-task').selection?.text).toBe('Selected');
    setDataOwnerGeneration('other-owner', 3);
    expect(pluginUiDraftSnapshot('owner-refresh-task').selection).toBeNull();
  } finally { release(); editor.destroy(); }
});

// Opus F1：140 万中文字符的粘贴草稿使上下文超过 4MB；旧覆盖只验证选区更新。
// 真实草稿 store 与 Host，只替换 IPC，观察订阅载荷预算而不限制原文长度。tier: unit。
it('keeps a large draft out of subscription notifications', async () => {
  const text = plainTextToTiptapDoc('中'.repeat(1_400_000));
  saveDraft('large-draft', { text, attachments: [] });
  render(<PluginUiHost />);
  await act(async () => receive({ requestId: 'large-watch', ownerStamp: { dataOwnerId: 'owner', ownerGeneration: 1 },
    kind: 'draft-watch', sessionId: 'large-draft' }));
  const reply = invoke.mock.calls[0] as unknown as [null, { result: Record<string, unknown> }];
  expect(Buffer.byteLength(JSON.stringify(reply[1]))).toBeLessThan(6_000);
  expect(reply[1].result).not.toHaveProperty('text');
  const revision = reply[1].result.revision, parts: string[] = [];
  let offset: number | null = 0;
  do {
    await act(async () => receive({ requestId: 'read', ownerStamp: { dataOwnerId: 'owner', ownerGeneration: 1 },
      kind: 'draft-read', sessionId: 'large-draft', revision, offset }));
    const read = invoke.mock.calls.at(-1) as unknown as [null, { result: { chunk: string; nextOffset: number | null } }];
    expect(Buffer.byteLength(JSON.stringify(read[1]))).toBeLessThan(1_000_000);
    parts.push(read[1].result.chunk); offset = read[1].result.nextOffset;
  } while (offset !== null);
  expect(JSON.parse(parts.join(''))).toEqual(text);
  await act(async () => saveDraft('large-draft', { text: plainTextToTiptapDoc('New input'), attachments: [] }, { silent: true }));
  await act(async () => receive({ requestId: 'stale-read', ownerStamp: { dataOwnerId: 'owner', ownerGeneration: 1 },
    kind: 'draft-read', sessionId: 'large-draft', revision, offset: 128000 }));
  expect(invoke).toHaveBeenLastCalledWith(null, expect.objectContaining({ error: 'MCP_APP_DRAFT_CHANGED' }));
});

it('notifies draft revisions with one in-flight reply, keeps document reads current, and releases on unwatch', async () => {
  const { timers } = draftWithPendingTyping('watched-task');
  let accept!: () => void;
  invoke.mockImplementationOnce(() => new Promise(resolve => { accept = () => resolve({}); }));
  render(<PluginUiHost />);
  await act(async () => receive({ requestId: 'watch', ownerStamp: { dataOwnerId: 'owner', ownerGeneration: 1 },
    kind: 'draft-watch', sessionId: 'watched-task' }));
  expect(timers.size).toBe(0);
  expect(invoke).toHaveBeenCalledTimes(1);
  expect(invoke).toHaveBeenCalledWith(null, expect.objectContaining({ requestId: 'watch',
    result: { revision: expect.any(String), selection: null } }));
  expect(JSON.parse(readPluginUiDraftDocument('watched-task').chunk)).toEqual(plainTextToTiptapDoc('Latest typing'));
  await act(async () => {
    for (let i = 0; i < 1000; i++) saveDraft('watched-task', { text: plainTextToTiptapDoc(`Typing ${i}`), attachments: [] }, { silent: true });
  });
  expect(invoke).toHaveBeenCalledTimes(1);
  await act(async () => accept());
  expect(invoke).toHaveBeenCalledTimes(2);
  expect(invoke).toHaveBeenLastCalledWith(null, expect.objectContaining({ requestId: 'watch',
    result: { revision: expect.any(String), selection: null } }));
  expect(JSON.parse(readPluginUiDraftDocument('watched-task').chunk)).toEqual(plainTextToTiptapDoc('Typing 999'));
  await act(async () => receive({ requestId: 'watch', kind: 'draft-unwatch' }));
  await act(async () => saveDraft('watched-task', { text: plainTextToTiptapDoc('After close'), attachments: [] }, { silent: true }));
  expect(invoke).toHaveBeenCalledTimes(2);
});

// 本轮选区监听回归：原用例只测同步突发合并，未覆盖分散的光标/选区变化。
// 真实编辑器和 Host 入口、20 万字符输入：空光标移动零 IPC，真实选区仅传小更新；tier: unit。
it.each([1, 3])('avoids full draft transfers for caret and selection changes with %i visible Views', async consumers => {
  const sessionId = `selection-cost-${consumers}`;
  const text = plainTextToTiptapDoc('x'.repeat(200_000));
  saveDraft(sessionId, { text, attachments: [] });
  const editor = new Editor({ element: document.createElement('div'), extensions: [Document, Paragraph, Text], content: text });
  const release = registerPluginUiDraftEditor(sessionId, editor, () => false);
  render(<PluginUiHost />);
  const ownerStamp = { dataOwnerId: 'owner', ownerGeneration: 1 };
  try {
    await act(async () => editor.commands.setTextSelection(2));
    expect(invoke).not.toHaveBeenCalled();
    for (let id = 0; id < consumers; id++) await act(async () => receive({
      kind: 'draft-watch', sessionId, ownerStamp, requestId: `selection-cost-${id}`,
    }));
    expect(invoke).toHaveBeenCalledTimes(consumers);
    invoke.mockClear();
    for (let move = 3; move < 23; move++) await act(async () => editor.commands.setTextSelection(move));
    expect(invoke).not.toHaveBeenCalled();
    for (let move = 1; move <= 20; move++) await act(async () => editor.commands.setTextSelection({ from: move, to: move + 4 }));
    expect(invoke).toHaveBeenCalledTimes(20 * consumers);
    const calls = invoke.mock.calls as unknown as Array<[null, { result: Record<string, unknown> }]>;
    for (const [, reply] of calls) {
      expect(reply.result).not.toHaveProperty('text');
      expect(reply.result.selection).toMatchObject({ text: 'xxxx' });
    }
    expect(calls.reduce((bytes, [, reply]) => bytes + Buffer.byteLength(JSON.stringify(reply)), 0)).toBeLessThan(6_000 * consumers);
    invoke.mockClear();
    const updated = plainTextToTiptapDoc('Changed');
    await act(async () => saveDraft(sessionId, { text: updated, attachments: [] }, { silent: true }));
    expect(invoke).toHaveBeenCalledTimes(consumers);
    expect(invoke).toHaveBeenLastCalledWith(null, expect.objectContaining({ result: expect.not.objectContaining({ text: expect.anything() }) }));
    expect(JSON.parse(readPluginUiDraftDocument(sessionId).chunk)).toEqual(updated);
    invoke.mockClear();
    await act(async () => editor.commands.setTextSelection(24));
    expect(invoke).toHaveBeenCalledTimes(consumers);
    expect(invoke).toHaveBeenLastCalledWith(null, expect.objectContaining({ result: expect.objectContaining({ selection: null }) }));
    for (let id = 0; id < consumers; id++) await act(async () => receive({ kind: 'draft-unwatch', requestId: `selection-cost-${id}` }));
    invoke.mockClear();
    await act(async () => editor.commands.setTextSelection({ from: 2, to: 6 }));
    expect(invoke).not.toHaveBeenCalled();
  } finally { release(); editor.destroy(); }
});
