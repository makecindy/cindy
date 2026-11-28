/**
 * makerChatStoreThinkingDeltaBatching.test.ts
 * ---------------------------------------------------------------------------
 * Regression (P0-4.3): `thinking` `stage: 'delta'` events must be coalesced on
 * the same 32ms batching path as `text` deltas while strictly preserving event
 * ordering against `thinking` `final`/`start`, `text` deltas, and `done`.
 *
 * Production entry: `makerChatStore.initGlobalListeners()` via `maker.onEvent`.
 * Coverage gap: `makerChatStoreTextDeltaBatching.test.ts` covered `text` deltas
 * only; `thinking` deltas bypassed batching and copied `state.messages` per token.
 * Minimal input: burst of `thinking` delta events within 32ms, followed by timer
 * flush, block switch, interleaved `text` delta, and `thinking` `final`.
 * Tier: unit.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/messageService', () => ({
  list: vi.fn(async () => []),
  create: vi.fn(async () => ({}) as unknown),
  updateContent: vi.fn(async () => ({}) as unknown),
  dismissError: vi.fn(async () => ({}) as unknown),
}));

vi.mock('@/lib/sessionService', () => ({
  get: vi.fn(async () => ({
    agentKind: 'claude-code',
    remoteHostId: null,
    sdkSessionId: null,
    fastMode: false,
    contextTokens: 0,
    contextWindow: 0,
    totalCostUsd: 0,
  })),
  update: vi.fn(async () => ({})),
  touchUserSend: vi.fn(async () => ({})),
}));

vi.mock('@/lib/sessionsBus', () => ({ emitPatch: vi.fn() }));
vi.mock('@/lib/userPromptStore', () => ({ getUserPrompt: () => '' }));
vi.mock('@/lib/memorySettingsStore', () => ({ getMakerMemoryEnabled: () => true }));
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('@/lib/imageRef', () => ({
  parseUserContent: vi.fn((c: unknown) => ({ text: String(c), images: [], files: [] })),
  stringifyUserContent: vi.fn((t: string) => t),
}));
vi.mock('@/lib/composerDraftStore', () => ({
  saveDraft: vi.fn(),
  setRemoteOptimisticAttachmentUrls: vi.fn(),
  plainTextToTiptapDoc: (s: string) => ({
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text: s }] }],
  }),
}));

import { makerChatStore } from '@/lib/makerChatStore';
import {
  __testing as dataOwnerGenerationTesting,
  setDataOwnerGeneration,
} from '@/contexts/dataOwnerGeneration';

const SESSION_ID = 'thinking-delta-batching';
let onEvent: ((data: unknown) => void) | undefined;

function installBridge(): void {
  onEvent = undefined;
  const w = globalThis as unknown as { window: Record<string, unknown> };
  w.window = {
    electronAPI: {
      maker: {
        onEvent: (cb: (data: unknown) => void) => {
          onEvent = cb;
          return vi.fn();
        },
        onStatusChanged: () => vi.fn(),
        onInputProjection: () => vi.fn(),
        onInteractionRequest: () => vi.fn(),
        onInteractionDismissed: () => vi.fn(),
        getPendingInteractions: vi.fn(async () => []),
        listActive: vi.fn(async () => []),
      },
      localDb: {
        messages: {
          onDeleted: () => vi.fn(),
          onCreated: () => vi.fn(),
          onErrorPersisted: () => vi.fn(),
        },
        sessions: { ackInterrupted: vi.fn(async () => undefined) },
      },
      deviceLink: {
        onStatusChanged: () => vi.fn(),
        onPresenceChanged: () => vi.fn(),
        onRemotePush: () => vi.fn(),
      },
      ghosts: {
        onUserMessageBlocked: () => vi.fn(),
        onUserMessageRewritten: () => vi.fn(),
        onAssistantMessageRewritten: () => vi.fn(),
        onAssistantMessagePending: () => vi.fn(),
        onHookFused: () => vi.fn(),
        onNotify: () => vi.fn(),
        onPreviewOpen: () => vi.fn(),
      },
    },
  };
}

describe('makerChatStore thinking delta batching', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    makerChatStore.__teardownGlobalListeners();
    makerChatStore.purgeSession(SESSION_ID);
    dataOwnerGenerationTesting.reset();
    setDataOwnerGeneration('owner-a');
    installBridge();
    makerChatStore.initGlobalListeners();
  });

  afterEach(() => {
    makerChatStore.__teardownGlobalListeners();
    makerChatStore.purgeSession(SESSION_ID);
    dataOwnerGenerationTesting.reset();
    vi.useRealTimers();
  });

  it('coalesces rapid thinking deltas into a single store notification after 32ms', () => {
    onEvent?.({
      sessionId: SESSION_ID,
      event: {
        type: 'thinking',
        source: 'claude-code',
        data: { stage: 'start', blockId: 'think-1', startedAt: 1000 },
      },
    });
    vi.advanceTimersByTime(50);

    const listener = vi.fn();
    const unsub = makerChatStore.subscribe(SESSION_ID, listener);
    try {
      for (const token of ['Step 1: ', 'check ', 'the ', 'diff.']) {
        onEvent?.({
          sessionId: SESSION_ID,
          event: {
            type: 'thinking',
            source: 'claude-code',
            data: { stage: 'delta', blockId: 'think-1', text: token },
          },
        });
      }

      // Not yet flushed before the 32ms batching tick.
      expect(listener).not.toHaveBeenCalled();
      expect(makerChatStore.getSnapshot(SESSION_ID).messages[0]?.content).toBe('');

      vi.advanceTimersByTime(32);

      expect(listener).toHaveBeenCalledTimes(1);
      expect(makerChatStore.getSnapshot(SESSION_ID).messages[0]).toMatchObject({
        clientId: 'think-1',
        role: 'thinking',
        content: 'Step 1: check the diff.',
        isStreaming: true,
      });
    } finally {
      unsub();
    }
  });

  it('flushes buffered thinking deltas in strict order before block switch, text delta, and final', () => {
    onEvent?.({
      sessionId: SESSION_ID,
      event: {
        type: 'thinking',
        source: 'claude-code',
        data: { stage: 'start', blockId: 'think-a', startedAt: 1000 },
      },
    });
    onEvent?.({
      sessionId: SESSION_ID,
      event: {
        type: 'thinking',
        source: 'claude-code',
        data: { stage: 'delta', blockId: 'think-a', text: 'part-1 ' },
      },
    });
    onEvent?.({
      sessionId: SESSION_ID,
      event: {
        type: 'thinking',
        source: 'claude-code',
        data: { stage: 'delta', blockId: 'think-a', text: 'part-2' },
      },
    });
    // Interleaved text delta forces thinking batch to flush first, preserving order.
    onEvent?.({
      sessionId: SESSION_ID,
      persistId: 'assistant-1',
      event: {
        type: 'text',
        source: 'claude-code',
        data: { text: 'Answer body', isFinal: false },
      },
    });
    // Thinking final flushes buffered text first and settles authoritative content.
    onEvent?.({
      sessionId: SESSION_ID,
      event: {
        type: 'thinking',
        source: 'claude-code',
        data: { stage: 'final', blockId: 'think-a', text: 'part-1 part-2', durationMs: 420 },
      },
    });
    vi.advanceTimersByTime(50);

    const messages = makerChatStore.getSnapshot(SESSION_ID).messages;
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({
      clientId: 'think-a',
      role: 'thinking',
      content: 'part-1 part-2',
      isStreaming: false,
      thinkingDurationMs: 420,
    });
    expect(messages[1]).toMatchObject({
      clientId: 'assistant-1',
      role: 'assistant',
      content: 'Answer body',
      isStreaming: true,
    });
  });
});
