/**
 * deviceLinkInteractionScenarios.test.ts —— device-link「控制端交互往返」端到端集成(Tier 1)。
 * ---------------------------------------------------------------------------
 * 锁住「在远程会话上操作 agent 的交互特性」这条往返链路(过去要两台真机手测):
 *   被控端产生 interaction(permission / plan_review / ask_user_question)→ 经 push 推给
 *   控制端 → 控制端置 pending 卡片 → 用户响应 → `makerApiFor(sessionId).resolveInteraction`
 *   **按会话来源隧道**回被控端(`maker:resolve-interaction`)。
 *
 * 范式同 deviceLinkControllerScenarios:真实 makerChatStore + remoteProjectsStore +
 * makerTransport + initGlobalListeners,只在 `window.electronAPI.deviceLink.{invoke,onRemotePush}`
 * 注入忠实 FakeHost。node 环境,不引 RTL。
 *
 * 覆盖:permission allow/deny、plan approve(behavior=allow + editedPlan)/reject(deny + reason)、
 * ask(answers)、interaction-dismissed 清 pending、多请求并存、以及**本机会话零回归**
 * (未注册 origin → resolve 走本机 IPC,不经隧道)。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type { Session } from '@/lib/ccAgent.types';
import {
  __testing as dataOwnerTesting,
  setDataOwnerGeneration,
} from '@/contexts/dataOwnerGeneration';

vi.mock('@/lib/messageService', () => ({
  list: vi.fn(async () => []),
  around: vi.fn(async () => []),
  create: vi.fn(async () => ({}) as unknown),
  updateContent: vi.fn(async () => ({}) as unknown),
}));
vi.mock('@/lib/sessionService', () => ({
  get: vi.fn(async () => {
    throw new Error('[NOT_FOUND] Session 不存在');
  }),
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

import { makerChatStore } from '@/lib/makerChatStore';
import { remoteProjectsStore } from '@/features/device-link/remoteProjectsStore';
import * as messageService from '@/lib/messageService';
import { getIssueConfirmDraft, saveIssueConfirmDraft } from '@/lib/issueConfirmDraftStore';

const TEST_OWNER_STAMP = { dataOwnerId: 'test-owner', ownerGeneration: 0 } as const;
type RemotePush = {
  deviceId: string;
  channel: string;
  payload: unknown;
  ownerStamp?: typeof TEST_OWNER_STAMP;
};
type ResolveCall = { requestId: string; decision: Record<string, unknown> };

/** 被控端内存替身:转发 interaction push,记录 resolve-interaction,并提供挂起交互快照。 */
function makeFakeHost(deviceId: string) {
  let pushCb: ((p: RemotePush) => void) | null = null;
  const resolved: ResolveCall[] = [];
  // 被控端「当前挂起交互」快照(maker:get-pending-interactions 返回它)。
  const pending = new Map<
    string,
    Array<{ request: Record<string, unknown>; persistId?: string }>
  >();

  const invoke = vi.fn(async (_d: string, channel: string, args: unknown[]) => {
    switch (channel) {
      case 'maker:resolve-interaction':
        resolved.push({
          requestId: args[0] as string,
          decision: args[1] as Record<string, unknown>,
        });
        return null;
      case 'maker:get-pending-interactions':
        return pending.get(args[0] as string) ?? [];
      case 'local-db:messages:list':
        return [];
      case 'local-db:sessions:get':
        return { agentKind: 'cc', remoteHostId: null, sdkSessionId: null, fastMode: false };
      default:
        return null;
    }
  });

  return {
    deviceId,
    invoke,
    resolved,
    /** 被控端「已挂起」一条交互(不发 live push)—— 模拟控制端窗口在交互之后才打开的场景。 */
    seedPending(sessionId: string, request: Record<string, unknown>, persistId?: string): void {
      const arr = pending.get(sessionId) ?? [];
      arr.push({ request, persistId });
      pending.set(sessionId, arr);
    },
    clearPending(sessionId: string): void {
      pending.delete(sessionId);
    },
    registerPush(cb: (p: RemotePush) => void): () => void {
      pushCb = (push) => cb({ ...push, ownerStamp: push.ownerStamp ?? TEST_OWNER_STAMP });
      return () => {
        pushCb = null;
      };
    },
    /** 被控端产生 interaction → 推 maker:interaction-request(payload 形状对齐 main 广播)。 */
    hostInteraction(sessionId: string, request: Record<string, unknown>, persistId?: string): void {
      pushCb?.({
        deviceId,
        channel: 'maker:interaction-request',
        payload: { sessionId, request, persistId },
      });
    },
    /**
     * 被控端撤回 interaction → 推 maker:interaction-dismissed。
     * reason==='resolved'(被某端答了)时 main 会带上 decision(ask answers / plan behavior+reason),
     * 让对端 live 渲染「已回答」卡片;真·放弃(timeout / mode_changed / session_closed)不带。
     */
    hostDismiss(
      sessionId: string,
      requestId: string,
      reason = 'session_closed',
      decision?: unknown,
    ): void {
      pushCb?.({
        deviceId,
        channel: 'maker:interaction-dismissed',
        payload: { sessionId, requestId, reason, ...(decision !== undefined ? { decision } : {}) },
      });
    },
  };
}

type FakeHost = ReturnType<typeof makeFakeHost>;

/** window.electronAPI 桩:maker.* 本机响应通道用 vi.fn(校验「本机会话不经隧道」),deviceLink 接 FakeHost。 */
function stubElectronApi(host: FakeHost) {
  const fanOut = () => () => () => {};
  const localResolveInteraction = vi.fn(async () => {});
  const localSetPermissionMode = vi.fn(async () => {});
  const localSetFastMode = vi.fn(async () => {});
  const localGetPendingInteractions = vi.fn(
    async () =>
      [] as Array<{
        request: { kind: string; requestId: string; [key: string]: unknown };
        persistId?: string;
      }>,
  );
  (globalThis as { window?: unknown }).window = {
    electronAPI: {
      maker: {
        onEvent: fanOut(),
        onStatusChanged: fanOut(),
        onInputProjection: fanOut(),
        onInteractionRequest: fanOut(),
        onInteractionDismissed: fanOut(),
        resolveInteraction: localResolveInteraction,
        setPermissionMode: localSetPermissionMode,
        setFastMode: localSetFastMode,
        getPendingInteractions: localGetPendingInteractions,
        input: { getProjection: vi.fn(async (s: string) => emptyProjection(s)) },
      },
      localDb: { messages: { onCreated: fanOut() } },
      onUsageMessageTurnCost: fanOut(),
      deviceLink: {
        invoke: host.invoke,
        onRemotePush: (cb: (p: RemotePush) => void) => host.registerPush(cb),
        onStatusChanged: fanOut(),
        onPresenceChanged: fanOut(),
      },
    },
  };
  return {
    localResolveInteraction,
    localSetPermissionMode,
    localSetFastMode,
    localGetPendingInteractions,
  };
}

function emptyProjection(sessionId: string) {
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
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));
const DEVICE_ID = 'dev-int-scn';
let n = 0;
const sid = () => `int-scn-${n++}`;

let host: FakeHost;
let local: ReturnType<typeof stubElectronApi>;

/** 注册一个远程会话(getSessionDeviceId 命中 → makerApiFor 走隧道)。 */
function openRemoteSession(): string {
  const s = sid();
  remoteProjectsStore.setDeviceSessions(DEVICE_ID, 'Mac A', [{ id: s } as Session]);
  return s;
}

beforeEach(() => {
  dataOwnerTesting.reset();
  setDataOwnerGeneration(TEST_OWNER_STAMP.dataOwnerId, TEST_OWNER_STAMP.ownerGeneration);
  host = makeFakeHost(DEVICE_ID);
  local = stubElectronApi(host);
  makerChatStore.initGlobalListeners();
});

afterEach(() => {
  makerChatStore.__teardownGlobalListeners();
  remoteProjectsStore.clear();
  delete (globalThis as { window?: unknown }).window;
  vi.clearAllMocks();
  dataOwnerTesting.reset();
});

