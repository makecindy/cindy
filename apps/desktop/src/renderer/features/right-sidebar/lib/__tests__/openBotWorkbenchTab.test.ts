// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readPanelCollapsedRecord, writePanelCollapsed } from '@/layout/collapsePrefs';
import { setDataOwnerGeneration, __testing as ownerTesting } from '@/contexts/dataOwnerGeneration';
import { _resetStore, addTab, closeTab, ensureHydrated, getBucket, invalidateSessionCaches } from '../../store';
import { routeSidebarCommand } from '../detachedSidebarRouting';
import { ensureBotWorkbenchTab, openBotWorkbenchTab } from '../openBotWorkbenchTab';
import { _resetSidebarCommandsForTests, onRequestRightSidebarVisibility } from '../sidebarCommands';

vi.mock('../detachedSidebarRouting', () => ({ routeSidebarCommand: vi.fn(async () => 'attached') }));

type Row = { id: string; sessionId: string; kind: string; position: number; state: unknown };
// An isolated persistence adapter: exercise the real store, close queue and layout
// storage without reading the installed app's SQLite or localStorage profile.
const rows = new Map<string, Row>();
const active = new Map<string, string | null>();
const ipc = {
  list: vi.fn(async ({ sessionId }: { sessionId: string }) => ({
    tabs: [...rows.values()].filter((row) => row.sessionId === sessionId).sort((a, b) => a.position - b.position),
    activeTabId: active.get(sessionId) ?? null,
  })),
  upsert: vi.fn(async (row: Row) => { rows.set(row.id, row); }),
  close: vi.fn(async ({ id }: { id: string }) => { rows.delete(id); }),
  setActive: vi.fn(async ({ sessionId, id }: { sessionId: string; id: string | null }) => { active.set(sessionId, id); }),
  reorder: vi.fn(async ({ orderedIds }: { orderedIds: string[] }) => {
    orderedIds.forEach((id, position) => { const row = rows.get(id); if (row) rows.set(id, { ...row, position }); });
  }),
};
const visibility = vi.fn();

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

beforeEach(() => {
  _resetStore(); _resetSidebarCommandsForTests(); ownerTesting.reset();
  rows.clear(); active.clear(); localStorage.clear(); vi.clearAllMocks();
  vi.mocked(routeSidebarCommand).mockResolvedValue('attached');
  window.electronAPI = { localDb: { rightSidebarTabs: ipc }, platform: 'darwin' } as unknown as Window['electronAPI'];
  onRequestRightSidebarVisibility(visibility);
});
afterEach(() => { _resetStore(); _resetSidebarCommandsForTests(); ownerTesting.reset(); });

function workbenchId() {
  return getBucket('bot-main').tabs.find((tab) => tab.kind === 'bot-workbench')!.id;
}

