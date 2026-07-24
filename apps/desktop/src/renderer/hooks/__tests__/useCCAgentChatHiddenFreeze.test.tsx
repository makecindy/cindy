// @vitest-environment jsdom

import { act, cleanup, render, renderHook, screen, waitFor } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>();
  return {
    ...actual,
    useTranslation: () => ({
      t: (key: string, values?: Record<string, unknown>) =>
        typeof values?.msg === 'string' ? values.msg : key,
    }),
  };
});

vi.mock('@/features/device-link/remoteProjectsStore', () => ({
  remoteProjectsStore: {
    getSessionDeviceId: () => undefined,
    subscribe: vi.fn(() => () => undefined),
    applyPatch: vi.fn(),
  },
  requestRemoteReseed: vi.fn(),
}));

vi.mock('@/lib/makerTransport', () => ({
  makerApiFor: (sessionId: string) => ({
    input: {
      getProjection: vi.fn(async () => ({
        sessionId,
        pendingQueue: [],
        steeringQueueClientIds: [],
        queuePaused: false,
        queueExpanded: false,
        queueInteractionLocks: [],
        queueEditLocks: [],
        queueAbortPending: false,
        error: null,
        errorRetryText: null,
        credentialSwitchWait: null,
      })),
      persistTurnErrorDeferred: vi.fn(async () => undefined),
    },
    getPendingInteractions: vi.fn(async () => []),
  }),
  getSessionFor: vi.fn(async () => ({
    agentKind: 'codex',
    remoteHostId: null,
    sdkSessionId: null,
    fastMode: false,
    planModeEnabled: false,
    contextTokens: 0,
    contextWindow: 0,
    totalCostUsd: 0,
  })),
  listMessagesFor: vi.fn(async () => []),
  aroundMessagesFor: vi.fn(async () => []),
  aroundMessagesByClientIdFor: vi.fn(async () => []),
  dismissErrorMessageFor: vi.fn(async () => undefined),
  isRemoteSession: vi.fn(() => false),
  // useSessionEstimatedValue 的历史初值入口:本套测试全部按本机会话走,直接委托给
  // 下方 messageService mock(既有用例继续用它驱动/断言调用次数)。
  estimatedSessionValueFor: vi.fn(async (sessionId: string) =>
    (await import('@/lib/messageService')).estimatedSessionValue(sessionId)),
}));

vi.mock('@/lib/messageService', () => ({
  list: vi.fn(async () => ({ items: [], hasMore: false, oldestId: null })),
  around: vi.fn(async () => []),
  create: vi.fn(async () => ({}) as unknown),
  updateContent: vi.fn(async () => ({}) as unknown),
  estimatedSessionValue: vi.fn(async () => ({ totalValueUsd: 0, entries: [] })),
}));

vi.mock('@/lib/sessionService', () => ({
  get: vi.fn(async () => ({
    agentKind: 'codex',
    remoteHostId: null,
    sdkSessionId: null,
    fastMode: false,
    planModeEnabled: false,
    contextTokens: 0,
    contextWindow: 0,
    totalCostUsd: 0,
  })),
  update: vi.fn(async () => ({})),
  touchUserSend: vi.fn(async () => ({})),
}));

vi.mock('@/lib/sessionsBus', () => ({
  emitPatch: vi.fn(),
}));

vi.mock('@/lib/userPromptStore', () => ({
  getUserPrompt: () => '',
}));

vi.mock('@/lib/imageRef', () => ({
  parseUserContent: vi.fn((content: string) => ({ text: content, images: [], files: [] })),
  stringifyUserContent: vi.fn((text: string) => text),
}));

vi.mock('@/lib/composerDraftStore', () => ({
  saveDraft: vi.fn(),
  plainTextToTiptapDoc: (text: string) => ({
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
  }),
}));

