// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  sendCommand: vi.fn(
    async (): Promise<'attached' | 'routed' | 'queued' | 'stale-context'> => 'attached',
  ),
}));

vi.mock('@/lib/sidebarWindow', () => ({
  isSidebarWindow: () => false,
}));

import {
  _resetSidebarCommandsForTests,
  onRequestRightSidebarVisibility,
} from '../../../lib/sidebarCommands';
import { _resetStore, addTab, getBucket, setActiveTab } from '../../../store';
import {
  clearOrcaWorkersSelectionIntent,
  closeOrcaWorkersTabAfterTeamEnd,
  consumeOrcaWorkersFocusHint,
  consumeOrcaWorkersSearchJump,
  ensureOrcaWorkersTab,
  hydrateOrcaWorkersState,
  revealOrcaWorkersTab,
} from '../actions';

vi.mock('@/features/device-link/remoteProjectsStore', () => ({
  getSessionDeviceId: () => undefined,
}));

const tabsIpc = {
  list: vi.fn(async () => ({ tabs: [], activeTabId: null })),
  upsert: vi.fn(async () => ({ ok: true })),
  close: vi.fn(async () => ({ ok: true })),
  setActive: vi.fn(async () => ({ ok: true })),
  reorder: vi.fn(async () => ({ ok: true })),
};

function installElectronApi(): void {
  (
    window as unknown as {
      electronAPI: {
        localDb: { rightSidebarTabs: typeof tabsIpc };
        platform: string;
        rightSidebarWindow: {
          sendCommand: typeof mocks.sendCommand;
        };
      };
    }
  ).electronAPI = {
    localDb: { rightSidebarTabs: tabsIpc },
    platform: 'darwin',
    rightSidebarWindow: {
      sendCommand: mocks.sendCommand,
    },
  };
}