describe('bot workbench layout preference', () => {
  it('creates the workbench first and opens only on the first visit', async () => {
    await ensureHydrated('bot-main');
    const files = await addTab('bot-main', 'file-browser');
    await Promise.all([ensureBotWorkbenchTab('bot-main', 'bot-1'), ensureBotWorkbenchTab('bot-main', 'bot-1')]);
    expect(getBucket('bot-main').tabs.map((tab) => tab.kind)).toEqual(['bot-workbench', 'file-browser']);
    expect(ipc.reorder).toHaveBeenCalledWith({ sessionId: 'bot-main', orderedIds: [workbenchId(), files.id] });
    expect(visibility).toHaveBeenCalledOnce();
    expect(visibility).toHaveBeenCalledWith('open', { sessionId: 'bot-main', userInitiated: false });
    expect(readPanelCollapsedRecord('right-tabs', { sessionId: 'bot-main' })).toBe(false);
  });

  it('keeps a closed tab closed while other tabs remain, across cache resets; the header restores it', async () => {
    await ensureBotWorkbenchTab('bot-main', 'bot-1');
    const files = await addTab('bot-main', 'file-browser');
    await closeTab('bot-main', workbenchId());
    visibility.mockClear();
    invalidateSessionCaches();
    await ensureBotWorkbenchTab('bot-main', 'bot-1');
    await ensureHydrated('bot-main');
    expect(getBucket('bot-main').tabs.map((tab) => tab.id)).toEqual([files.id]);
    expect(visibility).not.toHaveBeenCalled();
    // Model a fresh renderer after restart, retaining only durable rows/preferences.
    _resetStore();
    await ensureBotWorkbenchTab('bot-main', 'bot-1');
    await ensureHydrated('bot-main');
    expect(getBucket('bot-main').tabs.map((tab) => tab.id)).toEqual([files.id]);
    await openBotWorkbenchTab('bot-main', 'bot-1');
    expect(getBucket('bot-main').tabs.map((tab) => tab.kind)).toEqual(['bot-workbench', 'file-browser']);
    expect(getBucket('bot-main').activeTabId).toBe(workbenchId());
    expect(visibility).toHaveBeenCalledOnce();
  });

  it('preserves panel/button/shortcut collapse through re-entry and restart, then explicitly reopens', async () => {
    await ensureBotWorkbenchTab('bot-main', 'bot-1');
    const id = workbenchId();
    // All MainLayout close/toggle and detached-close paths use this layout writer.
    writePanelCollapsed('right-tabs', { sessionId: 'bot-main' }, true);
    visibility.mockClear(); _resetStore();
    await ensureBotWorkbenchTab('bot-main', 'bot-1');
    await ensureHydrated('bot-main');
    expect(workbenchId()).toBe(id);
    expect(readPanelCollapsedRecord('right-tabs', { sessionId: 'bot-main' })).toBe(true);
    expect(visibility).not.toHaveBeenCalled();
    await closeTab('bot-main', id);
    _resetStore();
    await ensureBotWorkbenchTab('bot-main', 'bot-1');
    await ensureHydrated('bot-main');
    expect(getBucket('bot-main').tabs).toEqual([]);
    await openBotWorkbenchTab('bot-main', 'bot-1');
    expect(readPanelCollapsedRecord('right-tabs', { sessionId: 'bot-main' })).toBe(false);
    expect(getBucket('bot-main').activeTabId).toBe(workbenchId());
  });

  it.each([true, false])('preserves existing ordinary sidebar preferences (%s) without adding or focusing a tab', async (collapsed) => {
    await ensureHydrated('bot-main');
    const files = await addTab('bot-main', 'file-browser');
    writePanelCollapsed('right-tabs', { sessionId: 'bot-main' }, collapsed);
    await ensureBotWorkbenchTab('bot-main', 'bot-1');
    expect(getBucket('bot-main').activeTabId).toBe(files.id);
    expect(getBucket('bot-main').tabs).toHaveLength(1);
    expect(visibility).not.toHaveBeenCalled();
    await ensureBotWorkbenchTab('other-bot-main', 'bot-2');
    expect(getBucket('other-bot-main').tabs[0]?.kind).toBe('bot-workbench');
  });

  it('restores old tabs without focus or reveal, and remembers them when subsequently closed', async () => {
    await ensureHydrated('bot-main');
    const wb = await addTab('bot-main', 'bot-workbench', { botId: 'bot-1' });
    const files = await addTab('bot-main', 'file-browser');
    invalidateSessionCaches();
    await ensureBotWorkbenchTab('bot-main', 'bot-1');
    expect(getBucket('bot-main').activeTabId).toBe(files.id);
    expect(visibility).not.toHaveBeenCalled();
    await closeTab('bot-main', wb.id);
    _resetStore();
    await ensureBotWorkbenchTab('bot-main', 'bot-1');
    await ensureHydrated('bot-main');
    expect(getBucket('bot-main').tabs.map((tab) => tab.id)).toEqual([files.id]);
  });

  it.each(['close', 'owner-switch', 'unmount'] as const)('does not overwrite %s while hydration is in flight', async (action) => {
    const wait = deferred();
    ipc.list.mockImplementationOnce(async () => { await wait.promise; return { tabs: [], activeTabId: null }; });
    const controller = new AbortController();
    const init = ensureBotWorkbenchTab('bot-main', 'bot-1', controller.signal);
    await vi.waitFor(() => expect(ipc.list).toHaveBeenCalled());
    if (action === 'close') writePanelCollapsed('right-tabs', { sessionId: 'bot-main' }, true);
    if (action === 'owner-switch') { setDataOwnerGeneration('another-owner'); _resetStore(); }
    if (action === 'unmount') controller.abort();
    wait.resolve(); await init;
    expect(ipc.upsert).not.toHaveBeenCalled();
    expect(visibility).not.toHaveBeenCalled();
  });

  it('a close during tab INSERT wins; late completion neither resurrects the tab nor reveals the panel', async () => {
    const wait = deferred();
    ipc.upsert.mockImplementationOnce(async (row) => { await wait.promise; rows.set(row.id, row); });
    const init = ensureBotWorkbenchTab('bot-main', 'bot-1');
    await vi.waitFor(() => expect(ipc.upsert).toHaveBeenCalled());
    const closing = closeTab('bot-main', workbenchId());
    writePanelCollapsed('right-tabs', { sessionId: 'bot-main' }, true);
    visibility.mockClear();
    wait.resolve(); await Promise.all([init, closing]);
    expect(visibility).not.toHaveBeenCalled();
    expect(rows.size).toBe(0);
    _resetStore(); await ensureBotWorkbenchTab('bot-main', 'bot-1'); await ensureHydrated('bot-main');
    expect(getBucket('bot-main').tabs).toEqual([]);
  });

  it.each(['none', 'closed', 'opened'] as const)('failed default creation retries only without a newer user choice (%s)', async (choice) => {
    const wait = deferred();
    ipc.upsert.mockImplementationOnce(async () => { await wait.promise; throw new Error('temporary storage failure'); });
    const init = ensureBotWorkbenchTab('bot-main', 'bot-1');
    const rejected = expect(init).rejects.toThrow('temporary storage failure');
    await vi.waitFor(() => expect(ipc.upsert).toHaveBeenCalled());
    if (choice !== 'none') writePanelCollapsed('right-tabs', { sessionId: 'bot-main' }, choice === 'closed');
    wait.resolve(); await rejected;
    expect(readPanelCollapsedRecord('right-tabs', { sessionId: 'bot-main' })).toBe(choice === 'none' ? null : choice === 'closed');
    expect(visibility).not.toHaveBeenCalled();
    _resetStore(); await ensureBotWorkbenchTab('bot-main', 'bot-1'); await ensureHydrated('bot-main');
    expect(getBucket('bot-main').tabs).toHaveLength(choice === 'none' ? 1 : 0);
    expect(visibility).toHaveBeenCalledTimes(choice === 'none' ? 1 : 0);
  });

  it('routes passive detached first visits without reopening, and skips them after a recorded close', async () => {
    vi.mocked(routeSidebarCommand).mockResolvedValue('queued');
    await ensureBotWorkbenchTab('bot-main', 'bot-1');
    expect(routeSidebarCommand).toHaveBeenCalledWith(
      { type: 'open-bot-workbench-tab', sessionId: 'bot-main', botId: 'bot-1' },
      { allowOpen: false, userInitiated: false },
    );
    expect(ipc.upsert).not.toHaveBeenCalled(); expect(visibility).not.toHaveBeenCalled();
    writePanelCollapsed('right-tabs', { sessionId: 'bot-main' }, true);
    vi.mocked(routeSidebarCommand).mockClear();
    await ensureBotWorkbenchTab('bot-main', 'bot-1');
    expect(routeSidebarCommand).not.toHaveBeenCalled();
    vi.mocked(routeSidebarCommand).mockResolvedValue('routed');
    await openBotWorkbenchTab('bot-main', 'bot-1');
    expect(routeSidebarCommand).toHaveBeenCalledWith({ type: 'open-bot-workbench-tab', sessionId: 'bot-main', botId: 'bot-1', focusTab: true });
    expect(visibility).toHaveBeenCalledWith('open', { sessionId: 'bot-main' });
  });
});