describe('device-link 远程交互往返 — permission', () => {
  it('被控端 permission 请求 → 控制端置 pendingPermission → allow 经隧道回传', async () => {
    const s = openRemoteSession();
    host.hostInteraction(s, {
      kind: 'permission',
      requestId: 'perm-1',
      toolName: 'Bash',
      input: { command: 'ls' },
    });
    await flush();

    const pending = makerChatStore.getSnapshot(s).pendingPermission;
    expect(pending?.requestId).toBe('perm-1');
    expect(pending?.toolName).toBe('Bash');

    makerChatStore.respondToPermission(s, { behavior: 'allow' });
    await flush();

    // 经隧道回被控端(不走本机 IPC)。
    expect(host.resolved).toHaveLength(1);
    expect(host.resolved[0].requestId).toBe('perm-1');
    expect(host.resolved[0].decision).toMatchObject({ kind: 'permission', behavior: 'allow' });
    expect(local.localResolveInteraction).not.toHaveBeenCalled();
    expect(makerChatStore.getSnapshot(s).pendingPermission).toBeNull();
  });

  it('permission deny 同样经隧道回传 behavior=deny', async () => {
    const s = openRemoteSession();
    host.hostInteraction(s, {
      kind: 'permission',
      requestId: 'perm-2',
      toolName: 'Write',
      input: {},
    });
    await flush();
    makerChatStore.respondToPermission(s, { behavior: 'deny', message: '不允许' });
    await flush();
    expect(host.resolved[0]).toMatchObject({
      requestId: 'perm-2',
      decision: { kind: 'permission', behavior: 'deny', reason: '不允许' },
    });
  });
});

describe('device-link 远程交互往返 — plan_review', () => {
  it('plan approve → behavior=allow + editedPlan(用户当前 plan)', async () => {
    const s = openRemoteSession();
    host.hostInteraction(
      s,
      {
        kind: 'plan_review',
        requestId: 'plan-1',
        plan: '# 计划\n步骤一',
        planFilePath: '/tmp/p.md',
      },
      'persist-plan-1',
    );
    await flush();
    expect(makerChatStore.getSnapshot(s).pendingPlanReview?.requestId).toBe('plan-1');

    makerChatStore.respondToPlanReview(s, 'plan-1', true);
    await flush();
    expect(host.resolved[0]).toMatchObject({
      requestId: 'plan-1',
      decision: { kind: 'plan_review', behavior: 'allow', editedPlan: '# 计划\n步骤一' },
    });
    expect(makerChatStore.getSnapshot(s).pendingPlanReview).toBeNull();
  });

  it('plan reject → behavior=deny + reason=feedback', async () => {
    const s = openRemoteSession();
    host.hostInteraction(
      s,
      { kind: 'plan_review', requestId: 'plan-2', plan: 'x', planFilePath: '' },
      'persist-plan-2',
    );
    await flush();
    makerChatStore.respondToPlanReview(s, 'plan-2', false, '再想想边界条件');
    await flush();
    expect(host.resolved[0]).toMatchObject({
      requestId: 'plan-2',
      decision: { kind: 'plan_review', behavior: 'deny', reason: '再想想边界条件' },
    });
  });
});

describe('device-link Desktop-only 确认 — 控制端只读投影', () => {
  it('只读提示展示期间保留 ChatInput，不把控制端锁死', () => {
    const src = readFileSync(
      resolve(__dirname, '..', 'features', 'cc-agent', 'CCAgentSessionView.tsx'),
      'utf8',
    );
    const branchStart = src.indexOf('/* 互斥:控制端能终结的 pending interaction');
    const chatInput = src.indexOf('<ChatInput', branchStart);
    expect(branchStart).toBeGreaterThan(-1);
    expect(chatInput).toBeGreaterThan(branchStart);
    expect(src.slice(branchStart, chatInput)).not.toContain('pendingRemoteDesktopConfirmation');
  });

  it.each(['issue_confirm', 'rename_sessions_confirm', 'ghost_grant_confirm'] as const)(
    '%s live push 只建立不可操作状态，dismissal 后清除',
    async (kind) => {
      const s = openRemoteSession();
      const requestId = `opaque-${kind}`;

      host.hostInteraction(s, {
        kind,
        requestId,
      });
      await flush();

      const state = makerChatStore.getSnapshot(s);
      expect(state.pendingRemoteDesktopConfirmation).toEqual({ kind, requestId });
      expect(state.pendingIssueConfirm).toBeNull();
      expect(state.pendingRenameSessionsConfirm).toBeNull();
      expect(state.pendingGhostGrantConfirm).toBeNull();
      expect(host.resolved).toHaveLength(0);
      expect(local.localResolveInteraction).not.toHaveBeenCalled();

      host.hostDismiss(s, requestId, 'resolved');
      await flush();
      expect(makerChatStore.getSnapshot(s).pendingRemoteDesktopConfirmation).toBeNull();
    },
  );

  it('远程来源即使误带完整 payload 也不能获得可操作确认能力', async () => {
    const s = openRemoteSession();
    host.hostInteraction(s, {
      kind: 'issue_confirm',
      requestId: 'opaque-full-payload',
      draft: { title: '敏感标题', body: '敏感正文', type: 'bug' },
      env: { appVersion: '1', platform: 'darwin', arch: 'arm64', osVersion: '1' },
      submissionIdentity: { kind: 'platform', login: 'private' },
    });
    await flush();

    expect(makerChatStore.getSnapshot(s).pendingRemoteDesktopConfirmation).toEqual({
      kind: 'issue_confirm',
      requestId: 'opaque-full-payload',
    });
    expect(makerChatStore.getSnapshot(s).pendingIssueConfirm).toBeNull();
  });

  it('并发确认按到达顺序排队，关闭任一项都不会丢失其余确认', async () => {
    const s = openRemoteSession();
    host.hostInteraction(s, { kind: 'issue_confirm', requestId: 'opaque-a' });
    host.hostInteraction(s, { kind: 'ghost_grant_confirm', requestId: 'opaque-b' });
    await flush();

    expect(makerChatStore.getSnapshot(s).pendingRemoteDesktopConfirmation).toEqual({
      kind: 'issue_confirm',
      requestId: 'opaque-a',
    });

    host.hostDismiss(s, 'opaque-b', 'resolved');
    await flush();
    expect(makerChatStore.getSnapshot(s).pendingRemoteDesktopConfirmation?.requestId).toBe(
      'opaque-a',
    );

    host.hostInteraction(s, { kind: 'ghost_grant_confirm', requestId: 'opaque-b' });
    await flush();
    host.hostDismiss(s, 'opaque-a', 'resolved');
    await flush();
    expect(makerChatStore.getSnapshot(s).pendingRemoteDesktopConfirmation).toEqual({
      kind: 'ghost_grant_confirm',
      requestId: 'opaque-b',
    });
  });

  it('重连快照可重建多个只读状态，后续权威快照将其逐项收口', async () => {
    const s = openRemoteSession();
    host.seedPending(s, {
      kind: 'issue_confirm',
      requestId: 'opaque-snapshot-a',
    });
    host.seedPending(s, {
      kind: 'rename_sessions_confirm',
      requestId: 'opaque-snapshot-b',
    });

    await makerChatStore.reconcilePendingInteractions(s);
    expect(makerChatStore.getSnapshot(s).pendingRemoteDesktopConfirmation).toEqual({
      kind: 'issue_confirm',
      requestId: 'opaque-snapshot-a',
    });

    host.clearPending(s);
    host.seedPending(s, {
      kind: 'rename_sessions_confirm',
      requestId: 'opaque-snapshot-b',
    });
    await makerChatStore.reconcilePendingInteractions(s);
    expect(makerChatStore.getSnapshot(s).pendingRemoteDesktopConfirmation).toEqual({
      kind: 'rename_sessions_confirm',
      requestId: 'opaque-snapshot-b',
    });

    host.clearPending(s);
    await makerChatStore.reconcilePendingInteractions(s);
    expect(makerChatStore.getSnapshot(s).pendingRemoteDesktopConfirmation).toBeNull();
  });
});