describe('orca-workers tab actions', () => {
  beforeEach(() => {
    _resetStore();
    _resetSidebarCommandsForTests();
    vi.clearAllMocks();
    mocks.sendCommand.mockResolvedValue('attached');
    installElectronApi();
  });

  afterEach(() => {
    _resetStore();
    _resetSidebarCommandsForTests();
    delete (window as unknown as { electronAPI?: unknown }).electronAPI;
  });

  it('ensure keeps an existing collaboration tab without opening the sidebar or stealing active tab', async () => {
    const requests: unknown[] = [];
    const off = onRequestRightSidebarVisibility((visibility, opts) => {
      requests.push({ visibility, opts });
    });
    const review = await addTab('s1', 'review', {});
    await addTab('s1', 'orca-workers', {});
    await setActiveTab('s1', review.id);
    tabsIpc.setActive.mockClear();

    await ensureOrcaWorkersTab('s1');

    expect(getBucket('s1').activeTabId).toBe(review.id);
    expect(requests).toEqual([]);
    expect(tabsIpc.setActive).not.toHaveBeenCalled();
    off();
  });

  it('reveal focuses the singleton collaboration tab and opens the sidebar', async () => {
    const requests: unknown[] = [];
    const off = onRequestRightSidebarVisibility((visibility, opts) => {
      requests.push({ visibility, opts });
    });
    const review = await addTab('s1', 'review', {});
    const orca = await addTab('s1', 'orca-workers', {});
    await setActiveTab('s1', review.id);

    await revealOrcaWorkersTab('s1');

    expect(getBucket('s1').activeTabId).toBe(orca.id);
    expect(requests).toEqual([{ visibility: 'open', opts: { sessionId: 's1' } }]);
    off();
  });

  it('reveal can request an instant sidebar open without priming animation', async () => {
    const requests: unknown[] = [];
    const off = onRequestRightSidebarVisibility((visibility, opts) => {
      requests.push({ visibility, opts });
    });

    await revealOrcaWorkersTab('s1', { animate: false });

    expect(requests).toEqual([{ visibility: 'open', opts: { sessionId: 's1', animate: false } }]);
    off();
  });

  it('patches a worker focus hint into the singleton tab state', async () => {
    await ensureOrcaWorkersTab('s1', { focusWorkerSessionId: 'worker-a' });
    const tab = getBucket('s1').tabs.find((candidate) => candidate.kind === 'orca-workers');

    expect(tab?.state).toEqual({
      focusWorkerSessionId: 'worker-a',
      focusWorkerHintRevision: 1,
    });
  });

  it('clears an existing worker focus hint only when null is explicitly passed', async () => {
    await ensureOrcaWorkersTab('s1', { focusWorkerSessionId: 'worker-a' });
    await ensureOrcaWorkersTab('s1');
    let tab = getBucket('s1').tabs.find((candidate) => candidate.kind === 'orca-workers');

    expect(tab?.state).toEqual({
      focusWorkerSessionId: 'worker-a',
      focusWorkerHintRevision: 1,
    });

    await ensureOrcaWorkersTab('s1', { focusWorkerSessionId: null });
    tab = getBucket('s1').tabs.find((candidate) => candidate.kind === 'orca-workers');

    expect(tab?.state).toEqual({
      focusWorkerSessionId: null,
      focusWorkerHintRevision: 2,
      searchJump: null,
    });
  });

  it('hydrates an explicit null hint without losing its revision', () => {
    expect(
      hydrateOrcaWorkersState({
        focusWorkerSessionId: null,
        focusWorkerHintRevision: 3,
        searchJump: null,
      }),
    ).toEqual({
      focusWorkerSessionId: null,
      focusWorkerHintRevision: 3,
      searchJump: null,
    });
  });

  it('assigns a consumable revision to legacy persisted string hints', () => {
    expect(hydrateOrcaWorkersState({ focusWorkerSessionId: 'worker-a' })).toEqual({
      focusWorkerSessionId: 'worker-a',
      focusWorkerHintRevision: 1,
    });
  });

  it('does not let consumed clears from an old revision overwrite a newer intent', async () => {
    const jumpA = {
      kind: 'conversation-search' as const,
      sessionId: 'worker-a',
      messageId: 'a',
      messageClientId: 'a',
    };
    await ensureOrcaWorkersTab('s1', {
      focusWorkerSessionId: 'worker-a',
      searchJump: jumpA,
    });
    const tab = getBucket('s1').tabs.find((candidate) => candidate.kind === 'orca-workers');
    if (!tab) throw new Error('missing orca tab');

    await ensureOrcaWorkersTab('s1', {
      focusWorkerSessionId: 'worker-b',
      searchJump: {
        kind: 'conversation-search',
        sessionId: 'worker-b',
        messageId: 'b',
        messageClientId: 'b',
      },
    });
    await consumeOrcaWorkersFocusHint('s1', tab.id, 1);
    await consumeOrcaWorkersSearchJump('s1', tab.id, 1);

    expect(getBucket('s1').tabs.find((candidate) => candidate.id === tab.id)?.state).toEqual({
      focusWorkerSessionId: 'worker-b',
      focusWorkerHintRevision: 2,
      searchJump: {
        kind: 'conversation-search',
        sessionId: 'worker-b',
        messageId: 'b',
        messageIdKind: 'id',
        messageClientId: 'b',
      },
    });
  });

  it('persists a worker message-location intent with the focus hint', async () => {
    const searchJump = {
      kind: 'conversation-search' as const,
      sessionId: 'worker-a',
      messageId: 'message-1',
      messageIdKind: 'clientId' as const,
      messageClientId: 'message-1',
    };

    await ensureOrcaWorkersTab('s1', {
      focusWorkerSessionId: 'worker-a',
      searchJump,
    });
    const tab = getBucket('s1').tabs.find((candidate) => candidate.kind === 'orca-workers');

    expect(tab?.state).toEqual({
      focusWorkerSessionId: 'worker-a',
      focusWorkerHintRevision: 1,
      searchJump,
    });
  });

  it('increments the intent revision for search-only updates and only once for combined updates', async () => {
    const jumpA = {
      kind: 'conversation-search' as const,
      sessionId: 'worker-a',
      messageId: 'message-a',
      messageClientId: 'message-a',
    };
    const jumpB = {
      ...jumpA,
      sessionId: 'worker-b',
      messageId: 'message-b',
      messageClientId: 'message-b',
    };

    await ensureOrcaWorkersTab('s1', { searchJump: jumpA });
    await ensureOrcaWorkersTab('s1', {
      focusWorkerSessionId: 'worker-a',
      searchJump: jumpB,
    });
    const tab = getBucket('s1').tabs.find((candidate) => candidate.kind === 'orca-workers');

    expect(tab?.state).toMatchObject({
      focusWorkerSessionId: 'worker-a',
      focusWorkerHintRevision: 2,
      searchJump: {
        messageId: 'message-b',
      },
    });
  });

  it('does not let an old search consumer clear a newer search-only intent', async () => {
    const jumpA = {
      kind: 'conversation-search' as const,
      sessionId: 'worker-a',
      messageId: 'message-a',
      messageClientId: 'message-a',
    };
    const jumpB = {
      ...jumpA,
      sessionId: 'worker-b',
      messageId: 'message-b',
      messageClientId: 'message-b',
    };
    await ensureOrcaWorkersTab('s1', {
      focusWorkerSessionId: 'worker-a',
      searchJump: jumpA,
    });
    const tab = getBucket('s1').tabs.find((candidate) => candidate.kind === 'orca-workers');
    if (!tab) throw new Error('missing orca tab');

    await ensureOrcaWorkersTab('s1', { searchJump: jumpB });
    await consumeOrcaWorkersSearchJump('s1', tab.id, 1);

    expect(getBucket('s1').tabs.find((candidate) => candidate.id === tab.id)?.state).toMatchObject({
      focusWorkerSessionId: 'worker-b',
      focusWorkerHintRevision: 2,
      searchJump: { messageId: 'message-b' },
    });
  });

  it('atomically clears focus and search jump when the user switches workers', async () => {
    await ensureOrcaWorkersTab('s1', {
      focusWorkerSessionId: 'worker-b',
      searchJump: {
        kind: 'conversation-search',
        sessionId: 'worker-b',
        messageId: 'message-b',
        messageClientId: 'message-b',
      },
    });
    const tab = getBucket('s1').tabs.find((candidate) => candidate.kind === 'orca-workers');
    if (!tab) throw new Error('missing orca tab');

    await clearOrcaWorkersSelectionIntent('s1', tab.id, 1);
    await consumeOrcaWorkersSearchJump('s1', tab.id, 1);

    expect(getBucket('s1').tabs.find((candidate) => candidate.id === tab.id)?.state).toEqual({
      focusWorkerSessionId: null,
      focusWorkerHintRevision: 1,
      searchJump: null,
    });
  });

  it('routes ensure to the detached sidebar window when it is already open', async () => {
    mocks.sendCommand.mockResolvedValueOnce('routed');

    await ensureOrcaWorkersTab('s1', { focusWorkerSessionId: 'worker-a' });

    expect(mocks.sendCommand).toHaveBeenCalledWith({
      command: {
        type: 'ensure-orca-workers-tab',
        sessionId: 's1',
        focusWorkerSessionId: 'worker-a',
        focusTab: false,
      },
      allowOpen: false,
      userInitiated: true,
    });
    expect(getBucket('s1').tabs).toEqual([]);
    expect(tabsIpc.upsert).not.toHaveBeenCalled();
  });

  it('forwards worker message-location intent to the detached sidebar host', async () => {
    mocks.sendCommand.mockResolvedValueOnce('routed');
    const searchJump = {
      kind: 'conversation-search' as const,
      sessionId: 'worker-a',
      messageId: 'message-a',
      messageIdKind: 'clientId' as const,
      messageClientId: 'message-a',
    };

    await revealOrcaWorkersTab('s1', {
      focusWorkerSessionId: 'worker-a',
      searchJump,
    });

    expect(mocks.sendCommand).toHaveBeenCalledWith({
      command: {
        type: 'ensure-orca-workers-tab',
        sessionId: 's1',
        focusWorkerSessionId: 'worker-a',
        searchJump,
        focusTab: true,
      },
      allowOpen: true,
      userInitiated: true,
    });
  });

  it('preserves missing vs explicit null worker focus hints across detached commands', async () => {
    mocks.sendCommand.mockResolvedValue('routed');

    await ensureOrcaWorkersTab('s1');
    await ensureOrcaWorkersTab('s1', { focusWorkerSessionId: null });

    expect(mocks.sendCommand).toHaveBeenNthCalledWith(1, {
      command: { type: 'ensure-orca-workers-tab', sessionId: 's1', focusTab: false },
      allowOpen: false,
      userInitiated: true,
    });
    expect(mocks.sendCommand).toHaveBeenNthCalledWith(2, {
      command: {
        type: 'ensure-orca-workers-tab',
        sessionId: 's1',
        focusWorkerSessionId: null,
        focusTab: false,
      },
      allowOpen: false,
      userInitiated: true,
    });
  });

  it('routes reveal to the detached sidebar window even when the window is currently closed', async () => {
    const requests: unknown[] = [];
    const off = onRequestRightSidebarVisibility((visibility, opts) => {
      requests.push({ visibility, opts });
    });
    mocks.sendCommand.mockResolvedValueOnce('routed');

    await expect(
      revealOrcaWorkersTab('s1', { focusWorkerSessionId: 'worker-a' }),
    ).resolves.toBe('routed');

    expect(mocks.sendCommand).toHaveBeenCalledWith({
      command: {
        type: 'ensure-orca-workers-tab',
        sessionId: 's1',
        focusWorkerSessionId: 'worker-a',
        focusTab: true,
      },
      allowOpen: true,
      userInitiated: true,
    });
    expect(requests).toEqual([{ visibility: 'open', opts: { sessionId: 's1' } }]);
    expect(getBucket('s1').tabs).toEqual([]);
    off();
  });

  it('routes close to the detached sidebar window when it is open', async () => {
    mocks.sendCommand.mockResolvedValueOnce('routed');

    await closeOrcaWorkersTabAfterTeamEnd('s1');

    expect(mocks.sendCommand).toHaveBeenCalledWith({
      command: { type: 'close-orca-workers-tab', sessionId: 's1' },
      allowOpen: false,
      userInitiated: true,
    });
    expect(tabsIpc.close).not.toHaveBeenCalled();
  });

  it.each(['queued', 'stale-context'] as const)(
    'does not fall back to the local bucket or reveal for %s',
    async (routeResult) => {
      const requests: unknown[] = [];
      const off = onRequestRightSidebarVisibility((visibility, opts) => {
        requests.push({ visibility, opts });
      });
      mocks.sendCommand.mockResolvedValueOnce(routeResult);

      await expect(
        revealOrcaWorkersTab('s1', { focusWorkerSessionId: 'worker-a' }),
      ).resolves.toBe(routeResult);

      expect(getBucket('s1').tabs).toEqual([]);
      expect(tabsIpc.upsert).not.toHaveBeenCalled();
      expect(requests).toEqual([]);
      off();
    },
  );
});
