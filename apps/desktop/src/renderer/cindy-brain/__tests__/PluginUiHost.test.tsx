// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { getDraft, plainTextToTiptapDoc, registerDraftFlush, saveDraft } from '@/lib/composerDraftStore';
import { createComposerDraftSaveScheduler } from '@/lib/composerDraftSaveScheduler';
import { setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import { pluginUiDraftSnapshot, subscribePluginUiDraft } from '../pluginUiContext';
vi.mock('../PluginUiContributions', () => ({ usePluginUiLaunchers: () => [], runPluginUiLauncher: vi.fn() }));
vi.mock('@/features/right-sidebar/lib/openPluginUiView', () => ({ openPluginUiView: vi.fn() }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
import { PluginUiHost } from '../PluginUiHost';

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

it('rejects an old replacement revision after flushing newer typing', async () => {
  const { revision, timers } = draftWithPendingTyping('replace-task');
  render(<PluginUiHost />);
  await act(async () => receive({ requestId: 'replace', ownerStamp: { dataOwnerId: 'owner', ownerGeneration: 1 },
    kind: 'draft', sessionId: 'replace-task', mode: 'replace', text: 'Must not overwrite', revision }));
  expect(getDraft('replace-task')?.text).toEqual(plainTextToTiptapDoc('Latest typing'));
  expect(timers.size).toBe(0);
  expect(invoke).toHaveBeenCalledWith(null, expect.objectContaining({ op: 'host-result', error: 'MCP_APP_DRAFT_CHANGED' }));
});

it('streams the original draft with one in-flight reply and releases the subscription on unwatch', async () => {
  const { timers } = draftWithPendingTyping('watched-task');
  let accept!: () => void;
  invoke.mockImplementationOnce(() => new Promise(resolve => { accept = () => resolve({}); }));
  render(<PluginUiHost />);
  await act(async () => receive({ requestId: 'watch', ownerStamp: { dataOwnerId: 'owner', ownerGeneration: 1 },
    kind: 'draft-watch', sessionId: 'watched-task' }));
  expect(timers.size).toBe(0);
  expect(invoke).toHaveBeenCalledTimes(1);
  expect(invoke).toHaveBeenCalledWith(null, expect.objectContaining({ requestId: 'watch',
    result: expect.objectContaining({ text: plainTextToTiptapDoc('Latest typing') }) }));
  await act(async () => {
    for (let i = 0; i < 1000; i++) saveDraft('watched-task', { text: plainTextToTiptapDoc(`Typing ${i}`), attachments: [] }, { silent: true });
  });
  expect(invoke).toHaveBeenCalledTimes(1);
  await act(async () => accept());
  expect(invoke).toHaveBeenCalledTimes(2);
  expect(invoke).toHaveBeenLastCalledWith(null, expect.objectContaining({ requestId: 'watch',
    result: expect.objectContaining({ text: plainTextToTiptapDoc('Typing 999') }) }));
  await act(async () => receive({ requestId: 'watch', kind: 'draft-unwatch' }));
  await act(async () => saveDraft('watched-task', { text: plainTextToTiptapDoc('After close'), attachments: [] }, { silent: true }));
  expect(invoke).toHaveBeenCalledTimes(2);
});
