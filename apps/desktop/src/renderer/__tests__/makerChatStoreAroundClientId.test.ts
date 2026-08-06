import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/makerTransport', () => ({
  getSessionFor: vi.fn(async () => ({
    agentKind: 'cc',
    remoteHostId: null,
    sdkSessionId: null,
    contextTokens: 0,
    contextWindow: 0,
    totalCostUsd: 0,
  })),
  listMessagesFor: vi.fn(async () => []),
  aroundMessagesByClientIdFor: vi.fn(async () => []),
  makerApiFor: vi.fn(() => ({
    input: {
      getProjection: vi.fn(async () => Promise.reject(new Error('n/a in test'))),
    },
  })),
  isRemoteSession: vi.fn(() => false),
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
import { aroundMessagesByClientIdFor } from '@/lib/makerTransport';
import type { Message } from '@/lib/ccAgent.types';

function makeElectronApiStub() {
  const fanOut = () => () => () => {};
  return {
    maker: {
      onEvent: fanOut(),
      onStatusChanged: fanOut(),
      onInputProjection: fanOut(),
      onInteractionRequest: fanOut(),
      onInteractionDismissed: fanOut(),
      input: {
        getProjection: vi.fn(async () => Promise.reject(new Error('n/a in test'))),
      },
    },
    localDb: { messages: { onCreated: fanOut() } },
    onUsageMessageTurnCost: fanOut(),
  };
}

function serverMessage(over: Partial<Message>): Message {
  return {
    id: over.id ?? over.clientId ?? 'id',
    clientId: over.clientId ?? 'client',
    sessionId: over.sessionId ?? 'sess-fork-origin',
    role: over.role ?? 'user',
    content: over.content ?? 'hello',
    toolUseId: null,
    agentMeta: null,
    createdAt: over.createdAt ?? '2026-06-12T00:00:00.000Z',
    ...over,
  } as Message;
}

describe('makerChatStore loadAroundMessageClientId', () => {
  const SID = 'sess-fork-origin';

  beforeEach(() => {
    (globalThis as { window?: unknown }).window = { electronAPI: makeElectronApiStub() };
    makerChatStore.initGlobalListeners();
  });

  afterEach(() => {
    makerChatStore.purgeSession(SID);
    makerChatStore.__teardownGlobalListeners();
    delete (globalThis as { window?: unknown }).window;
    vi.clearAllMocks();
  });

  it('loads around a message clientId and returns the found message', async () => {
    vi.mocked(aroundMessagesByClientIdFor).mockResolvedValueOnce([
      serverMessage({ id: 'm1', clientId: 'before', createdAt: '2026-06-12T00:00:00.000Z' }),
      serverMessage({ id: 'm2', clientId: 'target', createdAt: '2026-06-12T00:00:01.000Z' }),
    ]);

    const result = await makerChatStore.loadAroundMessageClientId(SID, 'target', { radius: 10 });

    expect(aroundMessagesByClientIdFor).toHaveBeenCalledWith(SID, 'target', { radius: 10 });
    expect(result?.clientId).toBe('target');
    expect(makerChatStore.getSnapshot(SID).messages.map((m) => m.clientId)).toEqual([
      'before',
      'target',
    ]);
  });

  it('hydrates shorter authoritative tool_result content during around-message hydration', async () => {
    vi.mocked(aroundMessagesByClientIdFor)
      .mockResolvedValueOnce([
        serverMessage({
          id: 'tool-result-row',
          clientId: 'tool-result-1',
          role: 'tool_result',
          content: 'verbose summary',
          toolUseId: 'tool-1',
          createdAt: '2026-06-12T00:00:01.000Z',
        }),
      ])
      .mockResolvedValueOnce([
        serverMessage({
          id: 'tool-result-row',
          clientId: 'tool-result-1',
          role: 'tool_result',
          content: 'ok',
          toolUseId: 'tool-1',
          createdAt: '2026-06-12T00:00:02.000Z',
        }),
      ]);

    await makerChatStore.loadAroundMessageClientId(SID, 'tool-result-1', { radius: 10 });
    await makerChatStore.loadAroundMessageClientId(SID, 'tool-result-1', { radius: 10 });

    expect(makerChatStore.getSnapshot(SID).messages).toEqual([
      expect.objectContaining({
        clientId: 'tool-result-1',
        role: 'tool_result',
        content: 'ok',
        toolUseId: 'tool-1',
        createdAt: '2026-06-12T00:00:02.000Z',
      }),
    ]);
  });
});