import { useCCAgentChat } from '@/hooks/useCCAgentChat';
import { useSessionEstimatedValue } from '@/hooks/useSessionEstimatedValue';
import { ChatDisplaySnapshotProvider, type ChatDisplaySnapshot } from '@/components/chat/ChatDisplaySnapshotContext';
import { makerChatStore, type ChatMessage } from '@/lib/makerChatStore';
import * as messageService from '@/lib/messageService';
import { buildTurnUsageDetails } from '../../../shared/turnUsageDetails';

type TurnCostListener = (payload: {
  sessionId: string;
  clientId: string;
  turnCostUsd: number;
  turnCostIsEstimate: boolean;
  turnUsageDetails?: unknown;
}) => void;

type EstimatedValueSnapshot = Awaited<ReturnType<typeof messageService.estimatedSessionValue>>;

const TURN_USAGE_DETAILS = buildTurnUsageDetails({
  inputTokens: 12_000,
  outputTokens: 1_200,
  cacheReadTokens: 0,
  cacheCreateTokens: 0,
  model: 'gpt-5.5',
});
if (!TURN_USAGE_DETAILS) {
  throw new Error('expected test turn usage details to be buildable');
}

function sid(label: string): string {
  return `${label}-${Math.random().toString(36).slice(2, 8)}`;
}

function rendererSource(relativePath: string): string {
  return readFileSync(resolve(__dirname, '..', '..', relativePath), 'utf8');
}

function assistantCostMessage(clientId: string, costUsd: number): ChatMessage {
  return {
    clientId,
    role: 'assistant',
    content: `cost ${costUsd}`,
    createdAt: new Date(0).toISOString(),
    turnCostUsd: costUsd,
    turnCostIsEstimate: true,
    turnUsageDetails: TURN_USAGE_DETAILS,
  } as ChatMessage;
}

function displaySnapshot(
  sessionId: string,
  messages: ChatMessage[],
  options: Partial<Pick<ChatDisplaySnapshot, 'chatRealtime' | 'historyLoaded' | 'hasMoreMessages'>> = {},
): ChatDisplaySnapshot {
  return {
    sessionId,
    chatRealtime: options.chatRealtime ?? false,
    messages,
    historyLoaded: options.historyLoaded ?? true,
    hasMoreMessages: options.hasMoreMessages ?? false,
  };
}

