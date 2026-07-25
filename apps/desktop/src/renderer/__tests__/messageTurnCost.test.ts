/**
 * messageTurnCost.test.ts
 * ---------------------------------------------------------------------------
 * per-turn 费用展示(MessageActionBar"本轮消耗")的 renderer 侧:
 *   - formatTurnCostUsd:用户可见费用统一保留两位小数。
 *   - makerChatStore:历史 USD 会投影为区域金额;本机 IPC 与 device-link
 *     remote push 都按 clientId 命中消息补字段;clientId 不存在 → state 引用不变(no-op)。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/messageService', () => ({
  list: vi.fn(async () => []),
  create: vi.fn(async () => ({}) as unknown),
  updateContent: vi.fn(async () => ({}) as unknown),
}));

vi.mock('@/lib/sessionService', () => ({
  get: vi.fn(async () => ({
    agentKind: 'cc',
    remoteHostId: null,
    sdkSessionId: null,
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

import { formatTurnCostUsd } from '@/lib/usageFormat';
import { CURRENT_CINDY_REGION } from '../../shared/brandRegion';
import { regionalizeLegacyUsd } from '../../shared/regionalMoney';
import { buildTurnUsageDetails } from '../../shared/turnUsageDetails';
import { makerChatStore } from '@/lib/makerChatStore';
import * as messageService from '@/lib/messageService';
import type { Message } from '@/lib/ccAgent.types';

describe('formatTurnCostUsd', () => {
  it('始终保留两位小数，小于一美分显示下限', () => {
    expect(formatTurnCostUsd(0.15)).toBe('$0.15');
    expect(formatTurnCostUsd(0.7)).toBe('$0.70');
    expect(formatTurnCostUsd(0.01)).toBe('$0.01');
    expect(formatTurnCostUsd(0.003)).toBe('<$0.01');
    expect(formatTurnCostUsd(0.0004)).toBe('<$0.01');
    expect(formatTurnCostUsd(9.99)).toBe('$9.99');
    expect(formatTurnCostUsd(12)).toBe('$12.00');
    expect(formatTurnCostUsd(52.22922325)).toBe('$52.23');
  });
});

// ── store 集成:历史映射 + 实时推送 ──────────────────────────────────────────

type FanOutCb = (data: unknown) => void;

function makeElectronApiStub() {
  let turnCostCb: FanOutCb | null = null;
  let remotePushCb: FanOutCb | null = null;
  const fanOut = () => () => () => {};
  const stub = {
    maker: {
      onEvent: fanOut(),
      onStatusChanged: fanOut(),
      onInputProjection: fanOut(),
      onInteractionRequest: fanOut(),
      onInteractionDismissed: fanOut(),
      input: {
        // reject → store 只 warn,不影响消息装载路径。
        getProjection: vi.fn(async () => Promise.reject(new Error('n/a in test'))),
      },
    },
    localDb: { messages: { onCreated: fanOut() } },
    deviceLink: {
      onRemotePush: (cb: FanOutCb) => {
        remotePushCb = cb;
        return () => {
          remotePushCb = null;
        };
      },
    },
    onUsageMessageTurnCost: (cb: FanOutCb) => {
      turnCostCb = cb;
      return () => {
        turnCostCb = null;
      };
    },
  };
  return { stub, getRemotePushCb: () => remotePushCb, getTurnCostCb: () => turnCostCb };
}

function serverMessage(over: Partial<Message>): Message {
  return {
    id: over.clientId ?? 'id',
    clientId: 'c1',
    sessionId: 'sess',
    role: 'assistant',
    content: 'hello',
    toolUseId: null,
    agentMeta: null,
    createdAt: '2026-06-12T00:00:00.000Z',
    ...over,
  } as Message;
}

const flush = () => new Promise((r) => setTimeout(r, 0));
const legacyMoney = (amountUsd: number) =>
  regionalizeLegacyUsd(amountUsd, CURRENT_CINDY_REGION);
const DETAILS = buildTurnUsageDetails({
  inputTokens: 1200,
  outputTokens: 300,
  cacheReadTokens: 4800,
  cacheCreateTokens: 0,
  model: 'claude-sonnet-4-6',
});
if (!DETAILS) {
  throw new Error('expected test turn usage details to be buildable');
}
const GPT_DETAILS = buildTurnUsageDetails({
  inputTokens: 213_800,
  outputTokens: 6_400,
  cacheReadTokens: 1_500_000,
  cacheCreateTokens: 0,
  model: 'gpt-5.5',
});
if (!GPT_DETAILS) {
  throw new Error('expected test GPT turn usage details to be buildable');
}
const GPT_DETAILS_WITHOUT_MODEL = buildTurnUsageDetails({
  inputTokens: 213_800,
  outputTokens: 6_400,
  cacheReadTokens: 1_500_000,
  cacheCreateTokens: 0,
});
if (!GPT_DETAILS_WITHOUT_MODEL) {
  throw new Error('expected test GPT turn usage details without model to be buildable');
}

describe('makerChatStore per-turn 费用', () => {
  let getRemotePushCb: () => FanOutCb | null;
  let getTurnCostCb: () => FanOutCb | null;
  const SID = 'sess-turn-cost';

  beforeEach(() => {
    const { stub, getRemotePushCb: getRemote, getTurnCostCb: getTurn } = makeElectronApiStub();
    getRemotePushCb = getRemote;
    getTurnCostCb = getTurn;
    (globalThis as { window?: unknown }).window = { electronAPI: stub };
    makerChatStore.initGlobalListeners();
  });

  afterEach(() => {
    makerChatStore.purgeSession(SID);
    makerChatStore.__teardownGlobalListeners();
    delete (globalThis as { window?: unknown }).window;
    vi.clearAllMocks();
  });

  it('历史加载:原始分段与用户轮累计成本分别映射;无值不映射', async () => {
    vi.mocked(messageService.list).mockResolvedValueOnce([
      serverMessage({
        clientId: 'a-with-cost',
        agentMeta: {
          turnCostUsd: 0.05,
          turnCostIsEstimate: true,
          userTurnCostUsd: 12.34,
          userTurnCostIsEstimate: true,
          turnUsageDetails: DETAILS ?? undefined,
        },
      }),
      serverMessage({
        clientId: 'a-stale-estimate',
        agentMeta: { turnCostUsd: 8.76, turnCostIsEstimate: true, turnUsageDetails: GPT_DETAILS },
      }),
      serverMessage({
        clientId: 'a-stale-estimate-meta-model',
        agentMeta: {
          model: 'gpt-5.5',
          turnCostUsd: 8.76,
          turnCostIsEstimate: true,
          turnUsageDetails: GPT_DETAILS_WITHOUT_MODEL,
        },
      }),
      serverMessage({
        clientId: 'a-live-pricing-preserved',
        agentMeta: {
          model: 'gpt-5.5',
          turnCostUsd: 3.14,
          turnCostIsEstimate: true,
          turnUsageDetails: GPT_DETAILS_WITHOUT_MODEL,
        },
      }),
      serverMessage({ clientId: 'a-no-cost' }),
    ]);
    makerChatStore.ensureInitialMessages(SID);
    await flush();
    await flush();

    const snap = makerChatStore.getSnapshot(SID);
    const withCost = snap.messages.find((m) => m.clientId === 'a-with-cost');
    const staleEstimate = snap.messages.find((m) => m.clientId === 'a-stale-estimate');
    const staleEstimateMetaModel = snap.messages.find((m) => m.clientId === 'a-stale-estimate-meta-model');
    const livePricingPreserved = snap.messages.find((m) => m.clientId === 'a-live-pricing-preserved');
    const noCost = snap.messages.find((m) => m.clientId === 'a-no-cost');
    expect(withCost?.turnMoney).toEqual(legacyMoney(0.05));
    expect(withCost?.turnCostIsEstimate).toBe(true);
    expect(withCost?.userTurnMoney).toEqual(legacyMoney(12.34));
    expect(withCost?.userTurnCostUsd).toBe(12.34);
    expect(withCost?.userTurnCostIsEstimate).toBe(true);
    expect(withCost?.turnUsageDetails).toEqual(DETAILS);
    expect(staleEstimate?.turnMoney).toEqual(legacyMoney(2.011));
    expect(staleEstimate?.turnCostIsEstimate).toBe(true);
    expect(staleEstimate?.turnUsageDetails).toEqual(GPT_DETAILS);
    expect(staleEstimateMetaModel?.turnMoney).toEqual(legacyMoney(2.011));
    expect(livePricingPreserved?.turnMoney).toEqual(legacyMoney(3.14));
    expect(noCost?.turnMoney).toBeUndefined();
  });

  it('device-link 旧历史:缺少持久化累计值时按完整用户轮投影', async () => {
    vi.mocked(messageService.list).mockResolvedValueOnce([
      serverMessage({
        clientId: 'user',
        role: 'user',
        createdAt: '2026-06-12T00:00:00.000Z',
      }),
      serverMessage({
        clientId: 'segment-1',
        createdAt: '2026-06-12T00:00:01.000Z',
        agentMeta: { turnCostUsd: 14.8 },
      }),
      serverMessage({
        clientId: 'auto-resume',
        role: 'user',
        createdAt: '2026-06-12T00:00:02.000Z',
        agentMeta: { autoResume: true },
      }),
      serverMessage({
        clientId: 'final',
        createdAt: '2026-06-12T00:00:03.000Z',
        agentMeta: { turnCostUsd: 0.7, turnCostIsEstimate: true },
      }),
    ]);
    makerChatStore.ensureInitialMessages(SID);
    await flush();
    await flush();

    const messages = makerChatStore.getSnapshot(SID).messages;
    expect(messages.find((m) => m.clientId === 'segment-1')?.userTurnMoney).toEqual(
      legacyMoney(14.8),
    );
    expect(messages.find((m) => m.clientId === 'segment-1')?.userTurnCostUsd).toBe(14.8);
    const final = messages.find((m) => m.clientId === 'final');
    expect(final?.userTurnMoney).toEqual(legacyMoney(15.5));
    expect(final?.userTurnCostUsd).toBe(15.5);
    expect(final?.userTurnCostIsEstimate).toBe(true);
  });

  it('实时推送:按 clientId 同时补原始分段与用户轮累计;未知 clientId → state 引用不变', async () => {
    vi.mocked(messageService.list).mockResolvedValueOnce([
      serverMessage({ clientId: 'a-live' }),
    ]);
    makerChatStore.ensureInitialMessages(SID);
    await flush();
    await flush();

    const cb = getTurnCostCb();
    expect(cb).toBeTruthy();
    cb!({
      sessionId: SID,
      clientId: 'a-live',
      turnCostUsd: 0.042,
      turnCostIsEstimate: false,
      userTurnCostUsd: 52.229224,
      userTurnCostIsEstimate: false,
      turnUsageDetails: DETAILS,
    });

    const snap = makerChatStore.getSnapshot(SID);
    const msg = snap.messages.find((m) => m.clientId === 'a-live');
    expect(msg?.turnMoney).toEqual(legacyMoney(0.042));
    expect(msg?.turnCostIsEstimate).toBe(false);
    expect(msg?.userTurnMoney).toEqual(legacyMoney(52.229224));
    expect(msg?.userTurnCostUsd).toBe(52.229224);
    expect(msg?.userTurnCostIsEstimate).toBe(false);
    expect(msg?.turnUsageDetails).toEqual(DETAILS);

    // 未知 clientId / 非法金额 → no-op(state 引用不变)。
    cb!({ sessionId: SID, clientId: 'ghost', turnCostUsd: 0.01, turnCostIsEstimate: false });
    cb!({ sessionId: SID, clientId: 'a-live', turnCostUsd: 0, turnCostIsEstimate: false });
    expect(makerChatStore.getSnapshot(SID)).toBe(snap);
  });

  it('实时推送:订阅估算值有 GPT token 明细时按 cache 口径重算', async () => {
    vi.mocked(messageService.list).mockResolvedValueOnce([
      serverMessage({ clientId: 'a-live-estimate' }),
    ]);
    makerChatStore.ensureInitialMessages(SID);
    await flush();
    await flush();

    const cb = getTurnCostCb();
    cb!({
      sessionId: SID,
      clientId: 'a-live-estimate',
      turnCostUsd: 8.76,
      turnCostIsEstimate: true,
      turnUsageDetails: GPT_DETAILS,
    });

    const msg = makerChatStore.getSnapshot(SID).messages.find((m) => m.clientId === 'a-live-estimate');
    expect(msg?.turnMoney).toEqual(legacyMoney(2.011));
    expect(msg?.turnCostIsEstimate).toBe(true);
  });

  it('实时推送:订阅估算值不像旧 full-cache 口径时保留原始 live pricing 值', async () => {
    vi.mocked(messageService.list).mockResolvedValueOnce([
      serverMessage({ clientId: 'a-live-pricing-preserved' }),
    ]);
    makerChatStore.ensureInitialMessages(SID);
    await flush();
    await flush();

    const cb = getTurnCostCb();
    cb!({
      sessionId: SID,
      clientId: 'a-live-pricing-preserved',
      turnCostUsd: 3.14,
      turnCostIsEstimate: true,
      turnUsageDetails: GPT_DETAILS,
    });

    const msg = makerChatStore.getSnapshot(SID).messages.find((m) => m.clientId === 'a-live-pricing-preserved');
    expect(msg?.turnMoney).toEqual(legacyMoney(3.14));
    expect(msg?.turnCostIsEstimate).toBe(true);
  });

  it('device-link remote push:按 clientId 命中消息补用户轮累计成本', async () => {
    vi.mocked(messageService.list).mockResolvedValueOnce([
      serverMessage({ clientId: 'a-remote' }),
    ]);
    makerChatStore.ensureInitialMessages(SID);
    await flush();
    await flush();

    const cb = getRemotePushCb();
    expect(cb).toBeTruthy();
    cb!({
      deviceId: 'dev-1',
      channel: 'usage:message-turn-cost',
      payload: {
        sessionId: SID,
        clientId: 'a-remote',
        turnCostUsd: 0.08,
        turnCostIsEstimate: true,
        userTurnCostUsd: 2.08,
        userTurnCostIsEstimate: true,
      },
    });

    const msg = makerChatStore.getSnapshot(SID).messages.find((m) => m.clientId === 'a-remote');
    expect(msg?.turnMoney).toEqual(legacyMoney(0.08));
    expect(msg?.turnCostIsEstimate).toBe(true);
    expect(msg?.userTurnMoney).toEqual(legacyMoney(2.08));
    expect(msg?.userTurnCostUsd).toBe(2.08);
    expect(msg?.userTurnCostIsEstimate).toBe(true);
  });
});
