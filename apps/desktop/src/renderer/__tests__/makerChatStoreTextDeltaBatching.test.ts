/**
 * makerChatStoreTextDeltaBatching.test.ts
 * ---------------------------------------------------------------------------
 * input dispatch 移到 main 后 renderer 仍需负责的契约：
 * text delta 合并、可恢复错误展示，以及基于 main projection 的队列保留。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  GHOST_SETUP_MAX_INTERACTION_STEPS,
  GHOST_SETUP_MAX_STEPS,
} from '../../shared/ghost';
import type { AgentInputProjection, AgentInputQueuedMessage } from '../../shared/agentInputQueue';
import type { Message } from '@/lib/ccAgent.types';
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
  plainTextToTiptapDoc: (s: string) => ({
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text: s }] }],
  }),
}));

import { makerChatStore, type ChatMessage } from '@/lib/makerChatStore';
import * as messageService from '@/lib/messageService';
import * as sessionService from '@/lib/sessionService';
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
let onDbMessageCreated: ((data: unknown) => void) | undefined;
let onInteractionRequest: ((data: unknown) => void) | undefined;
let onInteractionDismissed: ((data: unknown) => void) | undefined;
const getPendingInteractions = vi.fn<
  (sessionId: string) => Promise<
    Array<{
      request: { kind: string; requestId: string; [key: string]: unknown };
      persistId?: string;
    }>
  >
>(async () => []);

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
  clearSession: vi.fn(async (sessionId: string, _clearedAt?: string) => projection(sessionId)),
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
  onDbMessageCreated = undefined;
  onInteractionRequest = undefined;
  onInteractionDismissed = undefined;
  for (const fn of Object.values(input) as Array<{ mockClear: () => void }>) {
    fn.mockClear();
  }

  const w = globalThis as unknown as { window: Record<string, unknown> };
  w.window = {
    electronAPI: {
      maker: {
        input,
        onInputProjection: vi.fn(() => vi.fn()),
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

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    makerChatStore.__teardownGlobalListeners();
    makerChatStore.purgeSession(SESSION_ID);
    for (const sessionId of MULTI_SESSION_IDS) makerChatStore.purgeSession(sessionId);
    installElectronBridge();
    makerChatStore.initGlobalListeners();
  });

  afterEach(() => {
    makerChatStore.__teardownGlobalListeners();
    makerChatStore.purgeSession(SESSION_ID);
    for (const sessionId of MULTI_SESSION_IDS) makerChatStore.purgeSession(sessionId);
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

  it('forces DB-hydrated SSH UI triggers off controller-local Maker Memory', async () => {
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
          makerMemoryEnabled: false,
        }),
      }),
      expect.any(Object),
    );
  });
});