describe('device-link 远程 fastMode 持久化', () => {
  it('setFastMode 隧道失败时 reject 给调用方,避免草稿默认误同步', async () => {
    const s = openRemoteSession();
    const err = new Error('[REMOTE] relay down');
    host.invoke.mockImplementationOnce(
      async (deviceId: string, channel: string, args: unknown[]) => {
        expect(deviceId).toBe(DEVICE_ID);
        expect(channel).toBe('maker:set-fast-mode');
        expect(args).toEqual([s, true]);
        throw err;
      },
    );

    await expect(makerChatStore.setFastMode(s, true)).rejects.toThrow('relay down');
    expect(host.invoke).toHaveBeenCalledWith(DEVICE_ID, 'maker:set-fast-mode', [s, true]);
    expect(makerChatStore.getSnapshot(s).fastMode).toBe(false);
  });

  it('已捕获 deviceId 在 session origin 消失后仍固定走远程 Fast 隧道', async () => {
    const s = openRemoteSession();
    remoteProjectsStore.clear();

    await makerChatStore.setFastMode(s, true, DEVICE_ID);

    expect(host.invoke).toHaveBeenCalledWith(DEVICE_ID, 'maker:set-fast-mode', [s, true]);
    expect(local.localSetFastMode).not.toHaveBeenCalled();
    expect(makerChatStore.getSnapshot(s).fastMode).toBe(true);
  });
});

describe('device-link 远程交互往返 — ask_user_question', () => {
  it('ask 请求 → 控制端置 pendingAskUser → answers 经隧道回传', async () => {
    const s = openRemoteSession();
    host.hostInteraction(
      s,
      {
        kind: 'ask_user_question',
        requestId: 'ask-1',
        questions: [
          {
            question: '用哪个库?',
            header: 'lib',
            options: [{ label: 'A', description: '' }],
            multiSelect: false,
          },
        ],
      },
      'persist-ask-1',
    );
    await flush();
    expect(makerChatStore.getSnapshot(s).pendingAskUser?.requestId).toBe('ask-1');

    makerChatStore.answerUserQuestion(s, 'ask-1', { '用哪个库?': 'A' });
    await flush();
    expect(host.resolved[0]).toMatchObject({
      requestId: 'ask-1',
      decision: { kind: 'ask_user_question', answers: { '用哪个库?': 'A' } },
    });
    expect(makerChatStore.getSnapshot(s).pendingAskUser).toBeNull();
  });

  // F1:远程会话答 ask 不再 dead-write 控制端本机 DB(被控端在 RESOLVE_INTERACTION 权威落库)。
  it('远程答 ask → 不调本机 messageService.updateContent(避免写控制端空库丢答案)', async () => {
    (messageService.updateContent as ReturnType<typeof vi.fn>).mockClear();
    const s = openRemoteSession();
    host.hostInteraction(
      s,
      {
        kind: 'ask_user_question',
        requestId: 'ask-f1',
        questions: [
          {
            question: 'X?',
            header: 'h',
            options: [{ label: 'A', description: '' }],
            multiSelect: false,
          },
        ],
      },
      'persist-ask-f1',
    );
    await flush();
    makerChatStore.answerUserQuestion(s, 'ask-f1', { 'X?': 'A' });
    await flush();
    expect(messageService.updateContent).not.toHaveBeenCalled(); // 远程跳过本机写
    expect(host.resolved.find((r) => r.requestId === 'ask-f1')?.decision).toMatchObject({
      kind: 'ask_user_question',
      answers: { 'X?': 'A' },
    });
  });
});

describe('device-link 远程交互 — dismissed / 顺序 / 本机零回归', () => {
  it('interaction-dismissed push → 清掉对应 pending 卡片(无需控制端响应)', async () => {
    const s = openRemoteSession();
    host.hostInteraction(s, {
      kind: 'permission',
      requestId: 'perm-d',
      toolName: 'Bash',
      input: {},
    });
    await flush();
    expect(makerChatStore.getSnapshot(s).pendingPermission?.requestId).toBe('perm-d');

    host.hostDismiss(s, 'perm-d', 'mode_changed_to_bypassPermissions');
    await flush();
    expect(makerChatStore.getSnapshot(s).pendingPermission).toBeNull();
    expect(host.resolved).toHaveLength(0); // dismissed 不触发响应回传
  });

  // 对端(另一控制端 / 被控端自己)解决交互后,被控端 main 广播 INTERACTION_DISMISSED('resolved')
  // → 本端面板必须收敛清掉(本轮修复:resolve handler 现在会广播 dismissed)。覆盖 ask / plan。
  it('对端解决 ask(带 answers)→ 本端清 pendingAskUser + 卡片转 answered 并填答案(非 expired)', async () => {
    const s = openRemoteSession();
    host.hostInteraction(
      s,
      {
        kind: 'ask_user_question',
        requestId: 'ask-other',
        questions: [
          {
            question: 'X?',
            header: 'h',
            options: [{ label: 'A', description: '' }],
            multiSelect: false,
          },
        ],
      },
      'persist-ask-other',
    );
    await flush();
    expect(makerChatStore.getSnapshot(s).pendingAskUser?.requestId).toBe('ask-other');

    // 对端答了 → 被控端 resolve handler 广播 dismissed('resolved') 并带上 answers。
    host.hostDismiss(s, 'ask-other', 'resolved', {
      kind: 'ask_user_question',
      answers: { 'X?': 'A' },
    });
    await flush();
    expect(makerChatStore.getSnapshot(s).pendingAskUser).toBeNull();
    const askMsg = makerChatStore
      .getSnapshot(s)
      .messages.find((m) => m.askUserRequestId === 'ask-other');
    expect(askMsg?.askUserStatus).toBe('answered'); // 与答题端一致,而非 expired
    expect(askMsg?.askUserAnswers).toEqual({ 'X?': 'A' });
  });

  it('对端 dismiss 但无 decision(真·放弃 / 老被控端)→ ask 仍标 expired(兜底)', async () => {
    const s = openRemoteSession();
    host.hostInteraction(
      s,
      {
        kind: 'ask_user_question',
        requestId: 'ask-noamt',
        questions: [
          {
            question: 'X?',
            header: 'h',
            options: [{ label: 'A', description: '' }],
            multiSelect: false,
          },
        ],
      },
      'persist-ask-noamt',
    );
    await flush();
    host.hostDismiss(s, 'ask-noamt', 'session_closed'); // 无 decision
    await flush();
    expect(makerChatStore.getSnapshot(s).pendingAskUser).toBeNull();
    const askMsg = makerChatStore
      .getSnapshot(s)
      .messages.find((m) => m.askUserRequestId === 'ask-noamt');
    expect(askMsg?.askUserStatus).toBe('expired');
  });

  it('对端解决 plan(reject+feedback)→ 本端清 pendingPlanReview + 卡片转 revised 带 feedback', async () => {
    const s = openRemoteSession();
    host.hostInteraction(
      s,
      { kind: 'plan_review', requestId: 'plan-other', plan: '# P', planFilePath: '' },
      'persist-plan-other',
    );
    await flush();
    expect(makerChatStore.getSnapshot(s).pendingPlanReview?.requestId).toBe('plan-other');

    host.hostDismiss(s, 'plan-other', 'resolved', {
      kind: 'plan_review',
      behavior: 'deny',
      reason: '改一下范围',
    });
    await flush();
    expect(makerChatStore.getSnapshot(s).pendingPlanReview).toBeNull();
    const planMsg = makerChatStore
      .getSnapshot(s)
      .messages.find((m) => m.planReviewRequestId === 'plan-other');
    expect(planMsg?.planReviewStatus).toBe('revised'); // 与答题端一致,而非 expired
    expect(planMsg?.planReviewFeedback).toBe('改一下范围');
  });

  it('多会话各自的 interaction 互不串台,resolve 命中正确 requestId', async () => {
    const s1 = openRemoteSession();
    const s2 = openRemoteSession();
    host.hostInteraction(s1, {
      kind: 'permission',
      requestId: 'p-s1',
      toolName: 'Bash',
      input: {},
    });
    host.hostInteraction(s2, {
      kind: 'permission',
      requestId: 'p-s2',
      toolName: 'Write',
      input: {},
    });
    await flush();
    expect(makerChatStore.getSnapshot(s1).pendingPermission?.requestId).toBe('p-s1');
    expect(makerChatStore.getSnapshot(s2).pendingPermission?.requestId).toBe('p-s2');

    makerChatStore.respondToPermission(s2, { behavior: 'allow' });
    await flush();
    expect(host.resolved).toHaveLength(1);
    expect(host.resolved[0].requestId).toBe('p-s2');
    expect(makerChatStore.getSnapshot(s1).pendingPermission?.requestId).toBe('p-s1'); // s1 仍待处理
  });

  it('本机会话零回归:未注册 origin → resolve 走本机 IPC,不经隧道', async () => {
    const s = sid(); // 不注册进 remoteProjectsStore → 本机
    // 直接喂一个本机 interaction-request(模拟本机 onInteractionRequest 行为,共用同一 reducer)。
    host.hostInteraction(s, {
      kind: 'permission',
      requestId: 'local-perm',
      toolName: 'Bash',
      input: {},
    });
    await flush();
    expect(makerChatStore.getSnapshot(s).pendingPermission?.requestId).toBe('local-perm');

    makerChatStore.respondToPermission(s, { behavior: 'allow' });
    await flush();
    expect(local.localResolveInteraction).toHaveBeenCalledWith(
      'local-perm',
      expect.objectContaining({ kind: 'permission', behavior: 'allow' }),
    );
    expect(host.resolved).toHaveLength(0); // 本机会话不经隧道
  });
});

