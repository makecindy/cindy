/**
 * remoteStallRecovery.test.ts —— 控制端「卡死 Generating」恢复(makerChatStore 侧)。
 *
 * 锁住两件事:
 *  - finalizeStuckRemoteTurn:远程会话卡死(isRunning/isStreaming=true)时强制收尾 → 清 flag;
 *    幂等(二次 no-op、快照引用不变);本机会话整体 no-op(零回归)。
 *  - reconcileRemoteMessages 的 force:isStreaming 时默认仍跳过(happy-path 守卫不破),
 *    force=true 才放行补回(供 stall 看门狗在确认被控端 not-running 后补丢失消息)。
 *
 * 通过 initGlobalListeners + onEvent 驱动一个 status(isRunning=true)事件把会话推进「在跑/在串」态
 * (reducer 与 onRemotePush 远程路径同源),会话本身经 remoteProjectsStore 注册成远程。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Message } from '@/lib/ccAgent.types';

vi.mock('@/lib/messageService', () => ({
  list: vi.fn(async () => []),
  around: vi.fn(async () => []),
  create: vi.fn(async () => ({}) as unknown),
  updateContent: vi.fn(async () => ({}) as unknown),
}));
vi.mock('@/lib/sessionService', () => ({
  get: vi.fn(async () => ({
    agentKind: 'cc', remoteHostId: null, sdkSessionId: null, fastMode: false,
    contextTokens: 0, contextWindow: 0, totalCostUsd: 0,
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
  parseUserContent: vi.fn((c: string) => ({ text: c, images: [], files: [] })),
  stringifyUserContent: vi.fn((text: string) => text),
}));
vi.mock('@/lib/composerDraftStore', () => ({
  saveDraft: vi.fn(),
  plainTextToTiptapDoc: (s: string) => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: s }] }] }),
}));

import { makerChatStore } from '@/lib/makerChatStore';
import { remoteProjectsStore } from '@/features/device-link/remoteProjectsStore';

const DEVICE_ID = 'dev-A';
let n = 0;
const sid = () => `stall-${n++}`;

let onEvent: ((data: unknown) => void) | undefined;
let remoteList: Message[] = [];

const invoke = vi.fn(async (_deviceId: string, channel: string) => {
  if (channel === 'local-db:messages:list') return remoteList;
  if (channel === 'local-db:sessions:get') {
    return { agentKind: 'cc', remoteHostId: null, sdkSessionId: null, fastMode: false, contextTokens: 0, contextWindow: 0, totalCostUsd: 0 };
  }
  return null;
});

function installBridge(): void {
  onEvent = undefined;
  vi.stubGlobal('window', {
    electronAPI: {
      maker: {
        onInputProjection: vi.fn(() => vi.fn()),
        input: { getProjection: vi.fn(async () => null) },
        onEvent: (cb: (d: unknown) => void) => { onEvent = cb; return vi.fn(); },
        onStatusChanged: vi.fn(() => vi.fn()),
        onInteractionRequest: vi.fn(() => vi.fn()),
        onInteractionDismissed: vi.fn(() => vi.fn()),
      },
      localDb: { messages: { onCreated: vi.fn(() => vi.fn()) } },
      deviceLink: { invoke, onRemotePush: vi.fn(() => vi.fn()) },
    },
  });
}

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) await Promise.resolve();
}

function dbMessage(sessionId: string, id: string, content: string, ts: string, role: Message['role'] = 'assistant'): Message {
  return { id, clientId: `client-${id}`, sessionId, role, content, toolUseId: null, agentMeta: null, createdAt: ts };
}

/** 经 onEvent 推一个 status(isRunning)事件:reducer 把 state.isStreaming / agentStatus.isRunning 翻起。 */
function emitRunning(sessionId: string, isRunning: boolean): void {
  onEvent?.({
    sessionId,
    event: { type: 'status', source: 'claude-code', data: { status: 'thinking', isRunning, tokenUsage: 0, contextTokens: 0, contextWindow: 0 } },
  });
}

