/**
 * learn 状态卡的 store 行为:runId 幂等插入 + 提案就绪时移到消息流末尾
 * (卡片在 /learn 发出时插入,长叙述后停在顶部会被用户错过 —— Chris 实测反馈)。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const transportMocks = vi.hoisted(() => ({
  listMessages: vi.fn(async () => []),
}));

vi.mock('@/lib/messageService', () => ({
  list: vi.fn(async () => []),
  around: vi.fn(async () => []),
  create: vi.fn(async () => ({}) as unknown),
  updateContent: vi.fn(async () => ({}) as unknown),
}));
vi.mock('@/lib/sessionService', () => ({
  get: vi.fn(async () => ({
    agentKind: 'cc',
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
vi.mock('@/lib/imageRef', () => ({
  parseUserContent: vi.fn((c: string) => ({ text: c, images: [], files: [] })),
  stringifyUserContent: vi.fn((text: string) => text),
}));
vi.mock('@/lib/composerDraftStore', () => ({
  saveDraft: vi.fn(),
  plainTextToTiptapDoc: (s: string) => ({
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text: s }] }],
  }),
}));
vi.mock('@/lib/makerTransport', () => ({
  makerApiFor: () => ({
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
    getPendingInteractions: vi.fn(async () => []),
  }),
  getSessionFor: vi.fn(async () => ({
    agentKind: 'cc',
    remoteHostId: null,
    sdkSessionId: null,
    fastMode: false,
    contextTokens: 0,
    contextWindow: 0,
    totalCostUsd: 0,
  })),
  listMessagesFor: transportMocks.listMessages,
  aroundMessagesFor: vi.fn(async () => []),
  aroundMessagesByClientIdFor: vi.fn(async () => []),
  dismissErrorMessageFor: vi.fn(async () => undefined),
  isRemoteSession: () => false,
}));

import { makerChatStore } from '@/lib/makerChatStore';

const sessionIds: string[] = [];
function sid(label: string): string {
  const value = `${label}-${Math.random().toString(36).slice(2, 8)}`;
  sessionIds.push(value);
  return value;
}

afterEach(() => {
  for (const id of sessionIds.splice(0)) makerChatStore.purgeSession(id);
});

describe('learn 状态卡 store 行为', () => {
  it('runId 幂等:重复 insert 不产生第二张卡', () => {
    const id = sid('learn-card');
    makerChatStore.insertSystemCard(id, 'learn', { runId: 'r1' });
    makerChatStore.insertSystemCard(id, 'learn', { runId: 'r1' });
    const cards = makerChatStore
      .getSnapshot(id)
      .messages.filter((m) => m.systemCardType === 'learn');
    expect(cards).toHaveLength(1);
  });

  it('moveLearnCardToEnd:提案就绪时卡片移到末尾,保持同一 clientId;已在末尾不动', () => {
    const id = sid('learn-move');
    const cardClientId = makerChatStore.insertSystemCard(id, 'learn', { runId: 'r1' });
    makerChatStore.insertSystemCard(id, 'status', { label: 'narration-1' });
    makerChatStore.insertSystemCard(id, 'status', { label: 'narration-2' });

    makerChatStore.moveLearnCardToEnd(id, 'r1');
    let msgs = makerChatStore.getSnapshot(id).messages;
    expect(msgs.at(-1)?.systemCardType).toBe('learn');
    expect(msgs.at(-1)?.clientId).toBe(cardClientId);

    // 幂等:已在末尾时引用不变(不触发无谓重渲染)
    const before = makerChatStore.getSnapshot(id).messages;
    makerChatStore.moveLearnCardToEnd(id, 'r1');
    expect(makerChatStore.getSnapshot(id).messages).toBe(before);

    // 未命中 runId 不动
    makerChatStore.moveLearnCardToEnd(id, 'r-missing');
    msgs = makerChatStore.getSnapshot(id).messages;
    expect(msgs.at(-1)?.systemCardType).toBe('learn');
  });
});

describe('agent switch 历史投影', () => {
  it('保留 resumed=true,让桌面端显示已续接原生会话', async () => {
    const id = sid('agent-switch-resumed');
    transportMocks.listMessages.mockResolvedValueOnce([
      {
        id: 'row-agent-switch',
        clientId: 'agent-switch:1',
        sessionId: id,
        role: 'agent_switch',
        content: {
          fromAgentKind: 'cc',
          toAgentKind: 'codex',
          fromModel: 'claude-sonnet-5',
          toModel: 'gpt-5.5-codex',
          handoff: 'handoff',
          resumed: true,
        },
        createdAt: Date.now(),
      },
    ] as never);

    makerChatStore.ensureInitialMessages(id);
    await vi.waitFor(() => {
      expect(makerChatStore.getSnapshot(id).historyLoaded).toBe(true);
    });

    const card = makerChatStore
      .getSnapshot(id)
      .messages.find((message) => message.systemCardType === 'agent-switch');
    expect(card?.systemCardData).toMatchObject({ resumed: true });
  });
});
