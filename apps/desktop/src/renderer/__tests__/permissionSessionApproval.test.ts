/**
 * permissionSessionApproval.test.ts
 * ---------------------------------------------------------------------------
 * Regression coverage for "Always allow for session".
 *
 * The UI is fed through maker interaction IPC, then responds through
 * resolveInteraction. Both hops must preserve vendor permission suggestions;
 * otherwise the button behaves like "Allow once".
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/messageService', () => ({
  list: vi.fn(async () => ({ items: [], hasMore: false, oldestId: null })),
  create: vi.fn(async () => ({}) as unknown),
  updateContent: vi.fn(async () => ({}) as unknown),
}));

vi.mock('@/lib/sessionService', () => ({
  update: vi.fn(async () => {}),
  touchUserSend: vi.fn(async () => {}),
}));

vi.mock('@/lib/sessionsBus', () => ({
  emitPatch: vi.fn(),
}));

vi.mock('@/lib/userPromptStore', () => ({
  getUserPrompt: () => '',
}));

vi.mock('@/lib/imageRef', () => ({
  parseUserContent: vi.fn((c: string) => ({ text: c, images: [], files: [] })),
  stringifyUserContent: vi.fn((text: string) => text),
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

const SESSION_ID = 'perm-session-approval';

type ListenerKey = 'event' | 'statusChanged' | 'inputProjection' | 'interaction' | 'dismissed' | 'messageCreated';

let listeners: Partial<Record<ListenerKey, (data: unknown) => void>>;
let resolveInteraction: ReturnType<typeof vi.fn>;
let listActive: ReturnType<typeof vi.fn>;

function subscribe(key: ListenerKey) {
  return (cb: (data: unknown) => void) => {
    listeners[key] = cb;
    return vi.fn();
  };
}

function installElectronBridge(): void {
  resolveInteraction = vi.fn(async () => {});
  listActive = vi.fn(async () => []);
  listeners = {};
  const w = globalThis as unknown as { window: Record<string, unknown> };
  w.window = {
    electronAPI: {
      maker: {
        onEvent: subscribe('event'),
        onStatusChanged: subscribe('statusChanged'),
        onInputProjection: subscribe('inputProjection'),
        onInteractionRequest: subscribe('interaction'),
        onInteractionDismissed: subscribe('dismissed'),
        input: {
          getProjection: vi.fn(async (sessionId: string) => ({
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
          })),
        },
        resolveInteraction,
        send: vi.fn(async () => {}),
        generateTitle: vi.fn(async () => ({ title: 't' })),
        abortSession: vi.fn(async () => {}),
        closeSession: vi.fn(async () => {}),
        listActive,
      },
      localDb: {
        messages: {
          onCreated: subscribe('messageCreated'),
        },
      },
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  makerChatStore.__teardownGlobalListeners();
  makerChatStore.purgeSession(SESSION_ID);
  installElectronBridge();
});

describe('permission interaction IPC', () => {
  it('rehydrates a running turn from main after renderer listener init', async () => {
    listActive.mockResolvedValueOnce([
      {
        sessionId: SESSION_ID,
        agentKind: 'claude-code',
        workDir: '/tmp/project',
        capabilities: {},
        isTurnRunning: true,
      },
    ]);

    makerChatStore.initGlobalListeners();
    makerChatStore.syncActiveTurnsFromMain();
    await Promise.resolve();
    await Promise.resolve();

    const snap = makerChatStore.getSnapshot(SESSION_ID);
    expect(snap.isStreaming).toBe(true);
    expect(snap.agentStatus.isRunning).toBe(true);
    expect(snap.agentStatus.status).toBe('Running');
  });

  it('rehydrates a running Pi turn instead of dropping the active snapshot', async () => {
    listActive.mockResolvedValueOnce([
      {
        sessionId: SESSION_ID,
        agentKind: 'pi',
        workDir: '/tmp/project',
        capabilities: {},
        isTurnRunning: true,
      },
    ]);

    makerChatStore.initGlobalListeners();
    makerChatStore.syncActiveTurnsFromMain();
    await Promise.resolve();
    await Promise.resolve();

    const snap = makerChatStore.getSnapshot(SESSION_ID);
    expect(snap.agentKind).toBe('pi');
    expect(snap.isStreaming).toBe(true);
    expect(snap.agentStatus.isRunning).toBe(true);
  });

  it('preserves title, description, and suggestions from main to pendingPermission', () => {
    const suggestions = [
      {
        type: 'addRules',
        rules: [{ toolName: 'mcp__lizi_feishu__call_tool' }],
        behavior: 'allow',
        destination: 'session',
      },
    ];

    makerChatStore.initGlobalListeners();
    listeners.interaction?.({
      sessionId: SESSION_ID,
      request: {
        kind: 'permission',
        requestId: 'perm-1',
        toolName: 'mcp:lizi_feishu',
        input: { serverName: 'lizi_feishu' },
        title: 'Allow Codex to use call_tool?',
        description: 'Allow the lizi_feishu MCP server to run tool "call_tool"?',
        suggestions,
      },
    });

    expect(makerChatStore.getSnapshot(SESSION_ID).pendingPermission).toEqual({
      requestId: 'perm-1',
      toolName: 'mcp:lizi_feishu',
      input: { serverName: 'lizi_feishu' },
      title: 'Allow Codex to use call_tool?',
      displayName: undefined,
      description: 'Allow the lizi_feishu MCP server to run tool "call_tool"?',
      suggestions,
    });
  });

  it('forwards updatedPermissions back through resolveInteraction', () => {
    const permissionUpdates = [
      {
        type: 'addRules',
        rules: [{ toolName: 'mcp__lizi_feishu__call_tool' }],
        behavior: 'allow',
        destination: 'session',
      },
    ];

    makerChatStore.initGlobalListeners();
    listeners.interaction?.({
      sessionId: SESSION_ID,
      request: {
        kind: 'permission',
        requestId: 'perm-2',
        toolName: 'mcp:lizi_feishu',
        input: {},
        suggestions: permissionUpdates,
      },
    });

    makerChatStore.respondToPermission(SESSION_ID, {
      behavior: 'allow',
      updatedPermissions: permissionUpdates,
      decisionClassification: 'user_permanent',
    });

    expect(resolveInteraction).toHaveBeenCalledWith(
      'perm-2',
      expect.objectContaining({
        kind: 'permission',
        behavior: 'allow',
        permissionUpdates,
      }),
    );
    expect(makerChatStore.getSnapshot(SESSION_ID).pendingPermission).toBeNull();
  });
});

describe('PermissionPrompt source contract', () => {
  const source = readFileSync(
    resolve(__dirname, '..', 'components', 'new-chat', 'PermissionPrompt.tsx'),
    'utf8',
  );

  it('only renders Always allow for session when session suggestions exist', () => {
    expect(source).toMatch(/canAlwaysAllowForSession\s*&&/);
  });

  it('uses maker-provided session-scoped suggestions without rewriting vendor payloads', () => {
    expect(source).toMatch(/destination\s*===\s*'session'/);
    expect(source).not.toContain("...suggestion, destination: 'session'");
  });
});
