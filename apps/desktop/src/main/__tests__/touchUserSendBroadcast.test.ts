/**
 * touchUserSendBroadcast.test.ts
 * ---------------------------------------------------------------------------
 * device-link 回归(被控端把控制端新建的远程会话当草稿挂在项目外的根因)。
 *
 * touchUserSendInDb 写 userSendAt 后必须广播 sessions:patched —— 否则:
 *   - 本机会话靠 renderer 乐观 patchLocal 掩盖,看不出问题;
 *   - device-link 远程会话由控制端在**被控端** enqueue 时 bump userSendAt,被控端自己的
 *     renderer 不会乐观更新,没有这条广播就一直按草稿(userSendAt==null && messages==0 →
 *     未分类)把会话挂在项目外。广播经 device-link tap 同时推给控制端,两端收敛到项目下。
 *
 * userSendAt 按 renderer 约定(sessionToCamel 的 msToIso)用 ISO 字符串广播;DB 落 epoch ms。
 *
 * drizzle / electron / 副作用模块的 mock 方式对齐 patchMessageAgentMeta.test.ts。
 * 捕获用的 spy / 数组放进 vi.hoisted —— vi.mock 工厂被提升到文件顶,不能引用普通顶层变量。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => {
  const updateSetCalls: Array<Record<string, unknown>> = [];
  // 验证 SELECT 结果队列。若队列为空，makeUpdateChain.set 会自动把"UPDATE 成功"行
  // 填进来（userSendAt/updatedAt = 本次 ts），模拟正常路径。
  // 需要非默认结果（no-op/MAX updatedAt）的测试先 push 目标行再调函数。
  const selectResults: Array<Array<Record<string, unknown>>> = [];
  const updateErrors: unknown[] = [];

  const makeUpdateChain = () => {
    const chain: Record<string, unknown> = {};
    chain.set = (payload: Record<string, unknown>) => {
      updateSetCalls.push(payload);
      // 自动填充"UPDATE 落地"场景（验证 SELECT 返回该行，广播触发）。
      // 若测试预先 push 了结果，队列非空，跳过自动填充，使用预设值。
      if (selectResults.length === 0 && typeof payload.userSendAt === 'number') {
        selectResults.push([{ userSendAt: payload.userSendAt, updatedAt: payload.userSendAt }]);
      }
      return chain;
    };
    chain.where = () => {
      const error = updateErrors.shift();
      return error === undefined ? Promise.resolve(undefined) : Promise.reject(error);
    };
    return chain;
  };

  const makeSelectChain = () => {
    const result = selectResults.shift() ?? [];
    const chain: Record<string, unknown> = {};
    chain.from = () => chain;
    chain.where = () => chain;
    chain.limit = () => Promise.resolve(result);
    return chain;
  };

  return {
    tapWindowBroadcast: vi.fn(),
    webContentsSend: vi.fn(),
    agentIslandService: {
      handleSessionClosed: vi.fn(),
      handleSessionMetadataPatch: vi.fn(),
    },
    updateSetCalls,
    selectResults,
    updateErrors,
    fakeDb: {
      update: vi.fn(() => makeUpdateChain()),
      select: vi.fn(() => makeSelectChain()),
    },
  };
});

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  BrowserWindow: {
    getAllWindows: () => [{ isDestroyed: () => false, webContents: { send: h.webContentsSend } }],
  },
}));
vi.mock('../logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
// 被 sessions.ts 顶层 import 但与本测试无关的副作用模块,全部 stub 掉避免触碰 electron app 路径。
vi.mock('../localDb/dialogueWorkspace', () => ({ ensureDialogueWorkspaceDir: vi.fn() }));
vi.mock('../git-context/prRefsStore', () => ({ recomputePrRefsForSession: vi.fn(() => Promise.resolve()) }));
vi.mock('../localDb/ipc/recentWorkdirs', () => ({ upsertRecentWorkdir: vi.fn() }));
vi.mock('../device-link/broadcast-tap', () => ({
  captureDataOwnerBroadcastScope: vi.fn(() => null),
  getSafeDataOwnerPushStamp: vi.fn(() => undefined),
  isDataOwnerBroadcastScopeCurrent: vi.fn(() => true),
  tapWindowBroadcast: h.tapWindowBroadcast,
}));
vi.mock('../localDb/client/current', () => ({ getDbClient: () => ({ drizzle: h.fakeDb }) }));
vi.mock('../agent-island/service.js', () => ({
  getAgentIslandService: () => h.agentIslandService,
}));

import { notifyAgentIslandSessionPatch } from '../localDb/agentIslandSessionPatch.js';
import { clearSessionContextInDb, touchUserSendInDb, persistSessionFields } from '../localDb/ipc/sessions.js';
import {
  backgroundTurnPredatesSessionClear,
  noteSessionClearBoundary,
} from '../messagePersistBroadcaster.js';

beforeEach(() => {
  vi.clearAllMocks();
  h.updateSetCalls.length = 0;
  h.selectResults.length = 0;
  h.updateErrors.length = 0;
});

describe('touchUserSendInDb 广播 sessions:patched(device-link 项目归属收敛)', () => {
  it('显式 atMs:UPDATE 落地后广播 ISO userSendAt(本机窗口 + device-link tap)', async () => {
    const atMs = 1_700_000_000_000;
    // auto-fill 默认行为（selectResults 为空，makeUpdateChain 自动填充 UPDATE 成功行）。
    await touchUserSendInDb('sess-1', atMs);

    // UPDATE SET：userSendAt = atMs；updatedAt = MAX(updated_at, ts) SQL 表达式，非裸数字。
    expect(h.updateSetCalls).toHaveLength(1);
    expect(h.updateSetCalls[0].userSendAt).toBe(atMs);
    expect(typeof h.updateSetCalls[0].updatedAt).not.toBe('number');

    const iso = new Date(atMs).toISOString();
    // 本机所有窗口都收到(被控端自己的 renderer 据此把会话重归项目下)。
    expect(h.webContentsSend).toHaveBeenCalledWith('local-db:sessions:patched', {
      sessionId: 'sess-1',
      patch: { userSendAt: iso, updatedAt: iso },
    });
    // device-link tap:经 topic 路由把权威 userSendAt 推给订阅 sessions 的控制端。
    expect(h.tapWindowBroadcast).toHaveBeenCalledWith('local-db:sessions:patched', {
      sessionId: 'sess-1',
      patch: { userSendAt: iso, updatedAt: iso },
    });
  });

  it('缺省 atMs:回落到当前时间(广播 patch 含 ISO userSendAt + updatedAt 字段)', async () => {
    const before = Date.now();
    // auto-fill 自动填充 Date.now() 产生的 ts，无需预设。
    await touchUserSendInDb('sess-2');
    expect(h.updateSetCalls).toHaveLength(1);
    const ts = h.updateSetCalls[0].userSendAt as number;
    expect(typeof ts).toBe('number');
    expect(ts).toBeGreaterThanOrEqual(before);

    const tapArg = h.tapWindowBroadcast.mock.calls.at(-1);
    expect(tapArg?.[0]).toBe('local-db:sessions:patched');
    const payload = tapArg?.[1] as { sessionId: string; patch: Record<string, unknown> };
    expect(payload.sessionId).toBe('sess-2');
    expect(typeof payload.patch.userSendAt).toBe('string'); // ISO
    expect(typeof payload.patch.updatedAt).toBe('string');  // ISO
  });

  it('atomic guard: UPDATE no-op 时（验证 SELECT 返回空）跳过广播，不向 renderer 发送过时值', async () => {
    const atMs = 1_700_000_000_000;
    // 预设空结果：WHERE 条件为假，UPDATE 为 no-op，SELECT 找不到行。
    h.selectResults.push([]);
    await touchUserSendInDb('sess-noop', atMs);

    expect(h.updateSetCalls).toHaveLength(1); // UPDATE 调用了，但 WHERE 阻止了写入
    expect(h.tapWindowBroadcast).not.toHaveBeenCalled();
    expect(h.webContentsSend).not.toHaveBeenCalled();
  });

  it('MAX updatedAt: 广播使用 SELECT 读回的实际 updatedAt，防止 finishedAt 被 firedAt 回退', async () => {
    const firedAt = 1_700_000_000_000;
    const finishedAt = firedAt + 5_000; // run 完成路径已将 updatedAt 推进到 finishedAt
    // 模拟 MAX(updated_at, firedAt) = finishedAt 的 SELECT 结果。
    h.selectResults.push([{ userSendAt: firedAt, updatedAt: finishedAt }]);
    await touchUserSendInDb('sess-max', firedAt);

    expect(h.tapWindowBroadcast).toHaveBeenCalledWith('local-db:sessions:patched', {
      sessionId: 'sess-max',
      patch: {
        userSendAt: new Date(firedAt).toISOString(),
        updatedAt: new Date(finishedAt).toISOString(), // 广播 finishedAt，不回退到 firedAt
      },
    });
  });
});

describe('clearSessionContextInDb 广播 sessions:patched(device-link /clear 收敛)', () => {
  it('写 clearedAt + sdkSessionId=null,并用 ISO clearedAt 广播给本机窗口和控制端镜像', async () => {
    const atMs = 1_700_000_123_000;
    // Drizzle's MAX/COALESCE expressions are not JavaScript numbers.  Mock the
    // SELECT read-back with the effective values that SQLite would return.
    h.selectResults.push([{ clearedAt: atMs, updatedAt: atMs }]);
    await clearSessionContextInDb('sess-clear', atMs);

    expect(h.updateSetCalls).toHaveLength(1);
    expect(h.updateSetCalls[0].sdkSessionId).toBeNull();
    expect(typeof h.updateSetCalls[0].clearedAt).not.toBe('number');
    expect(typeof h.updateSetCalls[0].updatedAt).not.toBe('number');

    const iso = new Date(atMs).toISOString();
    expect(h.webContentsSend).toHaveBeenCalledWith('local-db:sessions:patched', {
      sessionId: 'sess-clear',
      patch: { sdkSessionId: null, clearedAt: iso, updatedAt: iso },
    });
    expect(h.tapWindowBroadcast).toHaveBeenCalledWith('local-db:sessions:patched', {
      sessionId: 'sess-clear',
      patch: { sdkSessionId: null, clearedAt: iso, updatedAt: iso },
    });
  });

  it('把 DB 读回的有效 clear 边界登记给晚到 background 过滤器', async () => {
    const sessionId = 'sess-clear-background-boundary';
    const requestedAt = 1_700_000_123_000;
    const effectiveAt = requestedAt + 5_000;
    noteSessionClearBoundary(sessionId, null);
    expect(backgroundTurnPredatesSessionClear(sessionId, effectiveAt - 1)).toBe(false);

    // 并发的较新 clear 可能已经把 DB 边界推进到 requestedAt 之后；内存过滤器
    // 必须采用 SELECT 读回的有效值，不能只记本次请求参数。
    h.selectResults.push([{ clearedAt: effectiveAt, updatedAt: effectiveAt }]);
    await clearSessionContextInDb(sessionId, requestedAt);

    expect(backgroundTurnPredatesSessionClear(sessionId, effectiveAt - 1)).toBe(true);
    expect(backgroundTurnPredatesSessionClear(sessionId, effectiveAt + 1)).toBe(false);
    noteSessionClearBoundary(sessionId, null);
  });

  it('DB 落库失败时仍先登记 host-owned clear 边界', async () => {
    const sessionId = 'sess-clear-background-boundary-db-failure';
    const requestedAt = 1_700_000_456_000;
    noteSessionClearBoundary(sessionId, null);
    h.updateErrors.push(new Error('db unavailable'));

    await expect(clearSessionContextInDb(sessionId, requestedAt)).rejects.toThrow('db unavailable');

    expect(backgroundTurnPredatesSessionClear(sessionId, requestedAt - 1)).toBe(true);
    expect(backgroundTurnPredatesSessionClear(sessionId, requestedAt + 1)).toBe(false);
    noteSessionClearBoundary(sessionId, null);
  });
});

describe('persistSessionFields(远程 set-* 回流:字段白名单 + 广播)', () => {
  /** 取最近一次 tap 广播的 patch(persistSessionFields 末尾 broadcastSessionPatched 用)。 */
  function lastTapPatch(): { sessionId: string; patch: Record<string, unknown> } | undefined {
    const call = h.tapWindowBroadcast.mock.calls.at(-1);
    if (!call || call[0] !== 'local-db:sessions:patched') return undefined;
    return call[1] as { sessionId: string; patch: Record<string, unknown> };
  }

  it('只持久化 + 广播白名单字段(model/providerId/effort/permissionMode/fastMode/extraDirs),其余丢弃', async () => {
    await persistSessionFields('sess-1', {
      model: 'opus-4-8',
      effort: 'high',
      // 以下非白名单 —— 远程不得借 set-* 回流改任意列,必须被丢弃:
      title: 'should-drop',
      status: 'archived',
      userSendAt: 123,
    } as Record<string, unknown>);

    expect(h.updateSetCalls).toHaveLength(1); // 写了库
    const tap = lastTapPatch()!;
    expect(tap.sessionId).toBe('sess-1');
    expect(tap.patch).toEqual({ model: 'opus-4-8', effort: 'high' }); // 仅白名单子集
  });

  // 回归:providerId 曾漏入白名单 → 被控端不写 provider_id + 广播 patch 不带 providerId →
  // 控制端 mirror 的 session.providerId 永不收敛、跨来源切换(GPT→Opus)模型选择器置灰吃满 5s。
  it('providerId(per-session 来源)随 set-model 一并写库 + 广播', async () => {
    await persistSessionFields('sess-p', {
      model: 'claude-opus-4-8',
      providerId: 'anthropic',
    } as Record<string, unknown>);

    expect(h.updateSetCalls).toHaveLength(1);
    expect(h.updateSetCalls[0]).toMatchObject({ model: 'claude-opus-4-8', providerId: 'anthropic' });
    expect(lastTapPatch()!.patch).toEqual({ model: 'claude-opus-4-8', providerId: 'anthropic' });
  });

  it('providerId=null(清除显式来源、回落默认路由)同样写库 + 广播', async () => {
    await persistSessionFields('sess-p2', { providerId: null } as Record<string, unknown>);

    expect(h.updateSetCalls).toHaveLength(1);
    expect(h.updateSetCalls[0]).toMatchObject({ providerId: null });
    expect(lastTapPatch()!.patch).toEqual({ providerId: null });
  });

  it('全是白名单字段(fastMode / extraDirs / permissionMode)→ 原样回流', async () => {
    await persistSessionFields('sess-x', {
      fastMode: true,
      extraDirs: ['/a', '/b'],
      permissionMode: 'plan',
    } as Record<string, unknown>);
    expect(lastTapPatch()!.patch).toEqual({ fastMode: true, extraDirs: ['/a', '/b'], permissionMode: 'plan' });
  });

  it('patch 不含任何白名单字段 → 早退:不写库、不广播', async () => {
    await persistSessionFields('sess-2', { title: 'x', status: 'archived' } as Record<string, unknown>);
    expect(h.updateSetCalls).toHaveLength(0);
    expect(h.tapWindowBroadcast).not.toHaveBeenCalled();
  });
});

