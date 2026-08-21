/**
 * makerChatStoreTextDeltaBatching.test.ts
 * ---------------------------------------------------------------------------
 * input dispatch 移到 main 后 renderer 仍需负责的契约：
 * text delta 合并、可恢复错误展示，以及基于 main projection 的队列保留。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GHOST_SETUP_MAX_INTERACTION_STEPS, GHOST_SETUP_MAX_STEPS } from '../../shared/ghost';
import type { AgentInputProjection, AgentInputQueuedMessage } from '../../shared/agentInputQueue';
import type { Message, Session } from '@/lib/ccAgent.types';
import type { AttachedFile, MentionedResource } from '@/lib/fileTypes';

vi.mock('@/lib/messageService', () => ({
  list: vi.fn(async () => []),
  create: vi.fn(async () => ({}) as unknown),
  updateContent: vi.fn(async () => ({}) as unknown),
  dismissError: vi.fn(async () => ({}) as unknown),
}));

vi.mock('@/lib/sessionService', () => ({
  get: vi.fn(async () => ({
    agentKind: 'codex',
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

vi.mock('@/lib/sessionsBus', () => ({
  emitPatch: vi.fn(),
}));

vi.mock('@/lib/userPromptStore', () => ({
  getUserPrompt: () => '',
}));

vi.mock('@/lib/memorySettingsStore', () => ({
  getMakerMemoryEnabled: () => true,
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('@/lib/imageRef', () => ({
  parseUserContent: vi.fn((content: unknown) => {
    let value = content;
    if (typeof content === 'string' && content.startsWith('{')) {
      try {
        value = JSON.parse(content);
      } catch {
        // Plain user text that merely starts with "{" remains plain text.
      }
    }
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const record = value as Record<string, unknown>;
      if (typeof record.text === 'string') {
        return {
          text: record.text,
          images: Array.isArray(record.images) ? record.images : [],
          files: Array.isArray(record.files) ? record.files : [],
          ...(Array.isArray(record.agentReferences)
            ? { agentReferences: record.agentReferences }
            : {}),
        };
      }
    }
    return { text: String(content), images: [], files: [] };
  }),
  stringifyUserContent: vi.fn((text: string, images = [], files = []) =>
    JSON.stringify({ text, images, files }),
  ),
}));

vi.mock('@/lib/composerDraftStore', () => ({
  saveDraft: vi.fn(),
  setRemoteOptimisticAttachmentUrls: vi.fn(),
  plainTextToTiptapDoc: (s: string) => ({
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text: s }] }],
  }),
}));

import {
  isRemoteOptimisticSessionPurgedError,
  makerChatStore,
  type ChatMessage,
} from '@/lib/makerChatStore';
import * as messageService from '@/lib/messageService';
import * as sessionService from '@/lib/sessionService';
import * as sessionsBus from '@/lib/sessionsBus';
import { setRemoteOptimisticAttachmentUrls } from '@/lib/composerDraftStore';
import { remoteProjectsStore } from '@/features/device-link/remoteProjectsStore';
import {
  __resetStickySessionOriginForTest,
  getStickySessionDeviceId,
} from '@/features/device-link/stickySessionOrigin';
import {
  __testing as dataOwnerGenerationTesting,
  setDataOwnerGeneration,
} from '@/contexts/dataOwnerGeneration';
import { CONTINUE_AFTER_APP_EXIT_PROMPT } from '../../shared/interruptedTurn';

const SESSION_ID = 'text-delta-batching';
const MODEL = 'gpt-5';
const EFFORT = 'medium';
const PERMISSION_MODE = 'default';
const WORKING_DIR = 'C:\\workspace';

function serverMessage(
  patch: Omit<Message, 'toolUseId' | 'agentMeta'> &
    Partial<Pick<Message, 'toolUseId' | 'agentMeta'>>,
): Message {
  return {
    toolUseId: null,
    agentMeta: null,
    ...patch,
  };
}

let onEvent: ((data: unknown) => void) | undefined;
let onStatusChanged: ((data: unknown) => void) | undefined;
let onDeviceLinkStatusChanged: ((data: unknown) => void) | undefined;
let onPresenceChanged: ((data: unknown) => void) | undefined;
let onRemotePush: ((data: unknown, ownerStamp?: unknown) => void) | undefined;
let onDbMessageCreated: ((data: unknown) => void) | undefined;
let onInputProjection: ((data: unknown) => void) | undefined;
let onInteractionRequest: ((data: unknown) => void) | undefined;
let onInteractionDismissed: ((data: unknown) => void) | undefined;
let onGhostMessageBlocked: ((data: unknown, ownerStamp?: unknown) => void) | undefined;
let onGhostMessageRewritten: ((data: unknown, ownerStamp?: unknown) => void) | undefined;
let onGhostAssistantRewritten: ((data: unknown, ownerStamp?: unknown) => void) | undefined;
let onGhostAssistantPending: ((data: unknown, ownerStamp?: unknown) => void) | undefined;
let onGhostHookFused: ((data: unknown, ownerStamp?: unknown) => void) | undefined;
let onGhostNotify: ((data: unknown, ownerStamp?: unknown) => void) | undefined;
let onGhostPreviewOpen: ((data: unknown, ownerStamp?: unknown) => void) | undefined;
const getPendingInteractions = vi.fn<
  (sessionId: string) => Promise<
    Array<{
      request: { kind: string; requestId: string; [key: string]: unknown };
      persistId?: string;
    }>
  >
>(async () => []);
const deviceLinkInvoke =
  vi.fn<(deviceId: string, channel: string, args: unknown[]) => Promise<unknown>>();

const input = {
  getProjection: vi.fn(async (sessionId: string) => projection(sessionId)),
  enqueue: vi.fn(async (sessionId: string, item: AgentInputQueuedMessage) =>
    projection(sessionId, { pendingQueue: [item] }),
  ),
  compact: vi.fn(async (sessionId: string) => projection(sessionId)),
  steer: vi.fn(async () => true),
  stop: vi.fn(async (sessionId: string) => projection(sessionId)),
  resume: vi.fn(async (sessionId: string) => projection(sessionId)),
  retryLastError: vi.fn(async (sessionId: string) => projection(sessionId)),
  clearError: vi.fn(async (sessionId: string) => projection(sessionId)),
  remove: vi.fn(async (sessionId: string) => projection(sessionId)),
  updateText: vi.fn(async (sessionId: string) => projection(sessionId)),
  move: vi.fn(async (sessionId: string) => projection(sessionId)),
  setExpanded: vi.fn(async (sessionId: string) => projection(sessionId)),
  setInteractionLock: vi.fn(async (sessionId: string) => projection(sessionId)),
  setEditLock: vi.fn(async (sessionId: string) => projection(sessionId)),
  clearSession: vi.fn(async (sessionId: string, clearedAt?: string) => {
    void clearedAt;
    return projection(sessionId);
  }),
  persistTurnErrorDeferred: vi.fn(async () => {}),
};

function projection(
  sessionId: string,
  patch: Partial<AgentInputProjection> = {},
): AgentInputProjection {
  return {
    sessionId,
    pendingQueue: [],
    steeringQueueClientIds: [],
    queuePaused: false,
    queueExpanded: false,
    queueInteractionLocks: [],
    queueEditLocks: [],
    queueAbortPending: false,
    error: null,
    recovery: null,
    errorRetryText: null,
    credentialSwitchWait: null,
    ...patch,
  };
}

function installElectronBridge(): void {
  onEvent = undefined;
  onStatusChanged = undefined;
  onDeviceLinkStatusChanged = undefined;
  onPresenceChanged = undefined;
  onRemotePush = undefined;
  onDbMessageCreated = undefined;
  onInputProjection = undefined;
  onInteractionRequest = undefined;
  onInteractionDismissed = undefined;
  onGhostMessageBlocked = undefined;
  onGhostMessageRewritten = undefined;
  onGhostAssistantRewritten = undefined;
  onGhostAssistantPending = undefined;
  onGhostHookFused = undefined;
  onGhostNotify = undefined;
  onGhostPreviewOpen = undefined;
  for (const fn of Object.values(input) as Array<{ mockClear: () => void }>) {
    fn.mockClear();
  }
  deviceLinkInvoke.mockReset();

  const w = globalThis as unknown as { window: Record<string, unknown> };
  w.window = {
    electronAPI: {
      maker: {
        input,
        onInputProjection: (cb: (data: unknown) => void) => {
          onInputProjection = cb;
          return vi.fn();
        },
        onEvent: (cb: (data: unknown) => void) => {
          onEvent = cb;
          return vi.fn();
        },
        onStatusChanged: (cb: (data: unknown) => void) => {
          onStatusChanged = cb;
          return vi.fn();
        },
        onInteractionRequest: (cb: (data: unknown) => void) => {
          onInteractionRequest = cb;
          return vi.fn();
        },
        onInteractionDismissed: (cb: (data: unknown) => void) => {
          onInteractionDismissed = cb;
          return vi.fn();
        },
        send: vi.fn(async () => ({ accepted: true })),
        resolveInteraction: vi.fn(async () => {}),
        submitPluginSetupInline: vi.fn(async () => {}),
        getPendingInteractions,
        steer: vi.fn(async () => true),
        generateTitle: vi.fn(async () => ({ title: 't' })),
        abortSession: vi.fn(async () => {}),
        closeSession: vi.fn(async () => {}),
        listActive: vi.fn(async () => []),
      },
      cacheMediaForSession: vi.fn(async ({ sessionId }: { sessionId: string }) => ({
        url: `xdt-image://${sessionId}/private.png`,
        name: 'private.png',
        ext: '.png',
        mimeType: 'image/png',
        size: 1,
      })),
      safeStorageRead: vi.fn(async () => 'local-key'),
      localDb: {
        messages: {
          onCreated: (cb: (data: unknown) => void) => {
            onDbMessageCreated = cb;
            return vi.fn();
          },
        },
        sessions: {
          ackInterrupted: vi.fn(async () => undefined),
        },
      },
      deviceLink: {
        invoke: deviceLinkInvoke,
        onStatusChanged: (cb: (data: unknown) => void) => {
          onDeviceLinkStatusChanged = cb;
          return vi.fn();
        },
        onPresenceChanged: (cb: (data: unknown) => void) => {
          onPresenceChanged = cb;
          return vi.fn();
        },
        onRemotePush: (cb: (data: unknown, ownerStamp?: unknown) => void) => {
          onRemotePush = cb;
          return vi.fn();
        },
      },
      ghosts: {
        onUserMessageBlocked: (cb: (data: unknown, ownerStamp?: unknown) => void) => {
          onGhostMessageBlocked = cb;
          return vi.fn();
        },
        onUserMessageRewritten: (cb: (data: unknown, ownerStamp?: unknown) => void) => {
          onGhostMessageRewritten = cb;
          return vi.fn();
        },
        onAssistantMessageRewritten: (cb: (data: unknown, ownerStamp?: unknown) => void) => {
          onGhostAssistantRewritten = cb;
          return vi.fn();
        },
        onAssistantMessagePending: (cb: (data: unknown, ownerStamp?: unknown) => void) => {
          onGhostAssistantPending = cb;
          return vi.fn();
        },
        onHookFused: (cb: (data: unknown, ownerStamp?: unknown) => void) => {
          onGhostHookFused = cb;
          return vi.fn();
        },
        onNotify: (cb: (data: unknown, ownerStamp?: unknown) => void) => {
          onGhostNotify = cb;
          return vi.fn();
        },
        onPreviewOpen: (cb: (data: unknown, ownerStamp?: unknown) => void) => {
          onGhostPreviewOpen = cb;
          return vi.fn();
        },
      },
    },
  };
}

function emitTextDelta(text: string, sessionId = SESSION_ID): void {
  onEvent?.({
    sessionId,
    event: {
      type: 'text',
      source: 'claude-code',
      data: { text, isFinal: false },
    },
    persistId: 'assistant-1',
  });
}

function emitDbMessageCreated(
  message: Pick<Message, 'clientId' | 'role' | 'content' | 'createdAt'> & Partial<Message>,
  sessionId = SESSION_ID,
): void {
  onDbMessageCreated?.({
    sessionId,
    message: {
      id: message.id ?? `row-${message.clientId}`,
      sessionId,
      toolUseId: message.toolUseId ?? null,
      agentMeta: message.agentMeta ?? null,
      ...message,
    },
  });
}

function emitStatus(
  data: {
    status: string;
    isRunning: boolean;
    tokenUsage?: number;
    costUsd?: number;
    contextTokens?: number;
    contextWindow?: number;
  },
  sessionId = SESSION_ID,
): void {
  onEvent?.({
    sessionId,
    event: {
      type: 'status',
      source: 'claude-code',
      data: {
        tokenUsage: 0,
        contextTokens: 0,
        contextWindow: 0,
        ...data,
      },
    },
  });
}

function emitInteractionRequest(
  request: { kind?: unknown; requestId?: unknown; [k: string]: unknown },
  persistId?: string,
  sessionId = SESSION_ID,
): void {
  onInteractionRequest?.({ sessionId, request, persistId });
}

function pluginSetupRequest(revision: number) {
  return {
    kind: 'plugin_setup',
    requestId: 'plugin-setup-1',
    revision,
    ghost: { id: 'filo-google', name: 'Filo Google' },
    intro: 'Connect your account',
    steps: [
      {
        id: 'google-account',
        title: 'Google account',
        description: 'Authorize access',
        phase: revision >= 2 ? 'action_running' : 'pending',
        action: { id: 'oauth:google-account', kind: 'oauth_connect' },
      },
    ],
  };
}

function inlinePluginSetupRequest(revision: number) {
  return {
    ...pluginSetupRequest(revision),
    ghost: { id: 'art', name: 'Art' },
    intro: 'Configure Art',
    steps: [
      {
        id: 'api-key',
        title: 'API Key',
        description: 'Stored securely on this desktop.',
        phase: 'pending',
        action: {
          id: 'inline:api-key',
          kind: 'inline_form',
          form: {
            fields: [
              {
                id: 'value',
                type: 'secret',
                label: 'API Key',
                externalLink: {
                  url: 'https://console.example.com/keys',
                },
                required: true,
                maxLength: 200,
              },
            ],
          },
        },
      },
    ],
  };
}

const flushPromises = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

describe('makerChatStore text delta batching', () => {
  const MULTI_SESSION_IDS = Array.from({ length: 10 }, (_, i) => `${SESSION_ID}-multi-${i}`);
  const LRU_SESSION_IDS = Array.from({ length: 21 }, (_, i) => `${SESSION_ID}-lru-${i}`);

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    makerChatStore.__teardownGlobalListeners();
    makerChatStore.purgeSession(SESSION_ID);
    makerChatStore.__resetRemoteTerminalTombstonesForTest();
    remoteProjectsStore.clear();
    remoteProjectsStore.__resetPinnedOriginsForTest();
    __resetStickySessionOriginForTest();
    dataOwnerGenerationTesting.reset();
    setDataOwnerGeneration('owner-a');
    for (const sessionId of MULTI_SESSION_IDS) makerChatStore.purgeSession(sessionId);
    for (const sessionId of LRU_SESSION_IDS) makerChatStore.purgeSession(sessionId);
    installElectronBridge();
    makerChatStore.initGlobalListeners();
  });

  afterEach(() => {
    makerChatStore.__teardownGlobalListeners();
    makerChatStore.purgeSession(SESSION_ID);
    makerChatStore.__resetRemoteTerminalTombstonesForTest();
    remoteProjectsStore.clear();
    remoteProjectsStore.__resetPinnedOriginsForTest();
    __resetStickySessionOriginForTest();
    dataOwnerGenerationTesting.reset();
    for (const sessionId of MULTI_SESSION_IDS) makerChatStore.purgeSession(sessionId);
    for (const sessionId of LRU_SESSION_IDS) makerChatStore.purgeSession(sessionId);
    vi.useRealTimers();
  });

  it('coalesces consecutive text deltas into one store notification', () => {
    let notifyCount = 0;
    const unsubscribe = makerChatStore.subscribe(SESSION_ID, () => {
      notifyCount += 1;
    });

    emitTextDelta('a');
    emitTextDelta('b');
    emitTextDelta('c');

    expect(notifyCount).toBe(0);
    expect(makerChatStore.getSnapshot(SESSION_ID).messages).toHaveLength(0);

    vi.advanceTimersByTime(32);

    expect(notifyCount).toBe(1);
    expect(makerChatStore.getSnapshot(SESSION_ID).messages).toEqual([
      expect.objectContaining({
        clientId: 'assistant-1',
        role: 'assistant',
        content: 'abc',
        isStreaming: true,
      }),
    ]);

    unsubscribe();
  });

  it('drops stale ghost pushes before they mutate the current owner slice', () => {
    const staleOwnerStamp = { dataOwnerId: 'owner-b', ownerGeneration: 1 };
    const currentOwnerStamp = { dataOwnerId: 'owner-a', ownerGeneration: 1 };
    const blockedPayload = {
      sessionId: SESSION_ID,
      clientId: 'ghost-client-1',
      ghostId: 'ghost-a',
      ghostName: 'Ghost A',
      reason: 'blocked',
      text: 'original text',
    };

    onGhostMessageBlocked?.(blockedPayload, staleOwnerStamp);
    expect(makerChatStore.getSnapshot(SESSION_ID).messages).toHaveLength(0);

    onGhostMessageBlocked?.(blockedPayload, currentOwnerStamp);
    expect(makerChatStore.getSnapshot(SESSION_ID).messages).toEqual([
      expect.objectContaining({
        clientId: 'ghost-client-1',
        content: 'original text',
        blockedByGhost: expect.objectContaining({ ghostId: 'ghost-a' }),
      }),
    ]);

    onGhostMessageRewritten?.(
      { sessionId: SESSION_ID, clientId: 'ghost-client-1', text: 'stale rewrite' },
      staleOwnerStamp,
    );
    expect(makerChatStore.getSnapshot(SESSION_ID).messages[0]?.content).toBe('original text');

    onGhostMessageRewritten?.(
      { sessionId: SESSION_ID, clientId: 'ghost-client-1', text: 'current rewrite' },
      currentOwnerStamp,
    );
    expect(makerChatStore.getSnapshot(SESSION_ID).messages[0]?.content).toBe('current rewrite');

    onGhostAssistantPending?.(
      { sessionId: SESSION_ID, clientId: 'ghost-client-1', pending: true },
      staleOwnerStamp,
    );
    expect(makerChatStore.getSnapshot(SESSION_ID).messages[0]?.ghostReplyPending).toBeUndefined();

    onGhostAssistantPending?.(
      { sessionId: SESSION_ID, clientId: 'ghost-client-1', pending: true },
      currentOwnerStamp,
    );
    expect(makerChatStore.getSnapshot(SESSION_ID).messages[0]?.ghostReplyPending).toBe(true);
  });

  it('flushes pending text before the next non-delta event', () => {
    emitTextDelta('a');

    onEvent?.({
      sessionId: SESSION_ID,
      event: {
        type: 'tool_use',
        source: 'claude-code',
        data: { toolUseId: 'tool-1', toolName: 'Read', input: { file_path: 'a.ts' } },
      },
      persistId: 'tool-message-1',
    });

    const messages = makerChatStore.getSnapshot(SESSION_ID).messages;
    expect(messages.map((m) => m.role)).toEqual(['assistant', 'tool_use']);
    expect(messages[0]?.content).toBe('a');
    expect(messages[0]?.clientId).toBe('assistant-1');
  });

  it('updates a repeated web_search tool_use row in place', () => {
    onEvent?.({
      sessionId: SESSION_ID,
      event: {
        type: 'tool_use',
        source: 'codex',
        data: {
          toolUseId: 'search-1',
          toolName: 'web_search',
          input: { query: 'early query' },
        },
      },
      persistId: 'search-message-1',
    });
    onEvent?.({
      sessionId: SESSION_ID,
      event: {
        type: 'tool_use',
        source: 'codex',
        data: {
          toolUseId: 'search-1',
          toolName: 'web_search',
          input: {
            query: 'https://example.com/final',
            action: { type: 'openPage', url: 'https://example.com/final' },
          },
        },
      },
      persistId: 'search-message-1',
    });

    const messages = makerChatStore.getSnapshot(SESSION_ID).messages;
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      clientId: 'search-message-1',
      role: 'tool_use',
      toolUseId: 'search-1',
      toolName: 'web_search',
      toolInput: {
        query: 'https://example.com/final',
        action: { type: 'openPage', url: 'https://example.com/final' },
      },
    });
  });

  it('refreshes the plan update timestamp when update_plan completes in place', () => {
    const startedAt = 1_700_000_000_000;
    vi.setSystemTime(startedAt);
    onEvent?.({
      sessionId: SESSION_ID,
      event: {
        type: 'tool_use',
        source: 'codex',
        data: {
          toolUseId: 'plan-1',
          toolName: 'update_plan',
          input: { plan: [{ step: 'Finish work', status: 'in_progress' }] },
        },
      },
      persistId: 'plan-message-1',
    });

    vi.setSystemTime(startedAt + 5_000);
    onEvent?.({
      sessionId: SESSION_ID,
      event: {
        type: 'tool_use',
        source: 'codex',
        data: {
          toolUseId: 'plan-1',
          toolName: 'update_plan',
          input: { plan: [{ step: 'Finish work', status: 'completed' }] },
        },
      },
      persistId: 'plan-message-1',
    });

    const messages = makerChatStore.getSnapshot(SESSION_ID).messages;
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      clientId: 'plan-message-1',
      createdAt: new Date(startedAt).toISOString(),
      planUpdatedAtMs: startedAt + 5_000,
      toolInput: { plan: [{ step: 'Finish work', status: 'completed' }] },
    });
  });

  it('accepts the terminal persisted plan when the renderer mounted with stale progress', () => {
    onEvent?.({
      sessionId: SESSION_ID,
      event: {
        type: 'tool_use',
        source: 'codex',
        data: {
          toolUseId: 'plan:turn-1',
          toolName: 'update_plan',
          input: {
            plan: [
              { step: 'Inspect', status: 'completed' },
              { step: 'Start dev', status: 'in_progress' },
            ],
          },
        },
      },
      persistId: 'plan-message-1',
    });

    onDbMessageCreated?.({
      sessionId: SESSION_ID,
      message: serverMessage({
        id: 'plan-row-1',
        clientId: 'plan-message-1',
        sessionId: SESSION_ID,
        role: 'tool_use',
        content: {
          toolUseId: 'plan:turn-1',
          toolName: 'update_plan',
          terminalPlanSnapshot: true,
          input: {
            plan: [
              { step: 'Inspect', status: 'completed' },
              { step: 'Start dev', status: 'completed' },
            ],
          },
        },
        createdAt: '2026-08-05T00:00:00.000Z',
      }),
    });

    expect(makerChatStore.getSnapshot(SESSION_ID).messages[0]).toMatchObject({
      clientId: 'plan-message-1',
      toolInput: {
        plan: [
          { step: 'Inspect', status: 'completed' },
          { step: 'Start dev', status: 'completed' },
        ],
      },
    });
  });

  it('accepts a terminal persisted empty plan instead of restoring stale progress', () => {
    onEvent?.({
      sessionId: SESSION_ID,
      event: {
        type: 'tool_use',
        source: 'codex',
        data: {
          toolUseId: 'plan:turn-clear',
          toolName: 'update_plan',
          input: { plan: [{ step: 'Wait for user', status: 'in_progress' }] },
        },
      },
      persistId: 'plan-message-clear',
    });

    onDbMessageCreated?.({
      sessionId: SESSION_ID,
      message: serverMessage({
        id: 'plan-row-clear',
        clientId: 'plan-message-clear',
        sessionId: SESSION_ID,
        role: 'tool_use',
        content: {
          toolUseId: 'plan:turn-clear',
          toolName: 'update_plan',
          terminalPlanSnapshot: true,
          input: { plan: [] },
        },
        createdAt: '2026-08-05T00:00:00.000Z',
      }),
    });

    expect(makerChatStore.getSnapshot(SESSION_ID).messages[0]).toMatchObject({
      clientId: 'plan-message-clear',
      toolInput: { plan: [] },
    });
  });

  it('restores a failed turn boundary from its persisted plan row', () => {
    const [mapped] = makerChatStore.__mapServerMessagesForTest([
      serverMessage({
        id: 'plan-row-interrupted',
        clientId: 'plan-message-interrupted',
        sessionId: SESSION_ID,
        role: 'tool_use',
        content: {
          toolUseId: 'plan:turn-interrupted',
          toolName: 'update_plan',
          turnCompleted: false,
          input: { plan: [{ step: 'Wait for user', status: 'in_progress' }] },
        },
        createdAt: '2026-08-05T00:00:00.000Z',
      }),
    ]);

    expect(mapped).toMatchObject({
      clientId: 'plan-message-interrupted',
      role: 'tool_use',
      toolName: 'update_plan',
      turnCompleted: false,
    });
  });

  it('does not let an unmarked completed-plan echo replace newer live work', () => {
    onEvent?.({
      sessionId: SESSION_ID,
      event: {
        type: 'tool_use',
        source: 'codex',
        data: {
          toolUseId: 'plan:turn-race',
          toolName: 'update_plan',
          input: { plan: [{ step: 'Initial work', status: 'completed' }] },
        },
      },
      persistId: 'plan-message-race',
    });
    onEvent?.({
      sessionId: SESSION_ID,
      event: {
        type: 'tool_use',
        source: 'codex',
        data: {
          toolUseId: 'plan:turn-race',
          toolName: 'update_plan',
          input: {
            plan: [
              { step: 'Initial work', status: 'completed' },
              { step: 'Follow-up work', status: 'in_progress' },
            ],
          },
        },
      },
      persistId: 'plan-message-race',
    });

    onDbMessageCreated?.({
      sessionId: SESSION_ID,
      message: serverMessage({
        id: 'plan-row-race',
        clientId: 'plan-message-race',
        sessionId: SESSION_ID,
        role: 'tool_use',
        content: {
          toolUseId: 'plan:turn-race',
          toolName: 'update_plan',
          input: { plan: [{ step: 'Initial work', status: 'completed' }] },
        },
        createdAt: '2026-08-05T00:00:00.000Z',
      }),
    });

    expect(makerChatStore.getSnapshot(SESSION_ID).messages[0]).toMatchObject({
      toolInput: {
        plan: [
          { step: 'Initial work', status: 'completed' },
          { step: 'Follow-up work', status: 'in_progress' },
        ],
      },
    });
  });

  it('does not let an unmarked empty-plan echo replace newer live work', () => {
    onEvent?.({
      sessionId: SESSION_ID,
      event: {
        type: 'tool_use',
        source: 'codex',
        data: {
          toolUseId: 'plan:turn-empty-race',
          toolName: 'update_plan',
          input: { plan: [] },
        },
      },
      persistId: 'plan-message-empty-race',
    });
    onEvent?.({
      sessionId: SESSION_ID,
      event: {
        type: 'tool_use',
        source: 'codex',
        data: {
          toolUseId: 'plan:turn-empty-race',
          toolName: 'update_plan',
          input: { plan: [{ step: 'New work', status: 'in_progress' }] },
        },
      },
      persistId: 'plan-message-empty-race',
    });

    onDbMessageCreated?.({
      sessionId: SESSION_ID,
      message: serverMessage({
        id: 'plan-row-empty-race',
        clientId: 'plan-message-empty-race',
        sessionId: SESSION_ID,
        role: 'tool_use',
        content: {
          toolUseId: 'plan:turn-empty-race',
          toolName: 'update_plan',
          input: { plan: [] },
        },
        createdAt: '2026-08-05T00:00:00.000Z',
      }),
    });

    expect(makerChatStore.getSnapshot(SESSION_ID).messages[0]).toMatchObject({
      toolInput: { plan: [{ step: 'New work', status: 'in_progress' }] },
    });
  });

  it('still ignores a stale open-plan DB echo after live progress moved forward', () => {
    onEvent?.({
      sessionId: SESSION_ID,
      event: {
        type: 'tool_use',
        source: 'codex',
        data: {
          toolUseId: 'plan:turn-1',
          toolName: 'update_plan',
          input: {
            plan: [
              { step: 'Inspect', status: 'completed' },
              { step: 'Start dev', status: 'completed' },
            ],
          },
        },
      },
      persistId: 'plan-message-1',
    });

    onDbMessageCreated?.({
      sessionId: SESSION_ID,
      message: serverMessage({
        id: 'plan-row-1',
        clientId: 'plan-message-1',
        sessionId: SESSION_ID,
        role: 'tool_use',
        content: {
          toolUseId: 'plan:turn-1',
          toolName: 'update_plan',
          input: {
            plan: [
              { step: 'Inspect', status: 'completed' },
              { step: 'Start dev', status: 'in_progress' },
            ],
          },
        },
        createdAt: '2026-08-05T00:00:00.000Z',
      }),
    });

    expect(makerChatStore.getSnapshot(SESSION_ID).messages[0]).toMatchObject({
      toolInput: {
        plan: [
          { step: 'Inspect', status: 'completed' },
          { step: 'Start dev', status: 'completed' },
        ],
      },
    });
  });

  it('flushes pending text before a permission interaction request on the separate IPC channel', () => {
    const snapshots: Array<{ roles: string[]; pendingPermission: string | null }> = [];
    const unsubscribe = makerChatStore.subscribe(SESSION_ID, () => {
      const snap = makerChatStore.getSnapshot(SESSION_ID);
      snapshots.push({
        roles: snap.messages.map((m) => m.role),
        pendingPermission: snap.pendingPermission?.requestId ?? null,
      });
    });

    emitTextDelta('need approval');

    emitInteractionRequest({
      kind: 'permission',
      requestId: 'perm-1',
      toolName: 'Read',
      input: { file_path: 'a.ts' },
    });

    const snap = makerChatStore.getSnapshot(SESSION_ID);
    expect(snap.messages).toEqual([
      expect.objectContaining({
        clientId: 'assistant-1',
        role: 'assistant',
        content: 'need approval',
      }),
    ]);
    expect(snap.pendingPermission?.requestId).toBe('perm-1');
    expect(snapshots[0]).toEqual({ roles: ['assistant'], pendingPermission: null });
    expect(snapshots[1]).toEqual({ roles: ['assistant'], pendingPermission: 'perm-1' });

    vi.advanceTimersByTime(32);
    expect(makerChatStore.getSnapshot(SESSION_ID).messages).toHaveLength(1);

    unsubscribe();
  });

  it('flushes pending text before an ask_user_question interaction request on the separate IPC channel', () => {
    emitTextDelta('question lead-in');

    emitInteractionRequest(
      {
        kind: 'ask_user_question',
        requestId: 'ask-1',
        questions: [{ question: 'Continue?', options: [{ label: 'Yes' }] }],
      },
      'ask-message-1',
    );

    const messages = makerChatStore.getSnapshot(SESSION_ID).messages;
    expect(messages.map((m) => m.role)).toEqual(['assistant', 'ask_user']);
    expect(messages[0]).toEqual(
      expect.objectContaining({
        clientId: 'assistant-1',
        content: 'question lead-in',
      }),
    );
    expect(messages[1]).toEqual(
      expect.objectContaining({
        clientId: 'ask-message-1',
        askUserRequestId: 'ask-1',
        content: 'Continue?',
      }),
    );

    vi.advanceTimersByTime(32);
    expect(makerChatStore.getSnapshot(SESSION_ID).messages.map((m) => m.role)).toEqual([
      'assistant',
      'ask_user',
    ]);
  });

  it('flushes pending text before a plan_review interaction request on the separate IPC channel', () => {
    emitTextDelta('plan lead-in');

    emitInteractionRequest(
      {
        kind: 'plan_review',
        requestId: 'plan-1',
        plan: '1. Do the thing',
        planFilePath: 'C:\\workspace\\plan.md',
      },
      'plan-message-1',
    );

    const messages = makerChatStore.getSnapshot(SESSION_ID).messages;
    expect(messages.map((m) => m.role)).toEqual(['assistant', 'plan_review']);
    expect(messages[0]).toEqual(
      expect.objectContaining({
        clientId: 'assistant-1',
        content: 'plan lead-in',
      }),
    );
    expect(messages[1]).toEqual(
      expect.objectContaining({
        clientId: 'plan-message-1',
        planReviewRequestId: 'plan-1',
        planReviewPlan: '1. Do the thing',
      }),
    );

    vi.advanceTimersByTime(32);
    expect(makerChatStore.getSnapshot(SESSION_ID).messages.map((m) => m.role)).toEqual([
      'assistant',
      'plan_review',
    ]);
  });

  it('accepts plugin_setup snapshots and ignores a lower revision for the same request', () => {
    emitInteractionRequest(pluginSetupRequest(2));
    expect(makerChatStore.getSnapshot(SESSION_ID).pendingPluginSetup).toEqual(
      expect.objectContaining({
        requestId: 'plugin-setup-1',
        revision: 2,
      }),
    );
    expect(makerChatStore.getRunningSnapshot().get(SESSION_ID)?.hasPendingPluginSetup).toBe(true);

    emitInteractionRequest(pluginSetupRequest(1));
    expect(makerChatStore.getSnapshot(SESSION_ID).pendingPluginSetup?.revision).toBe(2);
  });

  it('keeps terminal setup feedback mounted without reporting a pending interaction', () => {
    emitInteractionRequest(pluginSetupRequest(1));
    emitInteractionRequest({
      ...pluginSetupRequest(2),
      terminal: true,
      steps: pluginSetupRequest(2).steps.map((step) => ({
        ...step,
        phase: 'satisfied',
      })),
    });

    expect(makerChatStore.getSnapshot(SESSION_ID).pendingPluginSetup).toMatchObject({
      requestId: 'plugin-setup-1',
      revision: 2,
      terminal: true,
    });
    expect(
      makerChatStore.getRunningSnapshot().get(SESSION_ID)?.hasPendingPluginSetup ?? false,
    ).toBe(false);

    onEvent?.({
      sessionId: SESSION_ID,
      event: { type: 'done', source: 'claude-code', data: {} },
    });
    expect(makerChatStore.getSnapshot(SESSION_ID).pendingPluginSetup).not.toBeNull();
    expect(
      makerChatStore.getRunningSnapshot().get(SESSION_ID)?.hasPendingPluginSetup ?? false,
    ).toBe(false);
  });

  it('keeps plugin_setup mounted across done and clears only on matching dismissal', () => {
    emitInteractionRequest(pluginSetupRequest(1));

    onEvent?.({
      sessionId: SESSION_ID,
      event: { type: 'done', source: 'claude-code', data: {} },
    });
    expect(makerChatStore.getSnapshot(SESSION_ID).pendingPluginSetup?.requestId).toBe(
      'plugin-setup-1',
    );

    onInteractionDismissed?.({
      sessionId: SESSION_ID,
      requestId: 'another-request',
      reason: 'resolved',
    });
    expect(makerChatStore.getSnapshot(SESSION_ID).pendingPluginSetup).not.toBeNull();

    onInteractionDismissed?.({
      sessionId: SESSION_ID,
      requestId: 'plugin-setup-1',
      reason: 'resolved',
    });
    expect(makerChatStore.getSnapshot(SESSION_ID).pendingPluginSetup).toBeNull();
    expect(makerChatStore.getSnapshot(SESSION_ID).pluginSetupViewerState).toBe('expanded');
  });

  it('queues concurrent plugin_setup requests and promotes them in first-seen order', () => {
    emitInteractionRequest(pluginSetupRequest(1));
    emitInteractionRequest({
      ...pluginSetupRequest(1),
      requestId: 'plugin-setup-2',
      ghost: {
        id: 'second-plugin',
        name: 'Second Plugin',
      },
    });

    let snapshot = makerChatStore.getSnapshot(SESSION_ID);
    expect(snapshot.pendingPluginSetup?.requestId).toBe('plugin-setup-1');
    expect(snapshot.pendingPluginSetupQueue.map((setup) => setup.requestId)).toEqual([
      'plugin-setup-2',
    ]);

    emitInteractionRequest({
      ...pluginSetupRequest(3),
      requestId: 'plugin-setup-2',
      ghost: {
        id: 'second-plugin',
        name: 'Second Plugin',
      },
    });
    snapshot = makerChatStore.getSnapshot(SESSION_ID);
    expect(snapshot.pendingPluginSetup?.requestId).toBe('plugin-setup-1');
    expect(snapshot.pendingPluginSetupQueue[0]).toEqual(
      expect.objectContaining({
        requestId: 'plugin-setup-2',
        revision: 3,
      }),
    );

    onInteractionDismissed?.({
      sessionId: SESSION_ID,
      requestId: 'plugin-setup-1',
      reason: 'ready',
    });
    snapshot = makerChatStore.getSnapshot(SESSION_ID);
    expect(snapshot.pendingPluginSetup).toEqual(
      expect.objectContaining({
        requestId: 'plugin-setup-2',
        revision: 3,
      }),
    );
    expect(snapshot.pendingPluginSetupQueue).toEqual([]);

    makerChatStore.respondToPluginSetup(
      SESSION_ID,
      'plugin-setup-2',
      'run_action',
      'oauth:google-account',
    );
    expect(window.electronAPI.maker.resolveInteraction).toHaveBeenCalledWith(
      'plugin-setup-2',
      expect.objectContaining({
        kind: 'plugin_setup',
        action: 'run_action',
        expectedRevision: 3,
      }),
    );
  });

  it('clears stale plugin_setup cards and in-flight state from an authoritative empty snapshot', async () => {
    emitInteractionRequest(pluginSetupRequest(1));
    emitInteractionRequest({
      ...pluginSetupRequest(1),
      requestId: 'plugin-setup-2',
      ghost: {
        id: 'second-plugin',
        name: 'Second Plugin',
      },
    });
    makerChatStore.setPluginSetupViewerState(SESSION_ID, 'minimized');
    makerChatStore.respondToPluginSetup(
      SESSION_ID,
      'plugin-setup-1',
      'run_action',
      'oauth:google-account',
    );
    expect(makerChatStore.getSnapshot(SESSION_ID).pluginSetupCommandInFlight).not.toBeNull();

    getPendingInteractions.mockResolvedValueOnce([]);
    await makerChatStore.reconcilePendingInteractions(SESSION_ID);

    const snapshot = makerChatStore.getSnapshot(SESSION_ID);
    expect(snapshot.pendingPluginSetup).toBeNull();
    expect(snapshot.pendingPluginSetupQueue).toEqual([]);
    expect(snapshot.pluginSetupCommandInFlight).toBeNull();
    expect(snapshot.pluginSetupViewerState).toBe('expanded');
  });

  it('promotes the surviving queued plugin_setup from an authoritative snapshot', async () => {
    emitInteractionRequest(pluginSetupRequest(1));
    emitInteractionRequest({
      ...pluginSetupRequest(1),
      requestId: 'plugin-setup-2',
      ghost: {
        id: 'second-plugin',
        name: 'Second Plugin',
      },
    });
    makerChatStore.setPluginSetupViewerState(SESSION_ID, 'minimized');

    getPendingInteractions.mockResolvedValueOnce([
      {
        request: {
          ...pluginSetupRequest(3),
          requestId: 'plugin-setup-2',
          ghost: {
            id: 'second-plugin',
            name: 'Second Plugin',
          },
        },
      },
    ]);
    await makerChatStore.reconcilePendingInteractions(SESSION_ID);

    const snapshot = makerChatStore.getSnapshot(SESSION_ID);
    expect(snapshot.pendingPluginSetup).toEqual(
      expect.objectContaining({
        requestId: 'plugin-setup-2',
        revision: 3,
      }),
    );
    expect(snapshot.pendingPluginSetupQueue).toEqual([]);
    expect(snapshot.pluginSetupViewerState).toBe('expanded');
  });

  it('preserves plugin_setup state when the authoritative snapshot fetch fails', async () => {
    emitInteractionRequest(pluginSetupRequest(1));
    emitInteractionRequest({
      ...pluginSetupRequest(1),
      requestId: 'plugin-setup-2',
      ghost: {
        id: 'second-plugin',
        name: 'Second Plugin',
      },
    });
    makerChatStore.setPluginSetupViewerState(SESSION_ID, 'minimized');
    makerChatStore.respondToPluginSetup(
      SESSION_ID,
      'plugin-setup-1',
      'run_action',
      'oauth:google-account',
    );
    const before = makerChatStore.getSnapshot(SESSION_ID);

    getPendingInteractions.mockRejectedValueOnce(new Error('device link disconnected'));
    await expect(makerChatStore.reconcilePendingInteractions(SESSION_ID)).rejects.toThrow(
      'device link disconnected',
    );

    const after = makerChatStore.getSnapshot(SESSION_ID);
    expect(after.pendingPluginSetup).toBe(before.pendingPluginSetup);
    expect(after.pendingPluginSetupQueue).toBe(before.pendingPluginSetupQueue);
    expect(after.pluginSetupCommandInFlight).toBe(before.pluginSetupCommandInFlight);
    expect(after.pluginSetupViewerState).toBe('minimized');
  });

  it('pins interaction snapshots to the last known remote device while the origin map is rebuilding', async () => {
    remoteProjectsStore.pinSessionOrigin('device-1', SESSION_ID);
    expect(getStickySessionDeviceId(SESSION_ID)).toBe('device-1');
    remoteProjectsStore.__resetPinnedOriginsForTest();
    getPendingInteractions.mockClear();
    deviceLinkInvoke.mockImplementation(async (deviceId, channel, args) => {
      expect(deviceId).toBe('device-1');
      expect(channel).toBe('maker:get-pending-interactions');
      expect(args).toEqual([SESSION_ID]);
      return [
        {
          request: {
            kind: 'plan_review',
            requestId: 'remote-plan-review',
            plan: '# Remote plan',
          },
          persistId: 'persist-remote-plan-review',
        },
      ];
    });

    await expect(makerChatStore.reconcilePendingInteractions(SESSION_ID)).resolves.toBe(1);

    expect(getPendingInteractions).not.toHaveBeenCalled();
    expect(deviceLinkInvoke).toHaveBeenCalledTimes(1);
    expect(makerChatStore.getSnapshot(SESSION_ID).pendingPlanReview?.requestId).toBe(
      'remote-plan-review',
    );
  });

  it('does not replay an interaction snapshot that became stale after dismissal', async () => {
    let resolveSnapshot!: (items: Awaited<ReturnType<typeof getPendingInteractions>>) => void;
    getPendingInteractions.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveSnapshot = resolve;
      }),
    );

    const reconcile = makerChatStore.reconcilePendingInteractions(SESSION_ID);
    onInteractionDismissed?.({
      sessionId: SESSION_ID,
      requestId: 'permission-late',
      reason: 'session_closed',
    });
    resolveSnapshot([
      {
        request: {
          kind: 'permission',
          requestId: 'permission-late',
          toolName: 'Read',
          input: { file_path: 'late.ts' },
        },
      },
    ]);

    await expect(reconcile).resolves.toBe(0);
    expect(makerChatStore.getSnapshot(SESSION_ID).pendingPermission).toBeNull();
  });

  it('does not replay an interaction snapshot across a data-owner boundary', async () => {
    let resolveSnapshot!: (items: Awaited<ReturnType<typeof getPendingInteractions>>) => void;
    getPendingInteractions.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveSnapshot = resolve;
      }),
    );

    const reconcile = makerChatStore.reconcilePendingInteractions(SESSION_ID);
    setDataOwnerGeneration('owner-b');
    resolveSnapshot([
      {
        request: {
          kind: 'permission',
          requestId: 'permission-old-owner',
          toolName: 'Read',
          input: { file_path: 'old-owner.ts' },
        },
      },
    ]);

    await expect(reconcile).resolves.toBe(0);
    expect(makerChatStore.getSnapshot(SESSION_ID).pendingPermission).toBeNull();
  });

  it('lets the newest concurrent interaction reconcile win', async () => {
    let resolveFirst!: (items: Awaited<ReturnType<typeof getPendingInteractions>>) => void;
    getPendingInteractions
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveFirst = resolve;
        }),
      )
      .mockResolvedValueOnce([
        {
          request: {
            ...pluginSetupRequest(2),
          },
        },
      ]);

    const first = makerChatStore.reconcilePendingInteractions(SESSION_ID);
    const second = makerChatStore.reconcilePendingInteractions(SESSION_ID);
    await flushPromises();
    expect(makerChatStore.getSnapshot(SESSION_ID).pendingPluginSetup?.revision).toBe(2);

    resolveFirst([
      {
        request: {
          ...pluginSetupRequest(1),
        },
      },
    ]);
    await expect(Promise.all([first, second])).resolves.toEqual([0, 1]);
    expect(makerChatStore.getSnapshot(SESSION_ID).pendingPluginSetup?.revision).toBe(2);
  });

  it('sends the independent plugin_setup decision and waits for a newer snapshot', async () => {
    emitInteractionRequest(pluginSetupRequest(1));

    makerChatStore.respondToPluginSetup(
      SESSION_ID,
      'plugin-setup-1',
      'run_action',
      'oauth:google-account',
    );

    expect(window.electronAPI.maker.resolveInteraction).toHaveBeenCalledWith('plugin-setup-1', {
      kind: 'plugin_setup',
      action: 'run_action',
      actionId: 'oauth:google-account',
      expectedRevision: 1,
    });
    expect(makerChatStore.getSnapshot(SESSION_ID).pendingPluginSetup).not.toBeNull();
    expect(makerChatStore.getSnapshot(SESSION_ID).pluginSetupCommandInFlight).toEqual(
      expect.objectContaining({ action: 'run_action' }),
    );

    emitInteractionRequest(pluginSetupRequest(2));
    expect(makerChatStore.getSnapshot(SESSION_ID).pluginSetupCommandInFlight).toBeNull();
    await flushPromises();
  });

  it('submits an inline Secret only through the local narrow API without retaining it', async () => {
    emitInteractionRequest(inlinePluginSetupRequest(1));

    makerChatStore.respondToPluginSetup(
      SESSION_ID,
      'plugin-setup-1',
      'submit_form',
      'inline:api-key',
      { value: '  secret-value  ' },
    );

    expect(window.electronAPI.maker.submitPluginSetupInline).toHaveBeenCalledWith({
      requestId: 'plugin-setup-1',
      actionId: 'inline:api-key',
      expectedRevision: 1,
      value: 'secret-value',
    });
    expect(window.electronAPI.maker.resolveInteraction).not.toHaveBeenCalled();
    const snapshot = makerChatStore.getSnapshot(SESSION_ID);
    expect(snapshot.pluginSetupCommandInFlight).toEqual({
      requestId: 'plugin-setup-1',
      action: 'submit_form',
      actionId: 'inline:api-key',
    });
    expect(JSON.stringify(snapshot)).not.toContain('secret-value');
    await flushPromises();
  });

  it('rejects oversized or malformed plugin_setup snapshots at the Renderer boundary', () => {
    emitInteractionRequest({
      ...pluginSetupRequest(1),
      intro: 'x'.repeat(501),
    });
    expect(makerChatStore.getSnapshot(SESSION_ID).pendingPluginSetup).toBeNull();

    emitInteractionRequest({
      ...pluginSetupRequest(1),
      steps: [],
    });
    expect(makerChatStore.getSnapshot(SESSION_ID).pendingPluginSetup).toBeNull();

    const unsafeLink = inlinePluginSetupRequest(1);
    unsafeLink.steps[0].action.form.fields[0].externalLink.url = 'http://unsafe.example.com';
    emitInteractionRequest(unsafeLink);
    expect(makerChatStore.getSnapshot(SESSION_ID).pendingPluginSetup).toBeNull();
  });

  it('accepts manifest-max and host-reserve step counts, rejects past the transport cap', () => {
    const step = pluginSetupRequest(1).steps[0];
    const buildSteps = (count: number) =>
      Array.from({ length: count }, (_, index) => ({
        ...step,
        id: `setup-${index}`,
        action: { ...step.action, id: `oauth:${index}` },
      }));

    // manifest 合法声明的步数上限(8 组 × 8 条)。
    emitInteractionRequest({
      ...pluginSetupRequest(1),
      steps: buildSteps(GHOST_SETUP_MAX_STEPS),
    });
    expect(makerChatStore.getSnapshot(SESSION_ID).pendingPluginSetup?.steps).toHaveLength(
      GHOST_SETUP_MAX_STEPS,
    );

    // Host-owned setup provider 可在 manifest 步骤之外追加 Core 步骤,
    // Main → Renderer 的传输上限是 GHOST_SETUP_MAX_INTERACTION_STEPS
    // (= manifest 上限 + Host 保留),打满仍须完整过界。
    makerChatStore.purgeSession(SESSION_ID);
    emitInteractionRequest({
      ...pluginSetupRequest(1),
      requestId: 'plugin-setup-transport-cap',
      steps: buildSteps(GHOST_SETUP_MAX_INTERACTION_STEPS),
    });
    expect(makerChatStore.getSnapshot(SESSION_ID).pendingPluginSetup?.steps).toHaveLength(
      GHOST_SETUP_MAX_INTERACTION_STEPS,
    );

    // 超过传输上限:整卡拒收。
    makerChatStore.purgeSession(SESSION_ID);
    emitInteractionRequest({
      ...pluginSetupRequest(1),
      requestId: 'plugin-setup-oversized',
      steps: buildSteps(GHOST_SETUP_MAX_INTERACTION_STEPS + 1),
    });
    expect(makerChatStore.getSnapshot(SESSION_ID).pendingPluginSetup).toBeNull();
  });

  it('does not flush pending text for unknown or malformed interaction requests', () => {
    emitTextDelta('still pending');

    emitInteractionRequest({
      kind: 'future_interaction',
      requestId: 'future-1',
    });

    expect(makerChatStore.getSnapshot(SESSION_ID).messages).toHaveLength(0);

    emitInteractionRequest({
      kind: 'permission',
      toolName: 'Read',
      input: { file_path: 'a.ts' },
    });

    const snapBeforeTimer = makerChatStore.getSnapshot(SESSION_ID);
    expect(snapBeforeTimer.messages).toHaveLength(0);
    expect(snapBeforeTimer.pendingPermission).toBeNull();

    vi.advanceTimersByTime(32);
    expect(makerChatStore.getSnapshot(SESSION_ID).messages).toEqual([
      expect.objectContaining({
        clientId: 'assistant-1',
        role: 'assistant',
        content: 'still pending',
      }),
    ]);
  });

  it('flushes pending text before an isFinal text confirmation without duplicating content', () => {
    emitTextDelta('a');

    onEvent?.({
      sessionId: SESSION_ID,
      event: {
        type: 'text',
        source: 'claude-code',
        data: { text: 'a', isFinal: true },
      },
      persistId: 'assistant-1',
    });

    vi.advanceTimersByTime(32);

    expect(makerChatStore.getSnapshot(SESSION_ID).messages).toEqual([
      expect.objectContaining({
        clientId: 'assistant-1',
        role: 'assistant',
        content: 'a',
      }),
    ]);
  });

  it('calibrates an in-flight bubble to a shorter authoritative final text', () => {
    emitTextDelta('Hello worxderful');

    onEvent?.({
      sessionId: SESSION_ID,
      event: {
        type: 'text',
        source: 'codex',
        data: { text: 'Hello wonderful', isFinal: true, isFullText: true },
      },
      persistId: 'assistant-1',
    });

    vi.advanceTimersByTime(32);

    const snapshot = makerChatStore.getSnapshot(SESSION_ID);
    expect(snapshot.streamingText).toBe('Hello wonderful');
    expect(snapshot.messages).toEqual([
      expect.objectContaining({
        clientId: 'assistant-1',
        role: 'assistant',
        content: 'Hello wonderful',
      }),
    ]);
  });

  it('keeps accumulated text when an unmarked isFinal event is only a tail block', () => {
    emitTextDelta('Hello ');

    onEvent?.({
      sessionId: SESSION_ID,
      event: {
        type: 'text',
        source: 'claude-code',
        data: { text: 'world', isFinal: true },
      },
      persistId: 'assistant-1',
    });

    vi.advanceTimersByTime(32);

    const snapshot = makerChatStore.getSnapshot(SESSION_ID);
    expect(snapshot.streamingText).toBe('Hello ');
    expect(snapshot.messages).toEqual([
      expect.objectContaining({ content: 'Hello ' }),
    ]);
  });

  it('keeps 1000 ordinary text deltas batched to at most two store commits after the 32ms timer', () => {
    let notifyCount = 0;
    const unsubscribe = makerChatStore.subscribe(SESSION_ID, () => {
      notifyCount += 1;
    });

    for (let i = 0; i < 1000; i++) {
      emitTextDelta('x');
    }

    vi.advanceTimersByTime(31);
    expect(notifyCount).toBe(0);
    expect(makerChatStore.getSnapshot(SESSION_ID).messages).toHaveLength(0);

    vi.advanceTimersByTime(1);
    expect(notifyCount).toBeLessThanOrEqual(2);
    expect(makerChatStore.getSnapshot(SESSION_ID).messages).toEqual([
      expect.objectContaining({
        clientId: 'assistant-1',
        role: 'assistant',
        content: 'x'.repeat(1000),
      }),
    ]);

    unsubscribe();
  });

  it('coalesces 1000 high-frequency thinking updates into one subscriber notification', () => {
    let notifyCount = 0;
    const unsubscribe = makerChatStore.subscribe(SESSION_ID, () => {
      notifyCount += 1;
    });

    onEvent?.({
      sessionId: SESSION_ID,
      event: {
        type: 'thinking',
        source: 'codex',
        data: { stage: 'start', blockId: 'thinking-flood', startedAt: Date.now() },
      },
    });
    for (let i = 0; i < 999; i++) {
      onEvent?.({
        sessionId: SESSION_ID,
        event: {
          type: 'thinking',
          source: 'codex',
          data: { stage: 'delta', blockId: 'thinking-flood', text: 'x' },
        },
      });
    }

    expect(notifyCount).toBe(0);
    expect(makerChatStore.getSnapshot(SESSION_ID).messages[0]).toMatchObject({
      clientId: 'thinking-flood',
      content: 'x'.repeat(999),
    });

    vi.advanceTimersByTime(32);
    expect(notifyCount).toBe(1);
    unsubscribe();
  });

  it('keeps coalescing live tool DB echoes after Stop has optimistically gone idle', () => {
    emitStatus({ status: 'Running', isRunning: true });
    makerChatStore.stopSession(SESSION_ID);
    expect(makerChatStore.getSnapshot(SESSION_ID).agentStatus.isRunning).toBe(false);
    const eventCount = 800;
    let notifyCount = 0;
    const unsubscribe = makerChatStore.subscribe(SESSION_ID, () => {
      notifyCount += 1;
    });
    vi.mocked(sessionsBus.emitPatch).mockClear();

    for (let i = 0; i < eventCount; i++) {
      onEvent?.({
        sessionId: SESSION_ID,
        event: {
          type: 'tool_use',
          source: 'codex',
          data: {
            toolUseId: `tool-use-${i}`,
            toolName: 'Read',
            input: { file_path: `file-${i}.ts` },
          },
        },
        persistId: `tool-row-${i}`,
      });
      emitDbMessageCreated({
        clientId: `tool-row-${i}`,
        role: 'tool_use',
        content: {
          toolUseId: `tool-use-${i}`,
          toolName: 'Read',
          input: { file_path: `file-${i}.ts` },
        },
        toolUseId: `tool-use-${i}`,
        createdAt: new Date(Date.UTC(2026, 5, 15) + i).toISOString(),
      });
    }

    expect(notifyCount).toBe(0);
    expect(sessionsBus.emitPatch).not.toHaveBeenCalled();
    expect(makerChatStore.getSnapshot(SESSION_ID).messages).toHaveLength(eventCount);
    expect(makerChatStore.getSnapshot(SESSION_ID).messages[eventCount - 1]).toMatchObject({
      clientId: 'tool-row-799',
      role: 'tool_use',
      toolUseId: 'tool-use-799',
      toolName: 'Read',
    });

    vi.advanceTimersByTime(32);
    expect(notifyCount).toBe(1);
    expect(sessionsBus.emitPatch).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it('flushes a pending high-frequency batch immediately when terminal done arrives', () => {
    let notifyCount = 0;
    const unsubscribe = makerChatStore.subscribe(SESSION_ID, () => {
      notifyCount += 1;
    });

    onEvent?.({
      sessionId: SESSION_ID,
      event: {
        type: 'tool_use',
        source: 'codex',
        data: { toolUseId: 'tool-flood', toolName: 'exec', input: {} },
      },
      persistId: 'tool-flood-row',
    });
    expect(notifyCount).toBe(0);

    onEvent?.({
      sessionId: SESSION_ID,
      event: { type: 'done', source: 'codex', data: {} },
    });
    expect(notifyCount).toBe(1);

    vi.advanceTimersByTime(32);
    expect(notifyCount).toBe(1);
    unsubscribe();
  });

  it('flushes at most 8 streaming sessions per timer tick', () => {
    for (const [index, sessionId] of MULTI_SESSION_IDS.entries()) {
      emitTextDelta(`s${index}`, sessionId);
    }

    vi.advanceTimersByTime(32);

    const flushedAfterFirstTick = MULTI_SESSION_IDS.filter(
      (sessionId) => makerChatStore.getSnapshot(sessionId).messages.length > 0,
    );
    expect(flushedAfterFirstTick).toEqual(MULTI_SESSION_IDS.slice(0, 8));
    for (const sessionId of MULTI_SESSION_IDS.slice(8)) {
      expect(makerChatStore.getSnapshot(sessionId).messages).toHaveLength(0);
    }

    vi.advanceTimersByTime(32);
    for (const [index, sessionId] of MULTI_SESSION_IDS.entries()) {
      expect(makerChatStore.getSnapshot(sessionId).messages).toEqual([
        expect.objectContaining({
          clientId: 'assistant-1',
          role: 'assistant',
          content: `s${index}`,
        }),
      ]);
    }
  });

  it('does not starve a Map-only sidebar patch behind 8 continuously active sessions', () => {
    const patchOnlySessionId = MULTI_SESSION_IDS[8];
    onEvent?.({
      sessionId: patchOnlySessionId,
      event: {
        type: 'tool_use',
        source: 'codex',
        data: { toolUseId: 'fair-tool', toolName: 'Read', input: { file_path: 'fair.ts' } },
      },
      persistId: 'fair-tool-row',
    });
    const persistedTool = {
      clientId: 'fair-tool-row',
      role: 'tool_use' as const,
      content: {
        toolUseId: 'fair-tool',
        toolName: 'Read',
        input: { file_path: 'fair.ts' },
      },
      toolUseId: 'fair-tool',
      createdAt: '2026-06-15T00:00:00.000Z',
    };
    emitDbMessageCreated(persistedTool, patchOnlySessionId);
    vi.advanceTimersByTime(32);
    vi.mocked(sessionsBus.emitPatch).mockClear();

    for (const sessionId of MULTI_SESSION_IDS.slice(0, 8)) {
      onEvent?.({
        sessionId,
        event: {
          type: 'thinking',
          source: 'codex',
          data: { stage: 'delta', blockId: 'fairness', text: 'a' },
        },
      });
    }
    // 完全相同的 DB echo 让 setState 走 no-op，只剩 sidebar patch 待发。
    emitDbMessageCreated(persistedTool, patchOnlySessionId);

    vi.advanceTimersByTime(32);
    expect(sessionsBus.emitPatch).not.toHaveBeenCalled();

    for (const sessionId of MULTI_SESSION_IDS.slice(0, 8)) {
      onEvent?.({
        sessionId,
        event: {
          type: 'thinking',
          source: 'codex',
          data: { stage: 'delta', blockId: 'fairness', text: 'b' },
        },
      });
    }
    vi.advanceTimersByTime(32);

    expect(sessionsBus.emitPatch).toHaveBeenCalledTimes(1);
    expect(sessionsBus.emitPatch).toHaveBeenCalledWith(patchOnlySessionId, {
      updatedAt: expect.any(String),
    });
  });

  it('flushes pending text before a closed status finalizes the session', () => {
    emitTextDelta('a');

    onStatusChanged?.({ sessionId: SESSION_ID, status: 'closed' });

    expect(makerChatStore.getSnapshot(SESSION_ID).messages).toEqual([
      expect.objectContaining({
        clientId: 'assistant-1',
        role: 'assistant',
        content: 'a',
        isStreaming: false,
      }),
    ]);
  });

  it('flushes pending text before stop resets streaming state', () => {
    emitTextDelta('a');

    makerChatStore.stopSession(SESSION_ID);
    vi.advanceTimersByTime(32);

    expect(makerChatStore.getSnapshot(SESSION_ID).messages).toEqual([
      expect.objectContaining({
        clientId: 'assistant-1',
        role: 'assistant',
        content: 'a',
        isStreaming: false,
      }),
    ]);
  });

  it('sends Stop IPC before flushing pending renderer work', () => {
    emitStatus({ status: 'Running', isRunning: true });
    const order: string[] = [];
    input.stop.mockImplementationOnce(async (sessionId: string) => {
      order.push('ipc');
      return projection(sessionId);
    });
    const unsubscribe = makerChatStore.subscribe(SESSION_ID, () => {
      order.push('notify');
    });
    emitTextDelta('pending');

    makerChatStore.stopSession(SESSION_ID);

    expect(input.stop).toHaveBeenCalledWith(SESSION_ID, undefined);
    expect(order[0]).toBe('ipc');
    expect(order).toContain('notify');
    expect(makerChatStore.getSnapshot(SESSION_ID).agentStatus.isRunning).toBe(false);
    unsubscribe();
  });

  it('ignores placeholder 0/0 context snapshots on Done status', () => {
    emitStatus({
      status: 'Done',
      isRunning: false,
      tokenUsage: 1200,
      contextTokens: 433_000,
      contextWindow: 1_000_000,
    });

    emitStatus({
      status: 'Done',
      isRunning: false,
      tokenUsage: 1200,
      contextTokens: 0,
      contextWindow: 0,
    });

    expect(makerChatStore.getSnapshot(SESSION_ID).agentStatus).toEqual(
      expect.objectContaining({
        contextTokens: 433_000,
        contextWindow: 1_000_000,
      }),
    );
  });

  it('accepts valid lower context snapshots on Done status', () => {
    emitStatus({
      status: 'Done',
      isRunning: false,
      tokenUsage: 1200,
      contextTokens: 860_000,
      contextWindow: 1_000_000,
    });

    emitStatus({
      status: 'Done',
      isRunning: false,
      tokenUsage: 1300,
      contextTokens: 120_000,
      contextWindow: 1_000_000,
    });

    expect(makerChatStore.getSnapshot(SESSION_ID).agentStatus).toEqual(
      expect.objectContaining({
        contextTokens: 120_000,
        contextWindow: 1_000_000,
      }),
    );
  });

  it('discards pending text when clearing or reloading the session', async () => {
    emitTextDelta('a');

    makerChatStore.clearSession(SESSION_ID);
    await flushPromises();
    vi.advanceTimersByTime(32);

    expect(makerChatStore.getSnapshot(SESSION_ID).messages).toEqual([]);

    emitTextDelta('b');
    makerChatStore.reloadMessages(SESSION_ID);
    vi.advanceTimersByTime(32);

    expect(makerChatStore.getSnapshot(SESSION_ID).messages).toEqual([]);
  });

  it('waits for the clear guard before wiping local messages when it completes promptly', async () => {
    let resolveClear: ((value: AgentInputProjection) => void) | undefined;
    input.clearSession.mockReturnValueOnce(
      new Promise<AgentInputProjection>((resolve) => {
        resolveClear = resolve;
      }),
    );

    emitTextDelta('a');
    vi.advanceTimersByTime(32);
    expect(makerChatStore.getSnapshot(SESSION_ID).messages).toHaveLength(1);

    makerChatStore.clearSession(SESSION_ID);
    await flushPromises();

    expect(input.clearSession).toHaveBeenCalledWith(SESSION_ID, expect.any(String));
    expect(makerChatStore.getSnapshot(SESSION_ID).messages).toHaveLength(1);

    expect(resolveClear).toBeDefined();
    resolveClear?.(projection(SESSION_ID));
    await flushPromises();

    expect(makerChatStore.getSnapshot(SESSION_ID).messages).toEqual([]);
  });

  it('continues clearing local state when the clear guard hangs', async () => {
    input.clearSession.mockReturnValueOnce(new Promise<AgentInputProjection>(() => {}));

    emitTextDelta('a');
    vi.advanceTimersByTime(32);
    expect(makerChatStore.getSnapshot(SESSION_ID).messages).toHaveLength(1);

    makerChatStore.clearSession(SESSION_ID);
    await flushPromises();

    expect(input.clearSession).toHaveBeenCalledWith(SESSION_ID, expect.any(String));
    expect(makerChatStore.getSnapshot(SESSION_ID).messages).toHaveLength(1);

    vi.advanceTimersByTime(500);
    await flushPromises();

    expect(makerChatStore.getSnapshot(SESSION_ID).messages).toEqual([]);
    expect(sessionService.update).toHaveBeenCalledWith(SESSION_ID, {
      sdkSessionId: null,
      clearedAt: expect.any(String),
    });
  });

  it('does not reinsert pre-clear DB messages when the clear guard times out', async () => {
    input.clearSession.mockReturnValueOnce(new Promise<AgentInputProjection>(() => {}));

    emitTextDelta('a');
    vi.advanceTimersByTime(32);
    expect(makerChatStore.getSnapshot(SESSION_ID).messages).toHaveLength(1);

    makerChatStore.clearSession(SESSION_ID);
    await flushPromises();

    const clearedAt = input.clearSession.mock.calls[0]?.[1];
    expect(typeof clearedAt).toBe('string');

    vi.advanceTimersByTime(500);
    await flushPromises();
    expect(makerChatStore.getSnapshot(SESSION_ID).messages).toEqual([]);

    const boundaryMs = new Date(clearedAt as string).getTime();
    emitDbMessageCreated({
      clientId: 'old-assistant-row',
      role: 'assistant',
      content: 'old',
      createdAt: new Date(boundaryMs).toISOString(),
    });

    expect(makerChatStore.getSnapshot(SESSION_ID).messages).toEqual([]);

    emitDbMessageCreated({
      clientId: 'new-assistant-row',
      role: 'assistant',
      content: 'new',
      createdAt: new Date(boundaryMs + 1).toISOString(),
    });

    expect(makerChatStore.getSnapshot(SESSION_ID).messages.map((m) => m.content)).toEqual(['new']);
  });

  it('continues clearing local state when the clear guard fails', async () => {
    input.clearSession.mockRejectedValueOnce(new Error('ipc failed'));

    emitTextDelta('a');
    vi.advanceTimersByTime(32);
    expect(makerChatStore.getSnapshot(SESSION_ID).messages).toHaveLength(1);

    makerChatStore.clearSession(SESSION_ID);
    await flushPromises();

    expect(input.clearSession).toHaveBeenCalledWith(SESSION_ID, expect.any(String));
    expect(makerChatStore.getSnapshot(SESSION_ID).messages).toEqual([]);
    expect(sessionService.update).toHaveBeenCalledWith(SESSION_ID, {
      sdkSessionId: null,
      clearedAt: expect.any(String),
    });
  });

  it('keeps recoverable errors busy without treating them as terminal failures', async () => {
    onEvent?.({
      sessionId: SESSION_ID,
      event: {
        type: 'status',
        source: 'codex',
        data: { status: 'Running', isRunning: true },
      },
    });
    onEvent?.({
      sessionId: SESSION_ID,
      event: {
        type: 'error',
        source: 'codex',
        data: { message: '401 retry-loop', isTerminal: false, willRetry: true },
      },
    });

    makerChatStore.sendMessage(SESSION_ID, 'next', MODEL, EFFORT, PERMISSION_MODE, WORKING_DIR);
    await flushPromises();

    const snap = makerChatStore.getSnapshot(SESSION_ID);
    expect(snap.error).toBeNull();
    expect(snap.recoverableError).toBe('401 retry-loop');
    expect(snap.agentStatus.isRunning).toBe(true);
    expect(snap.pendingQueue).toHaveLength(1);
    expect(snap.pendingQueue[0]?.text).toBe('next');
    expect(snap.messages.some((m) => m.role === 'user' && m.content === 'next')).toBe(false);
    expect(makerChatStore.getRunningSnapshot().get(SESSION_ID)?.hasError).toBe(false);
  });

  it('treats a recoverable error as busy even before a running status arrives', async () => {
    onEvent?.({
      sessionId: SESSION_ID,
      event: {
        type: 'error',
        source: 'codex',
        data: { message: 'transient retry', willRetry: true },
      },
    });

    makerChatStore.sendMessage(SESSION_ID, 'next', MODEL, EFFORT, PERMISSION_MODE, WORKING_DIR);
    await flushPromises();

    const snap = makerChatStore.getSnapshot(SESSION_ID);
    expect(snap.error).toBeNull();
    expect(snap.recoverableError).toBe('transient retry');
    expect(snap.agentStatus.isRunning).toBe(true);
    expect(snap.pendingQueue).toHaveLength(1);
    expect(snap.messages.some((m) => m.role === 'user' && m.content === 'next')).toBe(false);
  });

  it('does not flip product isRunning for background compact status', () => {
    emitStatus({ status: 'Done', isRunning: false });
    expect(makerChatStore.getSnapshot(SESSION_ID).agentStatus.isRunning).toBe(false);

    onEvent?.({
      sessionId: SESSION_ID,
      event: {
        type: 'status',
        source: 'pi',
        turnScope: 'background',
        data: {
          status: 'Compacting context…',
          isRunning: true,
          tokenUsage: 0,
          contextTokens: 415010,
          contextWindow: 500000,
        },
      },
    });

    const snap = makerChatStore.getSnapshot(SESSION_ID);
    expect(snap.agentStatus.isRunning).toBe(false);
    expect(snap.agentStatus.status).toBe('Compacting context…');
    expect(snap.agentStatus.contextTokens).toBe(415010);
    expect(snap.agentStatus.contextWindow).toBe(500000);
  });

  it('does not paint a live turn as Done when a late background compact status arrives', () => {
    emitStatus({ status: 'Thinking…', isRunning: true });
    expect(makerChatStore.getSnapshot(SESSION_ID).agentStatus.isRunning).toBe(true);

    onEvent?.({
      sessionId: SESSION_ID,
      event: {
        type: 'status',
        source: 'pi',
        turnScope: 'background',
        data: {
          status: 'Done',
          isRunning: false,
          tokenUsage: 0,
          contextTokens: 20000,
          contextWindow: 500000,
        },
      },
    });

    const snap = makerChatStore.getSnapshot(SESSION_ID);
    expect(snap.agentStatus.isRunning).toBe(true);
    expect(snap.agentStatus.status).toBe('Thinking…');
    expect(snap.agentStatus.contextTokens).toBe(20000);
  });

  // 本地 only 迁移后,网关 key 无服务器副本,401 不再触发"从服务器重拉 key"。
  // 原先验证 refreshApiKeyFromServer 调用次数的两个用例(terminal → 重拉、recoverable
  // → 不重拉)随该行为一并移除。非 remote 会话的 401 直接把 error 浮现给用户。

  it('keeps structured auth status visible to the error banner after redaction', () => {
    onEvent?.({
      sessionId: SESSION_ID,
      event: {
        type: 'error',
        source: 'codex',
        data: {
          errorStatus: 401,
          message: 'Authorization: [REDACTED]',
          isTerminal: true,
        },
      },
    });

    expect(makerChatStore.getSnapshot(SESSION_ID).error).toBe(
      'Authorization: [REDACTED] (HTTP 401)',
    );
  });

  it('does not run the legacy remote auth retry path for Codex auth errors', async () => {
    vi.mocked(sessionService.get).mockResolvedValue({
      agentKind: 'codex',
      remoteHostId: 'remote-host',
      sdkSessionId: null,
      fastMode: false,
      contextTokens: 0,
      contextWindow: 0,
      totalCostUsd: 0,
      workingDir: WORKING_DIR,
      model: MODEL,
      effort: EFFORT,
      permissionMode: PERMISSION_MODE,
    } as unknown as Awaited<ReturnType<typeof sessionService.get>>);
    makerChatStore.ensureInitialMessages(SESSION_ID);
    await flushPromises();
    emitDbMessageCreated({
      id: 'user-row',
      clientId: 'user-client',
      role: 'user',
      content: 'show sync auth',
      createdAt: '2026-01-01T00:00:01.000Z',
    });

    onEvent?.({
      sessionId: SESSION_ID,
      event: {
        type: 'error',
        source: 'codex',
        data: { errorStatus: 401, message: 'Authorization: [REDACTED]' },
        // 真实 Codex 事件没有 agentMeta（SDK 无 uuid 概念）——不注入合成值，
        // 正好覆盖双写修复：renderer 不再 deferred 补落，main 热路径唯一落库。
        agentMeta: null,
      },
    });
    await flushPromises();

    expect(window.electronAPI.safeStorageRead).not.toHaveBeenCalled();
    expect(window.electronAPI.maker.closeSession).not.toHaveBeenCalled();
    expect(input.enqueue).not.toHaveBeenCalled();
    // main 侧 isRemoteAuthRetryErrorEvent 对 codex 返回 false，error 行走正常
    // onTurnErrorEvent 落库；renderer 再 deferred 会双写（dedup key 对不上）。
    expect(input.persistTurnErrorDeferred).not.toHaveBeenCalled();
    expect(makerChatStore.getSnapshot(SESSION_ID).error).toBe(
      'Authorization: [REDACTED] (HTTP 401)',
    );
  });

  it('keeps remote auth retry side effects in the primary renderer', async () => {
    makerChatStore.__teardownGlobalListeners();
    makerChatStore.initGlobalListeners({ ownsRemoteAuthRetry: false });
    vi.mocked(sessionService.get).mockResolvedValue({
      agentKind: 'cc',
      remoteHostId: 'remote-host',
      sdkSessionId: null,
      fastMode: false,
      contextTokens: 0,
      contextWindow: 0,
      totalCostUsd: 0,
      workingDir: WORKING_DIR,
      model: MODEL,
      effort: EFFORT,
      permissionMode: PERMISSION_MODE,
    } as unknown as Awaited<ReturnType<typeof sessionService.get>>);
    makerChatStore.ensureInitialMessages(SESSION_ID);
    await flushPromises();
    emitDbMessageCreated({
      id: 'user-row',
      clientId: 'user-client',
      role: 'user',
      content: 'retry only in primary renderer',
      createdAt: '2026-01-01T00:00:01.000Z',
    });

    onEvent?.({
      sessionId: SESSION_ID,
      event: {
        type: 'error',
        source: 'claude-code',
        data: { sdkError: 'authentication_failed', message: '401 expired' },
        agentMeta: { sdkSessionId: 'sdk-1' },
      },
    });
    await flushPromises();

    expect(window.electronAPI.safeStorageRead).not.toHaveBeenCalled();
    expect(window.electronAPI.maker.closeSession).not.toHaveBeenCalled();
    expect(input.enqueue).not.toHaveBeenCalled();
    expect(input.persistTurnErrorDeferred).not.toHaveBeenCalled();
    expect(makerChatStore.getSnapshot(SESSION_ID).error).toBe('401 expired');
  });

  it('persists the original remote auth error when retry enqueue rejects asynchronously', async () => {
    vi.mocked(sessionService.get).mockResolvedValue({
      agentKind: 'cc',
      remoteHostId: 'remote-host',
      sdkSessionId: null,
      fastMode: false,
      contextTokens: 0,
      contextWindow: 0,
      totalCostUsd: 0,
      workingDir: WORKING_DIR,
      model: MODEL,
      effort: EFFORT,
      permissionMode: PERMISSION_MODE,
    } as unknown as Awaited<ReturnType<typeof sessionService.get>>);
    makerChatStore.ensureInitialMessages(SESSION_ID);
    await flushPromises();
    emitDbMessageCreated({
      id: 'user-row',
      clientId: 'user-client',
      role: 'user',
      content: 'retry me',
      createdAt: '2026-01-01T00:00:01.000Z',
    });
    input.enqueue.mockRejectedValueOnce(new Error('remote went offline'));

    onEvent?.({
      sessionId: SESSION_ID,
      event: {
        type: 'error',
        source: 'claude-code',
        data: { errorStatus: 401, message: 'Authorization: [REDACTED]' },
        agentMeta: { sdkSessionId: 'sdk-1' },
      },
    });
    await flushPromises();
    await vi.advanceTimersByTimeAsync(1500);
    await flushPromises();

    expect(input.persistTurnErrorDeferred).toHaveBeenCalledWith(
      SESSION_ID,
      { errorStatus: 401, message: 'Authorization: [REDACTED]' },
      { sdkSessionId: 'sdk-1' },
    );
  });

  it('persists the original remote auth error when an accepted retry returns a projection error', async () => {
    vi.mocked(sessionService.get).mockResolvedValue({
      agentKind: 'cc',
      remoteHostId: 'remote-host',
      sdkSessionId: null,
      fastMode: false,
      contextTokens: 0,
      contextWindow: 0,
      totalCostUsd: 0,
      workingDir: WORKING_DIR,
      model: MODEL,
      effort: EFFORT,
      permissionMode: PERMISSION_MODE,
    } as unknown as Awaited<ReturnType<typeof sessionService.get>>);
    makerChatStore.ensureInitialMessages(SESSION_ID);
    await flushPromises();
    emitDbMessageCreated({
      id: 'user-row',
      clientId: 'user-client',
      role: 'user',
      content: 'retry me',
      createdAt: '2026-01-01T00:00:01.000Z',
    });
    input.enqueue.mockImplementationOnce(async (sessionId: string, item: AgentInputQueuedMessage) =>
      projection(sessionId, {
        pendingQueue: [item],
        error: 'remote went offline',
        errorRetryText: 'retry me',
      }),
    );

    onEvent?.({
      sessionId: SESSION_ID,
      event: {
        type: 'error',
        source: 'claude-code',
        data: { sdkError: 'authentication_failed', message: '401 expired' },
        agentMeta: { sdkSessionId: 'sdk-1' },
      },
    });
    await flushPromises();
    await vi.advanceTimersByTimeAsync(1500);
    await flushPromises();

    expect(input.persistTurnErrorDeferred).toHaveBeenCalledWith(
      SESSION_ID,
      { sdkError: 'authentication_failed', message: '401 expired' },
      { sdkSessionId: 'sdk-1' },
    );
  });

  it('preserves semantic references, paste and slash metadata when retrying remote authentication', async () => {
    const agentReferences = [
      {
        kind: 'session' as const,
        start: 0,
        end: 5,
        href: 'cindy://session/source',
        sessionId: 'source',
      },
    ];
    vi.mocked(sessionService.get).mockResolvedValue({
      agentKind: 'cc',
      remoteHostId: 'remote-host',
      sdkSessionId: null,
      fastMode: false,
      contextTokens: 0,
      contextWindow: 0,
      totalCostUsd: 0,
      workingDir: WORKING_DIR,
      model: MODEL,
      effort: EFFORT,
      permissionMode: PERMISSION_MODE,
    } as unknown as Awaited<ReturnType<typeof sessionService.get>>);
    makerChatStore.ensureInitialMessages(SESSION_ID);
    await flushPromises();
    input.enqueue.mockImplementationOnce(async (sessionId: string) => projection(sessionId));
    await makerChatStore.sendMessage(
      SESSION_ID,
      'retry metadata',
      MODEL,
      EFFORT,
      PERMISSION_MODE,
      WORKING_DIR,
      undefined,
      undefined,
      {
        agentReferences,
        pastedTextRanges: [{ start: 0, end: 5, display: 'retry' }],
        slashCommandRanges: [],
      },
    );
    input.enqueue.mockClear();

    onEvent?.({
      sessionId: SESSION_ID,
      event: {
        type: 'error',
        source: 'claude-code',
        data: { sdkError: 'authentication_failed', message: '401 expired' },
      },
    });
    await flushPromises();
    await vi.advanceTimersByTimeAsync(1500);
    await flushPromises();

    const retried = input.enqueue.mock.calls[0]?.[1];
    expect(retried?.chatMessage.agentReferences).toEqual(agentReferences);
    expect(retried?.chatMessage.pastedTextRanges).toEqual([{ start: 0, end: 5, display: 'retry' }]);
    expect(retried?.chatMessage.slashCommandRanges).toEqual([]);
  });

  it('restores semantic reference metadata from persisted user messages', () => {
    const agentReferences = [
      {
        kind: 'message' as const,
        start: 4,
        end: 44,
        href: 'cindy://session/source?message=message-1',
        sessionId: 'source',
        messageClientId: 'message-1',
        text: 'referenced body',
      },
    ];
    const [mapped] = makerChatStore.__mapServerMessagesForTest([
      {
        id: 'row-user-reference',
        clientId: 'user-reference',
        sessionId: SESSION_ID,
        role: 'user',
        content: JSON.stringify({
          text: 'see cindy://session/source?message=message-1',
          agentReferences,
        }),
        toolUseId: null,
        agentMeta: null,
        createdAt: '2026-07-24T00:00:00.000Z',
      } satisfies Message,
    ]);

    expect(mapped).toEqual(
      expect.objectContaining({
        content: 'see cindy://session/source?message=message-1',
        agentReferences,
      }),
    );
  });

  it('uses the main projection to preserve a pre-dispatch message in the queue', async () => {
    makerChatStore.sendMessage(SESSION_ID, 'queued', MODEL, EFFORT, PERMISSION_MODE, WORKING_DIR);
    await flushPromises();

    const snap = makerChatStore.getSnapshot(SESSION_ID);
    expect(input.enqueue).toHaveBeenCalledTimes(1);
    expect(snap.pendingQueue).toHaveLength(1);
    expect(snap.pendingQueue[0]?.text).toBe('queued');
    expect(snap.messages.some((m) => m.role === 'user' && m.content === 'queued')).toBe(false);
  });

  it('dedupes the main DB-created ack for optimistic user bubbles', async () => {
    input.enqueue.mockImplementationOnce(async (sessionId: string) => projection(sessionId));

    makerChatStore.sendMessage(SESSION_ID, 'accepted', MODEL, EFFORT, PERMISSION_MODE, WORKING_DIR);
    await flushPromises();

    const optimistic = makerChatStore
      .getSnapshot(SESSION_ID)
      .messages.find((m) => m.role === 'user' && m.content === 'accepted');
    expect(optimistic).toEqual(expect.objectContaining({ isPendingPersist: true }));

    onDbMessageCreated?.({
      sessionId: SESSION_ID,
      message: {
        clientId: optimistic?.clientId,
        role: 'user',
        content: 'accepted',
        createdAt: new Date().toISOString(),
      },
    });

    const messages = makerChatStore.getSnapshot(SESSION_ID).messages;
    expect(messages.filter((m) => m.role === 'user' && m.content === 'accepted')).toHaveLength(1);
  });

  it('shows a device-link busy send before remote preflight and enqueue settle', async () => {
    remoteProjectsStore.pinSessionOrigin('device-1', SESSION_ID);
    makerChatStore.__applyStatusUpdateForTest(SESSION_ID, {
      sessionId: SESSION_ID,
      status: 'running',
      tokenUsage: 0,
      contextTokens: 0,
      contextWindow: 0,
      isRunning: true,
    });
    let resolvePreflight!: (value: boolean) => void;
    const preflight = new Promise<boolean>((resolve) => {
      resolvePreflight = resolve;
    });
    let resolveEnqueue!: (value: AgentInputProjection) => void;
    let queued: AgentInputQueuedMessage | undefined;
    deviceLinkInvoke.mockImplementation(async (_deviceId, channel, args) => {
      if (channel === 'maker:input:enqueue') {
        queued = args[1] as AgentInputQueuedMessage;
        return new Promise<AgentInputProjection>((resolve) => {
          resolveEnqueue = resolve;
        });
      }
      if (channel === 'maker:input:get-projection') return projection(SESSION_ID);
      throw new Error(`unexpected remote channel: ${channel}`);
    });

    const send = makerChatStore.sendMessage(
      SESSION_ID,
      'remote queued',
      MODEL,
      EFFORT,
      PERMISSION_MODE,
      WORKING_DIR,
      undefined,
      undefined,
      { beforeEnqueue: () => preflight },
    );

    expect(
      deviceLinkInvoke.mock.calls.some(([, channel]) => channel === 'maker:input:enqueue'),
    ).toBe(false);
    expect(makerChatStore.getSnapshot(SESSION_ID).pendingQueue).toEqual([
      expect.objectContaining({ text: 'remote queued', isPendingEnqueue: true }),
    ]);
    await expect(send).resolves.toBe(true);

    resolvePreflight(true);
    await flushPromises();
    expect(deviceLinkInvoke).toHaveBeenCalledWith(
      'device-1',
      'maker:input:enqueue',
      expect.any(Array),
    );
    expect(makerChatStore.getSnapshot(SESSION_ID).pendingQueue[0]).toEqual(
      expect.objectContaining({ isPendingEnqueue: true }),
    );

    resolveEnqueue(projection(SESSION_ID, { pendingQueue: queued ? [queued] : [] }));
    await flushPromises();
    expect(makerChatStore.getSnapshot(SESSION_ID).pendingQueue[0]).toEqual(
      expect.objectContaining({ text: 'remote queued' }),
    );
    expect(
      makerChatStore.getSnapshot(SESSION_ID).pendingQueue[0]?.isPendingEnqueue,
    ).toBeUndefined();
  });

  it('reuses a hydrated remote clear token for the first optimistic dispatch', async () => {
    const clearBoundaryMs = Date.parse('2026-08-03T00:00:00.000Z');
    let projectionProbes = 0;
    let enqueueOpts: unknown;
    deviceLinkInvoke.mockImplementation(async (_deviceId, channel, args) => {
      if (channel === 'maker:input:get-projection') {
        projectionProbes += 1;
        return projection(SESSION_ID, { clearBoundaryMs });
      }
      if (channel === 'maker:input:enqueue') {
        enqueueOpts = args[2];
        const item = args[1] as AgentInputQueuedMessage;
        return projection(SESSION_ID, { clearBoundaryMs, pendingQueue: [item] });
      }
      throw new Error(`unexpected remote channel: ${channel}`);
    });
    remoteProjectsStore.pinSessionOrigin('device-1', SESSION_ID);
    onInputProjection?.(projection(SESSION_ID, { clearBoundaryMs }));
    projectionProbes = 0;
    deviceLinkInvoke.mockClear();

    await expect(
      makerChatStore.sendMessage(
        SESSION_ID,
        'probe before dispatch',
        MODEL,
        EFFORT,
        PERMISSION_MODE,
        WORKING_DIR,
      ),
    ).resolves.toBe(true);
    await flushPromises();

    // pinSessionOrigin starts the normal remote-origin reconciliation probe;
    // the outbox itself must reuse the hydrated token rather than issue another
    // probe before enqueue.
    expect(projectionProbes).toBe(1);
    expect(enqueueOpts).toEqual(
      expect.objectContaining({ expectedClearBoundaryMs: clearBoundaryMs }),
    );
  });

  it('keeps a probe alive when the remote clear is sealing, then retries it', async () => {
    remoteProjectsStore.pinSessionOrigin('device-1', SESSION_ID);
    let projectionProbes = 0;
    let enqueueCalls = 0;
    deviceLinkInvoke.mockImplementation(async (_deviceId, channel, args) => {
      if (channel === 'maker:input:get-projection') {
        projectionProbes += 1;
        if (projectionProbes === 1) {
          throw new Error('REMOTE_OPTIMISTIC_INPUT_CLEARED: session clear is still sealing');
        }
        return projection(SESSION_ID);
      }
      if (channel === 'maker:input:enqueue') {
        enqueueCalls += 1;
        return projection(SESSION_ID, { pendingQueue: [args[1] as AgentInputQueuedMessage] });
      }
      throw new Error(`unexpected remote channel: ${channel}`);
    });

    await expect(
      makerChatStore.sendMessage(
        SESSION_ID,
        'retry after sealing',
        MODEL,
        EFFORT,
        PERMISSION_MODE,
        WORKING_DIR,
      ),
    ).resolves.toBe(true);
    await flushPromises();
    expect(enqueueCalls).toBe(0);

    onDeviceLinkStatusChanged?.({ status: 'online' });
    await flushPromises();
    expect(projectionProbes).toBe(2);
    expect(enqueueCalls).toBe(1);
  });

  it('rejects a stale modern projection before it can overwrite the new clear epoch', () => {
    remoteProjectsStore.pinSessionOrigin('device-1', SESSION_ID);
    const clearBoundaryMs = Date.parse('2026-08-03T00:00:00.000Z');
    onInputProjection?.(
      projection(SESSION_ID, {
        clearBoundaryMs,
        error: 'current epoch error',
        queueInteractionLocks: ['current-lock'],
      }),
    );
    expect(makerChatStore.getSnapshot(SESSION_ID).error).toBe('current epoch error');

    onInputProjection?.(
      projection(SESSION_ID, {
        clearBoundaryMs: null,
        error: 'stale epoch error',
        queueInteractionLocks: ['stale-lock'],
      }),
    );

    expect(makerChatStore.getSnapshot(SESSION_ID).error).toBe('current epoch error');
    expect(makerChatStore.getSnapshot(SESSION_ID).queueInteractionLocks).toEqual(['current-lock']);
  });

  it('accepts a source-tagged projection from the sticky origin after the mirror cache is cleared', async () => {
    remoteProjectsStore.pinSessionOrigin('device-1', SESSION_ID);
    let resolveProbe!: (value: AgentInputProjection) => void;
    const restore = vi.fn();
    deviceLinkInvoke.mockImplementation(async (_deviceId, channel) => {
      if (channel === 'maker:input:get-projection') {
        return new Promise<AgentInputProjection>((resolve) => {
          resolveProbe = resolve;
        });
      }
      throw new Error(`unexpected remote channel: ${channel}`);
    });

    await expect(
      makerChatStore.sendMessage(
        SESSION_ID,
        'sticky projection boundary',
        MODEL,
        EFFORT,
        PERMISSION_MODE,
        WORKING_DIR,
        undefined,
        undefined,
        { onRemoteOptimisticFailure: restore },
      ),
    ).resolves.toBe(true);
    await flushPromises();
    expect(makerChatStore.getSnapshot(SESSION_ID).messages).toEqual([
      expect.objectContaining({ content: 'sticky projection boundary', isPendingPersist: true }),
    ]);

    // Reconnect clears the live mirror before the first fresh projection arrives,
    // but the sticky origin still identifies the controlled device.
    remoteProjectsStore.clear();
    onRemotePush?.({
      deviceId: 'device-1',
      channel: 'maker:input:projection',
      payload: projection(SESSION_ID, { clearBoundaryMs: Date.parse('2026-08-03T00:01:00.000Z') }),
    });

    expect(restore).toHaveBeenCalledWith(expect.any(String), undefined);
    expect(makerChatStore.getSnapshot(SESSION_ID).messages).toHaveLength(0);

    resolveProbe(projection(SESSION_ID));
    await flushPromises();
  });

  it('accepts a second remote send while the first enqueue invoke is still unresolved', async () => {
    remoteProjectsStore.pinSessionOrigin('device-1', SESSION_ID);
    makerChatStore.__applyStatusUpdateForTest(SESSION_ID, {
      sessionId: SESSION_ID,
      status: 'running',
      tokenUsage: 0,
      contextTokens: 0,
      contextWindow: 0,
      isRunning: true,
    });
    const sentTexts: string[] = [];
    let resolveFirst!: (value: AgentInputProjection) => void;
    let firstQueued: AgentInputQueuedMessage | undefined;
    deviceLinkInvoke.mockImplementation(async (_deviceId, channel, args) => {
      if (channel === 'maker:input:enqueue') {
        const item = args[1] as AgentInputQueuedMessage;
        sentTexts.push(item.text);
        if (sentTexts.length === 1) {
          firstQueued = item;
          return new Promise<AgentInputProjection>((resolve) => {
            resolveFirst = resolve;
          });
        }
        return projection(SESSION_ID, { pendingQueue: [item] });
      }
      if (channel === 'maker:input:get-projection') return projection(SESSION_ID);
      throw new Error(`unexpected remote channel: ${channel}`);
    });

    await expect(
      makerChatStore.sendMessage(
        SESSION_ID,
        'first pending',
        MODEL,
        EFFORT,
        PERMISSION_MODE,
        WORKING_DIR,
      ),
    ).resolves.toBe(true);
    await expect(
      makerChatStore.sendMessage(
        SESSION_ID,
        'second pending',
        MODEL,
        EFFORT,
        PERMISSION_MODE,
        WORKING_DIR,
      ),
    ).resolves.toBe(true);

    expect(sentTexts).toEqual(['first pending']);
    expect(makerChatStore.getSnapshot(SESSION_ID).pendingQueue).toEqual([
      expect.objectContaining({ text: 'first pending' }),
      expect.objectContaining({ text: 'second pending', isPendingEnqueue: true }),
    ]);

    resolveFirst(projection(SESSION_ID, { pendingQueue: firstQueued ? [firstQueued] : [] }));
    await flushPromises();

    expect(sentTexts).toEqual(['first pending', 'second pending']);
  });

  it('continues the remote FIFO when a DB ack beats the first enqueue response', async () => {
    remoteProjectsStore.pinSessionOrigin('device-1', SESSION_ID);
    makerChatStore.__applyStatusUpdateForTest(SESSION_ID, {
      sessionId: SESSION_ID,
      status: 'running',
      tokenUsage: 0,
      contextTokens: 0,
      contextWindow: 0,
      isRunning: true,
    });
    const sentTexts: string[] = [];
    let resolveFirst!: (value: AgentInputProjection) => void;
    let firstQueued: AgentInputQueuedMessage | undefined;
    deviceLinkInvoke.mockImplementation(async (_deviceId, channel, args) => {
      if (channel === 'maker:input:enqueue') {
        const item = args[1] as AgentInputQueuedMessage;
        sentTexts.push(item.text);
        if (sentTexts.length === 1) {
          firstQueued = item;
          return new Promise<AgentInputProjection>((resolve) => {
            resolveFirst = resolve;
          });
        }
        return projection(SESSION_ID, { pendingQueue: [item] });
      }
      if (channel === 'maker:input:get-projection') return projection(SESSION_ID);
      throw new Error(`unexpected remote channel: ${channel}`);
    });

    await expect(
      makerChatStore.sendMessage(
        SESSION_ID,
        'first pending',
        MODEL,
        EFFORT,
        PERMISSION_MODE,
        WORKING_DIR,
      ),
    ).resolves.toBe(true);
    await expect(
      makerChatStore.sendMessage(
        SESSION_ID,
        'second pending',
        MODEL,
        EFFORT,
        PERMISSION_MODE,
        WORKING_DIR,
      ),
    ).resolves.toBe(true);

    expect(sentTexts).toEqual(['first pending']);
    onDbMessageCreated?.({
      sessionId: SESSION_ID,
      message: {
        clientId: firstQueued?.clientId,
        role: 'user',
        content: 'first pending',
        createdAt: new Date().toISOString(),
      },
    });
    resolveFirst(projection(SESSION_ID));
    await flushPromises();

    expect(sentTexts).toEqual(['first pending', 'second pending']);
  });

  it('does not let a detached pre-clear pump race a new optimistic send', async () => {
    remoteProjectsStore.pinSessionOrigin('device-1', SESSION_ID);
    let resolveFirst!: (value: AgentInputProjection) => void;
    let resolveSecondPreflight!: (value: boolean) => void;
    const secondPreflight = new Promise<boolean>((resolve) => {
      resolveSecondPreflight = resolve;
    });
    let secondPreflightCalls = 0;
    const sentTexts: string[] = [];
    deviceLinkInvoke.mockImplementation(async (_deviceId, channel, args) => {
      if (channel === 'maker:input:clear-session') return projection(SESSION_ID);
      if (channel === 'maker:close-session') return undefined;
      if (channel === 'maker:input:enqueue') {
        const item = args[1] as AgentInputQueuedMessage;
        sentTexts.push(item.text);
        if (item.text === 'before clear') {
          return new Promise<AgentInputProjection>((resolve) => {
            resolveFirst = resolve;
          });
        }
        return projection(SESSION_ID, { pendingQueue: [item] });
      }
      if (channel === 'maker:input:get-projection') return projection(SESSION_ID);
      throw new Error(`unexpected remote channel: ${channel}`);
    });

    await expect(
      makerChatStore.sendMessage(
        SESSION_ID,
        'before clear',
        MODEL,
        EFFORT,
        PERMISSION_MODE,
        WORKING_DIR,
      ),
    ).resolves.toBe(true);
    await makerChatStore.clearSession(SESSION_ID);
    await flushPromises();

    await expect(
      makerChatStore.sendMessage(
        SESSION_ID,
        'after clear',
        MODEL,
        EFFORT,
        PERMISSION_MODE,
        WORKING_DIR,
        undefined,
        undefined,
        {
          beforeEnqueue: () => {
            secondPreflightCalls += 1;
            return secondPreflight;
          },
        },
      ),
    ).resolves.toBe(true);
    await flushPromises();
    expect(secondPreflightCalls).toBe(1);

    resolveFirst(projection(SESSION_ID));
    await flushPromises();
    expect(secondPreflightCalls).toBe(1);

    resolveSecondPreflight(true);
    await flushPromises();
    expect(sentTexts).toEqual(['before clear', 'after clear']);
  });

  it('keeps a device-link queue item settling until its DB message arrives', async () => {
    remoteProjectsStore.pinSessionOrigin('device-1', SESSION_ID);
    makerChatStore.__applyStatusUpdateForTest(SESSION_ID, {
      sessionId: SESSION_ID,
      status: 'running',
      tokenUsage: 0,
      contextTokens: 0,
      contextWindow: 0,
      isRunning: true,
    });
    let queued: AgentInputQueuedMessage | undefined;
    deviceLinkInvoke.mockImplementation(async (_deviceId, channel, args) => {
      if (channel === 'maker:input:enqueue') {
        queued = args[1] as AgentInputQueuedMessage;
        return projection(SESSION_ID, { pendingQueue: [queued] });
      }
      if (channel === 'maker:input:get-projection') return projection(SESSION_ID);
      throw new Error(`unexpected remote channel: ${channel}`);
    });

    await expect(
      makerChatStore.sendMessage(
        SESSION_ID,
        'settling remote',
        MODEL,
        EFFORT,
        PERMISSION_MODE,
        WORKING_DIR,
      ),
    ).resolves.toBe(true);
    const clientId = queued?.clientId;
    expect(clientId).toBeTruthy();

    onInputProjection?.(projection(SESSION_ID));
    expect(makerChatStore.getSnapshot(SESSION_ID).pendingQueue).toHaveLength(0);
    expect(makerChatStore.getSnapshot(SESSION_ID).messages).toEqual([
      expect.objectContaining({ clientId, content: 'settling remote', isPendingPersist: true }),
    ]);

    emitDbMessageCreated({
      clientId: clientId!,
      role: 'user',
      content: 'settling remote',
      createdAt: '2026-08-02T00:00:00.000Z',
    });
    const messages = makerChatStore.getSnapshot(SESSION_ID).messages;
    expect(messages.filter((message) => message.clientId === clientId)).toHaveLength(1);
    expect(messages[0]?.isPendingPersist).toBeUndefined();
  });

  it('keeps pending remote attachment URLs live until the DB ack retires the send', async () => {
    remoteProjectsStore.pinSessionOrigin('device-1', SESSION_ID);
    const sentUrl = 'cindy-media://blobs/annotated.png';
    const sourceUrl = 'cindy-media://blobs/original.png';
    let queued: AgentInputQueuedMessage | undefined;
    deviceLinkInvoke.mockImplementation(async (_deviceId, channel, args) => {
      if (channel === 'maker:input:enqueue') {
        queued = args[1] as AgentInputQueuedMessage;
        return projection(SESSION_ID, { pendingQueue: [queued] });
      }
      if (channel === 'maker:input:get-projection') return projection(SESSION_ID);
      throw new Error(`unexpected remote channel: ${channel}`);
    });
    const attachment: AttachedFile = {
      id: 'remote-live-media',
      name: 'annotated.png',
      path: '',
      ext: '.png',
      size: 1,
      category: 'image',
      mimeType: 'image/png',
      url: sentUrl,
      annotationSourceUrl: sourceUrl,
    };

    await expect(
      makerChatStore.sendMessage(
        SESSION_ID,
        'media pending',
        MODEL,
        EFFORT,
        PERMISSION_MODE,
        WORKING_DIR,
        [attachment],
      ),
    ).resolves.toBe(true);
    await flushPromises();

    const liveUrls = vi.mocked(setRemoteOptimisticAttachmentUrls).mock.lastCall?.[0] ?? [];
    expect(liveUrls).toHaveLength(2);
    expect(liveUrls).toEqual(expect.arrayContaining([sentUrl, sourceUrl]));

    emitDbMessageCreated({
      clientId: queued!.clientId,
      role: 'user',
      content: 'media pending',
      createdAt: '2026-08-03T00:00:00.000Z',
    });

    expect(setRemoteOptimisticAttachmentUrls).toHaveBeenLastCalledWith([]);
  });

  it('bridges composer media into the remote outbox without a live-reference gap', async () => {
    remoteProjectsStore.pinSessionOrigin('device-1', SESSION_ID);
    const sentUrl = 'cindy-media://blobs/transition-annotated.png';
    const sourceUrl = 'cindy-media://blobs/transition-source.png';
    const attachment: AttachedFile = {
      id: 'remote-transition-media',
      name: 'transition.png',
      path: '',
      ext: '.png',
      size: 1,
      category: 'image',
      mimeType: 'image/png',
      url: sentUrl,
      annotationSourceUrl: sourceUrl,
    };
    const restore = vi.fn();
    let queued: AgentInputQueuedMessage | undefined;
    deviceLinkInvoke.mockImplementation(async (_deviceId, channel, args) => {
      if (channel === 'maker:input:enqueue') {
        queued = args[1] as AgentInputQueuedMessage;
        return projection(SESSION_ID, { pendingQueue: [queued] });
      }
      if (channel === 'maker:input:get-projection') return projection(SESSION_ID);
      throw new Error(`unexpected remote channel: ${channel}`);
    });

    const firstTransitionReport = vi.mocked(setRemoteOptimisticAttachmentUrls).mock.calls.length;
    const release = makerChatStore.beginRemoteOptimisticComposerTransition(
      SESSION_ID,
      [attachment],
      restore,
    );
    expect(setRemoteOptimisticAttachmentUrls).toHaveBeenLastCalledWith(
      expect.arrayContaining([sentUrl, sourceUrl]),
    );

    await expect(
      makerChatStore.sendMessage(
        SESSION_ID,
        'transition media',
        MODEL,
        EFFORT,
        PERMISSION_MODE,
        WORKING_DIR,
        [attachment],
        undefined,
        { onRemoteOptimisticFailure: restore },
      ),
    ).resolves.toBe(true);
    release();

    const reportsBeforeAck = vi
      .mocked(setRemoteOptimisticAttachmentUrls)
      .mock.calls.slice(firstTransitionReport);
    expect(reportsBeforeAck.length).toBeGreaterThan(0);
    expect(
      reportsBeforeAck.every(([urls]) => urls.includes(sentUrl) && urls.includes(sourceUrl)),
    ).toBe(true);

    emitDbMessageCreated({
      clientId: queued!.clientId,
      role: 'user',
      content: 'transition media',
      createdAt: '2026-08-03T00:00:00.000Z',
    });
    expect(setRemoteOptimisticAttachmentUrls).toHaveBeenLastCalledWith([]);
    expect(restore).not.toHaveBeenCalled();
  });

  it.each(['send', 'steer'] as const)(
    'restores a pre-registration %s transition before owner-boundary refs retire and rejects its late continuation',
    async (deliveryMode) => {
      remoteProjectsStore.pinSessionOrigin('device-1', SESSION_ID);
      const attachment: AttachedFile = {
        id: 'owner-transition-media',
        name: 'owner-transition.png',
        path: '',
        ext: '.png',
        size: 1,
        category: 'image',
        mimeType: 'image/png',
        url: 'cindy-media://blobs/owner-transition.png',
      };
      const restore = vi.fn();
      const release = makerChatStore.beginRemoteOptimisticComposerTransition(
        SESSION_ID,
        [attachment],
        restore,
      );

      makerChatStore.cancelRemoteOptimisticSendsForDataOwnerBoundary();

      expect(restore).toHaveBeenCalledWith(expect.any(String), expect.any(Error));
      expect(restore.mock.invocationCallOrder[0]).toBeLessThan(
        vi.mocked(setRemoteOptimisticAttachmentUrls).mock.invocationCallOrder.at(-1)!,
      );
      expect(setRemoteOptimisticAttachmentUrls).toHaveBeenLastCalledWith([]);

      setDataOwnerGeneration('owner-b');
      const accepted = await (deliveryMode === 'steer'
        ? makerChatStore.steerMessage(
            SESSION_ID,
            'late owner transition',
            MODEL,
            EFFORT,
            PERMISSION_MODE,
            WORKING_DIR,
            [attachment],
            undefined,
            { onRemoteOptimisticFailure: restore },
          )
        : makerChatStore.sendMessage(
            SESSION_ID,
            'late owner transition',
            MODEL,
            EFFORT,
            PERMISSION_MODE,
            WORKING_DIR,
            [attachment],
            undefined,
            { onRemoteOptimisticFailure: restore },
          ));

      expect(accepted).toBe(false);
      expect(deviceLinkInvoke).not.toHaveBeenCalled();
      release();
      expect(restore).toHaveBeenCalledTimes(1);
    },
  );

  it('shows a device-link steer bubble before preflight settles and dedupes its DB ack', async () => {
    remoteProjectsStore.pinSessionOrigin('device-1', SESSION_ID);
    makerChatStore.__applyStatusUpdateForTest(SESSION_ID, {
      sessionId: SESSION_ID,
      status: 'running',
      tokenUsage: 0,
      contextTokens: 0,
      contextWindow: 0,
      isRunning: true,
    });
    let resolvePreflight!: (value: boolean) => void;
    const preflight = new Promise<boolean>((resolve) => {
      resolvePreflight = resolve;
    });
    let queued: AgentInputQueuedMessage | undefined;
    deviceLinkInvoke.mockImplementation(async (_deviceId, channel, args) => {
      if (channel === 'maker:input:steer') {
        queued = args[1] as AgentInputQueuedMessage;
        return true;
      }
      if (channel === 'maker:input:get-projection') return projection(SESSION_ID);
      throw new Error(`unexpected remote channel: ${channel}`);
    });

    const steer = makerChatStore.steerMessage(
      SESSION_ID,
      'remote steer',
      MODEL,
      EFFORT,
      PERMISSION_MODE,
      WORKING_DIR,
      undefined,
      undefined,
      { beforeEnqueue: () => preflight },
    );

    expect(deviceLinkInvoke.mock.calls.some(([, channel]) => channel === 'maker:input:steer')).toBe(
      false,
    );
    expect(makerChatStore.getSnapshot(SESSION_ID).messages).toEqual([
      expect.objectContaining({ content: 'remote steer', isPendingPersist: true }),
    ]);

    resolvePreflight(true);
    await expect(steer).resolves.toBe(true);
    const clientId = queued?.clientId;
    expect(clientId).toBeTruthy();

    emitDbMessageCreated({
      clientId: clientId!,
      role: 'user',
      content: 'remote steer',
      createdAt: '2026-08-02T00:00:00.000Z',
    });
    const messages = makerChatStore.getSnapshot(SESSION_ID).messages;
    expect(messages.filter((message) => message.clientId === clientId)).toHaveLength(1);
    expect(messages[0]?.isPendingPersist).toBeUndefined();
  });

  it('keeps an accepted device-link steer until a delayed DB ack is reconciled', async () => {
    remoteProjectsStore.pinSessionOrigin('device-1', SESSION_ID);
    makerChatStore.__applyStatusUpdateForTest(SESSION_ID, {
      sessionId: SESSION_ID,
      status: 'running',
      tokenUsage: 0,
      contextTokens: 0,
      contextWindow: 0,
      isRunning: true,
    });
    let queued: AgentInputQueuedMessage | undefined;
    let persisted = false;
    deviceLinkInvoke.mockImplementation(async (_deviceId, channel, args) => {
      if (channel === 'maker:input:steer') {
        queued = args[1] as AgentInputQueuedMessage;
        return false;
      }
      if (channel === 'maker:input:get-projection') {
        return projection(SESSION_ID, { pendingQueue: queued ? [queued] : [] });
      }
      if (channel === 'local-db:messages:around-client-id') {
        if (!persisted) throw new Error('[NOT_FOUND] message not persisted yet');
        return [
          serverMessage({
            id: `row-${queued?.clientId}`,
            sessionId: SESSION_ID,
            clientId: queued?.clientId ?? 'missing',
            role: 'user',
            content: 'materialized steer',
            createdAt: '2026-08-02T00:00:00.000Z',
          }),
        ];
      }
      throw new Error(`unexpected remote channel: ${channel}`);
    });

    await expect(
      makerChatStore.steerMessage(
        SESSION_ID,
        'materialized steer',
        MODEL,
        EFFORT,
        PERMISSION_MODE,
        WORKING_DIR,
      ),
    ).resolves.toBe(true);
    const clientId = queued?.clientId;
    expect(clientId).toBeTruthy();
    expect(makerChatStore.getSnapshot(SESSION_ID).messages).toHaveLength(0);
    expect(makerChatStore.getSnapshot(SESSION_ID).pendingQueue).toEqual([
      expect.objectContaining({ clientId, text: 'materialized steer' }),
    ]);

    onInputProjection?.(projection(SESSION_ID));
    expect(makerChatStore.getSnapshot(SESSION_ID).messages).toEqual([
      expect.objectContaining({ clientId, content: 'materialized steer', isPendingPersist: true }),
    ]);

    vi.advanceTimersByTime(10_000);
    await flushPromises();
    expect(makerChatStore.getSnapshot(SESSION_ID).messages).toEqual([
      expect.objectContaining({ clientId, content: 'materialized steer', isPendingPersist: true }),
    ]);

    persisted = true;
    vi.advanceTimersByTime(10_000);
    await flushPromises();
    expect(makerChatStore.getSnapshot(SESSION_ID).messages).toEqual([
      expect.objectContaining({ clientId, content: 'materialized steer' }),
    ]);
    expect(makerChatStore.getSnapshot(SESSION_ID).messages[0]?.isPendingPersist).toBeUndefined();
  });

  it('ignores a stale device-link queue projection after the DB message persists', async () => {
    remoteProjectsStore.pinSessionOrigin('device-1', SESSION_ID);
    makerChatStore.__applyStatusUpdateForTest(SESSION_ID, {
      sessionId: SESSION_ID,
      status: 'running',
      tokenUsage: 0,
      contextTokens: 0,
      contextWindow: 0,
      isRunning: true,
    });
    let queued: AgentInputQueuedMessage | undefined;
    deviceLinkInvoke.mockImplementation(async (_deviceId, channel, args) => {
      if (channel === 'maker:input:enqueue') {
        queued = args[1] as AgentInputQueuedMessage;
        return projection(SESSION_ID, { pendingQueue: [queued] });
      }
      if (channel === 'maker:input:get-projection') return projection(SESSION_ID);
      throw new Error(`unexpected remote channel: ${channel}`);
    });

    await expect(
      makerChatStore.sendMessage(
        SESSION_ID,
        'persisted before projection',
        MODEL,
        EFFORT,
        PERMISSION_MODE,
        WORKING_DIR,
      ),
    ).resolves.toBe(true);
    const clientId = queued?.clientId;
    expect(clientId).toBeTruthy();

    emitDbMessageCreated({
      clientId: clientId!,
      role: 'user',
      content: 'persisted before projection',
      createdAt: '2026-08-02T00:00:00.000Z',
    });
    onInputProjection?.(projection(SESSION_ID, { pendingQueue: queued ? [queued] : [] }));

    const snapshot = makerChatStore.getSnapshot(SESSION_ID);
    expect(snapshot.pendingQueue).toHaveLength(0);
    expect(snapshot.messages.filter((message) => message.clientId === clientId)).toHaveLength(1);
    expect(snapshot.messages[0]?.isPendingPersist).toBeUndefined();
  });

  it('treats an enqueue reject as delivered when reconciliation finds the same clientId', async () => {
    remoteProjectsStore.pinSessionOrigin('device-1', SESSION_ID);
    let queued: AgentInputQueuedMessage | undefined;
    deviceLinkInvoke.mockImplementation(async (_deviceId, channel, args) => {
      if (channel === 'maker:input:enqueue') {
        queued = args[1] as AgentInputQueuedMessage;
        throw new Error('device-link timeout');
      }
      if (channel === 'maker:input:get-projection') {
        return projection(SESSION_ID, { pendingQueue: queued ? [queued] : [] });
      }
      throw new Error(`unexpected remote channel: ${channel}`);
    });

    await expect(
      makerChatStore.sendMessage(
        SESSION_ID,
        'maybe delivered',
        MODEL,
        EFFORT,
        PERMISSION_MODE,
        WORKING_DIR,
      ),
    ).resolves.toBe(true);
    expect(makerChatStore.getSnapshot(SESSION_ID).pendingQueue).toEqual([
      expect.objectContaining({ clientId: queued?.clientId, text: 'maybe delivered' }),
    ]);
    expect(makerChatStore.getSnapshot(SESSION_ID).error).toBeNull();
  });

  it('treats an uncertain remote steer as accepted while its steering marker is present', async () => {
    remoteProjectsStore.pinSessionOrigin('device-1', SESSION_ID);
    makerChatStore.__applyStatusUpdateForTest(SESSION_ID, {
      sessionId: SESSION_ID,
      status: 'running',
      tokenUsage: 0,
      contextTokens: 0,
      contextWindow: 0,
      isRunning: true,
    });
    let queued: AgentInputQueuedMessage | undefined;
    let steerCalls = 0;
    deviceLinkInvoke.mockImplementation(async (_deviceId, channel, args) => {
      if (channel === 'maker:input:steer') {
        steerCalls += 1;
        queued = args[1] as AgentInputQueuedMessage;
        throw new Error('[DEVICE_LINK_TIMEOUT] no result within 30000ms');
      }
      if (channel === 'maker:input:get-projection') {
        return projection(SESSION_ID, {
          steeringQueueClientIds: queued ? [queued.clientId] : [],
        });
      }
      throw new Error(`unexpected remote channel: ${channel}`);
    });

    await expect(
      makerChatStore.steerMessage(
        SESSION_ID,
        'maybe accepted steer',
        MODEL,
        EFFORT,
        PERMISSION_MODE,
        WORKING_DIR,
      ),
    ).resolves.toBe(true);
    expect(steerCalls).toBe(1);
    expect(makerChatStore.getSnapshot(SESSION_ID).error).toBeNull();
  });

  it('falls an ambiguous remote steer back to enqueue with the same clientId', async () => {
    remoteProjectsStore.pinSessionOrigin('device-1', SESSION_ID);
    makerChatStore.__applyStatusUpdateForTest(SESSION_ID, {
      sessionId: SESSION_ID,
      status: 'running',
      tokenUsage: 0,
      contextTokens: 0,
      contextWindow: 0,
      isRunning: true,
    });
    let steerCalls = 0;
    let enqueueCalls = 0;
    let queued: AgentInputQueuedMessage | undefined;
    deviceLinkInvoke.mockImplementation(async (_deviceId, channel, args) => {
      if (channel === 'maker:input:steer') {
        steerCalls += 1;
        queued = args[1] as AgentInputQueuedMessage;
        throw new Error('[DEVICE_LINK_TIMEOUT] no result within 30000ms');
      }
      if (channel === 'maker:input:get-projection') return projection(SESSION_ID);
      if (channel === 'local-db:messages:around-client-id') {
        throw new Error('[NOT_FOUND] Message 不存在');
      }
      if (channel === 'maker:input:enqueue') {
        enqueueCalls += 1;
        const fallback = args[1] as AgentInputQueuedMessage;
        expect(fallback.clientId).toBe(queued?.clientId);
        return projection(SESSION_ID, { pendingQueue: [fallback] });
      }
      throw new Error(`unexpected remote channel: ${channel}`);
    });

    await expect(
      makerChatStore.steerMessage(
        SESSION_ID,
        'ambiguous steer',
        MODEL,
        EFFORT,
        PERMISSION_MODE,
        WORKING_DIR,
      ),
    ).resolves.toBe(true);

    await flushPromises();

    expect(steerCalls).toBe(1);
    expect(enqueueCalls).toBe(1);
    expect(makerChatStore.getSnapshot(SESSION_ID).pendingQueue).toEqual([
      expect.objectContaining({ clientId: queued?.clientId, text: 'ambiguous steer' }),
    ]);
  });

  it('reconciles an ambiguous steer after reconnect without invoking steer twice', async () => {
    remoteProjectsStore.pinSessionOrigin('device-1', SESSION_ID);
    makerChatStore.__applyStatusUpdateForTest(SESSION_ID, {
      sessionId: SESSION_ID,
      status: 'running',
      tokenUsage: 0,
      contextTokens: 0,
      contextWindow: 0,
      isRunning: true,
    });
    let online = false;
    let steerCalls = 0;
    let enqueueCalls = 0;
    let queued: AgentInputQueuedMessage | undefined;
    const onRemoteOptimisticFailure = vi.fn();
    deviceLinkInvoke.mockImplementation(async (_deviceId, channel, args) => {
      if (channel === 'maker:input:steer') {
        steerCalls += 1;
        queued = args[1] as AgentInputQueuedMessage;
        throw new Error('[DEVICE_LINK_TIMEOUT] no result within 30000ms');
      }
      if (channel === 'maker:input:get-projection') {
        if (!online) throw new Error('[DEVICE_LINK_NOT_CONNECTED] relay offline');
        return projection(SESSION_ID);
      }
      if (channel === 'local-db:messages:around-client-id') {
        if (!online) throw new Error('[DEVICE_LINK_NOT_CONNECTED] relay offline');
        throw new Error('[NOT_FOUND] Message 不存在');
      }
      if (channel === 'maker:input:enqueue') {
        enqueueCalls += 1;
        const fallback = args[1] as AgentInputQueuedMessage;
        expect(fallback.clientId).toBe(queued?.clientId);
        return projection(SESSION_ID, { pendingQueue: [fallback] });
      }
      throw new Error(`unexpected remote channel: ${channel}`);
    });

    await expect(
      makerChatStore.steerMessage(
        SESSION_ID,
        'reconcile after reconnect',
        MODEL,
        EFFORT,
        PERMISSION_MODE,
        WORKING_DIR,
        undefined,
        undefined,
        { onRemoteOptimisticFailure },
      ),
    ).resolves.toBe(true);
    await flushPromises();

    // Unknown clear tokens are fenced before the first steer. While the relay
    // is offline the optimistic bubble remains local and the steer invoke is
    // deferred until a projection probe succeeds after reconnect.
    expect(steerCalls).toBe(0);
    expect(enqueueCalls).toBe(0);
    expect(onRemoteOptimisticFailure).not.toHaveBeenCalled();

    online = true;
    onDeviceLinkStatusChanged?.({ status: 'online' });
    await flushPromises();
    await flushPromises();
    await flushPromises();

    expect(steerCalls).toBe(1);
    expect(enqueueCalls).toBe(1);
    expect(onRemoteOptimisticFailure).not.toHaveBeenCalled();
  });

  it('lets a late DB ack retire an ambiguous steer without fallback or composer restore', async () => {
    remoteProjectsStore.pinSessionOrigin('device-1', SESSION_ID);
    makerChatStore.__applyStatusUpdateForTest(SESSION_ID, {
      sessionId: SESSION_ID,
      status: 'running',
      tokenUsage: 0,
      contextTokens: 0,
      contextWindow: 0,
      isRunning: true,
    });
    let queued: AgentInputQueuedMessage | undefined;
    let projectionCalls = 0;
    let resolveProjection!: (value: AgentInputProjection) => void;
    let resolvePersisted!: (value: Message[]) => void;
    let enqueueCalls = 0;
    const onRemoteOptimisticFailure = vi.fn();
    deviceLinkInvoke.mockImplementation(async (_deviceId, channel, args) => {
      if (channel === 'maker:input:steer') {
        queued = args[1] as AgentInputQueuedMessage;
        throw new Error('[DEVICE_LINK_NOT_CONNECTED] relay connection lost');
      }
      if (channel === 'maker:input:get-projection') {
        projectionCalls += 1;
        if (projectionCalls === 1) return projection(SESSION_ID);
        return new Promise<AgentInputProjection>((resolve) => {
          resolveProjection = resolve;
        });
      }
      if (channel === 'local-db:messages:around-client-id') {
        return new Promise<Message[]>((resolve) => {
          resolvePersisted = resolve;
        });
      }
      if (channel === 'maker:input:enqueue') {
        enqueueCalls += 1;
        return projection(SESSION_ID);
      }
      throw new Error(`unexpected remote channel: ${channel}`);
    });

    await expect(
      makerChatStore.steerMessage(
        SESSION_ID,
        'late persisted steer',
        MODEL,
        EFFORT,
        PERMISSION_MODE,
        WORKING_DIR,
        undefined,
        undefined,
        { onRemoteOptimisticFailure },
      ),
    ).resolves.toBe(true);
    await flushPromises();

    expect(queued).toBeDefined();
    emitDbMessageCreated({
      clientId: queued!.clientId,
      role: 'user',
      content: 'late persisted steer',
      createdAt: '2026-08-03T00:00:00.000Z',
    });
    resolveProjection(projection(SESSION_ID));
    resolvePersisted([]);
    await flushPromises();

    expect(enqueueCalls).toBe(0);
    expect(onRemoteOptimisticFailure).not.toHaveBeenCalled();
    const persisted = makerChatStore.getSnapshot(SESSION_ID).messages;
    expect(persisted).toEqual([expect.objectContaining({ clientId: queued?.clientId })]);
    expect(persisted[0]).not.toHaveProperty('isPendingPersist');
  });

  it('retires an unfenced steer when first numeric clear hydration races its dispatch', async () => {
    remoteProjectsStore.pinSessionOrigin('device-1', SESSION_ID);
    makerChatStore.__applyStatusUpdateForTest(SESSION_ID, {
      sessionId: SESSION_ID,
      status: 'running',
      tokenUsage: 0,
      contextTokens: 0,
      contextWindow: 0,
      isRunning: true,
    });
    const clearBoundaryMs = Date.now() - 5_000;
    // The controller clock is ahead of the remote host. A wall-clock
    // comparison would incorrectly classify this pre-hydration record as
    // clear-after input.
    vi.setSystemTime(clearBoundaryMs + 10_000);
    let queued: AgentInputQueuedMessage | undefined;
    let resolveSteer!: (accepted: boolean) => void;
    const onRemoteOptimisticFailure = vi.fn();
    deviceLinkInvoke.mockImplementation(async (_deviceId, channel, args) => {
      if (channel === 'maker:input:get-projection') return projection(SESSION_ID);
      if (channel === 'maker:input:steer') {
        queued = args[1] as AgentInputQueuedMessage;
        return new Promise<boolean>((resolve) => {
          resolveSteer = resolve;
        });
      }
      throw new Error(`unexpected remote channel: ${channel}`);
    });

    await expect(
      makerChatStore.steerMessage(
        SESSION_ID,
        'pre-clear steer',
        MODEL,
        EFFORT,
        PERMISSION_MODE,
        WORKING_DIR,
        undefined,
        undefined,
        { onRemoteOptimisticFailure },
      ),
    ).resolves.toBe(true);
    await flushPromises();
    expect(queued).toBeDefined();
    expect(makerChatStore.getSnapshot(SESSION_ID).messages).toEqual([
      expect.objectContaining({ clientId: queued?.clientId, isPendingPersist: true }),
    ]);

    onInputProjection?.(projection(SESSION_ID, { clearBoundaryMs }));
    expect(onRemoteOptimisticFailure).toHaveBeenCalledWith(queued?.clientId, undefined);
    expect(makerChatStore.getSnapshot(SESSION_ID).messages).toHaveLength(0);

    resolveSteer(true);
    await flushPromises();
    expect(makerChatStore.getSnapshot(SESSION_ID).messages).toHaveLength(0);
  });

  it('retires an unknown-token steer even while the first clear probe is in flight', async () => {
    remoteProjectsStore.pinSessionOrigin('device-1', SESSION_ID);
    makerChatStore.__applyStatusUpdateForTest(SESSION_ID, {
      sessionId: SESSION_ID,
      status: 'running',
      tokenUsage: 0,
      contextTokens: 0,
      contextWindow: 0,
      isRunning: true,
    });
    const clearBoundaryMs = Date.parse('2026-08-03T00:00:00.000Z');
    let resolveProjection!: (value: AgentInputProjection) => void;
    let steerCalls = 0;
    let queued: AgentInputQueuedMessage | undefined;
    const onRemoteOptimisticFailure = vi.fn();
    deviceLinkInvoke.mockImplementation(async (_deviceId, channel, args) => {
      if (channel === 'maker:input:get-projection') {
        return new Promise<AgentInputProjection>((resolve) => {
          resolveProjection = resolve;
        });
      }
      if (channel === 'maker:input:steer') {
        steerCalls += 1;
        queued = args[1] as AgentInputQueuedMessage;
        return true;
      }
      throw new Error(`unexpected remote channel: ${channel}`);
    });

    await expect(
      makerChatStore.steerMessage(
        SESSION_ID,
        'probe still pending',
        MODEL,
        EFFORT,
        PERMISSION_MODE,
        WORKING_DIR,
        undefined,
        undefined,
        { onRemoteOptimisticFailure },
      ),
    ).resolves.toBe(true);
    await flushPromises();

    expect(steerCalls).toBe(0);
    expect(makerChatStore.getSnapshot(SESSION_ID).messages).toEqual([
      expect.objectContaining({ isPendingPersist: true }),
    ]);

    onInputProjection?.(projection(SESSION_ID, { clearBoundaryMs }));
    expect(onRemoteOptimisticFailure).toHaveBeenCalledWith(expect.any(String), undefined);
    expect(makerChatStore.getSnapshot(SESSION_ID).messages).toHaveLength(0);

    resolveProjection(projection(SESSION_ID, { clearBoundaryMs }));
    await flushPromises();
    expect(steerCalls).toBe(0);
    expect(queued).toBeUndefined();
  });

  it('rolls back only the failed device-link optimistic item when reconciliation is empty', async () => {
    remoteProjectsStore.pinSessionOrigin('device-1', SESSION_ID);
    deviceLinkInvoke.mockImplementation(async (_deviceId, channel) => {
      if (channel === 'maker:input:enqueue') throw new Error('definitely failed');
      if (channel === 'maker:input:get-projection') return projection(SESSION_ID);
      throw new Error(`unexpected remote channel: ${channel}`);
    });

    await expect(
      makerChatStore.sendMessage(
        SESSION_ID,
        'failed remote',
        MODEL,
        EFFORT,
        PERMISSION_MODE,
        WORKING_DIR,
      ),
    ).resolves.toBe(true);
    await flushPromises();
    expect(makerChatStore.getSnapshot(SESSION_ID).pendingQueue).toHaveLength(0);
    expect(makerChatStore.getSnapshot(SESSION_ID).messages).toHaveLength(0);
    expect(makerChatStore.getSnapshot(SESSION_ID).error).toBe('definitely failed');
  });

  it('keeps a remote message locally on NOT_CONNECTED and pumps it after relay recovery', async () => {
    remoteProjectsStore.pinSessionOrigin('device-1', SESSION_ID);
    makerChatStore.__applyStatusUpdateForTest(SESSION_ID, {
      sessionId: SESSION_ID,
      status: 'running',
      tokenUsage: 0,
      contextTokens: 0,
      contextWindow: 0,
      isRunning: true,
    });
    let online = false;
    let enqueueCount = 0;
    let queued: AgentInputQueuedMessage | undefined;
    deviceLinkInvoke.mockImplementation(async (deviceId, channel, args) => {
      expect(deviceId).toBe('device-1');
      if (channel === 'maker:input:enqueue') {
        enqueueCount += 1;
        queued = args[1] as AgentInputQueuedMessage;
        if (!online) throw new Error('[NOT_CONNECTED] target offline');
        return projection(SESSION_ID, { pendingQueue: [queued] });
      }
      if (channel === 'maker:input:get-projection') return projection(SESSION_ID);
      throw new Error(`unexpected remote channel: ${channel}`);
    });

    await expect(
      makerChatStore.sendMessage(
        SESSION_ID,
        'offline message',
        MODEL,
        EFFORT,
        PERMISSION_MODE,
        WORKING_DIR,
      ),
    ).resolves.toBe(true);
    expect(enqueueCount).toBe(1);
    expect(makerChatStore.getSnapshot(SESSION_ID).error).toBeNull();
    expect(makerChatStore.getSnapshot(SESSION_ID).pendingQueue).toEqual([
      expect.objectContaining({ text: 'offline message', isPendingEnqueue: true }),
    ]);

    online = true;
    onDeviceLinkStatusChanged?.({ status: 'online' });
    await flushPromises();

    expect(enqueueCount).toBe(2);
    expect(deviceLinkInvoke).toHaveBeenLastCalledWith(
      'device-1',
      'maker:input:enqueue',
      expect.arrayContaining([SESSION_ID, expect.objectContaining({ clientId: queued?.clientId })]),
    );
    expect(makerChatStore.getSnapshot(SESSION_ID).pendingQueue[0]).toEqual(
      expect.objectContaining({ text: 'offline message' }),
    );
    expect(
      makerChatStore.getSnapshot(SESSION_ID).pendingQueue[0]?.isPendingEnqueue,
    ).toBeUndefined();
  });

  it('calls the composer recovery callback when a deferred remote send later fails permanently', async () => {
    remoteProjectsStore.pinSessionOrigin('device-1', SESSION_ID);
    const recoveryUrl = 'cindy-media://blobs/recover-me.png';
    let enqueueAttempts = 0;
    let queued: AgentInputQueuedMessage | undefined;
    const onRemoteOptimisticFailure = vi.fn();
    const recoveryAttachment: AttachedFile = {
      id: 'recover-me-media',
      name: 'recover-me.png',
      path: '',
      ext: '.png',
      size: 1,
      category: 'image',
      mimeType: 'image/png',
      url: recoveryUrl,
    };
    deviceLinkInvoke.mockImplementation(async (deviceId, channel, args) => {
      expect(deviceId).toBe('device-1');
      if (channel === 'maker:input:enqueue') {
        enqueueAttempts += 1;
        queued = args[1] as AgentInputQueuedMessage;
        if (enqueueAttempts === 1) throw new Error('[NOT_CONNECTED] target offline');
        throw new Error('permission denied');
      }
      if (channel === 'maker:input:get-projection') return projection(SESSION_ID);
      throw new Error(`unexpected remote channel: ${channel}`);
    });

    await expect(
      makerChatStore.sendMessage(
        SESSION_ID,
        'recover me',
        MODEL,
        EFFORT,
        PERMISSION_MODE,
        WORKING_DIR,
        [recoveryAttachment],
        undefined,
        { onRemoteOptimisticFailure },
      ),
    ).resolves.toBe(true);
    expect(queued?.text).toBe('recover me');
    expect(onRemoteOptimisticFailure).not.toHaveBeenCalled();
    expect(setRemoteOptimisticAttachmentUrls).toHaveBeenLastCalledWith([recoveryUrl]);
    const reportCallCountBeforeFailure = vi.mocked(setRemoteOptimisticAttachmentUrls).mock.calls
      .length;

    onDeviceLinkStatusChanged?.({ status: 'online' });
    await flushPromises();

    expect(enqueueAttempts).toBe(2);
    expect(onRemoteOptimisticFailure).toHaveBeenCalledWith(queued?.clientId, expect.any(Error));
    expect(onRemoteOptimisticFailure.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(setRemoteOptimisticAttachmentUrls).mock.invocationCallOrder[
        reportCallCountBeforeFailure
      ]!,
    );
    expect(setRemoteOptimisticAttachmentUrls).toHaveBeenLastCalledWith([]);
    expect(makerChatStore.getSnapshot(SESSION_ID).messages).toHaveLength(0);
    expect(makerChatStore.getSnapshot(SESSION_ID).pendingQueue).toHaveLength(0);
  });

  it('restores a remote composer without an error when clear supersedes input preparation', async () => {
    let enqueueAttempts = 0;
    let projectionRequests = 0;
    let queued: AgentInputQueuedMessage | undefined;
    const onRemoteOptimisticFailure = vi.fn();
    deviceLinkInvoke.mockImplementation(async (deviceId, channel, args) => {
      expect(deviceId).toBe('device-1');
      if (channel === 'maker:input:enqueue') {
        enqueueAttempts += 1;
        queued = args[1] as AgentInputQueuedMessage;
        throw new Error(
          'Error invoking remote method: Error: [PRECONDITION_FAILED] REMOTE_OPTIMISTIC_INPUT_SUPERSEDED: input preparation was superseded',
        );
      }
      if (channel === 'maker:input:get-projection') {
        projectionRequests += 1;
        return projection(SESSION_ID);
      }
      throw new Error(`unexpected remote channel: ${channel}`);
    });
    remoteProjectsStore.pinSessionOrigin('device-1', SESSION_ID);

    await expect(
      makerChatStore.sendMessage(
        SESSION_ID,
        'superseded remote send',
        MODEL,
        EFFORT,
        PERMISSION_MODE,
        WORKING_DIR,
        undefined,
        undefined,
        { onRemoteOptimisticFailure },
      ),
    ).resolves.toBe(true);
    await flushPromises();

    expect(enqueueAttempts).toBe(1);
    // The first remote send performs one ordinary slice projection sync. The
    // superseded enqueue must not add a second reconciliation request.
    expect(projectionRequests).toBe(1);
    expect(onRemoteOptimisticFailure).toHaveBeenCalledWith(queued?.clientId, undefined);
    expect(makerChatStore.getSnapshot(SESSION_ID).messages).toHaveLength(0);
    expect(makerChatStore.getSnapshot(SESSION_ID).pendingQueue).toHaveLength(0);
    expect(makerChatStore.getSnapshot(SESSION_ID).error).toBeNull();

    onDeviceLinkStatusChanged?.({ status: 'online' });
    await flushPromises();
    expect(enqueueAttempts).toBe(1);
    expect(projectionRequests).toBe(1);
  });

  it('does not re-enqueue a steer when clear supersedes its preparation', async () => {
    remoteProjectsStore.pinSessionOrigin('device-1', SESSION_ID);
    makerChatStore.__applyStatusUpdateForTest(SESSION_ID, {
      sessionId: SESSION_ID,
      status: 'running',
      tokenUsage: 0,
      contextTokens: 0,
      contextWindow: 0,
      isRunning: true,
    });
    let steerAttempts = 0;
    let enqueueAttempts = 0;
    let queued: AgentInputQueuedMessage | undefined;
    const channels: string[] = [];
    const onRemoteOptimisticFailure = vi.fn();
    deviceLinkInvoke.mockImplementation(async (deviceId, channel, args) => {
      expect(deviceId).toBe('device-1');
      channels.push(channel);
      if (channel === 'maker:input:steer') {
        steerAttempts += 1;
        queued = args[1] as AgentInputQueuedMessage;
        throw new Error(
          'Error invoking remote method: Error: [PRECONDITION_FAILED] REMOTE_OPTIMISTIC_INPUT_SUPERSEDED: input preparation was superseded',
        );
      }
      if (channel === 'maker:input:enqueue') {
        enqueueAttempts += 1;
        return projection(SESSION_ID);
      }
      if (channel === 'maker:input:get-projection') return projection(SESSION_ID);
      throw new Error(`unexpected remote channel: ${channel}`);
    });

    await expect(
      makerChatStore.steerMessage(
        SESSION_ID,
        'superseded remote steer',
        MODEL,
        EFFORT,
        PERMISSION_MODE,
        WORKING_DIR,
        undefined,
        undefined,
        { onRemoteOptimisticFailure },
      ),
    ).resolves.toBe(true);
    await flushPromises();

    expect(steerAttempts).toBe(1);
    expect(enqueueAttempts).toBe(0);
    expect(channels).not.toContain('local-db:messages:around-client-id');
    expect(onRemoteOptimisticFailure).toHaveBeenCalledWith(queued?.clientId, undefined);
    expect(makerChatStore.getSnapshot(SESSION_ID).messages).toHaveLength(0);
    expect(makerChatStore.getSnapshot(SESSION_ID).pendingQueue).toHaveLength(0);
    expect(makerChatStore.getSnapshot(SESSION_ID).error).toBeNull();

    onDeviceLinkStatusChanged?.({ status: 'online' });
    await flushPromises();
    expect(steerAttempts).toBe(1);
    expect(enqueueAttempts).toBe(0);
  });

  it('cancels an old-owner outbox before publishing the next data owner', async () => {
    remoteProjectsStore.pinSessionOrigin('device-1', SESSION_ID);
    const ownerAttachmentUrl = 'cindy-media://blobs/owner-a-pending.png';
    makerChatStore.__applyStatusUpdateForTest(SESSION_ID, {
      sessionId: SESSION_ID,
      status: 'running',
      tokenUsage: 0,
      contextTokens: 0,
      contextWindow: 0,
      isRunning: true,
    });
    let resolvePreflight!: (value: boolean) => void;
    const preflight = new Promise<boolean>((resolve) => {
      resolvePreflight = resolve;
    });
    const restore = vi.fn();
    const ownerAttachment: AttachedFile = {
      id: 'owner-a-pending-media',
      name: 'owner-a-pending.png',
      path: '',
      ext: '.png',
      size: 1,
      category: 'image',
      mimeType: 'image/png',
      url: ownerAttachmentUrl,
    };
    deviceLinkInvoke.mockImplementation(async (_deviceId, channel) => {
      if (channel === 'maker:input:get-projection') return projection(SESSION_ID);
      throw new Error(`unexpected remote channel: ${channel}`);
    });

    await expect(
      makerChatStore.sendMessage(
        SESSION_ID,
        'owner-a pending',
        MODEL,
        EFFORT,
        PERMISSION_MODE,
        WORKING_DIR,
        [ownerAttachment],
        undefined,
        { beforeEnqueue: () => preflight, onRemoteOptimisticFailure: restore },
      ),
    ).resolves.toBe(true);
    const clientId = makerChatStore.getSnapshot(SESSION_ID).pendingQueue[0]?.clientId;
    expect(clientId).toBeTruthy();
    expect(setRemoteOptimisticAttachmentUrls).toHaveBeenLastCalledWith([ownerAttachmentUrl]);
    const reportCallCountBeforeBoundary = vi.mocked(setRemoteOptimisticAttachmentUrls).mock.calls
      .length;

    makerChatStore.cancelRemoteOptimisticSendsForDataOwnerBoundary();
    setDataOwnerGeneration('owner-b');

    expect(restore).toHaveBeenCalledWith(clientId, expect.any(Error));
    expect(restore.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(setRemoteOptimisticAttachmentUrls).mock.invocationCallOrder[
        reportCallCountBeforeBoundary
      ]!,
    );
    expect(setRemoteOptimisticAttachmentUrls).toHaveBeenLastCalledWith([]);
    expect(makerChatStore.getSnapshot(SESSION_ID).pendingQueue).toHaveLength(0);

    resolvePreflight(true);
    await flushPromises();
    onDeviceLinkStatusChanged?.({ status: 'online' });
    await flushPromises();
    expect(
      deviceLinkInvoke.mock.calls.some(([, channel]) => channel === 'maker:input:enqueue'),
    ).toBe(false);
    expect(restore).toHaveBeenCalledTimes(1);
  });

  it('drops a standalone late projection when the data owner changes', async () => {
    remoteProjectsStore.setDeviceSessions('device-1', 'Test Mac', [
      { id: SESSION_ID, status: 'active', title: 'Remote task' } as Session,
    ]);
    expect(getStickySessionDeviceId(SESSION_ID)).toBe('device-1');
    remoteProjectsStore.clear();

    onInputProjection?.(
      projection(SESSION_ID, {
        error: 'new-owner-state',
        queueInteractionLocks: ['new-owner-lock'],
        steeringQueueClientIds: ['already-steering'],
      }),
    );

    let resolveProjection!: (value: AgentInputProjection) => void;
    deviceLinkInvoke.mockImplementation(async (deviceId, channel) => {
      expect(deviceId).toBe('device-1');
      if (channel === 'maker:input:get-projection') {
        return new Promise<AgentInputProjection>((resolve) => {
          resolveProjection = resolve;
        });
      }
      throw new Error(`unexpected remote channel: ${channel}`);
    });

    await expect(
      makerChatStore.steerMessage(
        SESSION_ID,
        'late projection probe',
        MODEL,
        EFFORT,
        PERMISSION_MODE,
        WORKING_DIR,
      ),
    ).resolves.toBe(false);
    await flushPromises();
    expect(deviceLinkInvoke).toHaveBeenCalledWith('device-1', 'maker:input:get-projection', [
      SESSION_ID,
    ]);

    makerChatStore.cancelRemoteOptimisticSendsForDataOwnerBoundary();
    setDataOwnerGeneration('owner-b');
    resolveProjection(
      projection(SESSION_ID, {
        error: 'old-owner-state',
        queueInteractionLocks: ['old-owner-lock'],
        steeringQueueClientIds: [],
      }),
    );
    await flushPromises();

    expect(makerChatStore.getSnapshot(SESSION_ID).error).toBe('new-owner-state');
    expect(makerChatStore.getSnapshot(SESSION_ID).queueInteractionLocks).toEqual([
      'new-owner-lock',
    ]);
    expect(makerChatStore.getSnapshot(SESSION_ID).steeringQueueClientIds).toEqual([
      'already-steering',
    ]);
    expect(input.getProjection).not.toHaveBeenCalled();
  });

  it('retries a deferred remote steer through steer instead of degrading it to enqueue', async () => {
    remoteProjectsStore.pinSessionOrigin('device-1', SESSION_ID);
    let online = false;
    const channels: string[] = [];
    deviceLinkInvoke.mockImplementation(async (deviceId, channel) => {
      expect(deviceId).toBe('device-1');
      channels.push(channel);
      if (channel === 'maker:input:steer') {
        if (!online) throw new Error('[DEVICE_LINK_DEVICE_OFFLINE] target offline');
        return true;
      }
      if (channel === 'maker:input:get-projection') return projection(SESSION_ID);
      throw new Error(`unexpected remote channel: ${channel}`);
    });

    await expect(
      makerChatStore.steerMessage(
        SESSION_ID,
        'steer me',
        MODEL,
        EFFORT,
        PERMISSION_MODE,
        WORKING_DIR,
      ),
    ).resolves.toBe(true);
    expect(channels).toContain('maker:input:steer');
    expect(channels).not.toContain('maker:input:enqueue');

    online = true;
    onDeviceLinkStatusChanged?.({ status: 'online' });
    await flushPromises();

    expect(channels.filter((channel) => channel === 'maker:input:steer')).toHaveLength(2);
    expect(channels).not.toContain('maker:input:enqueue');
  });

  it('keeps an ambiguous disconnected steer accepted when the same clientId is already persisted', async () => {
    remoteProjectsStore.pinSessionOrigin('device-1', SESSION_ID);
    makerChatStore.__applyStatusUpdateForTest(SESSION_ID, {
      sessionId: SESSION_ID,
      status: 'running',
      tokenUsage: 0,
      contextTokens: 0,
      contextWindow: 0,
      isRunning: true,
    });
    let queued: AgentInputQueuedMessage | undefined;
    let steerCalls = 0;
    let enqueueCalls = 0;
    const onRemoteOptimisticFailure = vi.fn();
    deviceLinkInvoke.mockImplementation(async (_deviceId, channel, args) => {
      if (channel === 'maker:input:steer') {
        steerCalls += 1;
        queued = args[1] as AgentInputQueuedMessage;
        throw new Error('[DEVICE_LINK_NOT_CONNECTED] relay connection lost');
      }
      if (channel === 'maker:input:get-projection') return projection(SESSION_ID);
      if (channel === 'local-db:messages:around-client-id') {
        return [
          serverMessage({
            id: 'persisted-ambiguous-steer',
            sessionId: SESSION_ID,
            clientId: queued!.clientId,
            role: 'user',
            content: 'ambiguous disconnect',
            createdAt: '2026-08-02T00:00:00.000Z',
          }),
        ];
      }
      if (channel === 'maker:input:enqueue') {
        enqueueCalls += 1;
        return projection(SESSION_ID);
      }
      throw new Error(`unexpected remote channel: ${channel}`);
    });

    await expect(
      makerChatStore.steerMessage(
        SESSION_ID,
        'ambiguous disconnect',
        MODEL,
        EFFORT,
        PERMISSION_MODE,
        WORKING_DIR,
        undefined,
        undefined,
        { onRemoteOptimisticFailure },
      ),
    ).resolves.toBe(true);
    await flushPromises();

    expect(steerCalls).toBe(1);
    expect(enqueueCalls).toBe(0);
    expect(onRemoteOptimisticFailure).not.toHaveBeenCalled();
    expect(makerChatStore.getSnapshot(SESSION_ID).messages).toEqual([
      expect.objectContaining({ clientId: queued?.clientId, isPendingPersist: true }),
    ]);
  });

  it('settles multiple permanent failures through composer callbacks in FIFO order', async () => {
    remoteProjectsStore.pinSessionOrigin('device-1', SESSION_ID);
    let enqueueAttempts = 0;
    const permanentlyFailedClientIds: string[] = [];
    const onRemoteOptimisticFailure = vi.fn();
    deviceLinkInvoke.mockImplementation(async (_deviceId, channel, args) => {
      if (channel === 'maker:input:enqueue') {
        enqueueAttempts += 1;
        if (enqueueAttempts === 1) throw new Error('[NOT_CONNECTED] target offline');
        permanentlyFailedClientIds.push((args[1] as AgentInputQueuedMessage).clientId);
        throw new Error('permission denied');
      }
      if (channel === 'maker:input:get-projection') return projection(SESSION_ID);
      throw new Error(`unexpected remote channel: ${channel}`);
    });

    await expect(
      makerChatStore.sendMessage(
        SESSION_ID,
        'first failed message',
        MODEL,
        EFFORT,
        PERMISSION_MODE,
        WORKING_DIR,
        undefined,
        undefined,
        { onRemoteOptimisticFailure },
      ),
    ).resolves.toBe(true);
    await expect(
      makerChatStore.sendMessage(
        SESSION_ID,
        'second failed message',
        MODEL,
        EFFORT,
        PERMISSION_MODE,
        WORKING_DIR,
        undefined,
        undefined,
        { onRemoteOptimisticFailure },
      ),
    ).resolves.toBe(true);
    onDeviceLinkStatusChanged?.({ status: 'online' });
    await flushPromises();

    expect(permanentlyFailedClientIds).toHaveLength(2);
    expect(onRemoteOptimisticFailure.mock.calls.map(([clientId]) => clientId)).toEqual(
      permanentlyFailedClientIds,
    );
    expect(makerChatStore.getSnapshot(SESSION_ID).messages).toHaveLength(0);
  });

  it('does not LRU-evict a remote optimistic message while its preflight is pending', async () => {
    remoteProjectsStore.pinSessionOrigin('device-1', SESSION_ID);
    let resolvePreflight!: (value: boolean) => void;
    const preflight = new Promise<boolean>((resolve) => {
      resolvePreflight = resolve;
    });
    let enqueueCalls = 0;
    deviceLinkInvoke.mockImplementation(async (deviceId, channel, args) => {
      expect(deviceId).toBe('device-1');
      if (channel === 'maker:input:enqueue') {
        enqueueCalls += 1;
        const item = args[1] as AgentInputQueuedMessage;
        return projection(SESSION_ID, { pendingQueue: [item] });
      }
      throw new Error(`unexpected remote channel: ${channel}`);
    });

    const send = makerChatStore.sendMessage(
      SESSION_ID,
      'must survive cache pressure',
      MODEL,
      EFFORT,
      PERMISSION_MODE,
      WORKING_DIR,
      undefined,
      undefined,
      { beforeEnqueue: () => preflight },
    );
    const optimisticSnapshot = makerChatStore.getSnapshot(SESSION_ID);
    expect([
      ...optimisticSnapshot.messages,
      ...optimisticSnapshot.pendingQueue.map((item) => item.chatMessage),
    ]).toEqual([
      expect.objectContaining({ content: 'must survive cache pressure', isPendingPersist: true }),
    ]);

    for (const sessionId of LRU_SESSION_IDS) makerChatStore.getSnapshot(sessionId);
    resolvePreflight(true);

    await expect(send).resolves.toBe(true);
    expect(enqueueCalls).toBe(1);
  });

  it('does not LRU-evict a remote optimistic message while its annotation is materializing', async () => {
    remoteProjectsStore.pinSessionOrigin('device-1', SESSION_ID);
    let resolveMaterialize!: (value: {
      url: string;
      name: string;
      ext: string;
      mimeType: string;
      size: number;
    }) => void;
    vi.mocked(window.electronAPI.cacheMediaForSession).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveMaterialize = resolve;
        }),
    );
    let enqueueCalls = 0;
    deviceLinkInvoke.mockImplementation(async (_deviceId, channel, args) => {
      if (channel === 'maker:input:enqueue') {
        enqueueCalls += 1;
        const item = args[1] as AgentInputQueuedMessage;
        return projection(SESSION_ID, { pendingQueue: [item] });
      }
      if (channel === 'maker:input:get-projection') return projection(SESSION_ID);
      throw new Error(`unexpected remote channel: ${channel}`);
    });
    const attachment: AttachedFile = {
      id: 'lru-materializing-source',
      name: 'lru-materializing.png',
      path: '',
      ext: '.png',
      size: 1,
      category: 'image',
      mimeType: 'image/png',
      url: 'xdt-image://source/lru-materializing.png',
      cacheUrlShared: true,
    };

    await expect(
      makerChatStore.sendMessage(
        SESSION_ID,
        'must survive materialization pressure',
        MODEL,
        EFFORT,
        PERMISSION_MODE,
        WORKING_DIR,
        [attachment],
      ),
    ).resolves.toBe(true);
    await flushPromises();
    for (const sessionId of LRU_SESSION_IDS) makerChatStore.getSnapshot(sessionId);

    expect(makerChatStore.getSnapshot(SESSION_ID).messages).toEqual([
      expect.objectContaining({
        content: 'must survive materialization pressure',
        isPendingPersist: true,
      }),
    ]);

    resolveMaterialize({
      url: 'xdt-image://text-delta-batching/lru-private.png',
      name: 'lru-private.png',
      ext: '.png',
      mimeType: 'image/png',
      size: 1,
    });
    await flushPromises();
    await flushPromises();
    expect(enqueueCalls).toBe(1);
  });

  it('does not revive or dispatch a materializing remote message after purge', async () => {
    remoteProjectsStore.pinSessionOrigin('device-1', SESSION_ID);
    let resolveMaterialize!: (value: {
      url: string;
      name: string;
      ext: string;
      mimeType: string;
      size: number;
    }) => void;
    vi.mocked(window.electronAPI.cacheMediaForSession).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveMaterialize = resolve;
        }),
    );
    let enqueueCalls = 0;
    const restore = vi.fn();
    deviceLinkInvoke.mockImplementation(async (_deviceId, channel, args) => {
      if (channel === 'maker:input:enqueue') {
        enqueueCalls += 1;
        return projection(SESSION_ID, {
          pendingQueue: [args[1] as AgentInputQueuedMessage],
        });
      }
      if (channel === 'maker:input:get-projection') return projection(SESSION_ID);
      throw new Error(`unexpected remote channel: ${channel}`);
    });
    const attachment: AttachedFile = {
      id: 'purged-materializing-source',
      name: 'purged-materializing.png',
      path: '',
      ext: '.png',
      size: 1,
      category: 'image',
      mimeType: 'image/png',
      url: 'xdt-image://source/purged-materializing.png',
      cacheUrlShared: true,
    };

    await expect(
      makerChatStore.sendMessage(
        SESSION_ID,
        'must stay purged',
        MODEL,
        EFFORT,
        PERMISSION_MODE,
        WORKING_DIR,
        [attachment],
        undefined,
        { onRemoteOptimisticFailure: restore },
      ),
    ).resolves.toBe(true);
    await flushPromises();
    makerChatStore.purgeSession(SESSION_ID);

    resolveMaterialize({
      url: 'xdt-image://text-delta-batching/purged-private.png',
      name: 'purged-private.png',
      ext: '.png',
      mimeType: 'image/png',
      size: 1,
    });
    await flushPromises();

    expect(enqueueCalls).toBe(0);
    expect(restore).toHaveBeenCalledTimes(1);
    expect(isRemoteOptimisticSessionPurgedError(restore.mock.calls[0]?.[1])).toBe(true);
    expect(makerChatStore.__hasSessionForTest(SESSION_ID)).toBe(false);
    expect(makerChatStore.getSnapshot(SESSION_ID).messages).toHaveLength(0);
    expect(makerChatStore.getSnapshot(SESSION_ID).pendingQueue).toHaveLength(0);
  });

  it.each(['archived', 'deleted'] as const)(
    'cancels a background offline outbox when the controlled task is %s',
    async (status) => {
      remoteProjectsStore.pinSessionOrigin('device-1', SESSION_ID);
      let resolvePreflight!: (value: boolean) => void;
      const preflight = new Promise<boolean>((resolve) => {
        resolvePreflight = resolve;
      });
      const restore = vi.fn();
      let enqueueCalls = 0;
      deviceLinkInvoke.mockImplementation(async (_deviceId, channel) => {
        if (channel === 'maker:input:enqueue') enqueueCalls += 1;
        if (channel === 'maker:input:get-projection') return projection(SESSION_ID);
        throw new Error(`unexpected remote channel: ${channel}`);
      });

      await expect(
        makerChatStore.sendMessage(
          SESSION_ID,
          'must not outlive remote task',
          MODEL,
          EFFORT,
          PERMISSION_MODE,
          WORKING_DIR,
          undefined,
          undefined,
          {
            beforeEnqueue: () => preflight,
            onRemoteOptimisticFailure: restore,
          },
        ),
      ).resolves.toBe(true);

      onRemotePush?.({
        deviceId: 'device-1',
        channel: 'local-db:sessions:patched',
        payload: { sessionId: SESSION_ID, patch: { status } },
      });
      resolvePreflight(true);
      await flushPromises();

      expect(enqueueCalls).toBe(0);
      expect(restore).toHaveBeenCalledTimes(1);
      expect(isRemoteOptimisticSessionPurgedError(restore.mock.calls[0]?.[1])).toBe(true);
      expect(makerChatStore.__hasSessionForTest(SESSION_ID)).toBe(false);
      expect(makerChatStore.getSnapshot(SESSION_ID).messages).toHaveLength(0);
      expect(makerChatStore.getSnapshot(SESSION_ID).pendingQueue).toHaveLength(0);
    },
  );

  it.each(['archived', 'deleted'] as const)(
    'keeps a remotely %s task purged when late session frames arrive',
    (status) => {
      remoteProjectsStore.pinSessionOrigin('device-1', SESSION_ID);
      makerChatStore.__applyStatusUpdateForTest(SESSION_ID, {
        sessionId: SESSION_ID,
        status: 'running',
        tokenUsage: 0,
        contextTokens: 0,
        contextWindow: 0,
        isRunning: true,
      });

      onRemotePush?.({
        deviceId: 'device-1',
        channel: 'local-db:sessions:patched',
        payload: { sessionId: SESSION_ID, patch: { status } },
      });
      expect(makerChatStore.__hasSessionForTest(SESSION_ID)).toBe(false);

      onRemotePush?.({
        deviceId: 'device-1',
        channel: 'local-db:messages:created',
        payload: {
          sessionId: SESSION_ID,
          message: serverMessage({
            id: 'late-row',
            sessionId: SESSION_ID,
            clientId: 'late-user',
            role: 'user',
            content: 'late message',
            createdAt: '2026-08-02T00:00:00.000Z',
          }),
        },
      });
      onRemotePush?.({
        deviceId: 'device-1',
        channel: 'maker:event',
        payload: {
          sessionId: SESSION_ID,
          event: {
            type: 'status',
            data: {
              status: 'running',
              isRunning: true,
              tokenUsage: 0,
              contextTokens: 0,
              contextWindow: 0,
            },
          },
        },
      });
      onRemotePush?.({
        deviceId: 'device-1',
        channel: 'maker:input:projection',
        payload: projection(SESSION_ID),
      });
      expect(makerChatStore.__hasSessionForTest(SESSION_ID)).toBe(false);

      if (status === 'archived') {
        remoteProjectsStore.setDeviceSessions('device-1', 'Test Mac', [
          {
            id: SESSION_ID,
            status: 'active',
            title: 'Restored task',
          } as Session,
        ]);
        onRemotePush?.({
          deviceId: 'device-1',
          channel: 'local-db:messages:created',
          payload: {
            sessionId: SESSION_ID,
            message: serverMessage({
              id: 'restored-row',
              sessionId: SESSION_ID,
              clientId: 'restored-user',
              role: 'user',
              content: 'after unarchive',
              createdAt: '2026-08-02T00:01:00.000Z',
            }),
          },
        });
        expect(makerChatStore.__hasSessionForTest(SESSION_ID)).toBe(true);
      }
    },
  );

  it('cancels a remote optimistic send that is still in preflight when the session is cleared', async () => {
    remoteProjectsStore.pinSessionOrigin('device-1', SESSION_ID);
    let resolvePreflight!: (value: boolean) => void;
    const preflight = new Promise<boolean>((resolve) => {
      resolvePreflight = resolve;
    });
    let enqueueCalls = 0;
    deviceLinkInvoke.mockImplementation(async (deviceId, channel, args) => {
      expect(deviceId).toBe('device-1');
      if (channel === 'maker:input:clear-session') return projection(SESSION_ID);
      if (channel === 'maker:close-session') return undefined;
      if (channel === 'maker:input:enqueue') {
        enqueueCalls += 1;
        const item = args[1] as AgentInputQueuedMessage;
        return projection(SESSION_ID, { pendingQueue: [item] });
      }
      if (channel === 'maker:input:get-projection') return projection(SESSION_ID);
      throw new Error(`unexpected remote channel: ${channel}`);
    });

    const send = makerChatStore.sendMessage(
      SESSION_ID,
      'must be cancelled by clear',
      MODEL,
      EFFORT,
      PERMISSION_MODE,
      WORKING_DIR,
      undefined,
      undefined,
      { beforeEnqueue: () => preflight },
    );
    makerChatStore.clearSession(SESSION_ID);
    await flushPromises();
    resolvePreflight(true);

    await expect(send).resolves.toBe(true);
    await flushPromises();
    expect(enqueueCalls).toBe(0);
  });

  it.each(['send', 'steer'] as const)(
    'rejects a pre-registration %s continuation after clear and leaves one caller-owned restore',
    async (deliveryMode) => {
      remoteProjectsStore.pinSessionOrigin('device-1', SESSION_ID);
      const restore = vi.fn();
      const release = makerChatStore.beginRemoteOptimisticComposerTransition(
        SESSION_ID,
        undefined,
        restore,
      );
      const dispatchedChannels: string[] = [];
      deviceLinkInvoke.mockImplementation(async (_deviceId, channel) => {
        dispatchedChannels.push(channel);
        if (channel === 'maker:input:clear-session') return projection(SESSION_ID);
        if (channel === 'maker:close-session') return undefined;
        throw new Error(`unexpected remote channel: ${channel}`);
      });

      makerChatStore.clearSession(SESSION_ID);
      await flushPromises();

      const accepted = await (deliveryMode === 'steer'
        ? makerChatStore.steerMessage(
            SESSION_ID,
            'late clear transition',
            MODEL,
            EFFORT,
            PERMISSION_MODE,
            WORKING_DIR,
            undefined,
            undefined,
            { onRemoteOptimisticFailure: restore },
          )
        : makerChatStore.sendMessage(
            SESSION_ID,
            'late clear transition',
            MODEL,
            EFFORT,
            PERMISSION_MODE,
            WORKING_DIR,
            undefined,
            undefined,
            { onRemoteOptimisticFailure: restore },
          ));

      expect(accepted).toBe(false);
      expect(dispatchedChannels).not.toContain('maker:input:enqueue');
      expect(dispatchedChannels).not.toContain('maker:input:steer');
      if (!accepted) restore('caller-owned-restore');
      release();
      expect(restore).toHaveBeenCalledTimes(1);
    },
  );

  it('keeps a send local while clear is waiting for its remote guard', async () => {
    remoteProjectsStore.pinSessionOrigin('device-1', SESSION_ID);
    let resolveClear!: (value: AgentInputProjection) => void;
    let enqueueCalls = 0;
    deviceLinkInvoke.mockImplementation(async (deviceId, channel, args) => {
      expect(deviceId).toBe('device-1');
      if (channel === 'maker:input:clear-session') {
        return new Promise<AgentInputProjection>((resolve) => {
          resolveClear = resolve;
        });
      }
      if (channel === 'maker:close-session') return undefined;
      if (channel === 'maker:input:enqueue') {
        enqueueCalls += 1;
        return projection(SESSION_ID, { pendingQueue: [args[1] as AgentInputQueuedMessage] });
      }
      throw new Error(`unexpected remote channel: ${channel}`);
    });

    makerChatStore.clearSession(SESSION_ID);
    await expect(
      makerChatStore.sendMessage(
        SESSION_ID,
        'blocked during clear',
        MODEL,
        EFFORT,
        PERMISSION_MODE,
        WORKING_DIR,
      ),
    ).resolves.toBe(true);
    expect(enqueueCalls).toBe(0);
    expect(makerChatStore.getSnapshot(SESSION_ID).messages).toEqual([
      expect.objectContaining({ content: 'blocked during clear', isPendingPersist: true }),
    ]);

    resolveClear(projection(SESSION_ID));
    await flushPromises();
    await flushPromises();
    expect(enqueueCalls).toBe(1);
  });

  it('keeps a clear-fenced send local after invoke rejection and dispatches it on reconnect ACK', async () => {
    remoteProjectsStore.pinSessionOrigin('device-1', SESSION_ID);
    let clearAttempts = 0;
    let online = false;
    let clearedAt: string | undefined;
    let enqueueCalls = 0;
    let enqueueOpts: unknown;
    deviceLinkInvoke.mockImplementation(async (deviceId, channel, args) => {
      expect(deviceId).toBe('device-1');
      if (channel === 'maker:input:clear-session') {
        clearAttempts += 1;
        clearedAt = args[1] as string;
        if (clearAttempts === 1) throw new Error('[DEVICE_LINK_DEVICE_OFFLINE] offline');
        if (!online) throw new Error('[DEVICE_LINK_DEVICE_OFFLINE] offline');
        // The controller and controlled host may have skewed clocks. The
        // host-owned boundary is still authoritative even when it is earlier
        // than the controller's request timestamp.
        return projection(SESSION_ID, { clearBoundaryMs: Date.parse(clearedAt) - 10_000 });
      }
      if (channel === 'maker:close-session') return undefined;
      if (channel === 'maker:input:enqueue') {
        enqueueCalls += 1;
        enqueueOpts = args[2];
        return projection(SESSION_ID, {
          clearBoundaryMs: Date.parse(clearedAt!) - 10_000,
          pendingQueue: [args[1] as AgentInputQueuedMessage],
        });
      }
      if (channel === 'maker:input:get-projection') {
        return projection(SESSION_ID, { clearBoundaryMs: Date.parse(clearedAt!) - 10_000 });
      }
      throw new Error(`unexpected remote channel: ${channel}`);
    });

    await makerChatStore.clearSession(SESSION_ID);
    expect(clearAttempts).toBe(1);

    await expect(
      makerChatStore.sendMessage(
        SESSION_ID,
        'send after offline clear',
        MODEL,
        EFFORT,
        PERMISSION_MODE,
        WORKING_DIR,
      ),
    ).resolves.toBe(true);
    await flushPromises();

    expect(enqueueCalls).toBe(0);
    expect(makerChatStore.getSnapshot(SESSION_ID).messages).toEqual([
      expect.objectContaining({ content: 'send after offline clear', isPendingPersist: true }),
    ]);

    online = true;
    onPresenceChanged?.({ deviceId: 'device-1', online: true });
    await flushPromises();
    await flushPromises();

    // Presence and projection-reseed callbacks may race and request the same
    // definitely-undelivered clear more than once; the send must still settle
    // only after an ACK, regardless of that duplicate retry trigger.
    expect(clearAttempts).toBeGreaterThanOrEqual(2);
    expect(enqueueCalls).toBe(1);
    expect(enqueueOpts).toEqual({
      sendAtMs: expect.any(Number),
      expectedClearBoundaryMs: Date.parse(clearedAt!) - 10_000,
    });
  });

  it('reconciles an ambiguous clear response loss before retrying the destructive clear', async () => {
    remoteProjectsStore.pinSessionOrigin('device-1', SESSION_ID);
    const baselineBoundary = Date.parse('2026-08-03T00:00:00.000Z');
    const appliedBoundary = baselineBoundary + 1_000;
    onInputProjection?.(projection(SESSION_ID, { clearBoundaryMs: baselineBoundary }));
    let online = false;
    let clearAttempts = 0;
    let projectionProbes = 0;
    let enqueueCalls = 0;
    let enqueueOpts: unknown;
    deviceLinkInvoke.mockImplementation(async (_deviceId, channel, args) => {
      if (channel === 'maker:input:clear-session') {
        clearAttempts += 1;
        if (clearAttempts === 1) {
          throw new Error('[DEVICE_LINK_NOT_CONNECTED] response lost after host clear');
        }
        return projection(SESSION_ID, { clearBoundaryMs: appliedBoundary + clearAttempts });
      }
      if (channel === 'maker:input:get-projection') {
        projectionProbes += 1;
        if (!online) throw new Error('[DEVICE_LINK_NOT_CONNECTED] host still offline');
        return projection(SESSION_ID, { clearBoundaryMs: appliedBoundary });
      }
      if (channel === 'maker:close-session') return undefined;
      if (channel === 'maker:input:enqueue') {
        enqueueCalls += 1;
        enqueueOpts = args[2];
        return projection(SESSION_ID, {
          clearBoundaryMs: appliedBoundary,
          pendingQueue: [args[1] as AgentInputQueuedMessage],
        });
      }
      throw new Error(`unexpected remote channel: ${channel}`);
    });

    await makerChatStore.clearSession(SESSION_ID);
    await expect(
      makerChatStore.sendMessage(
        SESSION_ID,
        'send after lost clear ACK',
        MODEL,
        EFFORT,
        PERMISSION_MODE,
        WORKING_DIR,
      ),
    ).resolves.toBe(true);
    expect(enqueueCalls).toBe(0);

    await flushPromises();
    projectionProbes = 0;
    online = true;
    onPresenceChanged?.({ deviceId: 'device-1', online: true });
    await flushPromises();
    await flushPromises();

    expect(projectionProbes).toBe(1);
    expect(clearAttempts).toBe(1);
    expect(enqueueCalls).toBe(1);
    expect(enqueueOpts).toEqual({
      sendAtMs: expect.any(Number),
      // The queued item captured the pre-clear token. If the host rejects it,
      // the normal send path re-probes and refreshes the token before retrying.
      expectedClearBoundaryMs: baselineBoundary,
    });
  });

  it('does not acknowledge a pending clear from an equal stale boundary replay', async () => {
    remoteProjectsStore.pinSessionOrigin('device-1', SESSION_ID);
    const baselineBoundary = Date.parse('2026-08-03T00:00:00.000Z');
    onInputProjection?.(projection(SESSION_ID, { clearBoundaryMs: baselineBoundary }));
    let clearAttempts = 0;
    let enqueueCalls = 0;
    let online = false;
    deviceLinkInvoke.mockImplementation(async (_deviceId, channel, args) => {
      if (channel === 'maker:input:clear-session') {
        clearAttempts += 1;
        throw new Error('[DEVICE_LINK_NOT_CONNECTED] response lost after host clear');
      }
      if (channel === 'maker:close-session') return undefined;
      if (channel === 'maker:input:enqueue') {
        enqueueCalls += 1;
        return projection(SESSION_ID, {
          clearBoundaryMs: baselineBoundary,
          pendingQueue: [args[1] as AgentInputQueuedMessage],
        });
      }
      if (channel === 'maker:input:get-projection') {
        if (!online) throw new Error('[DEVICE_LINK_NOT_CONNECTED] host still offline');
        return projection(SESSION_ID, { clearBoundaryMs: baselineBoundary });
      }
      throw new Error(`unexpected remote channel: ${channel}`);
    });

    await makerChatStore.clearSession(SESSION_ID);
    await expect(
      makerChatStore.sendMessage(
        SESSION_ID,
        'still fenced after stale replay',
        MODEL,
        EFFORT,
        PERMISSION_MODE,
        WORKING_DIR,
      ),
    ).resolves.toBe(true);

    onInputProjection?.(projection(SESSION_ID, { clearBoundaryMs: baselineBoundary }));
    await flushPromises();

    expect(clearAttempts).toBe(1);
    expect(enqueueCalls).toBe(0);
  });

  it('retries clear only after a projection proves the first attempt was not applied', async () => {
    remoteProjectsStore.pinSessionOrigin('device-1', SESSION_ID);
    const baselineBoundary = Date.parse('2026-08-03T00:00:00.000Z');
    const appliedBoundary = baselineBoundary + 1_000;
    onInputProjection?.(projection(SESSION_ID, { clearBoundaryMs: baselineBoundary }));
    let clearAttempts = 0;
    let projectionProbes = 0;
    let enqueueCalls = 0;
    let online = false;
    deviceLinkInvoke.mockImplementation(async (_deviceId, channel, args) => {
      if (channel === 'maker:input:clear-session') {
        clearAttempts += 1;
        if (clearAttempts === 1) {
          throw new Error('[DEVICE_LINK_NOT_CONNECTED] request delivery uncertain');
        }
        return projection(SESSION_ID, { clearBoundaryMs: appliedBoundary });
      }
      if (channel === 'maker:input:get-projection') {
        projectionProbes += 1;
        if (!online) throw new Error('[DEVICE_LINK_NOT_CONNECTED] host still offline');
        return projection(SESSION_ID, { clearBoundaryMs: baselineBoundary });
      }
      if (channel === 'maker:close-session') return undefined;
      if (channel === 'maker:input:enqueue') {
        enqueueCalls += 1;
        return projection(SESSION_ID, {
          clearBoundaryMs: appliedBoundary,
          pendingQueue: [args[1] as AgentInputQueuedMessage],
        });
      }
      throw new Error(`unexpected remote channel: ${channel}`);
    });

    await makerChatStore.clearSession(SESSION_ID);
    await expect(
      makerChatStore.sendMessage(
        SESSION_ID,
        'send after proved retry',
        MODEL,
        EFFORT,
        PERMISSION_MODE,
        WORKING_DIR,
      ),
    ).resolves.toBe(true);

    await flushPromises();
    projectionProbes = 0;
    online = true;
    onPresenceChanged?.({ deviceId: 'device-1', online: true });
    await flushPromises();
    await flushPromises();
    await flushPromises();

    expect(projectionProbes).toBe(1);
    expect(clearAttempts).toBe(2);
    expect(enqueueCalls).toBe(1);
  });

  it('keeps an ambiguous clear fenced when the reconciliation projection also fails', async () => {
    remoteProjectsStore.pinSessionOrigin('device-1', SESSION_ID);
    const baselineBoundary = Date.parse('2026-08-03T00:00:00.000Z');
    onInputProjection?.(projection(SESSION_ID, { clearBoundaryMs: baselineBoundary }));
    let clearAttempts = 0;
    let projectionProbes = 0;
    let enqueueCalls = 0;
    deviceLinkInvoke.mockImplementation(async (_deviceId, channel, args) => {
      if (channel === 'maker:input:clear-session') {
        clearAttempts += 1;
        if (clearAttempts === 1) {
          throw new Error('[DEVICE_LINK_NOT_CONNECTED] request delivery uncertain');
        }
        return projection(SESSION_ID, { clearBoundaryMs: baselineBoundary + 1_000 });
      }
      if (channel === 'maker:input:get-projection') {
        projectionProbes += 1;
        throw new Error('[DEVICE_LINK_NOT_CONNECTED] projection unavailable');
      }
      if (channel === 'maker:close-session') return undefined;
      if (channel === 'maker:input:enqueue') {
        enqueueCalls += 1;
        return projection(SESSION_ID, {
          pendingQueue: [args[1] as AgentInputQueuedMessage],
        });
      }
      throw new Error(`unexpected remote channel: ${channel}`);
    });

    await makerChatStore.clearSession(SESSION_ID);
    await expect(
      makerChatStore.sendMessage(
        SESSION_ID,
        'still fenced after failed probe',
        MODEL,
        EFFORT,
        PERMISSION_MODE,
        WORKING_DIR,
      ),
    ).resolves.toBe(true);

    onPresenceChanged?.({ deviceId: 'device-1', online: true });
    await flushPromises();
    await flushPromises();

    expect(projectionProbes).toBeGreaterThanOrEqual(1);
    expect(clearAttempts).toBe(1);
    expect(enqueueCalls).toBe(0);
  });

  it('accepts a direct clear response even when the host boundary equals the baseline', async () => {
    remoteProjectsStore.pinSessionOrigin('device-1', SESSION_ID);
    const baselineBoundary = Date.parse('2026-08-03T00:00:00.000Z');
    onInputProjection?.(projection(SESSION_ID, { clearBoundaryMs: baselineBoundary }));
    let enqueueCalls = 0;
    deviceLinkInvoke.mockImplementation(async (_deviceId, channel, args) => {
      if (channel === 'maker:input:clear-session') {
        return projection(SESSION_ID, { clearBoundaryMs: baselineBoundary });
      }
      if (channel === 'maker:close-session') return undefined;
      if (channel === 'maker:input:enqueue') {
        enqueueCalls += 1;
        return projection(SESSION_ID, {
          clearBoundaryMs: baselineBoundary,
          pendingQueue: [args[1] as AgentInputQueuedMessage],
        });
      }
      if (channel === 'maker:input:get-projection') {
        return projection(SESSION_ID, { clearBoundaryMs: baselineBoundary });
      }
      throw new Error(`unexpected remote channel: ${channel}`);
    });

    await makerChatStore.clearSession(SESSION_ID);
    await expect(
      makerChatStore.sendMessage(
        SESSION_ID,
        'send after same-millisecond clear',
        MODEL,
        EFFORT,
        PERMISSION_MODE,
        WORKING_DIR,
      ),
    ).resolves.toBe(true);
    await flushPromises();

    expect(enqueueCalls).toBe(1);
  });

  it('does not reset a remote owner fence for repeated online presence updates', () => {
    const deviceId = 'device-1';
    remoteProjectsStore.setDeviceSessions(deviceId, 'Test Mac', [
      { id: SESSION_ID, status: 'active', title: 'initial' } as Session,
    ]);

    // The first online edge permits a restarted controlled process to start at
    // any local generation; subsequent online=true snapshots must not reopen
    // the fence (busy/name/settings updates use the same snapshot shape).
    onPresenceChanged?.({ deviceId, online: true });
    onRemotePush?.({
      deviceId,
      channel: 'local-db:sessions:patched',
      payload: { sessionId: SESSION_ID, patch: { title: 'generation-5' } },
      ownerStamp: { dataOwnerId: 'owner-a', ownerGeneration: 5 },
    });
    expect(remoteProjectsStore.getDeviceSessions(deviceId)[0]?.title).toBe('generation-5');

    onPresenceChanged?.({ deviceId, online: true });
    onRemotePush?.({
      deviceId,
      channel: 'local-db:sessions:patched',
      payload: { sessionId: SESSION_ID, patch: { title: 'stale-generation-4' } },
      ownerStamp: { dataOwnerId: 'owner-a', ownerGeneration: 4 },
    });
    expect(remoteProjectsStore.getDeviceSessions(deviceId)[0]?.title).toBe('generation-5');

    // A real offline -> online edge represents a possible controlled-process
    // restart, so the next lower generation is accepted after the reset.
    onPresenceChanged?.({ deviceId, online: false });
    onPresenceChanged?.({ deviceId, online: true });
    onRemotePush?.({
      deviceId,
      channel: 'local-db:sessions:patched',
      payload: { sessionId: SESSION_ID, patch: { title: 'generation-1-after-restart' } },
      ownerStamp: { dataOwnerId: 'owner-a', ownerGeneration: 1 },
    });
    expect(remoteProjectsStore.getDeviceSessions(deviceId)[0]?.title).toBe(
      'generation-1-after-restart',
    );
  });

  it('rejects stale local-owner frames before they can advance the remote fence', () => {
    const deviceId = 'device-1';
    remoteProjectsStore.setDeviceSessions(deviceId, 'Test Mac', [
      { id: SESSION_ID, status: 'active', title: 'initial' } as Session,
    ]);
    setDataOwnerGeneration('owner-a', 2);

    const stalePush = {
      deviceId,
      channel: 'local-db:sessions:patched',
      payload: { sessionId: SESSION_ID, patch: { title: 'stale' } },
      ownerStamp: { dataOwnerId: 'owner-a', ownerGeneration: 5 },
    };
    onRemotePush?.(stalePush, { dataOwnerId: 'owner-a', ownerGeneration: 1 });
    expect(remoteProjectsStore.getDeviceSessions(deviceId)[0]?.title).toBe('initial');

    onRemotePush?.(
      {
        ...stalePush,
        payload: { sessionId: SESSION_ID, patch: { title: 'updated' } },
        ownerStamp: { dataOwnerId: 'owner-a', ownerGeneration: 1 },
      },
      { dataOwnerId: 'owner-a', ownerGeneration: 2 },
    );
    expect(remoteProjectsStore.getDeviceSessions(deviceId)[0]?.title).toBe('updated');
  });

  it.each(['send', 'steer'] as const)(
    'discards an already-accepted annotated %s when clear wins before materialization',
    async (deliveryMode) => {
      remoteProjectsStore.pinSessionOrigin('device-1', SESSION_ID);
      if (deliveryMode === 'steer') {
        makerChatStore.__applyStatusUpdateForTest(SESSION_ID, {
          sessionId: SESSION_ID,
          status: 'running',
          tokenUsage: 0,
          contextTokens: 0,
          contextWindow: 0,
          isRunning: true,
        });
      }
      let resolveMaterialize!: (value: {
        url: string;
        name: string;
        ext: string;
        mimeType: string;
        size: number;
      }) => void;
      vi.mocked(window.electronAPI.cacheMediaForSession).mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveMaterialize = resolve;
          }),
      );
      const dispatchedChannels: string[] = [];
      deviceLinkInvoke.mockImplementation(async (_deviceId, channel) => {
        dispatchedChannels.push(channel);
        if (channel === 'maker:input:clear-session') return projection(SESSION_ID);
        if (channel === 'maker:close-session') return undefined;
        if (channel === 'maker:input:get-projection') return projection(SESSION_ID);
        throw new Error(`unexpected remote channel: ${channel}`);
      });
      const sharedAttachment: AttachedFile = {
        id: 'shared-annotation-source',
        name: 'shared.png',
        path: '',
        ext: '.png',
        size: 1,
        category: 'image',
        mimeType: 'image/png',
        url: 'xdt-image://source/shared.png',
        cacheUrlShared: true,
      };
      const restore = vi.fn();

      const pending =
        deliveryMode === 'steer'
          ? makerChatStore.steerMessage(
              SESSION_ID,
              'late steer',
              MODEL,
              EFFORT,
              PERMISSION_MODE,
              WORKING_DIR,
              [sharedAttachment],
              undefined,
              { onRemoteOptimisticFailure: restore },
            )
          : makerChatStore.sendMessage(
              SESSION_ID,
              'late send',
              MODEL,
              EFFORT,
              PERMISSION_MODE,
              WORKING_DIR,
              [sharedAttachment],
              undefined,
              { onRemoteOptimisticFailure: restore },
            );
      await flushPromises();
      expect(window.electronAPI.cacheMediaForSession).toHaveBeenCalledTimes(1);
      expect(setRemoteOptimisticAttachmentUrls).toHaveBeenLastCalledWith([sharedAttachment.url]);
      await expect(pending).resolves.toBe(true);

      makerChatStore.clearSession(SESSION_ID);
      await flushPromises();
      resolveMaterialize({
        url: 'xdt-image://text-delta-batching/private.png',
        name: 'private.png',
        ext: '.png',
        mimeType: 'image/png',
        size: 1,
      });

      await flushPromises();
      expect(restore).not.toHaveBeenCalled();
      expect(setRemoteOptimisticAttachmentUrls).toHaveBeenLastCalledWith([]);
      expect(dispatchedChannels).not.toContain('maker:input:enqueue');
      expect(dispatchedChannels).not.toContain('maker:input:steer');
    },
  );

  it.each(['send', 'steer'] as const)(
    'restores an old-owner annotated %s before its late materialization can dispatch',
    async (deliveryMode) => {
      remoteProjectsStore.pinSessionOrigin('device-1', SESSION_ID);
      if (deliveryMode === 'steer') {
        makerChatStore.__applyStatusUpdateForTest(SESSION_ID, {
          sessionId: SESSION_ID,
          status: 'running',
          tokenUsage: 0,
          contextTokens: 0,
          contextWindow: 0,
          isRunning: true,
        });
      }
      let resolveMaterialize!: (value: {
        url: string;
        name: string;
        ext: string;
        mimeType: string;
        size: number;
      }) => void;
      vi.mocked(window.electronAPI.cacheMediaForSession).mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveMaterialize = resolve;
          }),
      );
      const sharedAttachment: AttachedFile = {
        id: 'old-owner-annotation-source',
        name: 'old-owner.png',
        path: '',
        ext: '.png',
        size: 1,
        category: 'image',
        mimeType: 'image/png',
        url: 'xdt-image://source/old-owner.png',
        cacheUrlShared: true,
      };
      const restore = vi.fn();

      const pending =
        deliveryMode === 'steer'
          ? makerChatStore.steerMessage(
              SESSION_ID,
              'old-owner steer',
              MODEL,
              EFFORT,
              PERMISSION_MODE,
              WORKING_DIR,
              [sharedAttachment],
              undefined,
              { onRemoteOptimisticFailure: restore },
            )
          : makerChatStore.sendMessage(
              SESSION_ID,
              'old-owner send',
              MODEL,
              EFFORT,
              PERMISSION_MODE,
              WORKING_DIR,
              [sharedAttachment],
              undefined,
              { onRemoteOptimisticFailure: restore },
            );
      await flushPromises();
      expect(window.electronAPI.cacheMediaForSession).toHaveBeenCalledTimes(1);
      await expect(pending).resolves.toBe(true);

      makerChatStore.cancelRemoteOptimisticSendsForDataOwnerBoundary();
      expect(restore).toHaveBeenCalledWith(expect.any(String), expect.any(Error));
      setDataOwnerGeneration('owner-b');
      resolveMaterialize({
        url: 'xdt-image://text-delta-batching/private.png',
        name: 'private.png',
        ext: '.png',
        mimeType: 'image/png',
        size: 1,
      });

      await flushPromises();
      expect(restore).toHaveBeenCalledTimes(1);
      expect(deviceLinkInvoke).not.toHaveBeenCalled();
      expect(makerChatStore.getSnapshot(SESSION_ID).messages).toHaveLength(0);
      expect(makerChatStore.getSnapshot(SESSION_ID).pendingQueue).toHaveLength(0);
    },
  );

  it('drains multiple remote messages in FIFO order and keeps the pinned route after mirror clear', async () => {
    remoteProjectsStore.pinSessionOrigin('device-1', SESSION_ID);
    makerChatStore.__applyStatusUpdateForTest(SESSION_ID, {
      sessionId: SESSION_ID,
      status: 'running',
      tokenUsage: 0,
      contextTokens: 0,
      contextWindow: 0,
      isRunning: true,
    });
    let online = false;
    const sentTexts: string[] = [];
    deviceLinkInvoke.mockImplementation(async (deviceId, channel, args) => {
      expect(deviceId).toBe('device-1');
      if (channel === 'maker:input:enqueue') {
        const item = args[1] as AgentInputQueuedMessage;
        if (!online) throw new Error('[DEVICE_OFFLINE] target offline');
        sentTexts.push(item.text);
        return projection(SESSION_ID, { pendingQueue: [item] });
      }
      if (channel === 'maker:input:get-projection') return projection(SESSION_ID);
      throw new Error(`unexpected remote channel: ${channel}`);
    });

    await expect(
      makerChatStore.sendMessage(
        SESSION_ID,
        'first offline',
        MODEL,
        EFFORT,
        PERMISSION_MODE,
        WORKING_DIR,
      ),
    ).resolves.toBe(true);
    await expect(
      makerChatStore.sendMessage(
        SESSION_ID,
        'second offline',
        MODEL,
        EFFORT,
        PERMISSION_MODE,
        WORKING_DIR,
      ),
    ).resolves.toBe(true);
    expect(sentTexts).toEqual([]);

    online = true;
    // Clearing the live shard simulates the relay reconnect window. The
    // sticky origin must still route the pump to device-1, never local maker.
    remoteProjectsStore.clear();
    onPresenceChanged?.({ deviceId: 'device-1', online: true });
    await flushPromises();

    expect(sentTexts).toEqual(['first offline', 'second offline']);
    expect(
      deviceLinkInvoke.mock.calls
        .filter(([, channel]) => channel === 'maker:input:enqueue')
        .every(([deviceId]) => deviceId === 'device-1'),
    ).toBe(true);
  });

  it('keeps click FIFO when an annotated message materializes after a later plain message', async () => {
    remoteProjectsStore.pinSessionOrigin('device-1', SESSION_ID);
    makerChatStore.__applyStatusUpdateForTest(SESSION_ID, {
      sessionId: SESSION_ID,
      status: 'running',
      tokenUsage: 0,
      contextTokens: 0,
      contextWindow: 0,
      isRunning: true,
    });
    let resolveMaterialize!: (value: {
      url: string;
      name: string;
      ext: string;
      mimeType: string;
      size: number;
    }) => void;
    vi.mocked(window.electronAPI.cacheMediaForSession).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveMaterialize = resolve;
        }),
    );
    const sentTexts: string[] = [];
    deviceLinkInvoke.mockImplementation(async (_deviceId, channel, args) => {
      if (channel === 'maker:input:enqueue') {
        const item = args[1] as AgentInputQueuedMessage;
        sentTexts.push(item.text);
        return projection(SESSION_ID, { pendingQueue: [item] });
      }
      if (channel === 'maker:input:get-projection') return projection(SESSION_ID);
      throw new Error(`unexpected remote channel: ${channel}`);
    });
    const attachment: AttachedFile = {
      id: 'fifo-materializing-source',
      name: 'fifo-materializing.png',
      path: '',
      ext: '.png',
      size: 1,
      category: 'image',
      mimeType: 'image/png',
      url: 'xdt-image://source/fifo-materializing.png',
      cacheUrlShared: true,
    };

    await expect(
      makerChatStore.sendMessage(
        SESSION_ID,
        'first annotated',
        MODEL,
        EFFORT,
        PERMISSION_MODE,
        WORKING_DIR,
        [attachment],
      ),
    ).resolves.toBe(true);
    await expect(
      makerChatStore.sendMessage(
        SESSION_ID,
        'second plain',
        MODEL,
        EFFORT,
        PERMISSION_MODE,
        WORKING_DIR,
      ),
    ).resolves.toBe(true);
    await flushPromises();
    expect(sentTexts).toEqual([]);

    resolveMaterialize({
      url: 'xdt-image://text-delta-batching/fifo-private.png',
      name: 'fifo-private.png',
      ext: '.png',
      mimeType: 'image/png',
      size: 1,
    });
    await flushPromises();
    await flushPromises();
    await flushPromises();

    expect(sentTexts).toEqual(['first annotated', 'second plain']);
  });

  it('reruns a deferred remote preflight after the connection recovers', async () => {
    remoteProjectsStore.pinSessionOrigin('device-1', SESSION_ID);
    let online = false;
    let preflightCalls = 0;
    const beforeEnqueue = vi.fn(async () => {
      preflightCalls += 1;
      if (!online) throw new Error('[DEVICE_LINK_NOT_CONNECTED] remote preflight deferred');
      return true;
    });
    const sentTexts: string[] = [];
    deviceLinkInvoke.mockImplementation(async (_deviceId, channel, args) => {
      if (channel === 'maker:input:enqueue') {
        const item = args[1] as AgentInputQueuedMessage;
        sentTexts.push(item.text);
        return projection(SESSION_ID, { pendingQueue: [item] });
      }
      if (channel === 'maker:input:get-projection') return projection(SESSION_ID);
      throw new Error(`unexpected remote channel: ${channel}`);
    });

    await expect(
      makerChatStore.sendMessage(
        SESSION_ID,
        'wait for preflight',
        MODEL,
        EFFORT,
        PERMISSION_MODE,
        WORKING_DIR,
        undefined,
        undefined,
        { beforeEnqueue },
      ),
    ).resolves.toBe(true);
    expect(preflightCalls).toBe(1);
    expect(sentTexts).toEqual([]);

    online = true;
    onPresenceChanged?.({ deviceId: 'device-1', online: true });
    await flushPromises();

    expect(preflightCalls).toBe(2);
    expect(sentTexts).toEqual(['wait for preflight']);
  });

  it('hydrates existing runtime messages with authoritative DB-created timestamps', () => {
    vi.setSystemTime(new Date('2026-06-15T00:00:30.000Z'));
    emitTextDelta('draft');
    vi.advanceTimersByTime(32);

    const runtime = makerChatStore.getSnapshot(SESSION_ID).messages[0];
    expect(runtime).toEqual(
      expect.objectContaining({
        clientId: 'assistant-1',
        role: 'assistant',
        content: 'draft',
        createdAt: '2026-06-15T00:00:30.032Z',
      }),
    );

    onDbMessageCreated?.({
      sessionId: SESSION_ID,
      message: {
        clientId: 'assistant-1',
        role: 'assistant',
        content: 'persisted',
        createdAt: '2026-06-15T00:00:05.000Z',
      },
    });

    const messages = makerChatStore.getSnapshot(SESSION_ID).messages;
    expect(messages.filter((m) => m.clientId === 'assistant-1')).toHaveLength(1);
    expect(messages[0]).toEqual(
      expect.objectContaining({
        clientId: 'assistant-1',
        role: 'assistant',
        content: 'persisted',
        isStreaming: false,
        createdAt: '2026-06-15T00:00:05.000Z',
      }),
    );
  });

  it('hydrates persisted thinking rows back to their start timestamp', () => {
    onEvent?.({
      sessionId: SESSION_ID,
      event: {
        type: 'thinking',
        source: 'claude-code',
        data: {
          stage: 'start',
          blockId: 'thinking-1',
          startedAt: Date.parse('2026-06-15T00:00:00.000Z'),
        },
      },
    });

    const runtime = makerChatStore.getSnapshot(SESSION_ID).messages[0];
    expect(runtime).toEqual(
      expect.objectContaining({
        clientId: 'thinking-1',
        role: 'thinking',
        isStreaming: true,
        createdAt: '2026-06-15T00:00:00.000Z',
      }),
    );

    onDbMessageCreated?.({
      sessionId: SESSION_ID,
      message: {
        clientId: 'thinking-1',
        role: 'thinking',
        content: {
          kind: 'thinking',
          text: 'done',
          durationMs: 5000,
          finishedAt: '2026-06-15T00:00:05.000Z',
          isRedacted: false,
        },
        createdAt: '2026-06-15T00:00:09.000Z',
      },
    });

    const messages = makerChatStore.getSnapshot(SESSION_ID).messages;
    expect(messages.filter((m) => m.clientId === 'thinking-1')).toHaveLength(1);
    expect(messages[0]).toEqual(
      expect.objectContaining({
        clientId: 'thinking-1',
        role: 'thinking',
        content: 'done',
        isStreaming: false,
        thinkingDurationMs: 5000,
        createdAt: '2026-06-15T00:00:00.000Z',
      }),
    );
  });

  it('preserves live pending interaction state on DB-created echoes', () => {
    emitInteractionRequest(
      {
        kind: 'ask_user_question',
        requestId: 'ask-live',
        questions: [{ question: 'Continue?', options: [{ label: 'Yes' }] }],
      },
      'ask-live-message',
    );
    emitInteractionRequest(
      {
        kind: 'plan_review',
        requestId: 'plan-live',
        plan: '# Plan',
        planFilePath: 'C:\\workspace\\plan.md',
      },
      'plan-live-message',
    );

    onDbMessageCreated?.({
      sessionId: SESSION_ID,
      message: {
        clientId: 'ask-live-message',
        role: 'ask_user',
        content: {
          status: 'pending',
          requestId: 'ask-live',
          questions: [{ question: 'Continue?', options: [{ label: 'Yes' }] }],
        },
        createdAt: '2026-06-15T00:00:01.000Z',
      },
    });
    onDbMessageCreated?.({
      sessionId: SESSION_ID,
      message: {
        clientId: 'plan-live-message',
        role: 'plan_review',
        content: {
          status: 'pending',
          requestId: 'plan-live',
          plan: '# Plan',
          planFilePath: 'C:\\workspace\\plan.md',
        },
        createdAt: '2026-06-15T00:00:02.000Z',
      },
    });

    const messages = makerChatStore.getSnapshot(SESSION_ID).messages;
    expect(messages.find((m) => m.clientId === 'ask-live-message')).toEqual(
      expect.objectContaining({
        role: 'ask_user',
        askUserStatus: 'pending',
        askUserRequestId: 'ask-live',
        createdAt: '2026-06-15T00:00:01.000Z',
      }),
    );
    expect(messages.find((m) => m.clientId === 'plan-live-message')).toEqual(
      expect.objectContaining({
        role: 'plan_review',
        planReviewStatus: 'pending',
        planReviewRequestId: 'plan-live',
        createdAt: '2026-06-15T00:00:02.000Z',
      }),
    );
  });

  it('preserves terminal interaction state on late initial DB-created echoes', () => {
    emitInteractionRequest(
      {
        kind: 'ask_user_question',
        requestId: 'ask-terminal',
        questions: [{ question: 'Continue?', options: [{ label: 'Yes' }] }],
      },
      'ask-terminal-message',
    );
    emitInteractionRequest(
      {
        kind: 'plan_review',
        requestId: 'plan-terminal',
        plan: '# Plan',
        planFilePath: 'C:\\workspace\\plan.md',
      },
      'plan-terminal-message',
    );

    makerChatStore.answerUserQuestion(SESSION_ID, 'ask-terminal', { 'Continue?': 'Yes' });
    makerChatStore.respondToPlanReview(SESSION_ID, 'plan-terminal', false, 'Needs more detail');

    expect(makerChatStore.getSnapshot(SESSION_ID).messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          clientId: 'ask-terminal-message',
          askUserStatus: 'answered',
          askUserReply: 'Continue?: Yes',
          askUserAnswers: { 'Continue?': 'Yes' },
        }),
        expect.objectContaining({
          clientId: 'plan-terminal-message',
          planReviewStatus: 'revised',
          planReviewFeedback: 'Needs more detail',
        }),
      ]),
    );

    onDbMessageCreated?.({
      sessionId: SESSION_ID,
      message: {
        clientId: 'ask-terminal-message',
        role: 'ask_user',
        content: {
          status: 'pending',
          requestId: 'ask-terminal',
          questions: [{ question: 'Continue?', options: [{ label: 'Yes' }] }],
        },
        createdAt: '2026-06-15T00:00:03.000Z',
      },
    });
    onDbMessageCreated?.({
      sessionId: SESSION_ID,
      message: {
        clientId: 'plan-terminal-message',
        role: 'plan_review',
        content: {
          status: 'pending',
          requestId: 'plan-terminal',
          plan: '# Plan',
          planFilePath: 'C:\\workspace\\plan.md',
        },
        createdAt: '2026-06-15T00:00:04.000Z',
      },
    });

    const messages = makerChatStore.getSnapshot(SESSION_ID).messages;
    expect(messages.find((m) => m.clientId === 'ask-terminal-message')).toEqual(
      expect.objectContaining({
        askUserStatus: 'answered',
        askUserReply: 'Continue?: Yes',
        askUserAnswers: { 'Continue?': 'Yes' },
        createdAt: '2026-06-15T00:00:03.000Z',
      }),
    );
    expect(messages.find((m) => m.clientId === 'plan-terminal-message')).toEqual(
      expect.objectContaining({
        planReviewStatus: 'revised',
        planReviewFeedback: 'Needs more detail',
        createdAt: '2026-06-15T00:00:04.000Z',
      }),
    );
  });

  it('preserves dismissed interaction state on stale pending hydration', () => {
    const ask = makerChatStore.__hydratePersistedMessageForTest(
      {
        clientId: 'ask-dismissed-message',
        role: 'ask_user',
        content: 'Continue?',
        isStreaming: false,
        askUserStatus: 'expired',
        askUserRequestId: 'ask-dismissed',
        createdAt: '2026-06-15T00:00:00.000Z',
      },
      {
        clientId: 'ask-dismissed-message',
        role: 'ask_user',
        content: 'Continue?',
        isStreaming: false,
        askUserStatus: 'pending',
        askUserRequestId: 'ask-dismissed',
        createdAt: '2026-06-15T00:00:03.000Z',
      },
    );
    const plan = makerChatStore.__hydratePersistedMessageForTest(
      {
        clientId: 'plan-dismissed-message',
        role: 'plan_review',
        content: '',
        isStreaming: false,
        planReviewStatus: 'expired',
        planReviewRequestId: 'plan-dismissed',
        planReviewPlan: '# Plan',
        planReviewFilePath: 'C:\\workspace\\plan.md',
        createdAt: '2026-06-15T00:00:01.000Z',
      },
      {
        clientId: 'plan-dismissed-message',
        role: 'plan_review',
        content: '',
        isStreaming: false,
        planReviewStatus: 'pending',
        planReviewRequestId: 'plan-dismissed',
        planReviewPlan: '# Plan',
        planReviewFilePath: 'C:\\workspace\\plan.md',
        createdAt: '2026-06-15T00:00:04.000Z',
      },
    );

    expect(ask).toEqual(
      expect.objectContaining({
        askUserStatus: 'expired',
        createdAt: '2026-06-15T00:00:03.000Z',
      }),
    );
    expect(plan).toEqual(
      expect.objectContaining({
        planReviewStatus: 'expired',
        createdAt: '2026-06-15T00:00:04.000Z',
      }),
    );
  });

  it('preserves edited plan review content on stale pending hydration', () => {
    const plan = makerChatStore.__hydratePersistedMessageForTest(
      {
        clientId: 'plan-edited-message',
        role: 'plan_review',
        content: '',
        isStreaming: false,
        planReviewStatus: 'pending',
        planReviewRequestId: 'plan-edited',
        planReviewPlan: '# Edited plan',
        planReviewFilePath: 'C:\\workspace\\edited-plan.md',
        createdAt: '2026-06-15T00:00:01.000Z',
      },
      {
        clientId: 'plan-edited-message',
        role: 'plan_review',
        content: '',
        isStreaming: false,
        planReviewStatus: 'expired',
        planReviewRequestId: 'plan-edited',
        planReviewPlan: '# Original plan',
        planReviewFilePath: 'C:\\workspace\\original-plan.md',
        createdAt: '2026-06-15T00:00:04.000Z',
      },
    );

    expect(plan).toEqual(
      expect.objectContaining({
        planReviewStatus: 'pending',
        planReviewPlan: '# Edited plan',
        planReviewFilePath: 'C:\\workspace\\edited-plan.md',
        createdAt: '2026-06-15T00:00:04.000Z',
      }),
    );
  });

  it('maps device-link truncated marker and preserves existing full content during hydration', () => {
    const [mapped] = makerChatStore.__mapServerMessagesForTest([
      {
        id: 'row-1',
        clientId: 'tool-result-1',
        sessionId: SESSION_ID,
        role: 'tool_result',
        content: '[remote content truncated: payload too large]',
        toolUseId: 'toolu-1',
        agentMeta: { remoteContentTruncated: true },
        createdAt: '2026-06-15T00:00:03.000Z',
      } satisfies Message,
    ]);

    expect(mapped).toEqual(
      expect.objectContaining({
        clientId: 'tool-result-1',
        role: 'tool_result',
        remoteContentTruncated: true,
      }),
    );

    const hydrated = makerChatStore.__hydratePersistedMessageForTest(
      {
        clientId: 'tool-result-1',
        role: 'tool_result',
        content: '完整实时 tool 输出',
        isStreaming: false,
        toolUseId: 'toolu-1',
        createdAt: '2026-06-15T00:00:01.000Z',
      },
      mapped,
    );

    expect(hydrated).toEqual(
      expect.objectContaining({
        content: '完整实时 tool 输出',
        createdAt: '2026-06-15T00:00:03.000Z',
      }),
    );
    expect(hydrated.remoteContentTruncated).toBeUndefined();
  });

  it('preserves empty live content over compact history rows', () => {
    const [mapped] = makerChatStore.__mapServerMessagesForTest([
      {
        id: 'row-empty',
        clientId: 'tool-result-empty',
        sessionId: SESSION_ID,
        role: 'tool_result',
        content: '[remote content truncated: payload too large]',
        toolUseId: 'toolu-empty',
        agentMeta: { remoteContentTruncated: true },
        createdAt: '2026-06-15T00:00:03.000Z',
      } satisfies Message,
    ]);

    const hydrated = makerChatStore.__hydratePersistedMessageForTest(
      {
        clientId: 'tool-result-empty',
        role: 'tool_result',
        content: '',
        isStreaming: false,
        toolUseId: 'toolu-empty',
        createdAt: '2026-06-15T00:00:01.000Z',
      },
      mapped,
    );

    expect(hydrated).toEqual(
      expect.objectContaining({
        content: '',
        createdAt: '2026-06-15T00:00:03.000Z',
      }),
    );
    expect(hydrated.remoteContentTruncated).toBeUndefined();
  });

  it('allows richer truncated history to replace a previous remote placeholder', () => {
    const [mapped] = makerChatStore.__mapServerMessagesForTest([
      {
        id: 'row-1',
        clientId: 'tool-result-1',
        sessionId: SESSION_ID,
        role: 'tool_result',
        content: '部分可读 tool 输出\n\n[remote content truncated: payload too large]',
        toolUseId: 'toolu-1',
        agentMeta: { remoteContentTruncated: true },
        createdAt: '2026-06-15T00:00:03.000Z',
      } satisfies Message,
    ]);

    const hydrated = makerChatStore.__hydratePersistedMessageForTest(
      {
        clientId: 'tool-result-1',
        role: 'tool_result',
        content: '[remote content truncated: payload too large]',
        remoteContentTruncated: true,
        isStreaming: false,
        toolUseId: 'toolu-1',
        createdAt: '2026-06-15T00:00:01.000Z',
      },
      mapped,
    );

    expect(hydrated).toEqual(
      expect.objectContaining({
        content: '部分可读 tool 输出\n\n[remote content truncated: payload too large]',
        createdAt: '2026-06-15T00:00:03.000Z',
        remoteContentTruncated: true,
      }),
    );
  });

  it('allows richer truncated tool_result history to replace a short live summary', () => {
    const [mapped] = makerChatStore.__mapServerMessagesForTest([
      {
        id: 'row-richer-tool-result',
        rowid: 2,
        clientId: 'tool-result-richer',
        sessionId: SESSION_ID,
        role: 'tool_result',
        content:
          '第一段可读输出\n第二段可读输出\n第三段可读输出\n[remote content truncated: payload too large]',
        toolUseId: 'toolu-richer',
        agentMeta: { remoteContentTruncated: true },
        createdAt: '2026-06-15T00:00:03.000Z',
      } satisfies Message,
    ]);

    const hydrated = makerChatStore.__hydratePersistedMessageForTest(
      {
        clientId: 'tool-result-richer',
        role: 'tool_result',
        content: 'tool result summary',
        remoteContentTruncated: true,
        isStreaming: false,
        toolUseId: 'toolu-richer',
        createdAt: '2026-06-15T00:00:01.000Z',
      },
      mapped,
    );

    expect(hydrated).toEqual(
      expect.objectContaining({
        content:
          '第一段可读输出\n第二段可读输出\n第三段可读输出\n[remote content truncated: payload too large]',
        createdAt: '2026-06-15T00:00:03.000Z',
        remoteContentTruncated: true,
        rowid: 2,
      }),
    );
  });

  it('clears remote truncation markers after full hydration', () => {
    const fullHydrated = makerChatStore.__hydratePersistedMessageForTest(
      {
        clientId: 'tool-result-1',
        role: 'tool_result',
        content: '[remote content truncated: payload too large]',
        remoteContentTruncated: true,
        remoteRowsTrimmed: true,
        isStreaming: false,
        toolUseId: 'toolu-1',
        createdAt: '2026-06-15T00:00:01.000Z',
      },
      {
        clientId: 'tool-result-1',
        role: 'tool_result',
        content: 'ok',
        isStreaming: false,
        toolUseId: 'toolu-1',
        createdAt: '2026-06-15T00:00:03.000Z',
      },
    );

    expect(fullHydrated).toEqual(
      expect.objectContaining({
        content: 'ok',
        createdAt: '2026-06-15T00:00:03.000Z',
      }),
    );
    expect(fullHydrated.remoteContentTruncated).toBeUndefined();
    expect(fullHydrated.remoteRowsTrimmed).toBeUndefined();

    const laterCompact = makerChatStore.__hydratePersistedMessageForTest(fullHydrated, {
      clientId: 'tool-result-1',
      role: 'tool_result',
      content: 'larger truncated placeholder prefix',
      remoteContentTruncated: true,
      isStreaming: false,
      toolUseId: 'toolu-1',
      createdAt: '2026-06-15T00:00:04.000Z',
    });

    expect(laterCompact).toEqual(
      expect.objectContaining({
        content: 'ok',
        createdAt: '2026-06-15T00:00:04.000Z',
      }),
    );
    expect(laterCompact.remoteContentTruncated).toBeUndefined();
  });

  it('preserves live tool_use input when compact history hydrates after reconnect', () => {
    const fullInput = {
      command: 'x'.repeat(32 * 1024),
      timeout: 1,
    };
    const [mapped] = makerChatStore.__mapServerMessagesForTest([
      {
        id: 'row-tool-use',
        clientId: 'tool-use-1',
        sessionId: SESSION_ID,
        role: 'tool_use',
        content: {
          toolUseId: 'toolu-1',
          toolName: 'Bash',
          input: {
            command: '[remote content truncated: payload too large]',
            timeout: 1,
          },
        },
        toolUseId: 'toolu-1',
        agentMeta: { remoteContentTruncated: true },
        createdAt: '2026-06-15T00:00:03.000Z',
      } satisfies Message,
    ]);

    const hydrated = makerChatStore.__hydratePersistedMessageForTest(
      {
        clientId: 'tool-use-1',
        role: 'tool_use',
        content: 'Bash: xxxxx',
        isStreaming: false,
        toolUseId: 'toolu-1',
        toolName: 'Bash',
        toolInput: fullInput,
        createdAt: '2026-06-15T00:00:01.000Z',
      },
      mapped,
    );

    expect(hydrated).toEqual(
      expect.objectContaining({
        content: 'Bash: xxxxx',
        createdAt: '2026-06-15T00:00:03.000Z',
        toolInput: fullInput,
        toolName: 'Bash',
        toolUseId: 'toolu-1',
      }),
    );
    expect(hydrated.remoteContentTruncated).toBeUndefined();
  });

  it('allows richer truncated tool_use input to replace forced compact history', () => {
    const richerInput = {
      command: 'x'.repeat(4096),
      timeout: 1,
    };
    const [mapped] = makerChatStore.__mapServerMessagesForTest([
      {
        id: 'row-tool-use',
        clientId: 'tool-use-1',
        sessionId: SESSION_ID,
        role: 'tool_use',
        content: {
          toolUseId: 'toolu-1',
          toolName: 'Bash',
          input: richerInput,
        },
        toolUseId: 'toolu-1',
        agentMeta: { remoteContentTruncated: true },
        createdAt: '2026-06-15T00:00:03.000Z',
      } satisfies Message,
    ]);

    const hydrated = makerChatStore.__hydratePersistedMessageForTest(
      {
        clientId: 'tool-use-1',
        role: 'tool_use',
        content: 'Bash: xxxxx',
        isStreaming: false,
        remoteContentTruncated: true,
        toolUseId: 'toolu-1',
        toolName: 'Bash',
        toolInput: {
          command: 'x'.repeat(512),
          timeout: 1,
        },
        createdAt: '2026-06-15T00:00:01.000Z',
      },
      mapped,
    );

    expect(hydrated).toEqual(
      expect.objectContaining({
        content: mapped.content,
        createdAt: '2026-06-15T00:00:03.000Z',
        remoteContentTruncated: true,
        toolInput: richerInput,
        toolName: 'Bash',
        toolUseId: 'toolu-1',
      }),
    );
  });

  it('keeps pagination open for device-link row-trimmed short pages', () => {
    const trimmedRows = [
      serverMessage({
        id: 'row-1',
        clientId: 'assistant-1',
        sessionId: SESSION_ID,
        role: 'assistant',
        content: '裁剪后保留的消息',
        agentMeta: { remoteRowsTrimmed: true, remoteOriginalRowCount: 50 },
        createdAt: '2026-06-15T00:00:03.000Z',
      }),
    ];

    expect(makerChatStore.__serverMessagePageHasMoreForTest(trimmedRows, 50)).toBe(true);
    expect(
      makerChatStore.__serverMessagePageHasMoreForTest(
        trimmedRows.map((row) => ({ ...row, agentMeta: {} })),
        50,
      ),
    ).toBe(false);

    const [mapped] = makerChatStore.__mapServerMessagesForTest(trimmedRows);
    expect(mapped).toEqual(
      expect.objectContaining({
        clientId: 'assistant-1',
        remoteRowsTrimmed: true,
      }),
    );
  });

  it('chooses row-order aware oldest cursors for same-timestamp remote pages', () => {
    const rows = [
      serverMessage({
        id: 'row-m',
        clientId: 'assistant-m',
        sessionId: SESSION_ID,
        role: 'assistant',
        content: 'same timestamp newest row',
        agentMeta: { remoteRowsTrimmed: true, remoteOriginalRowCount: 50 },
        createdAt: '2026-06-15T00:00:03.000Z',
      }),
      serverMessage({
        id: 'row-a',
        clientId: 'assistant-a',
        sessionId: SESSION_ID,
        role: 'assistant',
        content: 'same timestamp middle row',
        agentMeta: { remoteRowsTrimmed: true, remoteOriginalRowCount: 50 },
        createdAt: '2026-06-15T00:00:03.000Z',
      }),
      serverMessage({
        id: 'row-z',
        clientId: 'assistant-z',
        sessionId: SESSION_ID,
        role: 'assistant',
        content: 'same timestamp oldest row',
        agentMeta: { remoteRowsTrimmed: true, remoteOriginalRowCount: 50 },
        createdAt: '2026-06-15T00:00:03.000Z',
      }),
    ];

    expect(makerChatStore.__oldestMessageRowForTest(rows, 'newest-first')?.id).toBe('row-z');
    expect(makerChatStore.__oldestMessageRowForTest([...rows].reverse(), 'oldest-first')?.id).toBe(
      'row-z',
    );
  });

  it('keeps same-ms remote pages ordered across existing page boundaries', () => {
    const createdAt = '2026-06-15T00:00:03.000Z';
    const existing = [
      {
        clientId: 'existing-row-3',
        rowid: 3,
        role: 'assistant',
        content: 'existing boundary row',
        isStreaming: false,
        createdAt,
      },
    ] satisfies ChatMessage[];
    const fetchedNewestFirst = [
      {
        clientId: 'newer-row-5',
        rowid: 5,
        role: 'assistant',
        content: 'newer fetched row',
        isStreaming: false,
        createdAt,
      },
      {
        clientId: 'older-row-2',
        rowid: 2,
        role: 'assistant',
        content: 'older fetched row',
        isStreaming: false,
        createdAt,
      },
    ] satisfies ChatMessage[];

    const merged = makerChatStore.__mergeMessagesForTest(
      fetchedNewestFirst,
      existing,
      {},
      'newest-first',
    );

    expect(merged.map((message) => message.clientId)).toEqual([
      'older-row-2',
      'existing-row-3',
      'newer-row-5',
    ]);
  });

  it('does not stop remote reconciliation on row-trimmed overlaps', () => {
    const row = serverMessage({
      id: 'row-1',
      clientId: 'assistant-1',
      sessionId: SESSION_ID,
      role: 'assistant',
      content: '裁剪后保留的重叠消息',
      createdAt: '2026-06-15T00:00:03.000Z',
    });

    expect(makerChatStore.__shouldStopRemoteReconciliationAtOverlapForTest([row], true)).toBe(true);
    expect(
      makerChatStore.__shouldStopRemoteReconciliationAtOverlapForTest(
        [{ ...row, agentMeta: { remoteRowsTrimmed: true, remoteOriginalRowCount: 50 } }],
        true,
      ),
    ).toBe(false);
    expect(
      makerChatStore.__shouldStopRemoteReconciliationAtOverlapForTest(
        [{ ...row, agentMeta: { remoteRowsTrimmed: true, remoteOriginalRowCount: 50 } }],
        false,
      ),
    ).toBe(false);
    expect(
      makerChatStore.__getRemoteReconciliationOverlapDecisionForTest(
        [{ ...row, agentMeta: { remoteRowsTrimmed: true, remoteOriginalRowCount: 50 } }],
        true,
      ),
    ).toEqual({ reachedKnownWindow: true, shouldStop: false });
  });

  it('preserves local retry payloads on user DB-created echoes', async () => {
    input.enqueue.mockImplementationOnce(async (sessionId: string) => projection(sessionId));
    const files: AttachedFile[] = [
      {
        id: 'file-1',
        name: 'a.txt',
        path: 'C:\\workspace\\a.txt',
        ext: '.txt',
        size: 1,
        category: 'text',
        mimeType: 'text/plain',
      },
    ];
    const mentions: MentionedResource[] = [
      { type: 'file', name: 'a.txt', path: 'C:\\workspace\\a.txt' },
    ];

    makerChatStore.sendMessage(
      SESSION_ID,
      'accepted',
      MODEL,
      EFFORT,
      PERMISSION_MODE,
      WORKING_DIR,
      files,
      mentions,
    );
    await flushPromises();

    const optimistic = makerChatStore
      .getSnapshot(SESSION_ID)
      .messages.find((m) => m.role === 'user' && m.content === 'accepted');
    expect(optimistic).toEqual(
      expect.objectContaining({ retryFiles: files, retryMentions: mentions }),
    );

    onDbMessageCreated?.({
      sessionId: SESSION_ID,
      message: {
        clientId: optimistic?.clientId,
        role: 'user',
        content: 'accepted',
        createdAt: '2026-06-15T00:00:03.000Z',
      },
    });

    const hydrated = makerChatStore
      .getSnapshot(SESSION_ID)
      .messages.find((m) => m.clientId === optimistic?.clientId);
    expect(hydrated?.isPendingPersist).toBeUndefined();
    expect(hydrated).toEqual(
      expect.objectContaining({
        retryFiles: files,
        retryMentions: mentions,
        createdAt: '2026-06-15T00:00:03.000Z',
      }),
    );
  });

  it('does not overwrite newer live tool_result content with stale DB-created echoes', () => {
    onEvent?.({
      sessionId: SESSION_ID,
      event: {
        type: 'tool_result',
        source: 'claude-code',
        data: { toolUseIds: ['tool-1'] },
      },
      persistId: 'tool-result-1',
      resolvedContent: 'summary',
    });
    onEvent?.({
      sessionId: SESSION_ID,
      event: {
        type: 'tool_result_full',
        source: 'claude-code',
        data: { toolUseId: 'tool-1' },
      },
      persistId: 'tool-result-1',
      resolvedContent: 'full output',
    });

    expect(makerChatStore.getSnapshot(SESSION_ID).messages).toEqual([
      expect.objectContaining({
        clientId: 'tool-result-1',
        role: 'tool_result',
        content: 'full output',
      }),
    ]);

    onDbMessageCreated?.({
      sessionId: SESSION_ID,
      message: {
        clientId: 'tool-result-1',
        role: 'tool_result',
        content: 'summary',
        toolUseId: 'tool-1',
        createdAt: '2026-06-15T00:00:04.000Z',
      },
    });

    expect(makerChatStore.getSnapshot(SESSION_ID).messages).toEqual([
      expect.objectContaining({
        clientId: 'tool-result-1',
        role: 'tool_result',
        content: 'full output',
        toolUseId: 'tool-1',
        createdAt: '2026-06-15T00:00:04.000Z',
      }),
    ]);
  });

  it('rejects fallback direct UI trigger sends when maker.send returns accepted:false', async () => {
    const api = window.electronAPI.maker;
    vi.mocked(sessionService.get).mockResolvedValueOnce(
      null as unknown as Awaited<ReturnType<typeof sessionService.get>>,
    );
    vi.mocked(api.send).mockResolvedValueOnce({ accepted: false, reason: 'workdir-missing' });

    await expect(
      makerChatStore.sendUiTrigger(SESSION_ID, '[UI_ACTION_TRIGGER] retry'),
    ).rejects.toThrow(/workdir-missing/);
  });

  it('requests executor-side interrupted-turn ack for a direct-send continue fallback', async () => {
    const api = window.electronAPI.maker;
    const ackInterrupted = window.electronAPI.localDb.sessions.ackInterrupted;
    vi.mocked(sessionService.get).mockResolvedValueOnce(
      null as unknown as Awaited<ReturnType<typeof sessionService.get>>,
    );
    vi.mocked(api.send).mockResolvedValueOnce({ accepted: true });

    await makerChatStore.sendUiTrigger(SESSION_ID, CONTINUE_AFTER_APP_EXIT_PROMPT);

    expect(api.send).toHaveBeenCalledWith(
      SESSION_ID,
      { type: 'user', content: CONTINUE_AFTER_APP_EXIT_PROMPT },
      undefined,
      expect.objectContaining({ ackInterruptedTurnOnDispatch: true }),
    );
    expect(ackInterrupted).not.toHaveBeenCalled();
  });

  it('keeps executor-side interrupted-turn ack requested when direct dispatch is rejected', async () => {
    const api = window.electronAPI.maker;
    const ackInterrupted = window.electronAPI.localDb.sessions.ackInterrupted;
    vi.mocked(sessionService.get).mockResolvedValueOnce(
      null as unknown as Awaited<ReturnType<typeof sessionService.get>>,
    );
    vi.mocked(api.send).mockResolvedValueOnce({ accepted: false, reason: 'session-busy' });

    await expect(
      makerChatStore.sendUiTrigger(SESSION_ID, CONTINUE_AFTER_APP_EXIT_PROMPT),
    ).rejects.toThrow(/session-busy/);

    expect(api.send).toHaveBeenCalledWith(
      SESSION_ID,
      { type: 'user', content: CONTINUE_AFTER_APP_EXIT_PROMPT },
      undefined,
      expect.objectContaining({ ackInterruptedTurnOnDispatch: true }),
    );
    expect(ackInterrupted).not.toHaveBeenCalled();
  });

  it('does not durable-dismiss the error tail while a continue trigger is only enqueued', async () => {
    vi.mocked(sessionService.get).mockResolvedValueOnce({
      agentKind: 'codex',
      remoteHostId: null,
      sdkSessionId: null,
      fastMode: false,
      contextTokens: 0,
      contextWindow: 0,
      totalCostUsd: 0,
      workingDir: WORKING_DIR,
      model: MODEL,
      effort: EFFORT,
      permissionMode: PERMISSION_MODE,
    } as unknown as Awaited<ReturnType<typeof sessionService.get>>);
    input.enqueue.mockImplementationOnce(async (sessionId: string) => projection(sessionId));
    emitDbMessageCreated({
      clientId: 'persisted-error-tail',
      role: 'error',
      content: 'interrupted',
      createdAt: '2026-07-23T00:00:00.000Z',
    });

    await makerChatStore.sendUiTrigger(SESSION_ID, CONTINUE_AFTER_APP_EXIT_PROMPT);

    expect(makerChatStore.getSnapshot(SESSION_ID).messages.at(-1)).toEqual(
      expect.objectContaining({
        clientId: 'persisted-error-tail',
        role: 'error',
      }),
    );
    expect(makerChatStore.getSnapshot(SESSION_ID).messages.at(-1)?.errorDismissed).not.toBe(true);
    expect(messageService.dismissError).not.toHaveBeenCalled();
  });

  it('dismisses the error tail after a direct-send continue fallback is accepted', async () => {
    const api = window.electronAPI.maker;
    const ackInterrupted = window.electronAPI.localDb.sessions.ackInterrupted;
    vi.mocked(sessionService.get).mockResolvedValueOnce(
      null as unknown as Awaited<ReturnType<typeof sessionService.get>>,
    );
    vi.mocked(api.send).mockResolvedValueOnce({ accepted: true });
    emitDbMessageCreated({
      clientId: 'persisted-error-tail-direct',
      role: 'error',
      content: 'interrupted',
      createdAt: '2026-07-23T00:00:00.000Z',
    });

    await makerChatStore.sendUiTrigger(SESSION_ID, CONTINUE_AFTER_APP_EXIT_PROMPT);

    expect(api.send).toHaveBeenCalledWith(
      SESSION_ID,
      { type: 'user', content: CONTINUE_AFTER_APP_EXIT_PROMPT },
      undefined,
      expect.objectContaining({ ackInterruptedTurnOnDispatch: true }),
    );
    expect(ackInterrupted).not.toHaveBeenCalled();
    expect(makerChatStore.getSnapshot(SESSION_ID).messages.at(-1)).toEqual(
      expect.objectContaining({
        clientId: 'persisted-error-tail-direct',
        errorDismissed: true,
      }),
    );
    expect(messageService.dismissError).toHaveBeenCalledWith(
      SESSION_ID,
      'persisted-error-tail-direct',
    );
  });

  it('keeps a new direct-send continuation failure visible while dismissing the original error', async () => {
    const api = window.electronAPI.maker;
    vi.mocked(sessionService.get).mockResolvedValueOnce(
      null as unknown as Awaited<ReturnType<typeof sessionService.get>>,
    );
    emitDbMessageCreated({
      clientId: 'original-error-tail-direct',
      role: 'error',
      content: 'interrupted',
      createdAt: '2026-07-23T00:00:00.000Z',
    });
    vi.mocked(api.send).mockImplementationOnce(async () => {
      emitDbMessageCreated({
        clientId: 'new-continuation-error',
        role: 'error',
        content: 'continuation failed',
        createdAt: '2026-07-23T00:00:01.000Z',
      });
      return { accepted: true };
    });

    await makerChatStore.sendUiTrigger(SESSION_ID, CONTINUE_AFTER_APP_EXIT_PROMPT);

    expect(messageService.dismissError).toHaveBeenCalledWith(
      SESSION_ID,
      'original-error-tail-direct',
    );
    expect(messageService.dismissError).not.toHaveBeenCalledWith(
      SESSION_ID,
      'new-continuation-error',
    );
    expect(makerChatStore.getSnapshot(SESSION_ID).messages).toEqual([
      expect.objectContaining({
        clientId: 'original-error-tail-direct',
        errorDismissed: true,
      }),
      expect.objectContaining({
        clientId: 'new-continuation-error',
      }),
    ]);
    expect(makerChatStore.getSnapshot(SESSION_ID).messages.at(-1)?.errorDismissed).not.toBe(true);
  });

  it('keeps DB-hydrated SSH UI triggers on the controller-global Maker Memory setting', async () => {
    vi.mocked(sessionService.get).mockResolvedValueOnce({
      agentKind: 'codex',
      remoteHostId: 'remote-host',
      sdkSessionId: null,
      fastMode: false,
      contextTokens: 0,
      contextWindow: 0,
      totalCostUsd: 0,
      workingDir: WORKING_DIR,
      model: MODEL,
      effort: EFFORT,
      permissionMode: PERMISSION_MODE,
    } as unknown as Awaited<ReturnType<typeof sessionService.get>>);
    input.enqueue.mockImplementationOnce(async (sessionId: string) => projection(sessionId));

    await makerChatStore.sendUiTrigger(SESSION_ID, '[UI_ACTION_TRIGGER] retry');

    expect(input.enqueue).toHaveBeenCalledWith(
      SESSION_ID,
      expect.objectContaining({
        createOpts: expect.objectContaining({
          remoteHostId: 'remote-host',
          // SSH remote 与本地同语义:跟随控制端全局 Maker Memory 设置
          // (默认开启), 不再被强制 false;scope 隔离由 maker-core 按
          // remoteHostId+workingDir 处理。
          makerMemoryEnabled: true,
        }),
      }),
      expect.any(Object),
    );
  });
});