async function openRemoteStuck(s: string, initial: Message[]): Promise<void> {
  remoteList = initial;
  remoteProjectsStore.setDeviceSessions(DEVICE_ID, 'Mac A', [{ id: s }] as never);
  makerChatStore.ensureInitialMessages(s);
  await flush();
  emitRunning(s, true); // → isRunning=true + isStreaming=true(卡死的 Generating 态)
}

beforeEach(() => {
  installBridge();
  makerChatStore.__teardownGlobalListeners();
  makerChatStore.initGlobalListeners();
  remoteList = [];
  invoke.mockClear();
});

afterEach(() => {
  makerChatStore.__teardownGlobalListeners();
  remoteProjectsStore.clear();
  vi.unstubAllGlobals();
});

describe('finalizeStuckRemoteTurn', () => {
  it('远程卡死 → 收尾清 isRunning / isStreaming;幂等(二次快照引用不变)', async () => {
    const s = sid();
    await openRemoteStuck(s, [dbMessage(s, 'a1', '在', '2026-06-15T00:00:01.000Z')]);
    const before = makerChatStore.getSnapshot(s);
    expect(before.agentStatus.isRunning).toBe(true);
    expect(before.isStreaming).toBe(true);

    makerChatStore.finalizeStuckRemoteTurn(s);
    const after = makerChatStore.getSnapshot(s);
    expect(after.agentStatus.isRunning).toBe(false);
    expect(after.isStreaming).toBe(false);
    expect(after.streamingClientId).toBeNull();

    // 幂等:已收尾再调 → 不新建对象(引用不变)
    makerChatStore.finalizeStuckRemoteTurn(s);
    expect(makerChatStore.getSnapshot(s)).toBe(after);
  });

  it('本机会话 → no-op(不收尾,isRunning 保持)', async () => {
    const s = sid();
    // 不注册进 remoteProjectsStore → 本机会话
    makerChatStore.ensureInitialMessages(s);
    await flush();
    emitRunning(s, true);
    expect(makerChatStore.getSnapshot(s).agentStatus.isRunning).toBe(true);

    makerChatStore.finalizeStuckRemoteTurn(s);
    expect(makerChatStore.getSnapshot(s).agentStatus.isRunning).toBe(true); // 未被收尾
  });
});

describe('reconcileRemoteMessages — force(stall 看门狗放行)', () => {
  it('isStreaming + 默认 → 仍跳过(不破 happy-path 守卫)', async () => {
    const s = sid();
    await openRemoteStuck(s, [dbMessage(s, 'a1', '在', '2026-06-15T00:00:01.000Z')]);
    expect(makerChatStore.getSnapshot(s).isStreaming).toBe(true);

    remoteList = [
      dbMessage(s, 'a1', '在', '2026-06-15T00:00:01.000Z'),
      dbMessage(s, 'a2', '收到', '2026-06-15T00:00:02.000Z'), // 被控端有、控制端缺
    ];
    makerChatStore.reconcileRemoteMessages(s); // 无 force
    await flush();
    expect(makerChatStore.getSnapshot(s).messages.map((m) => m.clientId)).toEqual(['client-a1']); // 未补
  });

  it('isStreaming + force=true → 放行补回缺失消息', async () => {
    const s = sid();
    await openRemoteStuck(s, [dbMessage(s, 'a1', '在', '2026-06-15T00:00:01.000Z')]);
    remoteList = [
      dbMessage(s, 'a1', '在', '2026-06-15T00:00:01.000Z'),
      dbMessage(s, 'a2', '收到', '2026-06-15T00:00:02.000Z'),
    ];
    makerChatStore.reconcileRemoteMessages(s, { force: true });
    await flush();
    expect(makerChatStore.getSnapshot(s).messages.map((m) => m.clientId)).toEqual(['client-a1', 'client-a2']); // 补回
  });
});