describe('notifyAgentIslandSessionPatch(归档/删除同步 Agent Island)', () => {
  it('status 变为 archived/deleted 时移除 Agent Island session', async () => {
    notifyAgentIslandSessionPatch('sess-archived', {
      status: 'archived',
      title: 'Archived session',
      workingDir: '/repo',
      workspaceKind: 'project',
    });

    await vi.waitFor(() => {
      expect(h.agentIslandService.handleSessionClosed).toHaveBeenCalledWith('sess-archived');
    });
    expect(h.agentIslandService.handleSessionMetadataPatch).not.toHaveBeenCalled();

    notifyAgentIslandSessionPatch('sess-deleted', { status: 'deleted' });
    await vi.waitFor(() => {
      expect(h.agentIslandService.handleSessionClosed).toHaveBeenCalledWith('sess-deleted');
    });
  });

  it('active session 仍只同步 metadata', async () => {
    notifyAgentIslandSessionPatch('sess-active', {
      status: 'active',
      title: 'Active session',
      workingDir: '/repo',
      workspaceKind: 'project',
    });

    await vi.waitFor(() => {
      expect(h.agentIslandService.handleSessionMetadataPatch).toHaveBeenCalledWith('sess-active', {
        title: 'Active session',
        workingDir: '/repo',
        workspaceKind: 'project',
      });
    });
    expect(h.agentIslandService.handleSessionClosed).not.toHaveBeenCalled();
  });
});