describe('device-link 交互快照重建 — 窗口在交互挂起之后才打开(无 live push)', () => {
  it('本机 issue_confirm:无 push → 快照重建确认卡，重复重放保留用户草稿', async () => {
    const s = sid();
    local.localGetPendingInteractions.mockResolvedValue([
      {
        request: {
          kind: 'issue_confirm',
          requestId: 'issue-mid',
          draft: { title: '原始标题', body: '原始正文', type: 'bug' },
          env: {
            appVersion: '0.1.23',
            platform: 'darwin',
            arch: 'arm64',
            osVersion: '25.0',
            region: 'cn',
          },
          submissionIdentity: { kind: 'platform', login: 'cindy-issue' },
          suggestedPublicName: '当前昵称',
        },
      },
    ]);

    makerChatStore.ensureInitialMessages(s);
    await flush();
    await flush();
    expect(makerChatStore.getSnapshot(s).pendingIssueConfirm?.requestId).toBe('issue-mid');
    expect(local.localGetPendingInteractions).toHaveBeenCalledWith(s);
    expect(host.invoke).not.toHaveBeenCalledWith(DEVICE_ID, 'maker:get-pending-interactions', [s]);

    saveIssueConfirmDraft(s, 'issue-mid', {
      title: '用户编辑后的标题',
      body: '用户编辑后的正文',
      type: 'feature',
      publicName: '匿名',
    });
    await makerChatStore.reconcilePendingInteractions(s);
    expect(getIssueConfirmDraft(s, 'issue-mid')).toMatchObject({
      title: '用户编辑后的标题',
      body: '用户编辑后的正文',
      type: 'feature',
      publicName: '匿名',
    });
    makerChatStore.purgeSession(s);
  });

  it('兼容旧 Main 已固定的 GitHub 身份，不静默丢弃确认卡', async () => {
    const s = sid();
    local.localGetPendingInteractions.mockResolvedValue([
      {
        request: {
          kind: 'issue_confirm',
          requestId: 'issue-legacy-github',
          draft: { title: '旧版标题', body: '旧版正文', type: 'bug' },
          env: {
            appVersion: '0.1.33',
            platform: 'win32',
            arch: 'x64',
            osVersion: '10.0',
          },
          submissionIdentity: { kind: 'github-user', login: 'legacy-user' },
        },
      },
    ]);

    makerChatStore.ensureInitialMessages(s);
    await flush();
    await flush();

    expect(makerChatStore.getSnapshot(s).pendingIssueConfirm).toMatchObject({
      requestId: 'issue-legacy-github',
      submissionIdentity: { kind: 'github-user', login: 'legacy-user' },
    });
    expect(makerChatStore.getSnapshot(s).pendingIssueConfirm?.githubUserIdentity).toBeUndefined();
    expect(makerChatStore.getSnapshot(s).pendingIssueConfirm?.suggestedPublicName).toBeUndefined();
    makerChatStore.purgeSession(s);
  });

  it('permission:被控端已挂起 + 不发 push → ensureInitialMessages 后重建 pendingPermission', async () => {
    const s = openRemoteSession();
    host.seedPending(s, {
      kind: 'permission',
      requestId: 'perm-mid',
      toolName: 'Bash',
      input: { command: 'ls' },
    });
    // 关键:不调 host.hostInteraction(不发 live push)—— 模拟新窗口错过了那条实时推送。
    makerChatStore.ensureInitialMessages(s);
    await flush();
    await flush();
    expect(host.invoke).toHaveBeenCalledWith(DEVICE_ID, 'maker:get-pending-interactions', [s]);
    expect(makerChatStore.getSnapshot(s).pendingPermission?.requestId).toBe('perm-mid');
  });

  it('ask_user_question:无 push → 快照重建 pendingAskUser', async () => {
    const s = openRemoteSession();
    host.seedPending(
      s,
      {
        kind: 'ask_user_question',
        requestId: 'ask-mid',
        questions: [
          {
            question: 'X?',
            header: 'h',
            options: [{ label: 'A', description: '' }],
            multiSelect: false,
          },
        ],
      },
      'persist-ask-mid',
    );
    makerChatStore.ensureInitialMessages(s);
    await flush();
    await flush();
    expect(makerChatStore.getSnapshot(s).pendingAskUser?.requestId).toBe('ask-mid');
  });

  it('plan_review:无 push → 快照重建 pendingPlanReview', async () => {
    const s = openRemoteSession();
    host.seedPending(
      s,
      { kind: 'plan_review', requestId: 'plan-mid', plan: '# P', planFilePath: '' },
      'persist-plan-mid',
    );
    makerChatStore.ensureInitialMessages(s);
    await flush();
    await flush();
    expect(makerChatStore.getSnapshot(s).pendingPlanReview?.requestId).toBe('plan-mid');
  });

  it('去重:同 requestId 重复喂 ask(push + 快照重建)→ messages 里该 ask 仍只有 1 条', async () => {
    const s = openRemoteSession();
    const ask = {
      kind: 'ask_user_question',
      requestId: 'ask-dup',
      questions: [
        {
          question: 'X?',
          header: 'h',
          options: [{ label: 'A', description: '' }],
          multiSelect: false,
        },
      ],
    };
    host.hostInteraction(s, ask, 'persist-ask-dup'); // live push 建 1 条
    await flush();
    host.hostInteraction(s, ask, 'persist-ask-dup'); // 重复(模拟快照重建再喂一次)
    await flush();
    const askMsgs = makerChatStore
      .getSnapshot(s)
      .messages.filter((m) => m.role === 'ask_user' && m.askUserRequestId === 'ask-dup');
    expect(askMsgs).toHaveLength(1);
    expect(askMsgs[0].askUserStatus).toBe('pending');
  });

  it('本机会话:快照重建走本机 IPC(getPendingInteractions),不经隧道', async () => {
    const s = sid(); // 未注册 → 本机
    makerChatStore.ensureInitialMessages(s);
    await flush();
    await flush();
    expect(local.localGetPendingInteractions).toHaveBeenCalledWith(s);
    expect(host.invoke).not.toHaveBeenCalledWith(DEVICE_ID, 'maker:get-pending-interactions', [s]);
  });
});

