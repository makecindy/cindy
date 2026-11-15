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
  setRemoteOptimisticAttachmentUrls: vi.fn(),
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

describe('voice call history projection', () => {
  // Real history ingress: a handoff must have a distinct entry even when its
  // call card is outside the loaded page. Prefix-only lookalikes stay ordinary.
  it('labels a host-receipted voice handoff without rewriting its original or role', async () => {
    const id = sid('voice-handoff-history');
    const original = '请在后台整理计划，然后退出语音模式。';
    const clientId = 'voice-task:call:u1';
    transportMocks.listMessages.mockResolvedValueOnce([
      {
        id: 'handoff-row', clientId, sessionId: id, role: 'user', content: original,
        agentMeta: { autoReviewUserText: {
          kind: 'agent-request', request: { userText: original, sessionId: id, clientId: 'u1' },
        } }, createdAt: 1000,
      },
      {
        id: 'ordinary-row', clientId: 'voice-task:call:u2', sessionId: id,
        role: 'user', content: original, createdAt: 2000,
      },
    ] as never);
    makerChatStore.ensureInitialMessages(id);
    await vi.waitFor(() => expect(makerChatStore.getSnapshot(id).historyLoaded).toBe(true));
    const [handoff, ordinary] = makerChatStore.getSnapshot(id).messages;
    expect(handoff).toMatchObject({
      clientId, role: 'user', content: original,
      systemCardType: 'voice-call-task', systemCardData: { text: original },
    });
    expect(ordinary.systemCardType).toBeUndefined();
  });

  it('restores the call as one expandable card without projecting turns as main messages', async () => {
    const id = sid('voice-call-history');
    const record = {
      version: 1, callId: 'call', startedAt: 1000, endedAt: 2000, handoffs: [],
      turns: [
        { id: 'voice-input', role: 'user', text: 'Call-only context.', createdAt: 1100, complete: true },
        { id: 'voice-reply', role: 'assistant', text: 'Hello.', createdAt: 1200, complete: true },
      ],
    };
    transportMocks.listMessages.mockResolvedValueOnce([{
      id: 'call-row', clientId: 'voice-call:call', sessionId: id,
      role: 'assistant', content: '', agentMeta: { voiceCall: record }, createdAt: 1000,
    }] as never);
    makerChatStore.ensureInitialMessages(id);
    await vi.waitFor(() => expect(makerChatStore.getSnapshot(id).historyLoaded).toBe(true));
    expect(makerChatStore.getSnapshot(id).messages).toMatchObject([{
      clientId: 'voice-call:call', content: '', systemCardType: 'voice-call',
      systemCardData: { record },
    }]);
  });
});

describe('agent switch 历史投影', () => {
  it.each(['restored', 'fallback'] as const)('重新打开任务保留换电脑信息与 %s 状态', async (nativeHistory) => {
    const id = sid(`agent-relocation-${nativeHistory}`);
    const relocation = {
      nativeHistory, resumed: nativeHistory === 'restored',
      toAgentDeviceId: 'test-macbook', toAgentDeviceName: 'Test MacBook',
      switchReason: 'quota-rebalance',
    };
    transportMocks.listMessages.mockResolvedValueOnce([{
      id: 'relocation-row', clientId: 'relocation', sessionId: id, role: 'agent_switch',
      content: { fromAgentKind: 'codex', toAgentKind: 'codex', ...relocation }, createdAt: Date.now(),
    }] as never);
    makerChatStore.ensureInitialMessages(id);
    await vi.waitFor(() => expect(makerChatStore.getSnapshot(id).historyLoaded).toBe(true));
    expect(makerChatStore.getSnapshot(id).messages[0].systemCardData).toMatchObject(relocation);
  });

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
    expect(card?.systemCardData).not.toHaveProperty('toAgentDeviceId');
  });
});

