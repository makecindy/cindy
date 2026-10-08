// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  bucket: {
    tabs: [] as Array<{ id: string; kind: string; state: unknown }>,
    activeTabId: null as string | null,
  },
}));

vi.mock('../../store', () => ({
  ensureHydrated: vi.fn(async () => undefined),
  getBucket: vi.fn(() => mocks.bucket),
  addTab: vi.fn(async (_sessionId: string, kind: string, state: unknown) => {
    const tab = { id: 'workbench-new', kind, state };
    mocks.bucket.tabs = [...mocks.bucket.tabs, tab];
    mocks.bucket.activeTabId = tab.id;
    return tab;
  }),
  reorderTabs: vi.fn(async () => undefined),
}));
vi.mock('../detachedSidebarRouting', () => ({
  routeSidebarCommand: vi.fn(async () => 'attached'),
}));
vi.mock('../sidebarCommands', () => ({
  requestRightSidebarVisibility: vi.fn(),
}));

import { addTab, reorderTabs } from '../../store';
import { routeSidebarCommand } from '../detachedSidebarRouting';
import { ensureBotWorkbenchTab } from '../openBotWorkbenchTab';
import { requestRightSidebarVisibility } from '../sidebarCommands';

describe('ensureBotWorkbenchTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.bucket.tabs = [];
    mocks.bucket.activeTabId = null;
    vi.mocked(routeSidebarCommand).mockResolvedValue('attached');
  });

  it('creates the workbench first and opens the sidebar on the first visit', async () => {
    mocks.bucket.tabs = [{ id: 'files', kind: 'file-browser', state: null }];
    await ensureBotWorkbenchTab('bot-main', 'bot-1');
    expect(routeSidebarCommand).toHaveBeenCalledWith(
      { type: 'open-bot-workbench-tab', sessionId: 'bot-main', botId: 'bot-1' },
      { allowOpen: false, userInitiated: false },
    );
    expect(addTab).toHaveBeenCalledWith('bot-main', 'bot-workbench', { botId: 'bot-1' });
    expect(reorderTabs).toHaveBeenCalledWith('bot-main', ['workbench-new', 'files']);
    expect(requestRightSidebarVisibility).toHaveBeenCalledWith('open', {
      sessionId: 'bot-main',
      userInitiated: false,
    });
  });

  it('leaves an existing workbench and the user sidebar choice alone', async () => {
    mocks.bucket.tabs = [{ id: 'wb', kind: 'bot-workbench', state: { botId: 'bot-1' } }];
    await ensureBotWorkbenchTab('bot-main', 'bot-1');
    expect(addTab).not.toHaveBeenCalled();
    expect(requestRightSidebarVisibility).not.toHaveBeenCalled();
  });

  it('lets a detached sidebar window handle it without popping the window open', async () => {
    vi.mocked(routeSidebarCommand).mockResolvedValue('routed');
    await ensureBotWorkbenchTab('bot-main', 'bot-1');
    expect(addTab).not.toHaveBeenCalled();
    expect(requestRightSidebarVisibility).not.toHaveBeenCalled();
  });
});