describe('useCCAgentChat hidden chat snapshot freeze', () => {
  const sessionIds: string[] = [];
  let turnCostListener: TurnCostListener | null = null;

  beforeEach(() => {
    vi.mocked(messageService.estimatedSessionValue).mockResolvedValue({ totalValueUsd: 0, entries: [] });
  });

  afterEach(() => {
    cleanup();
    for (const sessionId of sessionIds) {
      makerChatStore.purgeSession(sessionId);
    }
    sessionIds.length = 0;
    vi.restoreAllMocks();
    turnCostListener = null;
    delete (window as unknown as { electronAPI?: unknown }).electronAPI;
  });

  it('freezes heavy messages while hidden, keeps light state live, and restores latest once', async () => {
    const sessionId = sid('hidden-freeze');
    sessionIds.push(sessionId);
    const ensureInitial = vi.spyOn(makerChatStore, 'ensureInitialMessages');
    const loadOlder = vi.spyOn(makerChatStore, 'loadOlderMessages');

    const { result, rerender } = renderHook(
      ({ live }: { live: boolean }) =>
        useCCAgentChat(sessionId, undefined, { chatRealtime: live }),
      { initialProps: { live: true } },
    );

    await waitFor(() => expect(result.current.historyLoaded).toBe(true));
    expect(ensureInitial).toHaveBeenCalledTimes(1);

    act(() => {
      makerChatStore.insertSystemCard(sessionId, 'status', { label: 'visible' });
    });
    expect(result.current.messages).toHaveLength(1);

    rerender({ live: false });
    const frozenMessages = result.current.messages;

    act(() => {
      makerChatStore.insertSystemCard(sessionId, 'status', { label: 'hidden' });
    });
    expect(makerChatStore.getSnapshot(sessionId).messages).toHaveLength(2);
    expect(Object.is(result.current.messages, frozenMessages)).toBe(true);

    act(() => {
      makerChatStore.mirrorSessionFields(sessionId, { fastMode: true });
    });
    expect(result.current.fastMode).toBe(true);
    expect(Object.is(result.current.messages, frozenMessages)).toBe(true);

    rerender({ live: true });
    expect(result.current.messages).toHaveLength(2);
    expect(Object.is(result.current.messages, frozenMessages)).toBe(false);
    expect(ensureInitial).toHaveBeenCalledTimes(1);
    expect(loadOlder).not.toHaveBeenCalled();
  });

  it('keeps chat realtime separate from read visibility and does not remount MessageStream', () => {
    const pluginSource = rendererSource('features/right-sidebar/plugins/orca-workers/index.tsx');
    const panelSource = rendererSource('features/cc-agent/OrcaWorkerPanel.tsx');
    const sessionViewSource = rendererSource('features/cc-agent/CCAgentSessionView.tsx');
    const messageStreamSource = rendererSource('components/chat/MessageStream.tsx');

    expect(pluginSource).toContain(
      'const chatRealtime = Boolean(active && shellVisible && documentVisible);',
    );
    expect(panelSource).toContain('viewVisible={viewVisible}');
    expect(panelSource).toContain('chatRealtime={chatRealtime}');
    expect(sessionViewSource).toContain(
      'useCCAgentChat(sessionId, handleTitleUpdate, { chatRealtime })',
    );
    expect(sessionViewSource).toContain('key={sessionId}');
    expect(messageStreamSource).toContain('if (isNearBottomRef.current) {');
    expect(messageStreamSource).toContain('pinToBottom();');
    expect(messageStreamSource).toContain('if (!programmaticScrollRef.current) {');
  });

  it('keeps session value consumers on the frozen display snapshot while hidden', async () => {
    const sessionId = sid('hidden-consumers');
    sessionIds.push(sessionId);
    (window as unknown as {
      electronAPI: {
        onUsageMessageTurnCost: (cb: TurnCostListener) => () => void;
      };
    }).electronAPI = {
      onUsageMessageTurnCost: (cb: TurnCostListener) => {
        turnCostListener = cb;
        return () => {
          if (turnCostListener === cb) turnCostListener = null;
        };
      },
    };
    const renderCounts = { estimated: 0 };
    const initialSnapshot = displaySnapshot(sessionId, [assistantCostMessage('visible-cost', 1.23)]);
    const latestSnapshot = displaySnapshot(sessionId, [
      assistantCostMessage('visible-cost', 1.23),
      assistantCostMessage('restored-cost', 4.56),
    ]);

    function EstimatedValueProbe() {
      renderCounts.estimated += 1;
      const value = useSessionEstimatedValue(sessionId, true);
      return <div data-testid="estimated-value">{value == null ? '' : value.toFixed(2)}</div>;
    }

    function TestTree({ snapshot }: { snapshot: ChatDisplaySnapshot }) {
      return (
        <ChatDisplaySnapshotProvider value={snapshot}>
          <EstimatedValueProbe />
        </ChatDisplaySnapshotProvider>
      );
    }

    const { rerender } = render(<TestTree snapshot={initialSnapshot} />);
    await waitFor(() => expect(screen.getByTestId('estimated-value').textContent).toBe('1.23'));
    const hiddenEstimatedRenders = renderCounts.estimated;

    act(() => {
      turnCostListener?.({
        sessionId,
        clientId: 'hidden-cost',
        turnCostUsd: 9.99,
        turnCostIsEstimate: true,
        turnUsageDetails: TURN_USAGE_DETAILS,
      });
    });

    expect(renderCounts.estimated).toBe(hiddenEstimatedRenders);
    expect(screen.getByTestId('estimated-value').textContent).toBe('1.23');

    rerender(<TestTree snapshot={latestSnapshot} />);

    await waitFor(() => expect(screen.getByTestId('estimated-value').textContent).toBe('5.79'));
  });

  it('keeps direct turn-cost events live when a realtime display provider is present', async () => {
    const sessionId = sid('visible-provider');
    sessionIds.push(sessionId);
    (window as unknown as {
      electronAPI: {
        onUsageMessageTurnCost: (cb: TurnCostListener) => () => void;
      };
    }).electronAPI = {
      onUsageMessageTurnCost: (cb: TurnCostListener) => {
        turnCostListener = cb;
        return () => {
          if (turnCostListener === cb) turnCostListener = null;
        };
      },
    };
    vi.mocked(messageService.estimatedSessionValue).mockResolvedValue({ totalValueUsd: 0, entries: [] });

    function EstimatedValueProbe() {
      const value = useSessionEstimatedValue(sessionId, true);
      return <div data-testid="estimated-value">{value == null ? '' : value.toFixed(2)}</div>;
    }

    render(
      <ChatDisplaySnapshotProvider
        value={displaySnapshot(sessionId, [], {
          chatRealtime: true,
          historyLoaded: false,
          hasMoreMessages: true,
        })}
      >
        <EstimatedValueProbe />
      </ChatDisplaySnapshotProvider>,
    );

    await waitFor(() => expect(turnCostListener).toBeTruthy());

    act(() => {
      turnCostListener?.({
        sessionId,
        clientId: 'unknown-live-client',
        turnCostUsd: 2.5,
        turnCostIsEstimate: true,
        turnUsageDetails: TURN_USAGE_DETAILS,
      });
    });

    await waitFor(() => expect(screen.getByTestId('estimated-value').textContent).toBe('2.50'));
  });

  it('pauses direct turn-cost events while frozen and refreshes once when realtime resumes', async () => {
    const sessionId = sid('frozen-provider');
    sessionIds.push(sessionId);
    (window as unknown as {
      electronAPI: {
        onUsageMessageTurnCost: (cb: TurnCostListener) => () => void;
      };
    }).electronAPI = {
      onUsageMessageTurnCost: (cb: TurnCostListener) => {
        turnCostListener = cb;
        return () => {
          if (turnCostListener === cb) turnCostListener = null;
        };
      },
    };
    const renderCounts = { estimated: 0 };
    vi.mocked(messageService.estimatedSessionValue)
      .mockResolvedValueOnce({ totalValueUsd: 4.56, entries: [{ clientId: 'hidden-cost', costUsd: 4.56 }] });

    function EstimatedValueProbe({ sessionId: currentSessionId }: { sessionId: string }) {
      renderCounts.estimated += 1;
      const value = useSessionEstimatedValue(currentSessionId, true);
      return <div data-testid="estimated-value">{value == null ? '' : value.toFixed(2)}</div>;
    }

    const { rerender } = render(
      <ChatDisplaySnapshotProvider
        value={displaySnapshot(sessionId, [assistantCostMessage('visible-cost', 1.23)], {
          chatRealtime: false,
        })}
      >
        <EstimatedValueProbe sessionId={sessionId} />
      </ChatDisplaySnapshotProvider>,
    );

    await waitFor(() => expect(screen.getByTestId('estimated-value').textContent).toBe('1.23'));
    const hiddenRenderCount = renderCounts.estimated;
    expect(turnCostListener).toBeNull();

    act(() => {
      turnCostListener?.({
        sessionId,
        clientId: 'hidden-cost',
        turnCostUsd: 9.99,
        turnCostIsEstimate: true,
        turnUsageDetails: TURN_USAGE_DETAILS,
      });
    });

    expect(renderCounts.estimated).toBe(hiddenRenderCount);
    expect(screen.getByTestId('estimated-value').textContent).toBe('1.23');

    rerender(
      <ChatDisplaySnapshotProvider
        value={displaySnapshot(sessionId, [assistantCostMessage('visible-cost', 1.23)], {
          chatRealtime: true,
        })}
      >
        <EstimatedValueProbe sessionId={sessionId} />
      </ChatDisplaySnapshotProvider>,
    );

    await waitFor(() => expect(screen.getByTestId('estimated-value').textContent).toBe('5.79'));
    expect(messageService.estimatedSessionValue).toHaveBeenCalledTimes(1);

    act(() => {
      turnCostListener?.({
        sessionId,
        clientId: 'hidden-cost',
        turnCostUsd: 4.56,
        turnCostIsEstimate: true,
        turnUsageDetails: TURN_USAGE_DETAILS,
      });
    });

    expect(screen.getByTestId('estimated-value').textContent).toBe('5.79');
  });

  it('does not apply cleared or stale async estimated-value entries across display providers', async () => {
    const clearedSessionId = sid('cleared-provider');
    const staleSessionId = sid('stale-provider');
    const nextSessionId = sid('next-provider');
    sessionIds.push(clearedSessionId, staleSessionId, nextSessionId);
    const pendingQueries = new Map<string, (value: EstimatedValueSnapshot) => void>();
    vi.mocked(messageService.estimatedSessionValue).mockImplementation((sessionId: string) =>
      new Promise((resolveQuery) => {
        pendingQueries.set(sessionId, resolveQuery);
      }),
    );
    (window as unknown as {
      electronAPI: {
        onUsageMessageTurnCost: (cb: TurnCostListener) => () => void;
      };
    }).electronAPI = {
      onUsageMessageTurnCost: (cb: TurnCostListener) => {
        turnCostListener = cb;
        return () => {
          if (turnCostListener === cb) turnCostListener = null;
        };
      },
    };

    function EstimatedValueProbe({ sessionId: currentSessionId }: { sessionId: string }) {
      const value = useSessionEstimatedValue(currentSessionId, true);
      return <div data-testid="estimated-value">{value == null ? '' : value.toFixed(2)}</div>;
    }

    const { rerender } = render(
      <ChatDisplaySnapshotProvider
        value={displaySnapshot(clearedSessionId, [], { chatRealtime: true })}
      >
        <EstimatedValueProbe sessionId={clearedSessionId} />
      </ChatDisplaySnapshotProvider>,
    );

    await waitFor(() => expect(turnCostListener).toBeTruthy());
    act(() => {
      turnCostListener?.({
        sessionId: clearedSessionId,
        clientId: 'stale-before-clear',
        turnCostUsd: 6.66,
        turnCostIsEstimate: true,
        turnUsageDetails: TURN_USAGE_DETAILS,
      });
    });
    expect(screen.getByTestId('estimated-value').textContent).toBe('');
    pendingQueries.get(clearedSessionId)?.({ totalValueUsd: 0, entries: [] });

    rerender(
      <ChatDisplaySnapshotProvider
        value={displaySnapshot(staleSessionId, [], {
          chatRealtime: true,
          historyLoaded: false,
          hasMoreMessages: true,
        })}
      >
        <EstimatedValueProbe sessionId={staleSessionId} />
      </ChatDisplaySnapshotProvider>,
    );
    await waitFor(() => expect(pendingQueries.has(staleSessionId)).toBe(true));

    rerender(
      <ChatDisplaySnapshotProvider
        value={displaySnapshot(nextSessionId, [], {
          chatRealtime: true,
          historyLoaded: false,
          hasMoreMessages: true,
        })}
      >
        <EstimatedValueProbe sessionId={nextSessionId} />
      </ChatDisplaySnapshotProvider>,
    );
    await waitFor(() => expect(pendingQueries.has(nextSessionId)).toBe(true));

    act(() => {
      pendingQueries.get(staleSessionId)?.({ totalValueUsd: 7.77, entries: [{ clientId: 'stale-entry', costUsd: 7.77 }] });
    });
    expect(screen.getByTestId('estimated-value').textContent).toBe('');

    act(() => {
      pendingQueries.get(nextSessionId)?.({ totalValueUsd: 3.21, entries: [{ clientId: 'next-entry', costUsd: 3.21 }] });
    });

    await waitFor(() => expect(screen.getByTestId('estimated-value').textContent).toBe('3.21'));
  });
});