describe('context rebuild 历史投影', () => {
  it('把可见交接行投影成可展开的 context-rebuild 卡', async () => {
    const id = sid('context-rebuild-card');
    transportMocks.listMessages.mockResolvedValueOnce([
      {
        id: 'row-rebuild',
        clientId: 'context-rebuild-card:1',
        sessionId: id,
        role: 'assistant',
        content: '',
        agentMeta: {
          contextRebuild: {
            reason: 'pi-prompt-timeout',
            handoff: 'stopped responding to prompts',
          },
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
      .messages.find((message) => message.systemCardType === 'context-rebuild');
    expect(card?.systemCardData).toMatchObject({
      reason: 'pi-prompt-timeout',
      handoff: 'stopped responding to prompts',
    });
  });
});

describe('teammate result attachment history', () => {
  it('loads frozen results from the sealed reply even when the receipt is outside the history page', async () => {
    const id = sid('result-attachment');
    const result = {
      v: 1, role: 'delegation-result', delegationId: 'job', fromBotId: 'bot', fromBotName: 'Cindy',
      toBotId: null, toBotName: 'Cindy', parentSessionId: id, childSessionId: 'child', objective: 'Report',
      result: { runSequence: 2, status: 'completed', title: 'Report', text: 'Saved', artifacts: [] },
    };
    transportMocks.listMessages.mockResolvedValueOnce([
      { id: 'progress', clientId: 'progress', sessionId: id, role: 'assistant', content: 'Checking',
        agentMeta: { botTaskResults: [result] }, createdAt: 1 },
      { id: 'final', clientId: 'final', sessionId: id, role: 'assistant', content: 'Ready',
        agentMeta: { turnCompleted: true, botTaskResults: [result, result, {}] }, createdAt: 2 },
    ] as never);
    makerChatStore.ensureInitialMessages(id);
    await vi.waitFor(() => expect(makerChatStore.getSnapshot(id).historyLoaded).toBe(true));
    const messages = makerChatStore.getSnapshot(id).messages;
    expect(messages.find(message => message.clientId === 'progress')?.botTaskResults).toBeUndefined();
    expect(messages.find(message => message.clientId === 'final')?.botTaskResults).toEqual([result]);
  });
});

// Both initial history and live message insertion use the same stored-row projection.
describe('MCP App read-only history', () => {
  it.each(['owner', 'guest', 'pending'])(
    'keeps public text and titles for %s card history',
    async (audience) => {
      const id = sid('mcp-app-history');
      const text = audience === 'pending' ? '' : 'Saved form result';
      transportMocks.listMessages.mockResolvedValueOnce([
        {
          id: 'app-row',
          clientId: 'app-card',
          sessionId: id,
          role: 'assistant',
          createdAt: Date.now(),
          content:
            audience !== 'owner'
              ? { mcpAppHistory: { version: 1, title: 'Saved form', text } }
              : {
                  mcpApp: {
                    version: 1,
                    serverId: 'example',
                    serverRevision: 'revision',
                    resourceUri: 'ui://example/app',
                    tool: { name: 'draft', title: 'Saved form', inputSchema: { type: 'object' } },
                    arguments: {},
                    result: {
                      content: [{ type: 'text', text: 'Saved form result' }],
                      _meta: { private: 'view-only' },
                    },
                  },
                },
          agentMeta: { mcpApp: true },
        },
      ] as never);
      makerChatStore.ensureInitialMessages(id);
      await vi.waitFor(() => expect(makerChatStore.getSnapshot(id).historyLoaded).toBe(true));
      expect(makerChatStore.getSnapshot(id).messages[0]).toMatchObject({
        systemCardType: 'mcp-app',
        systemCardData: { title: 'Saved form', fallbackText: text },
      });
      expect(
        JSON.stringify(makerChatStore.getSnapshot(id).messages[0].systemCardData),
      ).not.toContain('view-only');
    },
  );
});

describe('private group reply source', () => {
  it('keeps group provenance on assistant rows without relabeling normal private replies', async () => {
    const id = sid('group-private-source');
    transportMocks.listMessages.mockResolvedValueOnce([
      { id: 'group-reply', clientId: 'group-reply', sessionId: id, role: 'assistant', content: 'Reply',
        agentMeta: { sourceGroup: { groupId: 'g-1', name: 'Design' } }, createdAt: Date.now() },
      { id: 'private-reply', clientId: 'private-reply', sessionId: id, role: 'assistant', content: 'Private',
        agentMeta: null, createdAt: Date.now() },
    ] as never);
    makerChatStore.ensureInitialMessages(id);
    await vi.waitFor(() => expect(makerChatStore.getSnapshot(id).historyLoaded).toBe(true));
    const messages = makerChatStore.getSnapshot(id).messages;
    expect(messages.find(m => m.clientId === 'group-reply')).toMatchObject({ role: 'assistant', sourceGroup: { groupId: 'g-1', name: 'Design' } });
    expect(messages.find(m => m.clientId === 'private-reply')?.sourceGroup).toBeUndefined();
  });
});