// ─── 接线源不变式:锁住远程交互的「收」与「发」两半,防像 orca 那样静默退化 ───────────────
describe('远程交互接线不变式', () => {
  const R = resolve(__dirname, '..');
  // Windows CRLF 检出下 \n 字面量断言会失配,统一归一化成 LF 再断言。
  const read = (rel: string) => readFileSync(resolve(R, rel), 'utf8').replace(/\r\n/g, '\n');

  it('makerChatStore 远程 push switch 消费 interaction-request / interaction-dismissed(否则远程卡片不显示)', () => {
    const src = read('lib/makerChatStore.ts');
    expect(src).toContain("case 'maker:interaction-request':");
    expect(src).toContain("case 'maker:interaction-dismissed':");
  });

  it('makerChatStore 的 resolve 全经 makerApiFor 按来源路由,不直连本机 maker.resolveInteraction', () => {
    const src = read('lib/makerChatStore.ts');
    expect(src).toContain('makerApiFor(sessionId)');
    expect(src).toContain('.resolveInteraction(');
    // 直连本机会让远程会话的响应错发到控制端本机(无 pending resolver)→ 远程交互卡死。
    expect(src).not.toContain('electronAPI.maker.resolveInteraction');
  });

  it('makerChatStore 不向 device-link 远程 session 透传本地 Maker Memory 开关;SSH 跟随全局设置', () => {
    const src = read('lib/makerChatStore.ts');
    expect(src).toContain('const deviceLinkRemote = isRemoteSessionSticky(sessionId);');
    // 该表达式可能被 prettier 折成多行:先把空白折叠成单空格,只锁 token 序列。
    // SSH remote 与本地同语义 (memory 按 hostId+远端路径 scope 存本机),
    // 不再出现 ssh 强制 false 的三元;device-link 仍整体省略该字段。
    expect(src.replace(/\s+/g, ' ')).toContain(
      '...(deviceLinkRemote ? {} : { makerMemoryEnabled: getMakerMemoryEnabled() })',
    );
    expect(src).not.toContain('sshRemote ? false');
  });

  it('context usage 对 SSH 跟随全局 Maker Memory 设置,对 device-link 仍省略', () => {
    const src = read('features/cc-agent/CCAgentSessionView.tsx');
    expect(src.replace(/\s+/g, ' ')).toContain(
      '...(remoteDeviceId ? {} : { makerMemoryEnabled: getMakerMemoryEnabled() })',
    );
    expect(src).not.toContain('makerMemoryEnabled: session.remoteHostId ? false');
  });

  it('ChatInput 的 setPermissionMode 远程经隧道(makerApiFor),本机才走本机 IPC', () => {
    const src = read('components/new-chat/ChatInput.tsx');
    expect(src).toContain('makerApiFor(sessionId).setPermissionMode');
    const runtimeSet = src.indexOf(
      'await window.electronAPI.maker.setPermissionMode(sessionId, newMode);',
    );
    const persistSet = src.indexOf(
      'await sessionService.update(sessionId, { permissionMode: newMode });',
    );
    expect(runtimeSet).toBeGreaterThan(-1);
    expect(persistSet).toBeGreaterThan(runtimeSet);
    expect(src).toContain(
      'await window.electronAPI.maker.setPermissionMode(sessionId, previousMode);',
    );
    expect(src).toContain('requiresFullAccessConfirmation(previousMode, newMode)');
    expect(src).toContain('if (!confirmed) return;');
    expect(src).toContain("toast.error(t('newChat.chatInput.permissionSwitchFailed'))");
  });

  it('ChatInput 的 Fast 草稿默认同步必须等 onFastModeChange 成功后才执行', () => {
    const src = read('components/new-chat/ChatInput.tsx');
    const helperStart = src.indexOf('const persistFastModeChange');
    expect(helperStart).toBeGreaterThan(-1);
    const helperBody = src.slice(helperStart, helperStart + 800);
    expect(helperBody).toContain('await onFastModeChange?.(enabled, options?.remoteDeviceId);');
    expect(helperBody).toContain('return true;');
    expect(helperBody).toContain('catch (err)');
    expect(helperBody).toContain('if (!options?.silent) {');
    expect(helperBody).toContain('return false;');

    const start = src.indexOf('const handleFastModeChange');
    expect(start).toBeGreaterThan(-1);
    // 窗口覆盖:函数头部的切换意图拦截块(session-agent-switch 意图制)之后
    // 才是本用例断言的 persist→memory→draft 顺序,取 2200 字符保证包住全体。
    const body = src.slice(start, start + 2200);
    expect(body).toContain('const persisted = await persistFastModeChange(enabled, {');
    expect(body).toContain('remoteDeviceId: sourceRemoteDeviceId');
    expect(body.indexOf('if (!persisted) return false;')).toBeLessThan(
      body.indexOf('syncSessionDraftModelPrefs'),
    );
    expect(body.indexOf('if (!persisted) return false;')).toBeLessThan(
      body.indexOf('modelMemory?.setFast'),
    );
    expect(body.indexOf('modelMemory?.setFast')).toBeLessThan(
      body.indexOf('syncSessionDraftModelPrefs'),
    );
  });

  it('ModelSelector 当前模型 Fast 编辑不能先写 modelMemory 镜像', () => {
    const src = read('components/new-chat/ModelSelector.tsx');
    const start = src.indexOf('const handleEditFast =');
    expect(start).toBeGreaterThan(-1);
    const body = src.slice(start, start + 1000);
    const activeBranch = body.indexOf('if (editingIsActive) {');
    const onFastModeChange = body.indexOf('void onFastModeChange?.(enabled);');
    const elseBranch = body.indexOf('} else {', onFastModeChange);
    const modelMemorySetFast = body.indexOf('modelMemory?.setFast', elseBranch);
    expect(activeBranch).toBeGreaterThan(-1);
    expect(onFastModeChange).toBeGreaterThan(activeBranch);
    expect(elseBranch).toBeGreaterThan(onFastModeChange);
    expect(modelMemorySetFast).toBeGreaterThan(elseBranch);
    expect(body.slice(activeBranch, elseBranch)).not.toContain('modelMemory?.setFast');
  });

  it('ChatInput 远程切模型优先原子提交 model/effort/fast,旧 host 才走兼容链', () => {
    const src = read('components/new-chat/ChatInput.tsx');
    const start = src.indexOf('if (sourceRemoteDeviceId) {');
    expect(start).toBeGreaterThan(-1);
    const body = src.slice(start, start + 2800);
    const atomic = body.indexOf('? { effort: newEffort, fastMode: restoredFast }');
    const fallback = body.indexOf('if (!useAtomicSelection) {');
    const persist = body.indexOf('fastPersisted = await persistFastModeChange(restoredFast, {');
    const sync = body.indexOf('syncSessionDraftModelPrefs(');
    expect(atomic).toBeGreaterThan(-1);
    expect(fallback).toBeGreaterThan(atomic);
    expect(persist).toBeGreaterThan(
      body.indexOf('await remoteMaker.setEffort(sessionId, newEffort);'),
    );
    expect(persist).toBeGreaterThan(-1);
    expect(sync).toBeGreaterThan(-1);
    expect(persist).toBeLessThan(sync);
    expect(body.slice(persist, sync)).not.toContain('return;');
    expect(body.slice(persist, sync)).not.toContain('if (fastPersisted)');
    expect(body.slice(sync, sync + 300)).toContain('fast: fastPersisted ? restoredFast : fastMode');
  });

  it('ChatInput 远程切来源优先原子提交选择快照,旧 host 才走兼容链', () => {
    const src = read('components/new-chat/ChatInput.tsx');
    const start = src.indexOf('if (sessionId && sourceRemoteDeviceId)');
    const end = src.indexOf('// 把这次切换后落定的 (model, effort)', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const body = src.slice(start, end);
    const atomic = body.indexOf('? { effort: targetEffort, fastMode: restoredFast }');
    const fallback = body.indexOf('if (!useAtomicSelection) {');
    const persist = body.indexOf('fastPersisted = await persistFastModeChange(restoredFast, {');
    const sync = body.indexOf('syncSessionDraftModelPrefs(');
    const finalize = body.indexOf('onModelDidChange?.(targetModel);');
    expect(atomic).toBeGreaterThan(-1);
    expect(fallback).toBeGreaterThan(atomic);
    expect(persist).toBeGreaterThan(
      body.indexOf('await remoteMaker.setEffort(sessionId, targetEffort);'),
    );
    expect(persist).toBeGreaterThan(-1);
    expect(sync).toBeGreaterThan(-1);
    expect(body.slice(persist, sync)).not.toContain('return;');
    expect(body.slice(persist, sync)).not.toContain('if (fastPersisted)');
    expect(body.slice(sync, sync + 400)).toContain('fast: fastPersisted ? restoredFast : fastMode');
    expect(persist).toBeLessThan(sync);
    expect(finalize).toBeGreaterThan(sync);
  });

  it('已有任务换模会打选模标记,只改思考档 / Fast 不会', () => {
    const chatInputSrc = read('components/new-chat/ChatInput.tsx');
    const syncStart = chatInputSrc.indexOf('const syncSessionDraftModelPrefs');
    const syncEnd = chatInputSrc.indexOf('const persistFastModeChange', syncStart);
    expect(syncStart).toBeGreaterThan(-1);
    expect(syncEnd).toBeGreaterThan(syncStart);
    const syncBody = chatInputSrc.slice(syncStart, syncEnd);
    expect(syncBody).toContain('patchVendorPrefsPreservingModelChoice');
    expect(syncBody).toMatch(
      /markModelChoice\s*\?\s*patchVendorPrefs\s*:\s*patchVendorPrefsPreservingModelChoice/,
    );
    expect(syncBody).toContain('opts.markModelChoice === true');
    expect(syncBody).toContain('markModelChoice');
    expect(syncBody).toContain('{ model: modelId, providerId: activeProviderId ?? null }');
    expect(syncBody).not.toContain(': { model: modelId }');
    expect(syncBody).toContain(
      'opts.remoteDeviceId ?? getSessionDeviceId(sessionId) ?? deviceLinkDeviceId',
    );
    expect(syncBody).toContain(".invoke(remoteDeviceId, 'maker:apply-new-maker-draft-pref'");

    expect(chatInputSrc).toContain('markModelChoice: true');
    expect(chatInputSrc).toContain('agentKind: targetAgentKind');

    const appSrc = read('App.tsx');
    expect(appSrc).toContain(
      'markModelChoice === false ? patchVendorPrefsPreservingModelChoice : patchVendorPrefs',
    );
    expect(appSrc).toContain('model: modelId');
    expect(appSrc).not.toContain('markModelChoice === false ? {} : { model: modelId }');

    const draftSrc = read('state/newMakerDraft.ts');
    expect(draftSrc).toContain('if (!opts.markModelChoice && modelChosen[vendor] === true)');
    expect(draftSrc).toContain('delete nextPatch.model');
    expect(draftSrc).toContain('delete nextPatch.providerId');
    expect(draftSrc).toContain('if (incomingModel !== savedModel)');
    expect(draftSrc).toContain('delete nextPatch.effort');

    const newMakerDraftRouteSrc = read('features/cc-agent/NewMakerDraftRoute.tsx');
    const pushActiveStart = newMakerDraftRouteSrc.indexOf('const pushActiveDraftPref');
    expect(pushActiveStart).toBeGreaterThan(-1);
    // 切到函数体结束(catch 兜底那一行)再断言,别按固定字符数截 —— 注释一长就漏断言。
    const pushActiveEnd = newMakerDraftRouteSrc.indexOf('.catch(() => {});', pushActiveStart);
    expect(pushActiveEnd).toBeGreaterThan(pushActiveStart);
    const pushActiveBody = newMakerDraftRouteSrc.slice(pushActiveStart, pushActiveEnd);
    expect(pushActiveBody).toContain('active: true');
    expect(pushActiveBody).toContain('markModelChoice: false');
  });

  it('外部 session effort patch 必须在 layout commit 时对齐 cache 并抢占旧 runtime', () => {
    const src = read('components/new-chat/ChatInput.tsx');
    const start = src.indexOf('const effortChangeCoordinatorRef');
    const end = src.indexOf('// 优先级: 外部 store', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const body = src.slice(start, end);
    expect(body).toContain('useLayoutEffect(() => {');
    expect(body).toContain('adoptExternalEffort(');
    expect(body).toContain('window.electronAPI.maker.setEffort(targetSessionId, effort)');
  });

  it('远程 model/provider 收尾必须把已捕获 deviceId 传给草稿偏好同步', () => {
    const src = read('components/new-chat/ChatInput.tsx');
    const modelStart = src.indexOf('const performModelChange = useCallback(');
    const modelEnd = src.indexOf('const handleModelChange = useCallback(', modelStart);
    const providerStart = src.indexOf('const performProviderChange = useCallback(');
    const providerEnd = src.indexOf('const handleProviderChange = useCallback(', providerStart);
    expect(modelStart).toBeGreaterThan(-1);
    expect(modelEnd).toBeGreaterThan(modelStart);
    expect(providerStart).toBeGreaterThan(-1);
    expect(providerEnd).toBeGreaterThan(providerStart);
    const modelBody = src.slice(modelStart, modelEnd);
    const providerBody = src.slice(providerStart, providerEnd);
    expect(modelBody).toContain('remoteDeviceId: sourceRemoteDeviceId');
    expect(modelBody).toContain('onEffortDidChange?.(newEffort, sessionId, sourceRemoteDeviceId)');
    expect(modelBody).toContain('confirmModelSwitchContextGuard(newModelId, sourceRemoteDeviceId)');
    expect(modelBody).toMatch(
      /persistFastModeChange\(restoredFast,\s*\{[\s\S]*?remoteDeviceId: sourceRemoteDeviceId/,
    );
    expect(providerBody).toContain('remoteDeviceId: sourceRemoteDeviceId');
    expect(providerBody).toContain(
      'onEffortDidChange?.(targetEffort, sessionId, sourceRemoteDeviceId)',
    );
    expect(providerBody).toMatch(
      /confirmModelSwitchContextGuard\(\s*reconciledModelId,\s*sourceRemoteDeviceId/,
    );
    expect(providerBody).toMatch(
      /persistFastModeChange\(restoredFast,\s*\{[\s\S]*?remoteDeviceId: sourceRemoteDeviceId/,
    );
  });

  it('Fast 持久化与草稿同步必须复用捕获 deviceId', () => {
    const chatInputSrc = read('components/new-chat/ChatInput.tsx');
    const persistStart = chatInputSrc.indexOf('const persistFastModeChange = useCallback(');
    const persistEnd = chatInputSrc.indexOf(
      'const handleFastModeChange = useCallback(',
      persistStart,
    );
    const handleStart = persistEnd;
    const handleEnd = chatInputSrc.indexOf('/**\n   * 切模型前的上下文容量护栏', handleStart);
    expect(persistStart).toBeGreaterThan(-1);
    expect(persistEnd).toBeGreaterThan(persistStart);
    expect(handleEnd).toBeGreaterThan(handleStart);
    expect(chatInputSrc.slice(persistStart, persistEnd)).toContain(
      'onFastModeChange?.(enabled, options?.remoteDeviceId)',
    );
    expect(chatInputSrc.slice(handleStart, handleEnd)).toMatch(
      /syncSessionDraftModelPrefs\(\s*modelId,\s*\{ effort, fast: enabled \},\s*\{ remoteDeviceId: sourceRemoteDeviceId \}/,
    );

    const hookSrc = read('hooks/useCCAgentChat.ts');
    expect(hookSrc).toContain(
      'makerChatStore.setFastMode(sessionId, enabled, sourceRemoteDeviceId)',
    );
    const storeSrc = read('lib/makerChatStore.ts');
    const setFastStart = storeSrc.indexOf('async function setFastMode(');
    const setFastEnd = storeSrc.indexOf('async function setPlanMode(', setFastStart);
    expect(setFastStart).toBeGreaterThan(-1);
    expect(setFastEnd).toBeGreaterThan(setFastStart);
    const setFastBody = storeSrc.slice(setFastStart, setFastEnd);
    expect(setFastBody).toContain(
      'const remoteDeviceId = sourceRemoteDeviceId ?? getStickySessionDeviceId(sessionId);',
    );
    expect(setFastBody).toContain('makerApiForDevice(remoteDeviceId)');
  });

  it('effort 回调必须追踪 sticky deviceId 并向父级保留远程 scope', () => {
    const src = read('components/new-chat/ChatInput.tsx');
    const effortStart = src.indexOf('const handleEffortChange = useCallback(');
    const effortEnd = src.indexOf('// per-session 来源切换', effortStart);
    expect(effortStart).toBeGreaterThan(-1);
    expect(effortEnd).toBeGreaterThan(effortStart);
    const effortBody = src.slice(effortStart, effortEnd);
    expect(effortBody).toContain('onEffortDidChange?.(newEffort, sessionId, remoteDeviceId)');
    expect(effortBody).toMatch(/\[\s*activeModel,\s*sessionId,\s*deviceLinkDeviceId,/);

    const sessionViewSrc = read('features/cc-agent/CCAgentSessionView.tsx');
    const callbackStart = sessionViewSrc.indexOf('const handleEffortDidChange = useCallback(');
    const callbackEnd = sessionViewSrc.indexOf(
      'const handlePermissionModeDidChange',
      callbackStart,
    );
    expect(callbackStart).toBeGreaterThan(-1);
    expect(callbackEnd).toBeGreaterThan(callbackStart);
    const callbackBody = sessionViewSrc.slice(callbackStart, callbackEnd);
    expect(callbackBody).toContain('sourceRemoteDeviceId?: string');
    expect(callbackBody).toContain(
      'if (sourceRemoteDeviceId || getSessionDeviceId(targetSessionId)) return;',
    );
  });

  it('同模型 provider task 必须在 lane 内读取最新 committed effort', () => {
    const src = read('components/new-chat/ChatInput.tsx');
    const providerStart = src.indexOf('const performProviderChange = useCallback(');
    const sameModelStart = src.indexOf('// 同模型只切来源', providerStart);
    const applyEnd = src.indexOf(
      'await applyModelAndEffort(activeModel, targetEffort);',
      sameModelStart,
    );
    expect(providerStart).toBeGreaterThan(-1);
    expect(sameModelStart).toBeGreaterThan(providerStart);
    expect(applyEnd).toBeGreaterThan(sameModelStart);
    const body = src.slice(sameModelStart, applyEnd);
    expect(body).toContain('getCommittedEffort(sessionId) ?? activeEffort');
    expect(body).toContain('fallbackEffort: committedActiveEffort');
  });

  it('device-link draft active Fast 写穿必须带当前 effort,避免目标 model 继承旧 effort', () => {
    const src = read('features/cc-agent/NewMakerDraftRoute.tsx');
    const start = src.indexOf('const pushActiveDraftPref');
    expect(start).toBeGreaterThan(-1);
    const end = src.indexOf('.catch(() => {});', start);
    expect(end).toBeGreaterThan(start);
    const body = src.slice(start, end);
    const activeEffort = body.indexOf('const activeEffort =');
    const payloadEffort = body.indexOf(
      '...(activeEffort !== undefined ? { effort: activeEffort } : {})',
    );
    expect(activeEffort).toBeGreaterThan(-1);
    // 没有显式目标(既有的 effort / fast 编辑入口)时仍回落当前 dlSel / seed 的档。
    expect(body).toMatch(/dlSel\?\.effort \?\? deviceLinkInitial\?\.effort/);
    expect(payloadEffort).toBeGreaterThan(activeEffort);
  });

  /**
   * 选中一行时的写穿必须用**本次 selection 的目标值**,不能读闭包里的旧运行配置:
   * `setDlSel` 尚未提交、跨引擎时 `switchVendor` 还在途,读闭包会把 B 的 effort / Fast
   * 以 active:true 写到 A 的偏好上(跨引擎连 agent 都是旧的)。
   */
  it('device-link draft 选中一行的写穿按目标 (agent, provider, model) 走,不读闭包旧值', () => {
    const src = read('features/cc-agent/NewMakerDraftRoute.tsx');

    // 1) pushActiveDraftPref 接收显式目标,且目标优先于当前状态。
    const pushStart = src.indexOf('const pushActiveDraftPref');
    const pushEnd = src.indexOf('.catch(() => {});', pushStart);
    expect(pushStart).toBeGreaterThan(-1);
    const pushBody = src.slice(pushStart, pushEnd);
    expect(pushBody).toContain('target?: {');
    expect(pushBody).toContain(
      'const model = target?.modelId ?? dlSel?.model ?? deviceLinkInitial?.model;',
    );
    expect(pushBody).toContain('agent: target?.agent ?? capabilityAgentKind');
    expect(pushBody).toMatch(/providerId: target\s*\r?\n?\s*\?\s*\(target\.providerId \?\? ''\)/);
    // 给了目标就**只**认目标的档 —— 不许再回落到上一个模型的 dlSel.effort。
    expect(pushBody).toMatch(/target\s*\r?\n?\s*\?\s*target\.effort/);

    // 2) handleUnifiedDraftSelect 的远程分支按本次 selection 传目标(跨引擎按目标 vendor 算 agent)。
    const selStart = src.indexOf('const handleUnifiedDraftSelect');
    expect(selStart).toBeGreaterThan(-1);
    const selEnd = src.indexOf('// ─── 用户改 workingDir', selStart);
    expect(selEnd).toBeGreaterThan(selStart);
    const selBody = src.slice(selStart, selEnd);
    const pushCall = selBody.indexOf('pushActiveDraftPref(');
    expect(pushCall).toBeGreaterThan(-1);
    const pushCallBody = selBody.slice(pushCall, selEnd);
    expect(pushCallBody).toContain(
      'agent: dbToMakerAgentKind(normalizeDbAgentKind(selection.vendor))',
    );
    expect(pushCallBody).toContain('providerId: selection.providerId');
    expect(pushCallBody).toContain('modelId: selection.modelId');
  });

  it('App active Fast-only 写穿不能改 lastByVendor model/effort 配对', () => {
    const src = read('App.tsx');
    const start = src.indexOf('if (active) {');
    expect(start).toBeGreaterThan(-1);
    const body = src.slice(start, start + 700);
    expect(body).toContain(
      'const shouldPatchActiveModel = markModelChoice !== false || effort !== undefined;',
    );
    expect(body).toContain('if (shouldPatchActiveModel) {');
  });

  it('跨窗口 worktree 写穿只合并目标字段，main 镜像读取共享持久快照', () => {
    const src = read('App.tsx');
    expect(src).toContain('const draft = getDraftForPreferenceSync();');
    expect(src).toContain('setWorktreePreference(worktreeEnabled === true);');
    expect(src).not.toContain('patchDraft({ worktreeEnabled: worktreeEnabled === true });');
  });

  it('本地切来源恢复 Fast 时必须写入目标 provider 的 session memory', () => {
    const src = read('components/new-chat/ChatInput.tsx');
    const handleStart = src.indexOf('const handleFastModeChange');
    expect(handleStart).toBeGreaterThan(-1);
    const handleBody = src.slice(handleStart, handleStart + 2200);
    expect(handleBody).toContain('memoryProviderId = effectiveSourceId');
    expect(handleBody).toContain(
      'modelMemory?.setFast(currentModelAgentKind, memoryProviderId, modelId, enabled)',
    );

    const applyStart = src.indexOf('const applyModelAndEffort = async');
    expect(applyStart).toBeGreaterThan(-1);
    const applyBody = src.slice(applyStart, applyStart + 3200);
    expect(applyBody).toContain('modelMemory?.setFast(');
    expect(applyBody).toMatch(
      /modelMemory\?\.setFast\(\s*currentModelAgentKind,\s*newProviderId,\s*modelId,\s*restoredFast,?\s*\)/,
    );
  });

  it('ChatInput 本地切来源把完整选择交给 main 原子落定后再更新 UI', () => {
    const src = read('components/new-chat/ChatInput.tsx');
    const start = src.indexOf('const applyModelAndEffort = async (modelId: string, eff: Effort)');
    expect(start).toBeGreaterThan(-1);
    const end = src.indexOf('const handleNavigateToProviders', start);
    expect(end).toBeGreaterThan(start);
    const body = src.slice(start, end);
    const runtimeGate = body.indexOf(
      'const setModelResult = await window.electronAPI.maker.setModel(',
    );
    const atomicSelection = body.indexOf('{ effort: eff, fastMode: restoredFast }');
    const applyUi = body.indexOf('applyProviderSelection();');
    expect(runtimeGate).toBeGreaterThan(-1);
    expect(atomicSelection).toBeGreaterThan(runtimeGate);
    expect(applyUi).toBeGreaterThan(-1);
    expect(atomicSelection).toBeLessThan(applyUi);
    expect(body).not.toContain('await sessionService.update(sessionId, {');
  });

  it('ChatInput 本地只切模型把完整选择交给 main 原子落定后再更新 UI', () => {
    const src = read('components/new-chat/ChatInput.tsx');
    const start = src.indexOf('const performModelChange = useCallback(');
    const end = src.indexOf('const handleModelChange = useCallback(', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const body = src.slice(start, end);
    const runtimeGate = body.indexOf(
      'const setModelResult = await window.electronAPI.maker.setModel(',
    );
    const atomicSelection = body.indexOf(
      '{ effort: newEffort, fastMode: restoredFast }',
      runtimeGate,
    );
    const applyUi = body.indexOf('onModelDidChange?.(newModelId)');
    expect(runtimeGate).toBeGreaterThan(-1);
    expect(atomicSelection).toBeGreaterThan(runtimeGate);
    expect(applyUi).toBeGreaterThan(-1);
    expect(atomicSelection).toBeLessThan(applyUi);
    expect(body).not.toContain('await sessionService.update(sessionId, {');
  });

  // 多端收敛核心:resolve interaction 必须广播 INTERACTION_DISMISSED,否则其它 renderer
  // (被控端自己 + 其它控制端 + 多窗口)面板卡住(真机实测的「两端点了不同步」)。
  it('main RESOLVE_INTERACTION handler 解决后广播 dismissed(dismissRendererInteraction)', () => {
    const src = readFileSync(resolve(__dirname, '../../main/maker-ipc/register.ts'), 'utf8');
    // handler 可以只委托 helper,但 helper 必须负责 resolved 广播和权威落库。
    // 截取窗口用下一个语法边界而非固定字符数:handler/helper 体量会随入参校验、
    // 注释增长,固定窗口会在无行为回归时误报(#329 曾把调用挤出 1000 字符窗口)。
    const handlerMatch = /ipcMain\.handle\(\s*MAKER_INVOKE\.RESOLVE_INTERACTION/.exec(src);
    const handlerStart = handlerMatch?.index ?? -1;
    expect(handlerStart).toBeGreaterThan(-1);
    const handlerEnd = src.indexOf('ipcMain.handle(', handlerStart + 1);
    const handlerBody = src.slice(handlerStart, handlerEnd === -1 ? undefined : handlerEnd);
    expect(handlerBody).toContain('resolvePendingInteraction(');
    const helperStart = src.indexOf('function resolvePendingInteraction');
    expect(helperStart).toBeGreaterThan(-1);
    // 顶层函数体内嵌套块都有缩进,列首 '\n}' 即 helper 自己的闭括号。
    const helperEnd = src.indexOf('\n}', helperStart);
    expect(helperEnd).toBeGreaterThan(-1);
    const body = src.slice(helperStart, helperEnd);
    expect(body).toContain('resolver.resolve(');
    expect(body).toContain('dismissRendererInteraction(');
    // F1:resolve 后被控端权威落库 ask/plan answered 状态。
    expect(body).toContain('persistInteractionDecision(');
    const persistStart = src.indexOf('function persistInteractionDecision');
    expect(persistStart).toBeGreaterThan(-1);
    const persistEnd = src.indexOf('\n}', persistStart);
    expect(persistEnd).toBeGreaterThan(-1);
    expect(src.slice(persistStart, persistEnd)).toContain('onInteractionResolved(');
  });

  // ── 全面审查批量修复(F1–F7)接线不变式:每条都是真机踩过 / 审查确认的「会话级直连未路由 /
  //    状态变更未广播收敛」家族残留,锁住防回归 ──────────────────────────────────────────
  const mainSrc = (rel: string) => readFileSync(resolve(__dirname, '../../main', rel), 'utf8');

  it('F1: ask 本地远程都只由 main 落库；plan answered 写库仍远程跳过', () => {
    const src = read('lib/makerChatStore.ts');
    const askStart = src.indexOf('function answerUserQuestion(');
    expect(askStart).toBeGreaterThan(-1);
    const askEnd = src.indexOf('\nfunction ', askStart + 1);
    const askBody = src.slice(askStart, askEnd === -1 ? undefined : askEnd);
    expect(askBody).not.toContain('askMsg');
    expect(askBody).not.toContain('messageService');
    expect(src).toContain('if (planMsg && !isRemoteSession(sessionId))');
  });

  it('F2: fork IPC handler 广播 sessions:created(否则 fork 会话在被控端/其它控制端不出现)', () => {
    const src = mainSrc('maker-ipc/fork.ts');
    expect(src).toContain('broadcastSessionCreated(session.id)');
    expect(src).toContain("tapWindowBroadcast('local-db:sessions:created'");
  });

  it('F3: schedule / project-automation 的 broadcast 补 tapWindowBroadcast(否则远程不回流)', () => {
    for (const f of ['maker-ipc/schedule.ts', 'maker-ipc/project-automation.ts']) {
      const src = mainSrc(f);
      const start = src.indexOf('function broadcast(');
      expect(start, f).toBeGreaterThan(-1);
      expect(src.slice(start, start + 400), f).toContain('tapWindowBroadcast(channel, payload)');
    }
  });

  it('F6: scheduler 新会话在首条消息落库后广播 created 给 device-link 列表订阅者', () => {
    const runnerSrc = mainSrc('scheduler-host/runner.ts');
    const hostSrc = mainSrc('scheduler-host/index.ts');
    expect(runnerSrc).toContain('this.deps.onSessionCreated?.(session.id)');
    expect(hostSrc).toContain('onSessionCreated: broadcastSessionCreated');
  });

  it('F7: 周期 sessions:list 是有界窗口，只能 merge，不能截断远程分片', () => {
    const src = read('features/device-link/useDeviceLinkRemoteProjects.ts');
    expect(src).toContain("snapshotMode: 'merge'");
    expect(src).toContain("coalescingMode: 'weak'");
  });

  it('F8: 周期对账从实际 link status 启动，且状态 push 不被迟到快照覆盖', () => {
    const src = read('features/device-link/useDeviceLinkRemoteProjects.ts');
    expect(src).toContain('let linkOnline = false');
    expect(src).toContain("if (!linkStatusPushSeen) linkOnline = state.linkStatus === 'online'");
    expect(src).toContain('linkStatusPushSeen = true');
    // debounce 排队后 relay 可能已进入 connecting；执行时必须重查实时状态，不能离线重试。
    expect(src).toContain('if (!disposed && linkOnline && eligible.has(deviceId))');
  });

  it('F4: extraDirs 远程跳过 sessionService.update(getSessionDeviceId 守卫,避免阻断 setExtraDirs)', () => {
    const src = read('features/cc-agent/CCAgentSessionView.tsx');
    const start = src.indexOf('handleExtraDirsChange');
    expect(start).toBeGreaterThan(-1);
    const body = src.slice(start, start + 700);
    expect(body).toContain('if (!getSessionDeviceId(sessionId))');
    expect(body).toContain('setExtraDirs');
  });

  it('F5: loadAroundMessage 经 aroundMessagesFor 路由(远程隧道,不查控制端空库)', () => {
    const src = read('lib/makerChatStore.ts');
    expect(src).toContain('aroundMessagesFor(sessionId, messageId, opts)');
  });

  it('F7: dispatch handleSubscriptionFrame 拒绝 legacy "*"(只 link-open 可订全量)', () => {
    const src = mainSrc('device-link/dispatch.ts');
    const predicateStart = src.indexOf('function isRemoteSubscriptionTopic');
    expect(predicateStart).toBeGreaterThan(-1);
    const predicate = src.slice(predicateStart, predicateStart + 500);
    expect(predicate).toContain("if (value === 'sessions') return true");
    expect(predicate).toContain("if (value.startsWith('session:'))");
    expect(predicate).toContain('return parseFsWatchTopic(value) !== null');

    const start = src.indexOf('function handleSubscriptionFrame');
    expect(start).toBeGreaterThan(-1);
    expect(src.slice(start, start + 900)).toContain('o.topics.filter(isRemoteSubscriptionTopic)');
  });
});
