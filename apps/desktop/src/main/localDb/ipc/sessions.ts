/**
 * chat-data-localization F5：Sessions IPC handlers（C6）。
 *
 * 函数签名与原 `/api/sessions` 端点完全一致——上层 sessionService 切层后零改动。
 * 失败时 throw `Error("[CODE] message")`，service 层包装回 `ApiError`。
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import { ipcMain, app, BrowserWindow } from 'electron';
import { eq, ne, and, desc, count, inArray, isNotNull, isNull, sql, type SQL } from 'drizzle-orm';

import { DEFAULT_DRAFT_SESSION_TITLE, normalizeAutoTitle } from '@cindy/maker-shared/session-title';

import { getDbClient } from '../client/current';
import type { DbClient } from '../client/DbClient';
import { sessions, messages } from '../schema';
import { throwIpcError, requireString, requireObject } from '../../utils/ipcValidate';
import { resolveBusinessSessionId } from '../../sessionIds';
import { normalizeDbAgentKind } from '../../../shared/agentKindConversion';
import {
  sessionToCamel,
  sessionCreateToRow,
  sessionPatchToRow,
  normalizeRemoteHostId,
  type SessionRowWithCount,
} from '../mapper';
import { ensureDialogueWorkspaceDir } from '../dialogueWorkspace';
import { recomputePrRefsForSession } from '../../git-context/prRefsStore';
import { ensureProjectGitInitialized } from '../../git-snapshot/projectGitBootstrap';
import { readGitSafetySettings } from '../../maker-host/git-safety-settings-store';
import * as imageCacheStore from '../../imageCacheStore';
import { removeSessionRefs as removeSessionMediaRefs } from '../../cindy-media/ledger';
import { removeWechatSessionAttachmentDir } from '../../im/wechat/mediaStaging';
import { upsertRecentWorkdir } from './recentWorkdirs';
import { createLogger } from '../../logger';
import { DESKTOP_VISIBLE_SESSION_SOURCES } from '../../../shared/sessionSource.js';
import { normalizeWorkingDirForStorage } from '../../../shared/workingDir.js';
import type { SessionReference } from '../../../shared/sessionReference.js';
import * as broadcastTap from '../../device-link/broadcast-tap.js';
import { notifyAgentIslandSessionPatch } from '../agentIslandSessionPatch';
import { noteSessionClearBoundary } from '../../messagePersistBroadcaster';
import {
  ackSessionTurnEndedDurable,
  ackSessionTurnEndedIfUnchanged,
  listErrorTailPendingRows,
  listErrorTailPendingSessionIds,
  listInterruptedPendingRows,
  listInterruptedPendingSessionIds,
  setOnSessionTurnEndedPersisted,
} from '../sessionActiveTurn';
import {
  dismissErrorMessage,
  listDeletableSessionPersistedChatAttachmentPaths,
  rebroadcastAgentSwitchBoundary,
} from './messages';
import { cleanupStagedChatAttachments } from '../../file-browser/remote-file-cache';
import { assertTrustedAppRendererEvent } from '../../security/trustedAppRenderer.js';

const log = createLogger('sessions');
const REMOTE_EDITABLE_META = new Set(['status', 'title', 'pinnedAt']);
const initialSessionListLogged = new Set<string>();
const SLOW_SESSION_LIST_MS = 250;
type OwnerScope = ReturnType<typeof broadcastTap.captureDataOwnerBroadcastScope> | null;

function captureOwnerScope(): OwnerScope {
  try {
    const capture = broadcastTap.captureDataOwnerBroadcastScope;
    return capture ? capture() : null;
  } catch {
    // Narrow unit-test mocks may intentionally expose only the legacy tap API.
    return null;
  }
}

function isOwnerScopeCurrent(scope: OwnerScope): boolean {
  if (scope === null) return true;
  try {
    const isCurrent = broadcastTap.isDataOwnerBroadcastScopeCurrent;
    return isCurrent ? isCurrent(scope) : true;
  } catch {
    return true;
  }
}

function getSafeOwnerPushStamp(): ReturnType<typeof broadcastTap.getSafeDataOwnerPushStamp> {
  try {
    return broadcastTap.getSafeDataOwnerPushStamp?.();
  } catch {
    return undefined;
  }
}

/**
 * 广播 sessions:patched 到本机所有窗口 + device-link tap。tap 让该 patch 经 topic 路由
 * 转发给订阅了 `sessions` 的控制端(push 驱动:控制端 applyPatch 即时镜像,无需重拉)。
 */
export function broadcastSessionPatched(
  sessionId: string,
  patch: Record<string, unknown>,
  ownerScope?: OwnerScope,
): void {
  if (ownerScope !== undefined && !isOwnerScopeCurrent(ownerScope)) return;
  const hasCapturedScope = ownerScope !== undefined && ownerScope !== null;
  const ownerStamp = hasCapturedScope ? ownerScope.ownerStamp : getSafeOwnerPushStamp();
  if (hasCapturedScope) {
    broadcastTap.tapWindowBroadcast('local-db:sessions:patched', { sessionId, patch }, ownerStamp);
  } else if (ownerStamp === undefined) {
    broadcastTap.tapWindowBroadcast('local-db:sessions:patched', { sessionId, patch });
  } else {
    broadcastTap.tapWindowBroadcast('local-db:sessions:patched', { sessionId, patch }, ownerStamp);
  }
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) {
      if (hasCapturedScope) {
        w.webContents.send('local-db:sessions:patched', { sessionId, patch }, ownerStamp);
      } else if (ownerStamp === undefined) {
        w.webContents.send('local-db:sessions:patched', { sessionId, patch });
      } else {
        w.webContents.send('local-db:sessions:patched', { sessionId, patch }, ownerStamp);
      }
    }
  }
}

/**
 * worktree 回收真正跑完后通知本机所有窗口重拉 worktree 快照。
 *
 * 没有这条推送,renderer 只能在归档/删除动作里"顺手"刷一次 worktree map,而回收
 * 是下面 fire-and-forget 的异步链(动态 import → 关子进程 → git worktree remove →
 * 文件系统清理),store 条目被移除的时刻远晚于状态 IPC 返回。renderer 那次刷新会
 * 快照到仍然存在的旧条目,归档列表上的 worktree 徽标就一直陈旧,直到某次无关的
 * 刷新才纠正(codex review P1)。
 *
 * 只广播给本机窗口、不进 device-link tap:控制端(手机/另一台桌面)的远程会话
 * worktree 元数据走 device-link 自己的镜像链路,不经本机 WorktreeContext。
 */
function broadcastWorktreeChanged(sessionId: string): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send('worktree:changed', { sessionId });
  }
}

/**
 * 会话 status 显式变为 deleted / archived 后的 worktree 回收调度(P0 重构:回收
 * 唯一驱动点,从 Maker onClose 迁到这里——close 是进程生命周期事件,/clear、鉴权
 * 重连、CLI 崩溃都会触发,不能当"用户不要工作区了"的信号)。
 *
 * fire-and-forget:回收失败不影响状态写库(启动期 reconcile 兜底 deleted 场景)。
 * 先关子进程再回收——Windows 下 CLI 子进程 cwd 在 worktree 内会锁目录。
 * 动态 import 避免 localDb → maker-host / worktree 的静态模块环(worktreeStore
 * 反向 import 本文件的 setWorktreePathInDb)。
 *
 * 回收链结束后(无论成功、跳过还是失败)都广播一次 worktree:changed —— 失败/跳过
 * 时条目仍在 store 里,重拉拿到的就是"徽标还在"这个真实状态,同样是对的。
 */
function scheduleWorktreeRecycleForStatusChange(sessionId: string, status: unknown): void {
  if (status !== 'deleted' && status !== 'archived') return;
  void (async () => {
    const [mh, recycle, routeLock] = await Promise.all([
      import('../../maker-host/index.js'),
      import('../../worktree/sessionRemovalRecycle.js'),
      import('../../maker-ipc/register.js'),
    ]);
    if (!(await recycle.isSessionStillRemovable(sessionId))) return;
    await routeLock.withSendToSessionLock(sessionId, async () => {
      if (!(await recycle.isSessionStillRemovable(sessionId))) return;
      await mh
        .getMakerIfReady()
        ?.closeSession(sessionId)
        .catch(() => undefined);
    });
    await recycle.recycleWorktreeForRemovedSession(sessionId);
  })()
    .catch((err) => {
      log.warn('worktree recycle after session status change failed', {
        sessionId,
        err: err instanceof Error ? err.message : String(err),
      });
    })
    .finally(() => {
      broadcastWorktreeChanged(sessionId);
    });
}

// shadow savepoint 链(refs/cindy/savepoints/<sid>)刻意**不**挂 status 变化
// 即时清理:覆盖导入等流程会把旧会话瞬态置为 deleted、失败后经 journal 恢复,
// status 触发的 ref 删除与这类回滚天然竞态(删了就不可逆)。孤儿 ref 隐藏且
// 极小,统一由启动期 reconcileSavepointRefsForDeletedSessions() 清理——启动期
// 不存在进行中的瞬态软删流程。

/**
 * 会话 status 变化的订阅槽①旁路通知(archived → did-session-archived)。
 * 与 worktree 回收共用同三个调用点(update / patch-meta / 批量 setStatus),
 * 保证主 UI 归档、device-link 远程归档、MCP 批量归档都发得出事件。
 * fire-and-forget + 动态 import 防环;资格过滤(用户主会话)与订阅者快路径
 * 都在 cindy-brain 内部,这里零判断。
 */
function notifyGhostSessionStatusChange(
  sessionId: string,
  status: unknown,
  workingDir?: string | null,
): void {
  if (status !== 'archived') return;
  void import('../../cindy-brain/index.js')
    .then((m) =>
      m.notifyGhostSessionEvent('archived', {
        sessionId,
        ...(workingDir ? { workdir: workingDir } : {}),
      }),
    )
    .catch(() => {});
}

/** device-link 远程 set-* 回流可持久化的 session settings 字段(见 persistSessionFields)。 */
const REMOTE_PERSIST_FIELDS = new Set([
  'model',
  // set-model 第 3 参 providerId(per-session 来源)与 model 同批回流:必须在白名单内,
  // 否则被控端 DB 不写 provider_id(跨重启/resume 丢来源)、且广播 patch 不带 providerId →
  // 控制端 mirror 的 session.providerId 永不收敛(模型选择器 settle 永远卡 5s)。
  'providerId',
  'effort',
  'permissionMode',
  'fastMode',
  'planModeEnabled',
  'extraDirs',
]);

/**
 * 远程 set-*(model/providerId/effort/permission/fastMode/extraDirs)持久化回流。
 * 仅由 device-link dispatch 在「远程控制端调用 set-* 成功后」注入调用:被控端的 set-* 是
 * runtime-only(只改 maker-core 运行时 Session,不落库),这里补一次 DB 写,使被控端 DB 成为
 * 真相,控制端重读/收 patched 即拿到真值(取代控制端 settingsOverrides 乐观覆盖)。
 *
 * 不双写:本机会话的 settings 由 renderer 另调 sessions:update 持久化;远程会话才走这条
 * (两路按「本机 vs 远程会话」互斥)。故意**不暴露 IPC handler** —— 这不是远程可调 channel,
 * 只是 dispatch 的内部回流,不开放新的远程裸写面。
 */
/**
 * session-agent-switch:切换 agent 引擎的 DB 提交(单点,只被
 * sessionAgentSwitchHandler 调用,不暴露 IPC handler——agent_kind 不进任何
 * 通用 update 白名单,防裸写)。语义:
 *  - agent_kind / model 落新引擎值;providerId undefined = 不动,null = 显式清除;
 *  - sdk_session_id:缺省 / null = 清空,新引擎从全新原生会话开始(全量交接注入
 *    承接上下文);Phase 2 切回停泊引擎时传停泊的原生 session id,随后的
 *    bootstrap / lazy-create 走标准 resume 路径续接(增量交接补齐离开期间进展)。
 *    旧引擎的原生会话 id 绝不能原样残留——resume 会以错误引擎解释它(离场值
 *    快照存在边界行 fromSdkSessionId,即停泊绑定)。
 *  - 广播 sessions:patched:本机各窗口 sessionsStore/会话视图收敛 + device-link
 *    tap 让控制端镜像同步(agentKind 翻转驱动 capabilities 缓存按新 key 重取)。
 */
export async function applyAgentSwitchToSessionRow(
  sessionId: string,
  patch: {
    agentKind: 'cc' | 'codex' | 'pi';
    model: string;
    providerId: string | null | undefined;
    sdkSessionId?: string | null;
    /** 目标引擎下的 effort / fastMode(意图登记时 renderer 按目标目录解析,apply 一并落库)。 */
    effort?: string;
    fastMode?: boolean;
  },
): Promise<void> {
  const ownerScope = captureOwnerScope();
  const db = getDbClient().drizzle;
  const nextSdkSessionId = patch.sdkSessionId ?? null;
  const setObj: Partial<typeof sessions.$inferInsert> = {
    agentKind: patch.agentKind,
    model: patch.model,
    sdkSessionId: nextSdkSessionId,
    updatedAt: Date.now(),
  };
  if (patch.providerId !== undefined) setObj.providerId = patch.providerId;
  // effort 值域由 renderer 按目标引擎 capabilities 解析(schema 列是字面量联合,
  // 跨层传输后此处以 string 到达;非法值与直改 DB 同级,运行时由引擎侧收敛)。
  if (patch.effort !== undefined) {
    setObj.effort = patch.effort as (typeof sessions.$inferInsert)['effort'];
  }
  if (patch.fastMode !== undefined) setObj.fastMode = patch.fastMode;
  await db.update(sessions).set(setObj).where(eq(sessions.id, sessionId));
  if (!isOwnerScopeCurrent(ownerScope)) return;
  broadcastSessionPatched(
    sessionId,
    {
      agentKind: patch.agentKind,
      model: patch.model,
      sdkSessionId: nextSdkSessionId,
      ...(patch.providerId !== undefined ? { providerId: patch.providerId } : {}),
      ...(patch.effort !== undefined ? { effort: patch.effort } : {}),
      ...(patch.fastMode !== undefined ? { fastMode: patch.fastMode } : {}),
    },
    ownerScope,
  );
}

/** resume 停泊失败的原子 DB 回落,提交成功后再把 session 与边界新状态广播。 */
export async function applyAgentSwitchResumeFallbackAtomically(
  sessionId: string,
  boundaryClientId: string,
  content: unknown,
): Promise<void> {
  const ownerScope = captureOwnerScope();
  let boundaryContent: string;
  try {
    boundaryContent = JSON.stringify(content);
  } catch {
    throwIpcError('INVALID_PARAMS', 'agent switch boundary content must be JSON serializable');
  }
  await getDbClient().tx('session.agentSwitchFallback', {
    sessionId,
    boundaryClientId,
    boundaryContent,
    updatedAt: Date.now(),
  });
  if (!isOwnerScopeCurrent(ownerScope)) return;
  broadcastSessionPatched(sessionId, { sdkSessionId: null }, ownerScope);
  await rebroadcastAgentSwitchBoundary(sessionId, boundaryClientId, ownerScope).catch((err) => {
    // DB 事务已提交，广播失败不能让上层误判为“原子回落失败”并重复事务。
    log.warn('agent-switch fallback boundary broadcast failed', {
      sessionId,
      boundaryClientId,
      err: err instanceof Error ? err.message : String(err),
    });
  });
}

/**
 * Auto 权限分类器降级专用的条件持久化:仅当持久态仍为 'auto' 时把 permissionMode
 * 写成 'ask'(SQL 级 compare-and-swap)。用户在降级过程中并发手动切档时 UPDATE 不
 * 命中,回读到的用户选择原样保留,调用方据返回值决定是否广播降级/回滚 runtime。
 * 返回 true = 写库后(或并发用户恰好也切到 ask 时)持久态已是 'ask'。
 */
export async function persistSessionPermissionModeIfAuto(sessionId: string): Promise<boolean> {
  const ownerScope = captureOwnerScope();
  const db = getDbClient().drizzle;
  await db
    .update(sessions)
    .set({ permissionMode: 'ask' })
    .where(and(eq(sessions.id, sessionId), eq(sessions.permissionMode, 'auto')));
  const row = await db
    .select({ permissionMode: sessions.permissionMode })
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .get();
  const applied = row?.permissionMode === 'ask';
  if (applied && isOwnerScopeCurrent(ownerScope)) {
    broadcastSessionPatched(sessionId, { permissionMode: 'ask' }, ownerScope);
  }
  return applied;
}

export async function persistSessionFields(
  sessionId: string,
  patch: Record<string, unknown>,
): Promise<void> {
  const ownerScope = captureOwnerScope();
  const clean: Record<string, unknown> = {};
  for (const k of Object.keys(patch)) {
    if (REMOTE_PERSIST_FIELDS.has(k)) clean[k] = patch[k];
  }
  if (Object.keys(clean).length === 0) return;
  const db = getDbClient().drizzle;
  const setObj = sessionPatchToRow(clean as Parameters<typeof sessionPatchToRow>[0], {
    bumpUpdatedAt: false,
  });
  await db.update(sessions).set(setObj).where(eq(sessions.id, sessionId));
  if (isOwnerScopeCurrent(ownerScope)) broadcastSessionPatched(sessionId, clean, ownerScope);
}

const MAX_LIMIT = 1000;

/**
 * LEFT JOIN 形状下 `count()` 的目标列——必须是 `messages.session_id`，不能是 `messages.id`。
 * 当前只有单行 get/update 路径（{@link selectSessionWithCount}）用这个形状。
 *
 * 三种写法只有一种可用：
 *   - `count(messages.id)`         语义对但**回表**：id 不在任何覆盖索引里，SQLite 为取它
 *                                  必须逐行读 messages 主表。消息多的会话就是读几万行。
 *   - `count(*)`                   **语义错**：LEFT JOIN 对零消息会话也补一行，数出 1 而非 0，
 *                                  会打歪 sidebar 的「单空 New Maker 草稿」判定。
 *   - `count(messages.session_id)` 语义对且免回表：session_id 是
 *                                  idx_messages_session_created 的首列。
 *
 * 代价差一个数量级。这个形状原先也用在 list 路径上（`LIMIT` 在 GROUP BY 之后才生效、削不掉
 * 扫描量，于是成本正比于 messages 表**总体积**）：4.7GB / 111 万条消息的真实库上同库同数据
 * 实测冷缓存 10.2s → 1.25s、热缓存 920ms → 73ms。list 现已另走两段式（见
 * {@link selectSessionListRows}），但 get/update 每次改标题、切模型都会跑这一条。
 *
 * 由 sessionListMessageCount 回归测试守护：它在真库上对照两种写法的 query plan（覆盖索引
 * vs 回表）与空会话语义，并静态断言生产源码用的就是这一列。
 */
const MESSAGE_COUNT_COL = messages.sessionId;

/**
 * 两段式 list 里的 messageCount：标量子查询版。口径与 `count(MESSAGE_COUNT_COL)` 完全
 * 一致——该会话的全部 messages 行数，不过滤 role / rewind_at / cleared_at（口径要动就得
 * 连手机端卡片上的「N 条消息」一起想，见 maker-shared/sessionList 的 messageCountLabel）。
 *
 * 这里用 `count(*)` 反而是安全的：标量子查询没有 LEFT JOIN 补的那一行空行，无匹配时聚合
 * 返回 0。仍然只扫 idx_messages_session_created（session_id 是首列），不回表。
 */
const SESSION_MESSAGE_COUNT_SQL = sql<number>`(
  SELECT count(*) FROM messages m WHERE m.session_id = ${sessions.id}
)`.as('message_count');

/**
 * sidebar-card-mode：最近一条 user/assistant 消息的 content / role correlated 子查询。
 * 跳过 tool_use/tool_result/thinking 等噪音 role；rewind 软删的消息不进预览。
 * 命中 idx_messages_session_created (session_id, created_at) 索引，逐 session O(logN)。
 */
// .as(alias) 必须显式给——drizzle 对匿名 sql 字段在 better-sqlite3 下无法
// 稳定按 select key 映射，结果列取不到值（实测全 undefined → preview 恒 null）。
// clearedAt 边界与 messages:list 同口径:clear 过的会话只看 clearedAt 之后的消息,
// 否则卡片预览会露出 /clear 已隐藏的旧内容。
// autoResume 排除:silent-stop 自动续跑注入的「继续」(agentMeta.autoResume=true,
// 见 register.ts handleSilentStopTurnEnd)不是用户消息,渲染层显示为「已自动继续」
// 分隔卡,预览同样不能把它当最近消息展示(session.preview 经 device-link 直达手机
// 首页,漏了会显示一条用户没发过的消息)。按落库标记过滤,不按文本——用户真发
// 「继续」是合法消息。json_extract 对 JSON true 返回 1;非 JSON / 缺字段返回 NULL,
// IS NOT 1 对两者都放行。
const LATEST_MSG_CONTENT_SQL = sql<string | null>`(
  SELECT m.content FROM messages m
  WHERE m.session_id = ${sessions.id}
    AND m.role IN ('user', 'assistant')
    AND m.rewind_at IS NULL
    AND (m.agent_meta IS NULL OR json_extract(m.agent_meta, '$.autoResume') IS NOT 1)
    AND (${sessions.clearedAt} IS NULL OR m.created_at > ${sessions.clearedAt})
  ORDER BY m.created_at DESC LIMIT 1
)`.as('latest_message_content');
const LATEST_MSG_ROLE_SQL = sql<string | null>`(
  SELECT m.role FROM messages m
  WHERE m.session_id = ${sessions.id}
    AND m.role IN ('user', 'assistant')
    AND m.rewind_at IS NULL
    AND (m.agent_meta IS NULL OR json_extract(m.agent_meta, '$.autoResume') IS NOT 1)
    AND (${sessions.clearedAt} IS NULL OR m.created_at > ${sessions.clearedAt})
  ORDER BY m.created_at DESC LIMIT 1
)`.as('latest_message_role');

/**
 * 按 session id 查 desktop 端 sessions 表的产品快照。
 * 与 maker-core SessionMeta 不重叠 —— SessionMeta 故意不带 status (那是 desktop 产品语义)。
 * Resume 路径(scheduler runner / send_to_session)用它做归档/删除兜底和展示元数据返回。
 * 失败 swallow 返 null 而非抛 —— 调用方应当把 null 视作 NOT_FOUND, 由业务自己决定 fallback。
 */
/**
 * sessionId → remoteHostId 的进程内缓存 reader:session 的 remoteHostId 创建后
 * 不变,lazy resume 路径每次 send 都经过 ensureRemoteReadyForSessionStart,避免
 * 重复查库。查询成功(含行不存在)才缓存;DB 异常返回 null 但**不缓存** ——
 * 一次瞬时 DB 失败不该永久关闭该 session 的 remote ensure 兜底(否则远端
 * session 会被按本地会话处理远端 workingDir)。
 */
export function createSessionRemoteHostIdReader(): (sessionId: string) => Promise<string | null> {
  const cache = new Map<string, string | null>();
  return async (sessionId) => {
    if (cache.has(sessionId)) {
      return cache.get(sessionId) ?? null;
    }
    let value: string | null;
    try {
      const db = getDbClient().drizzle;
      const [row] = await db
        .select({ remoteHostId: sessions.remoteHostId })
        .from(sessions)
        .where(eq(sessions.id, sessionId))
        .limit(1);
      value = normalizeRemoteHostId(row?.remoteHostId ?? null);
    } catch {
      return null;
    }
    cache.set(sessionId, value);
    return value;
  };
}

export interface SessionRowSnapshot {
  status: string;
  title: string | null;
  userSendAt: number | null;
  workingDir: string | null;
  workspaceKind: string | null;
  providerId: string | null;
  /** Hook exact-takeover must reject SSH-owned sessions. */
  remoteHostId?: string | null;
  /** Hook exact-takeover must reject internal Orca worker sessions. */
  orcaRole?: 'lead' | 'worker' | null;
  /** Collab policy gate: remote session 的 codex / claude-code 均放行。 */
  agentKind?: string | null;
  /** Authoritative `/clear` visibility boundary (unix ms). */
  clearedAt?: number | null;
}

async function selectSessionRowSnapshot(id: string): Promise<SessionRowSnapshot | null> {
  const db = getDbClient().drizzle;
  const [row] = await db
    .select({
      status: sessions.status,
      title: sessions.title,
      userSendAt: sessions.userSendAt,
      workingDir: sessions.workingDir,
      workspaceKind: sessions.workspaceKind,
      // heartbeat 任务 providerId 留空时,沿用绑定会话在聊天里选的来源(与 model
      // 留空沿用 meta.model 对称)。零新增查询,复用 runner 已并行取的这行快照。
      providerId: sessions.providerId,
      clearedAt: sessions.clearedAt,
      remoteHostId: sessions.remoteHostId,
      orcaRole: sessions.orcaRole,
      agentKind: sessions.agentKind,
    })
    .from(sessions)
    .where(eq(sessions.id, id))
    .limit(1);
  return row ?? null;
}

/**
 * 严格读取发送前的 session 行。
 *
 * 远控输入必须区分「明确不存在」和「数据库暂时不可读」：前者是可恢复之外的
 * 终态拒绝,后者则应让 renderer 保留草稿并稍后重试。普通 scheduler / 展示路径
 * 继续使用下面的 swallow 版本,避免扩大既有错误语义。
 */
export async function getSessionRowSnapshotStrict(id: string): Promise<SessionRowSnapshot | null> {
  return selectSessionRowSnapshot(id);
}

export async function getSessionRowSnapshot(id: string): Promise<SessionRowSnapshot | null> {
  try {
    return await selectSessionRowSnapshot(id);
  } catch (err) {
    log.warn('getSessionRowSnapshot failed', {
      sessionId: id,
      err: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * 按 session id 查 fs 槽(意识写文件)守门要看的会话快照:workdir 位置、
 * permission 模式(claude / codex / pi 共用这一列,codex 的 approval/sandbox
 * 由它映射派生)、plan 开关、远程工作区标记。失败 swallow 返 null(调用方按
 * 「会话不存在」拒绝写入,不抛)。
 */
export async function getSessionFsSnapshot(id: string): Promise<{
  workingDir: string | null;
  permissionMode: string;
  planModeEnabled: boolean;
  remoteHostId: string | null;
} | null> {
  try {
    const db = getDbClient().drizzle;
    const [row] = await db
      .select({
        workingDir: sessions.workingDir,
        permissionMode: sessions.permissionMode,
        planModeEnabled: sessions.planModeEnabled,
        remoteHostId: sessions.remoteHostId,
      })
      .from(sessions)
      .where(eq(sessions.id, id))
      .limit(1);
    return row ?? null;
  } catch (err) {
    log.warn('getSessionFsSnapshot failed', {
      sessionId: id,
      err: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * 内部 API：标记用户显式发送时间。
 *
 * 过去这一步由 renderer 在 sendMessage 里直接调 IPC。队列 / 插话迁到 main 事务
 * 协调器后，renderer 只发 intent，真正“这条输入已进入事务”的时间必须跟 main
 * 状态机同源，否则 retry / rollback 时会出现 DB 已 bump 但输入没有被接受的分裂。
 */
export async function touchUserSendInDb(id: string, atMs?: number): Promise<void> {
  const ownerScope = captureOwnerScope();
  const ts =
    typeof atMs === 'number' && Number.isFinite(atMs) && atMs > 0 ? Math.floor(atMs) : Date.now();
  const db = getDbClient().drizzle;
  // 原子 guard：单条 UPDATE + WHERE 代替 SELECT→条件判断→UPDATE 三步走。
  // 旧实现存在 TOCTOU 竞态：两个并发调用（如 scheduler fire + 手动发送）都可能
  // 通过旧值检查后都执行 UPDATE，后写入的更早时间戳会覆盖已写入的更新值。
  // WHERE 条件由 SQLite 行锁原子执行，消除竞态窗口。
  // updatedAt 用 MAX 防止 run 完成路径写入 finishedAt 后被更早的 firedAt 回退。
  // 同步 bump updatedAt:侧栏时间轴统一读 sessions.updatedAt("最近有动静的会话"),
  // 用户按下发送就是最典型的"有动静"—— userSendAt 保持"用户发送时刻"专用语义,
  // updatedAt 表示"任意路径下这个 session 最近一次被推进",两者语义正交但需同刷。
  await db
    .update(sessions)
    .set({ userSendAt: ts, updatedAt: sql`MAX(${sessions.updatedAt}, ${ts})` })
    .where(
      and(
        eq(sessions.id, id),
        sql`(${sessions.userSendAt} IS NULL OR ${sessions.userSendAt} < ${ts})`,
      ),
    );
  // 验证 UPDATE 是否落地，避免向 renderer 广播过时值。
  // WHERE 条件为假时（并发写入已领先，或 userSendAt 已 >= ts）UPDATE 为 no-op；
  // 此时 DB 里的 userSendAt ≠ ts，SELECT 返回空，正确跳过广播。
  // 通过 SELECT 拿回实际落库的 updatedAt（已经是 MAX'd 结果）用于广播，
  // 避免把旧 ts 当作 updatedAt 广播给 renderer。
  const updated = await db
    .select({ userSendAt: sessions.userSendAt, updatedAt: sessions.updatedAt })
    .from(sessions)
    .where(and(eq(sessions.id, id), eq(sessions.userSendAt, ts)))
    .limit(1);
  if (updated.length === 0) return;
  // 广播 sessions:patched,让 renderer 把刚发过消息的会话从「草稿(未分类)」即时重归到
  // 项目分组下(projectGrouping 的草稿兜底:userSendAt==null && messages==0 → unclassified)。
  //   - 本机会话:renderer 在 sendMessage 里已乐观 patchLocal(userSendAt),这条是权威确认(幂等)。
  //   - device-link 远程会话:控制端是在**被控端** enqueue 时才 bump userSendAt,被控端自己的
  //     renderer 不会乐观更新 —— 没有这条广播,被控端 sidebar 会把控制端新建的远程会话一直
  //     当草稿挂在项目外。经 device-link tap 同时把权威 userSendAt 推给控制端,两端收敛。
  // userSendAt 按 renderer 约定用 ISO 字符串(与 sessionToCamel 的 msToIso 对齐)。
  if (isOwnerScopeCurrent(ownerScope)) {
    broadcastSessionPatched(
      id,
      {
        userSendAt: new Date(updated[0].userSendAt!).toISOString(),
        updatedAt: new Date(updated[0].updatedAt).toISOString(),
      },
      ownerScope,
    );
  }
}

/** fork 出来的会话的占位标题前缀("[Fork] …" / "[Fork·已剥离] …")。 */
const FORK_PLACEHOLDER_TITLE_PREFIX = '[Fork';

let _onUserTitleWritten: ((sessionId: string) => void) | null = null;

/**
 * 注入「用户手动写过标题」的通知(传 null 清除;由 maker-ipc 的自动起名模块注册)。
 *
 * 为什么条件写不够:`persistSessionTitleIfStillDraft` 靠 `WHERE title = 期望值` 实现
 * user rename wins,但用户把标题改成**与占位逐字相同**的串时这条件仍然成立,随后的
 * 智能标题会把他刚保存的名字覆盖掉(PR #510 review P1)。`sessions` 表没有「谁写的」
 * 这一列,所以由改名出口显式说一声,自动起名据此收手。
 */
export function setOnUserSessionTitleWritten(fn: ((sessionId: string) => void) | null): void {
  _onUserTitleWritten = fn;
}

/** 用户改名出口统一调这个(自动起名自己的写入**不**调)。 */
function noteUserTitleWritten(sessionId: string): void {
  try {
    _onUserTitleWritten?.(sessionId);
  } catch {
    // 自动起名是附属功能,通知失败不该影响改名主流程。
  }
}

/**
 * 自动标题的资格检查:title 仍是系统占位。系统占位有三种 ——
 *
 *   1. `DEFAULT_DRAFT_SESSION_TITLE`:建会话时的默认标题;
 *   2. fork 占位("[Fork…" 前缀 **且** 有 parentSessionId):fork 会话天然带历史
 *      消息,要在用户发出第一句话时才被替换。额外要求 parentSessionId,避免用户
 *      手动改名成 "[Fork] ..." 的普通会话被误判成占位;
 *   3. `synthesizedPlaceholder`:调用方上次为纯附件消息写入的合成占位(文件名 /
 *      「图片」等),让「先只贴图、后打字」的会话在用户打字时把标题换成他写的内容。
 *
 * 只看标题、不要求「零消息且无 userSendAt」:首条输入是纯附件(无文本)时会话已经
 * 有消息和 userSendAt,旧口径会让它永久停在 "New Maker"。标题仍是系统占位本身就
 * 等价于「既没被自动起名、也没被用户改名」,足以作为门槛。
 */
export interface OverwritableAutoTitleTarget {
  /** 当前可覆写的标题 —— 直接用作条件写的期望值。 */
  title: string;
  /**
   * DB 里的权威 agentKind。**不要信调用方快照**:另一个窗口或设备切过 agent 时,
   * 入队时构建的 createOpts 可能已经过期(lazy-create 的
   * `reconcileCreateOptsAgainstDb` 处理的正是同一类漂移),用错 agent 会让标题
   * 走错供应商 —— 纯 Codex / 纯 Claude 用户会因此只拿到 fallback 标题。
   */
  agentKind: 'claude-code' | 'codex' | 'pi';
  /**
   * 是否仍停在建会话时的裸默认标题。合成占位(纯附件消息)只允许覆写这一种 ——
   * fork 占位与上一条附件写下的合成占位都要保留到用户真正打字为止。
   */
  isDefaultDraftTitle: boolean;
}

export async function getOverwritableAutoTitle(
  id: string,
  synthesizedPlaceholder?: string | null,
): Promise<OverwritableAutoTitleTarget | null> {
  const db = getDbClient().drizzle;
  const row = await selectSessionWithCount(db, id);
  if (!row) return null;
  const agentKind =
    row.agentKind === 'codex' || row.agentKind === 'pi' ? row.agentKind : 'claude-code';
  const overwritable =
    row.title === DEFAULT_DRAFT_SESSION_TITLE ||
    (!!row.parentSessionId && row.title.startsWith(FORK_PLACEHOLDER_TITLE_PREFIX)) ||
    (!!synthesizedPlaceholder && row.title === synthesizedPlaceholder);
  if (!overwritable) return null;
  return {
    title: row.title,
    agentKind,
    isDefaultDraftTitle: row.title === DEFAULT_DRAFT_SESSION_TITLE,
  };
}

/**
 * 布尔版资格检查(给 enqueue 前的廉价预检用)。真正执行起名的路径用
 * {@link getOverwritableAutoTitle},因为它还要拿当前标题当条件写的期望值 ——
 * fork 占位与合成占位都不等于草稿默认值,猜期望值会让写入直接落空。
 */
export async function isUntitledSessionAwaitingAutoTitle(
  id: string,
  synthesizedPlaceholder?: string | null,
): Promise<boolean> {
  return (await getOverwritableAutoTitle(id, synthesizedPlaceholder)) !== null;
}

/**
 * 自动标题落库出口。只在 title 仍等于 `expectedTitle` 时写入,避免后台标题覆盖
 * 用户手动改名。
 *
 * `expectedTitle` 默认是草稿占位;远控立即占位链路在写完占位后,用占位串作为
 * 期望值再写智能标题——用户在等待窗口内手动改名时期望值不匹配,写入被拒绝。
 */
export async function persistSessionTitleIfStillDraft(
  sessionId: string,
  title: string,
  expectedTitle: string = DEFAULT_DRAFT_SESSION_TITLE,
): Promise<boolean> {
  const ownerScope = captureOwnerScope();
  const cleanTitle = normalizeAutoTitle(title);
  if (!cleanTitle || cleanTitle === DEFAULT_DRAFT_SESSION_TITLE) return false;

  const db = getDbClient().drizzle;
  // 目标值与期望值相同 → UPDATE 无事可做,但**不能凭期望值直接报成功**:期望值
  // 可能已经过期(用户在资格检查之后手动改了名),那时库里根本不是这个标题。
  // 读一次真实标题再回答,避免调用方把"没写成"当成"已写入"(PR #510 review)。
  if (cleanTitle === expectedTitle) {
    const current = await selectSessionWithCount(db, sessionId);
    return !!current && current.title === cleanTitle;
  }

  const setObj = sessionPatchToRow({ title: cleanTitle }, { bumpUpdatedAt: false });
  await db
    .update(sessions)
    .set(setObj)
    .where(and(eq(sessions.id, sessionId), eq(sessions.title, expectedTitle)));

  const row = await selectSessionWithCount(db, sessionId);
  if (!row || row.title !== cleanTitle) return false;

  const updated = sessionToCamel(row);
  notifyAgentIslandSessionPatch(updated.id, {
    status: updated.status,
    title: updated.title,
    workingDir: updated.workingDir,
    workspaceKind: updated.workspaceKind,
  });
  if (isOwnerScopeCurrent(ownerScope)) {
    broadcastSessionPatched(sessionId, { title: cleanTitle }, ownerScope);
  }
  return true;
}

/**
 * `/clear` 权威落库出口。
 *
 * 本机会话历史上由 renderer 在 clearSession 后调 sessions:update 写库；device-link
 * 远程会话的 renderer 在控制端，不能写被控端 DB，所以远程 invoke 必须在被控端 main
 * 补这一步。广播让被控端窗口和控制端镜像都收敛到同一个 clearedAt 边界。
 */
export async function clearSessionContextInDb(sessionId: string, atMs?: number): Promise<void> {
  const ownerScope = captureOwnerScope();
  const ts =
    typeof atMs === 'number' && Number.isFinite(atMs) && atMs > 0 ? Math.floor(atMs) : Date.now();
  const db = getDbClient().drizzle;
  await db
    .update(sessions)
    .set({
      sdkSessionId: null,
      // Concurrent /clear calls may finish their DB awaits out of order. Keep
      // both persisted boundaries monotonic so the older completion cannot
      // make pre-clear history visible again or invalidate a newer input token.
      clearedAt: sql<number>`MAX(COALESCE(${sessions.clearedAt}, 0), ${ts})`,
      updatedAt: sql<number>`MAX(COALESCE(${sessions.updatedAt}, 0), ${ts})`,
    })
    .where(eq(sessions.id, sessionId));
  const [updated] = await db
    .select({ clearedAt: sessions.clearedAt, updatedAt: sessions.updatedAt })
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .limit(1);
  const effectiveClearedAt = updated?.clearedAt ?? ts;
  const effectiveUpdatedAt = updated?.updatedAt ?? effectiveClearedAt;
  void recomputePrRefsForSession(sessionId).catch(() => undefined);
  if (isOwnerScopeCurrent(ownerScope)) {
    broadcastSessionPatched(
      sessionId,
      {
        sdkSessionId: null,
        clearedAt: new Date(effectiveClearedAt).toISOString(),
        updatedAt: new Date(effectiveUpdatedAt).toISOString(),
      },
      ownerScope,
    );
  }
}

export function registerSessionIpc(
  readSessionListLogScope: () => string | null = () => null,
): void {
  // interrupted-turn-resume 假阳性修复:每次 last_turn_ended_at 真正落库(正常收尾 /
  // barrier 版收尾 / ack)都广播 lastTurnEndedAt patch —— renderer 的 session 快照可能
  // 是在 turn 飞行中或「done → ended 落库」空窗里取的(startedAt > endedAt),此前
  // 只有「忽略」ack 会广播,正常收尾静默写导致快照永不纠正,任务正常结束后切回
  // 会话仍弹「应用退出中断」。注入而非让 sessionActiveTurn 直接 import,避免
  // 反向依赖成环(本文件已 import sessionActiveTurn)。
  setOnSessionTurnEndedPersisted(
    (sid, endedAt, capturedOwnerScope) =>
      broadcastSessionPatched(
        sid,
        { lastTurnEndedAt: endedAt },
        capturedOwnerScope as OwnerScope | undefined,
      ),
    captureOwnerScope,
  );
  ipcMain.handle(
    'local-db:sessions:list',
    async (_e, limit: unknown, status: unknown, options: unknown) => {
      const startedAt = performance.now();
      const db = getDbClient().drizzle;
      // sidebar-card-mode: 首次 list(db 必然 ready)触发一次置顶摘要回填——
      // 老置顶会话没有 turn-done 触发点。模块内部 once 守卫 + 串行 + swallow。
      void import('../../sessionTaskSummary.js').then((m) => m.backfillPinnedSessionSummaries());
      const cap = clampLimit(limit, 20);
      const includePinned = shouldIncludePinnedSessions(options);
      // 支持 Sidebar Filter 的 Active/Archived/All status 过滤。
      //   - 'active' / 'archived' → WHERE status = ?
      //   - 'all' / undefined / 其它非法值 → WHERE status != 'deleted'
      //     （deleted 是软删除墓碑，对所有筛选都应不可见——与 server 端
      //      listSessions 行为一致：'all' 白名单 ['active','archived']）
      const statusFilter: 'active' | 'archived' | null =
        status === 'active' || status === 'archived' ? status : null;
      // 按 DESKTOP_VISIBLE_SESSION_SOURCES 白名单过滤 — 包含 IM 渠道
      // (feishu/slack/discord)与本机自动化(scheduler/learn/shared);
      // feishu 会话以「对话」分组展示(workspaceKind='dialogue')。
      const sourceFilter = inArray(sessions.source, DESKTOP_VISIBLE_SESSION_SOURCES);
      const statusWhere = () =>
        statusFilter ? eq(sessions.status, statusFilter) : ne(sessions.status, 'deleted');
      const rows = await selectSessionListRows(db, and(sourceFilter, statusWhere()), cap);

      let mergedRows = rows;
      if (includePinned) {
        const pinnedRows = await selectSessionListRows(
          db,
          and(sourceFilter, statusWhere(), isNotNull(sessions.pinnedAt)),
          null,
        );
        mergedRows = mergeSessionListRows(rows, pinnedRows);
      }

      const queryFinishedAt = performance.now();
      const result = mergedRows.map((r) =>
        sessionToCamel({
          ...r.session,
          messageCount: r.messageCount,
          latestMessageContent: r.latestMessageContent,
          latestMessageRole: r.latestMessageRole,
        }),
      );
      const finishedAt = performance.now();
      const filter = statusFilter ?? 'all';
      const elapsedMs = Math.round(finishedAt - startedAt);
      const fields = JSON.stringify({
        event: 'localDb.sessions.list.done',
        filter,
        cap,
        includePinned,
        rows: result.length,
        queryElapsedMs: Math.round(queryFinishedAt - startedAt),
        mapElapsedMs: Math.round(finishedAt - queryFinishedAt),
        elapsedMs,
      });
      const logScope = readSessionListLogScope() ?? 'unscoped';
      const logKey = `${logScope}:${filter}:${includePinned ? 'pinned' : 'plain'}`;
      if (!initialSessionListLogged.has(logKey) || elapsedMs >= SLOW_SESSION_LIST_MS) {
        initialSessionListLogged.add(logKey);
        log.info(fields);
      } else {
        log.debug(fields);
      }
      return result;
    },
  );

  ipcMain.handle('local-db:sessions:create', async (_e, body) => {
    const db = getDbClient().drizzle;
    const now = Date.now();
    const bodyObj = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
    const id = resolveBusinessSessionId(bodyObj.id);
    const createBody = bodyObj as Parameters<typeof sessionCreateToRow>[1];
    // M16: agentKind 白名单校验（防止 renderer 传非法值）
    const ALLOWED_AGENT_KINDS = new Set<string>(['cc', 'codex', 'pi']);
    if (bodyObj.agentKind !== undefined && !ALLOWED_AGENT_KINDS.has(bodyObj.agentKind as string)) {
      throwIpcError('INVALID_PARAMS', `invalid agentKind: ${String(bodyObj.agentKind)}`);
    }
    const ALLOWED_WORKSPACE_KINDS = new Set<string>(['project', 'dialogue']);
    if (
      bodyObj.workspaceKind !== undefined &&
      !ALLOWED_WORKSPACE_KINDS.has(bodyObj.workspaceKind as string)
    ) {
      throwIpcError('INVALID_PARAMS', `invalid workspaceKind: ${String(bodyObj.workspaceKind)}`);
    }
    const ALLOWED_ORCA_ROLES = new Set<string>(['lead', 'worker']);
    if (
      bodyObj.orcaRole !== undefined &&
      bodyObj.orcaRole !== null &&
      !ALLOWED_ORCA_ROLES.has(bodyObj.orcaRole as string)
    ) {
      throwIpcError('INVALID_PARAMS', `invalid orcaRole: ${String(bodyObj.orcaRole)}`);
    }
    const workspaceKind =
      (createBody?.workspaceKind as 'project' | 'dialogue' | undefined) ?? 'project';
    const explicitWorkingDir =
      normalizeWorkingDirForStorage(
        typeof createBody?.workingDir === 'string' ? createBody.workingDir : null,
      ) ?? undefined;
    const workingDir =
      workspaceKind === 'dialogue' && !explicitWorkingDir
        ? ensureDialogueWorkspaceDir(id, now)
        : explicitWorkingDir;
    if (workspaceKind === 'dialogue' && !explicitWorkingDir) {
      log.info('[localDb] allocated dialogue workspace', { sessionId: id, workingDir });
    }
    // body 透传 agentKind / orcaRole 给 mapper；非法值已由上方校验拦截，默认值由 mapper 兜底。
    const insertRow = sessionCreateToRow(id, { ...createBody, workspaceKind, workingDir }, now);
    await ensureProjectGitInitialized({
      workingDir: insertRow.workingDir,
      workspaceKind: insertRow.workspaceKind,
      remoteHostId: insertRow.remoteHostId,
      sessionId: id,
      autoSnapshotEnabled: readGitSafetySettings().autoSnapshotEnabled,
      source: 'local-db:sessions:create',
    });
    await db.insert(sessions).values(insertRow);
    const [row] = await db.select().from(sessions).where(eq(sessions.id, id));
    if (!row) throwIpcError('NOT_FOUND', 'Session 创建后查询失败');
    // recent-workdirs: 项目目录走 sidebar 分组,要进"最近"列表;dialogue 目录是
    // app-managed 临时 cwd,跟用户选过的项目目录语义不同,不污染最近列表。
    // 失败仅日志,不阻断创建流程。
    //
    // remote 项目排除:recent_workdirs 表只有 path 主键、无 host 维度,若把 remote
    // 路径写进去,后续 New Maker 项目下拉选中它时会丢失 host、按本机路径创建出一个
    // 错误的本地会话(指向本机不存在的同名目录)。在 host-aware 最近项目(给该表加
    // remote_host_id 列 + picker 区分 local/remote)落地前,remote 项目一律不进最近列表。
    if (insertRow.workspaceKind === 'project' && insertRow.workingDir && !insertRow.remoteHostId) {
      void upsertRecentWorkdir(insertRow.workingDir, now);
    }
    // 订阅槽①旁路通知(fire-and-forget,动态 import 防环):意识旁听会话创建。
    // 资格过滤(用户主会话)与订阅者快路径都在 cindy-brain 内部,这里零判断。
    void import('../../cindy-brain/index.js')
      .then((m) =>
        m.notifyGhostSessionEvent('created', {
          sessionId: id,
          ...(row.workingDir ? { workdir: row.workingDir } : {}),
        }),
      )
      .catch(() => {});
    // 新建 session 必然无 message，直接拼 0，免一次 join。
    return sessionToCamel({ ...row, messageCount: 0 });
  });

  // interrupted-turn-resume:「疑似中断」(startedAt > endedAt)的 active 会话 id。
  // ⚠️ 只在**启动首拉**时消费:该判定对正在跑的 turn 天然成立,只有启动时刻才能
  // 断定飞行中的 turn 来自上一个进程。周期性重跑会把运行中的会话误判为中断。
  ipcMain.handle('local-db:sessions:interrupted-pending', async () => {
    return listInterruptedPendingSessionIds();
  });

  // 「尾部停在未 dismissed 错误行」的 active 会话 id —— 红点派生的周期性重算源。
  // 与中断腿不同,这条判定与 turn 是否在跑无关(turn 一跑起来就会插入新的 user 行,
  // error 行不再是尾行,自然不命中),因此可以在每个收敛触发点安全重跑。
  // 故意**不**进 device-link allowlist:renderer 只查本机(远程会话的告警由被控端
  // 自己的派生收敛负责,控制端的处置动作经既有 ack-interrupted / dismiss-error 窄写
  // 落被控端 DB 后触发)。没有跨端调用方就不扩协议面。
  // sender guard:新增 handler 一律验证来源(electron-security-and-process-boundaries.md
  // §5 —— 存量未迁完不构成新 handler 省略校验的理由)。这两个 channel 都**不在**
  // device-link allowlist 里,只由本机顶层 renderer 调用,所以 guard 不会挡掉隧道
  // dispatch;将来若要放行跨端,必须连这道 guard 一起重新设计。
  ipcMain.handle('local-db:sessions:error-tail-pending', async (event) => {
    assertTrustedAppRendererEvent(event);
    return listErrorTailPendingSessionIds();
  });

  // 批量处置未处理告警(自动化分组右键「全部标为已读」)。红点是告警的派生投影,
  // 光清角标会被下一次重算打回来 —— 所以这个入口必须做真正的处置,与用户在横幅上
  // 点「忽略」等价:错误尾行 merge dismissed:true(复用 dismissErrorMessage,带 peer
  // 广播),中断态写 last_turn_ended_at 消化掉。
  // 只处置**当前真的命中告警**的会话:一次全量查询后按传入集合取交集,避免对
  // 无告警会话空写 lastTurnEndedAt 造成无意义的 patch 广播。
  // 输入有界(review 反馈):不接受无上限数组,也不静默吞掉畸形元素 —— 越界或元素
  // 不合法直接 INVALID_PARAMS 拒绝,避免异常调用方让 main 侧分配任意大的集合并跑
  // 一轮数据库写。上限取 sidebar 可能的自动化会话量级的宽松倍数。
  const MAX_DISMISS_SESSION_IDS = 500;
  // 单个 id 也要有界:session id 是 UUID / cuid(≤ 36 字符),128 是宽松上限。
  // 只限数组长度不够 —— 500 个超长字符串同样能让 main 侧白留一大块内存并做无谓比较。
  const MAX_SESSION_ID_LENGTH = 128;
  ipcMain.handle('local-db:sessions:dismiss-pending-alerts', async (event, ids: unknown) => {
    // 认证来源再做任何写:payload 有界 ≠ 来源可信(见上方 guard 说明)。
    assertTrustedAppRendererEvent(event);
    if (!Array.isArray(ids)) throwIpcError('INVALID_PARAMS', 'sessionIds 必须是数组');
    if (ids.length > MAX_DISMISS_SESSION_IDS) {
      throwIpcError('INVALID_PARAMS', `sessionIds 超过上限 ${MAX_DISMISS_SESSION_IDS}`);
    }
    for (const id of ids) {
      const sid = requireString(id, 'sessionId');
      if (sid.length > MAX_SESSION_ID_LENGTH) {
        throwIpcError('INVALID_PARAMS', `sessionId 超过长度上限 ${MAX_SESSION_ID_LENGTH}`);
      }
    }
    const wanted = new Set(ids as string[]);
    if (wanted.size === 0) return { dismissed: 0, processed: [], failed: [] };
    const [tailRows, interruptedRows] = await Promise.all([
      listErrorTailPendingRows(),
      listInterruptedPendingRows(),
    ]);
    // 回报**确切处置成功的 id**(processed),不让调用方用「不在 failed 里」推断成功:
    // 请求集合里可能有本 handler 根本不处理的告警来源(典型是 WorktreeRestoreBanner
    // 打的红点 —— 它不进错误尾行/中断查询),那些会话既不成功也不失败。按「非 failed
    // 即成功」清点会抹掉它们的红点,而 worktree 告警又不在重算范围内、恢复不了
    // (PR #879 review P1)。
    const processed = new Set<string>();
    const failed = new Set<string>();
    for (const row of tailRows) {
      if (!wanted.has(row.sessionId)) continue;
      try {
        const updated = await dismissErrorMessage(row.sessionId, row.clientId);
        if (updated) processed.add(row.sessionId);
        else failed.add(row.sessionId);
      } catch {
        failed.add(row.sessionId);
      }
    }
    for (const row of interruptedRows) {
      if (!wanted.has(row.sessionId)) continue;
      // CAS 写:带上快照里的 startedAt。快照之后若该会话已启动新 turn,条件不匹配、
      // 不写入 —— 否则会把刚启动的活跃 turn 记成已收尾,它真被中断时下次启动检测不到
      // (PR #879 review P1)。返回值已含读回校验。
      const landed = await ackSessionTurnEndedIfUnchanged(row.sessionId, row.startedAt);
      if (landed) processed.add(row.sessionId);
      else failed.add(row.sessionId);
    }
    // 同一会话两条腿都命中时,任一失败即整体算失败(它仍有未处置的告警)。
    for (const id of failed) processed.delete(id);
    return { dismissed: processed.size, processed: [...processed], failed: [...failed] };
  });

  // interrupted-turn-resume:用户对「疑似中断」提示点「忽略」/「继续」——写一次
  // 正常收尾时刻,startedAt > endedAt 不再成立,banner 与红点跨重启不复现。
  // 幂等窄写,device-link 远程会话经隧道调用(allowlist 收录)。
  ipcMain.handle('local-db:sessions:ack-interrupted', async (_e, id: unknown) => {
    const sid = requireString(id, 'id');
    // renderer 的「忽略」立即走本 IPC；「继续任务」由执行端 maker send 事务 /
    // coordinator 在 dispatch 成功后用进入 vendor 前冻结的本机时间戳直调 durable 写。
    // awaited 版:等落库完成才广播 / 返回 —— 用户点忽略后立刻退出/重载时,写不能
    // 还停在内存链上,否则重启后同一提示复现(review P2)。
    // 广播不在此显式调用:ended 落库即经 setOnSessionTurnEndedPersisted 注入的回调
    // 广播(见 registerSessionIpc 头部注入点),ack 路径 await 写链完成,返回前广播
    // 必已发出 —— 其它窗口 / device-link 控制端的 session 快照 merge 后 banner 判定
    // 自动熄灭,启动红点也靠这条 patch 收敛(useInterruptedSessionsAttention)。
    await ackSessionTurnEndedDurable(sid);
    return { ok: true };
  });

  ipcMain.handle('local-db:sessions:get', async (_e, id: unknown) => {
    const sid = requireString(id, 'id');
    const db = getDbClient().drizzle;
    const row = await selectSessionWithCount(db, sid);
    if (!row) throwIpcError('NOT_FOUND', 'Session 不存在');
    return sessionToCamel(row);
  });

  /**
   * 批量解析 scheduler 持有的会话引用。普通列表会隐藏软删除墓碑，renderer 不能
   * 再靠“列表中是否存在”推断可打开状态；单次有界查询也避免每张 run 卡各发 IPC。
   */
  ipcMain.handle('local-db:sessions:resolve-references', async (_e, value: unknown) => {
    if (!Array.isArray(value)) throwIpcError('INVALID_PARAMS', 'sessionIds must be an array');
    if (value.length > 200) throwIpcError('INVALID_PARAMS', 'sessionIds exceeds limit 200');

    const sessionIds = Array.from(
      new Set(value.map((id, index) => requireString(id, `sessionIds[${index}]`))),
    );
    if (sessionIds.length === 0) return [] satisfies SessionReference[];

    const db = getDbClient().drizzle;
    const rows = await db
      .select({
        id: sessions.id,
        status: sessions.status,
        title: sessions.title,
        agentKind: sessions.agentKind,
      })
      .from(sessions)
      .where(inArray(sessions.id, sessionIds));
    const rowsById = new Map(rows.map((row) => [row.id, row]));

    return sessionIds.map((sessionId): SessionReference => {
      const row = rowsById.get(sessionId);
      if (!row) return { sessionId, state: 'missing' };
      return {
        sessionId,
        state: row.status === 'deleted' ? 'deleted' : 'available',
        status: row.status,
        title: row.title,
        agentKind: normalizeDbAgentKind(row.agentKind),
      };
    });
  });

  /**
   * 批量恢复的 compare-and-set 写口：确认框期间会话可能被删除、由其他入口恢复，
   * 或移动到别的项目。状态与项目身份必须在同一条 UPDATE 中校验，避免 renderer
   * 先 get 再 update 的 TOCTOU 竞态覆盖较新的状态。
   */
  ipcMain.handle(
    'local-db:sessions:restore-if-archived',
    async (_e, id: unknown, expected: unknown) => {
      const sid = requireString(id, 'id');
      const ownerScope = captureOwnerScope();
      const identity = requireObject(expected, 'expected');
      const expectedWorkingDir = identity.workingDir;
      const expectedWorkspaceKind = identity.workspaceKind;
      const expectedRemoteHostId = identity.remoteHostId;

      if (expectedWorkingDir !== null && typeof expectedWorkingDir !== 'string') {
        throwIpcError('INVALID_PARAMS', 'expected.workingDir must be a string or null');
      }
      if (expectedWorkspaceKind !== 'project' && expectedWorkspaceKind !== 'dialogue') {
        throwIpcError('INVALID_PARAMS', 'expected.workspaceKind must be project or dialogue');
      }
      if (expectedRemoteHostId !== null && typeof expectedRemoteHostId !== 'string') {
        throwIpcError('INVALID_PARAMS', 'expected.remoteHostId must be a string or null');
      }

      const db = getDbClient().drizzle;
      // 显式 .run() 才能从生产 DbClient.drizzle proxy 拿到 changes；隐式 await
      // 会丢弃写结果。CAS 是否命中必须以该原子 UPDATE 的 changes 判定。
      const writeResult = await db
        .update(sessions)
        .set(sessionPatchToRow({ status: 'active' }))
        .where(
          and(
            eq(sessions.id, sid),
            eq(sessions.status, 'archived'),
            expectedWorkingDir === null
              ? isNull(sessions.workingDir)
              : eq(sessions.workingDir, expectedWorkingDir),
            eq(sessions.workspaceKind, expectedWorkspaceKind),
            expectedRemoteHostId === null
              ? isNull(sessions.remoteHostId)
              : eq(sessions.remoteHostId, expectedRemoteHostId),
          ),
        )
        .run();

      if (writeResult.changes === 0) {
        const [existing] = await db
          .select({ id: sessions.id })
          .from(sessions)
          .where(eq(sessions.id, sid));
        if (!existing) throwIpcError('NOT_FOUND', 'Session 不存在');
        return null;
      }

      const row = await selectSessionWithCount(db, sid);
      if (!row) throwIpcError('NOT_FOUND', 'Session 不存在');
      const updated = sessionToCamel(row);
      notifyAgentIslandSessionPatch(updated.id, {
        status: updated.status,
        title: updated.title,
        workingDir: updated.workingDir,
        workspaceKind: updated.workspaceKind,
      });
      if (isOwnerScopeCurrent(ownerScope)) {
        broadcastSessionPatched(sid, { status: 'active' }, ownerScope);
      }
      scheduleWorktreeRecycleForStatusChange(sid, 'active');
      notifyGhostSessionStatusChange(sid, 'active', updated.workingDir);
      return updated;
    },
  );

  ipcMain.handle('local-db:sessions:update', async (_e, id: unknown, patch: unknown) => {
    const sid = requireString(id, 'id');
    const ownerScope = captureOwnerScope();
    const p = requireObject(patch, 'patch');
    const db = getDbClient().drizzle;
    if (p.workspaceKind !== undefined) {
      const value = p.workspaceKind;
      if (value !== 'project' && value !== 'dialogue') {
        throwIpcError('INVALID_PARAMS', `invalid workspaceKind: ${String(value)}`);
      }
    }
    const ALLOWED_UPDATE_ORCA_ROLES = new Set<string>(['lead', 'worker']);
    if (
      p.orcaRole !== undefined &&
      p.orcaRole !== null &&
      !ALLOWED_UPDATE_ORCA_ROLES.has(p.orcaRole as string)
    ) {
      throwIpcError('INVALID_PARAMS', `invalid orcaRole: ${String(p.orcaRole)}`);
    }
    if (typeof p.workingDir === 'string') {
      p.workingDir = normalizeWorkingDirForStorage(p.workingDir) ?? null;
    }
    // 会话移动转录迁移:patch 带 workingDir 时先留存旧值,update 后对比实际变化。
    // CLI 转录按 cwd 转码目录存放,workingDir 变了必须跟着搬,否则 resume 报
    // "No conversation found with session ID"(见 claude-transcript-relocation.ts)。
    const beforeMove =
      p.workingDir !== undefined
        ? (
            await db
              .select({
                workingDir: sessions.workingDir,
                agentKind: sessions.agentKind,
                remoteHostId: sessions.remoteHostId,
              })
              .from(sessions)
              .where(eq(sessions.id, sid))
          )[0]
        : undefined;
    // 只有纯设置字段(model/effort 等)才跳过 bump；凡带 activity 字段
    // (clearedAt / sdkSessionId / status / token 用量等)仍需更新 updatedAt，
    // 否则本地 /clear 后重启侧栏时间回退旧值。
    const SETTINGS_ONLY_FIELDS = new Set([
      'model',
      'effort',
      'permissionMode',
      'fastMode',
      'planModeEnabled',
      'providerId',
      'orcaRole',
      'extraDirs',
      'pinnedAt',
      'workingDir',
      'workspaceKind',
      'title',
    ]);
    const isSettingsOnly = Object.keys(p).every((k) => SETTINGS_ONLY_FIELDS.has(k));
    const setObj = sessionPatchToRow(p as Parameters<typeof sessionPatchToRow>[0], {
      bumpUpdatedAt: !isSettingsOnly,
    });
    // 用户手动改名(重命名框 / 侧边栏)走这条:告诉自动起名收手。同值改名不会让
    // 条件写落空,不显式说一声的话智能标题会把他刚保存的名字盖掉(review P1)。
    // **必须先于 UPDATE**:写库是一次 worker RPC 往返,改名提交与这里拿到回执之间
    // 有真实时间差,在那期间智能标题仍能满足 `WHERE title = 期望值` 把名字盖掉。
    // 先记号后写库,代价只是写库失败时该会话本进程内不再自动起名 —— 用户毕竟确实
    // 按下过保存,这个方向的偏差是安全的。
    if (typeof p.title === 'string') noteUserTitleWritten(sid);
    await db.update(sessions).set(setObj).where(eq(sessions.id, sid));
    // session-git-pr-context:/clear 经此处写 clearedAt——边界之前的消息对用户
    // 不可见,PR 引用同步重算(fire-and-forget,内部按 clearedAt/rewindAt 过滤)。
    if (p.clearedAt !== undefined) {
      noteSessionClearBoundary(sid, p.clearedAt as string | null);
      // sidebar-card-mode(codex review):summary 是基于 clear 前内容生成的,clear 后
      // 已过时;SessionCard / rail flyout 优先用 summary 而非 preview,不清就会继续
      // 显示旧任务摘要。这里一并清空,待 clear 后新一轮 turn-done 重新生成。
      await db.update(sessions).set({ summary: null }).where(eq(sessions.id, sid));
      // 广播 summary:null,让已挂载的 sidebar 立即清掉旧摘要(codex review)——renderer 的
      // clearSession 乐观 patch 只带 sdkSessionId/clearedAt、不含 summary,本 update handler
      // 也不另发 patched;不广播则卡片/rail 会继续显示 clear 前摘要直到一次全量 refresh。
      if (isOwnerScopeCurrent(ownerScope)) {
        broadcastSessionPatched(sid, { summary: null }, ownerScope);
      }
      void recomputePrRefsForSession(sid).catch(() => undefined);
    }
    // workingDir 实际变化的本机 cc 会话:迁移 CLI 转录后再查询返回行/广播,保证
    // renderer 拿到更新结果时转录已就位(用户可立即续聊),且迁移中持久化的最新
    // sdkSessionId 能进返回行与广播 patch——否则 renderer 留着旧 resume id,下一次
    // lazy-create 仍会 resume 到 pre-fork 会话。内部 best-effort 不抛错。
    // 动态 import 避免 localDb → maker-host 的静态模块环(同下方 sessionTaskSummary)。
    if (
      beforeMove &&
      beforeMove.agentKind === 'cc' &&
      !beforeMove.remoteHostId &&
      beforeMove.workingDir &&
      typeof p.workingDir === 'string' &&
      p.workingDir &&
      normalizeWorkingDirForStorage(beforeMove.workingDir) !== p.workingDir
    ) {
      const m = await import('../../maker-host/claude-transcript-relocation.js');
      const reloc = await m.relocateClaudeTranscriptsForSessionMove(
        sid,
        beforeMove.workingDir,
        p.workingDir,
      );
      if (reloc.persistedSdkSessionId) {
        (p as Record<string, unknown>).sdkSessionId = reloc.persistedSdkSessionId;
      }
    }
    const row = await selectSessionWithCount(db, sid);
    if (!row) throwIpcError('NOT_FOUND', 'Session 不存在');
    const updated = sessionToCamel(row);
    const broadcastPatch =
      p.pinnedAt === undefined
        ? p
        : {
            ...p,
            pinnedAt: updated.pinnedAt,
            ...(updated.pinnedAt === null ? {} : { status: updated.status }),
          };
    const projectTargetChanged = p.workspaceKind !== undefined || p.workingDir !== undefined;
    const settingsChanged = Object.keys(p).some((key) => REMOTE_PERSIST_FIELDS.has(key));
    const titleChanged = p.title !== undefined;
    if (
      projectTargetChanged &&
      row.workspaceKind === 'project' &&
      row.workingDir &&
      !row.remoteHostId
    ) {
      await upsertRecentWorkdir(row.workingDir, Date.now());
    }
    if (projectTargetChanged || settingsChanged || titleChanged || p.pinnedAt !== undefined) {
      if (isOwnerScopeCurrent(ownerScope)) {
        broadcastSessionPatched(sid, broadcastPatch, ownerScope);
      }
    }
    // sidebar-card-mode: 会话被置顶那一刻补生成任务摘要(turn-done 路径只覆盖
    // "置顶后又跑过 turn"的会话)。动态 import 避免 localDb → maker-host 的静态
    // 模块环;fire-and-forget,模块内部自带置顶/节流守卫。
    if (p.pinnedAt !== undefined && updated.pinnedAt !== null) {
      void import('../../sessionTaskSummary.js').then((m) =>
        m.maybeGenerateSessionTaskSummary(sid),
      );
    }
    notifyAgentIslandSessionPatch(updated.id, {
      status: updated.status,
      title: updated.title,
      workingDir: updated.workingDir,
      workspaceKind: updated.workspaceKind,
    });
    scheduleWorktreeRecycleForStatusChange(sid, p.status);
    notifyGhostSessionStatusChange(sid, p.status, updated.workingDir);
    removeHookAttachmentDir(sid, p.status);
    return updated;
  });

  // 窄口径会话元数据编辑(status / title / pinnedAt)。专为 device-link 控制端**远程**
  // 删除/归档/重命名/置顶设计:通用 sessions:update 能写任意字段(workingDir/model/
  // sdkSessionId/orcaRole/clearedAt…),故意不进 allowlist;这个 handler 只放行白名单内的
  // 用户可编辑元数据,是「写库必须经业务 handler、不开裸写」原则下的窄能力(规则 9/13)。
  // 仅被隧道(远程操作)调到 —— 本机操作走 sessions:update + renderer 乐观更新。
  ipcMain.handle('local-db:sessions:patch-meta', async (_e, id: unknown, patch: unknown) => {
    const sid = requireString(id, 'id');
    const p = requireObject(patch, 'patch');
    const updated = await patchSessionMetaInDb(
      sid,
      p as Parameters<typeof patchSessionMetaInDb>[1],
    );
    return updated;
  });

  // fork-session: 已迁到 maker-ipc/fork.ts (Stage 2 C2), IPC channel 改名 maker:fork。
  // 业务函数 forkSessionAtMessage 仍在 apps/desktop/src/main/maker-orchestration/fork.ts, 内部 SDK 调用
  // 走 maker-core 的 Maker.forkSdkSession (Codex 自动抛 NotSupportedError)。

  // 单字段 bump：把 user_send_at 设为 now。fire-and-forget，不返回 row。
  // 故意与 sessions:update 解耦——update 会同步刷 updated_at（mapper.ts:165），
  // 那是给"字段类改动"用的；touchUserSend 只标记"对话活跃"，绝不污染 updated_at。
  ipcMain.handle(
    'local-db:sessions:touchUserSend',
    async (_e, id: unknown, atMs: unknown): Promise<void> => {
      const sid = requireString(id, 'id');
      await touchUserSendInDb(sid, typeof atMs === 'number' ? atMs : undefined);
    },
  );
}

export async function patchSessionMetaInDb(
  sessionId: string,
  patch: {
    status?: 'active' | 'archived' | 'deleted';
    title?: string;
    pinnedAt?: string | null;
  },
): Promise<ReturnType<typeof sessionToCamel>> {
  const ownerScope = captureOwnerScope();
  for (const k of Object.keys(patch)) {
    if (!REMOTE_EDITABLE_META.has(k)) {
      throwIpcError('INVALID_PARAMS', `field not allowed in patch-meta: ${k}`);
    }
  }
  if (
    patch.status !== undefined &&
    patch.status !== 'active' &&
    patch.status !== 'archived' &&
    patch.status !== 'deleted'
  ) {
    throwIpcError('INVALID_PARAMS', `invalid status: ${String(patch.status)}`);
  }
  if (patch.title !== undefined && typeof patch.title !== 'string') {
    throwIpcError('INVALID_PARAMS', 'title must be a string');
  }

  const db = getDbClient().drizzle;
  const setObj = sessionPatchToRow(patch, { bumpUpdatedAt: false });
  // 控制端远程改名走这条,与本机改名同口径(同样先记号后写库)。
  if (patch.title !== undefined) noteUserTitleWritten(sessionId);
  await db.update(sessions).set(setObj).where(eq(sessions.id, sessionId));
  const row = await selectSessionWithCount(db, sessionId);
  if (!row) throwIpcError('NOT_FOUND', 'Session 不存在');
  const updated = sessionToCamel(row);
  notifyAgentIslandSessionPatch(updated.id, {
    status: updated.status,
    title: updated.title,
    workingDir: updated.workingDir,
    workspaceKind: updated.workspaceKind,
  });
  if (patch.status === 'deleted') {
    void imageCacheStore.removeSession(sessionId).catch((err) => {
      log.warn('remote session image cleanup failed', {
        sessionId,
        err: err instanceof Error ? err.message : String(err),
      });
    });
    // 媒体总仓对应清理:删本会话名下的媒体引用行(附件/导入/
    // 消息出生引用;画廊等持久引用不动),引用归零的 blob 交回收器。
    // fire-and-forget 与历史目录清理同语义:失败只警告,不阻塞删除。
    void removeSessionMediaRefs(sessionId)
      .then((n) => {
        if (n > 0) log.info('session media refs removed', { sessionId, count: n });
      })
      .catch((err) => {
        log.warn('session media ref cleanup failed', {
          sessionId,
          err: err instanceof Error ? err.message : String(err),
        });
      });
    void removeWechatSessionAttachmentDir(sessionId).catch((err) => {
      log.warn('WeChat session attachment cleanup failed', {
        sessionId,
        err: err instanceof Error ? err.message : String(err),
      });
    });
    void listDeletableSessionPersistedChatAttachmentPaths(sessionId)
      .then((filePaths) => cleanupStagedChatAttachments(filePaths))
      .catch((err) => {
        log.warn('staged chat attachment cleanup failed', {
          sessionId,
          err: err instanceof Error ? err.message : String(err),
        });
      });
  }
  removeHookAttachmentDir(sessionId, patch.status);
  scheduleWorktreeRecycleForStatusChange(sessionId, patch.status);
  notifyGhostSessionStatusChange(sessionId, patch.status, updated.workingDir);
  // 远程 / MCP 改动绕过 renderer 乐观更新,故主动广播 sessions:patched:
  //   - sessionsStore.onPatched → patchLocal,即时反映到 sidebar(删/归档移出 active 桶、改名/置顶刷新);
  //   - CCAgentSessionView.onPatched → 合并进 serverSession。
  // 经 tap 转发:订阅了该被控端 `sessions` topic 的控制端也即时收到这条 patched(push 驱动镜像)。
  if (isOwnerScopeCurrent(ownerScope)) broadcastSessionPatched(sessionId, patch, ownerScope);
  return updated;
}

export interface RenameSessionMetaChange {
  sessionId: string;
  title: string;
  expectedCurrentTitle?: string;
  expectedUpdatedAt?: string;
}

export interface RenameSessionMetaItem {
  sessionId: string;
  currentTitle: string | null;
  newTitle: string;
  workingDir: string | null;
  updatedAt: string;
}

export async function renameSessionTitlesInDb(
  changes: RenameSessionMetaChange[],
  dryRun: boolean,
): Promise<RenameSessionMetaItem[]> {
  if (changes.length === 0) return [];
  const ownerScope = captureOwnerScope();

  const db = getDbClient().drizzle;
  const ids = changes.map((change) => change.sessionId);
  const rows = await db
    .select({
      id: sessions.id,
      title: sessions.title,
      workingDir: sessions.workingDir,
      updatedAt: sessions.updatedAt,
    })
    .from(sessions)
    .where(inArray(sessions.id, ids));
  const rowById = new Map(rows.map((row) => [row.id, row]));

  const preview: RenameSessionMetaItem[] = [];
  for (const change of changes) {
    const row = rowById.get(change.sessionId);
    if (!row) {
      throwIpcError('NOT_FOUND', `Session 不存在: ${change.sessionId}`);
    }

    const updatedAt = new Date(row.updatedAt).toISOString();
    if (change.expectedCurrentTitle !== undefined && row.title !== change.expectedCurrentTitle) {
      throwIpcError('PRECONDITION_FAILED', `Session 标题已变化: ${change.sessionId}`);
    }
    if (change.expectedUpdatedAt !== undefined && updatedAt !== change.expectedUpdatedAt) {
      throwIpcError('PRECONDITION_FAILED', `Session updatedAt 已变化: ${change.sessionId}`);
    }

    preview.push({
      sessionId: change.sessionId,
      currentTitle: row.title,
      newTitle: change.title,
      workingDir: row.workingDir,
      updatedAt,
    });
  }

  if (dryRun) return preview;

  // 批量改名(MCP 工具)同样是"人给的名字",自动起名不得再覆盖;与上面两条出口
  // 一样先记号后写库,不给并发的智能标题留窗口。
  for (const change of changes) noteUserTitleWritten(change.sessionId);
  const applied = await getDbClient()
    .tx('sessions.renameTitles', { changes })
    .catch((err) => {
      const code = (err as { code?: string }).code;
      const message = err instanceof Error ? err.message : String(err);
      if (code === 'NOT_FOUND' || code === 'PRECONDITION_FAILED' || code === 'INVALID_PARAMS') {
        throwIpcError(code, message);
      }
      throw err;
    });

  if (!isOwnerScopeCurrent(ownerScope)) return applied;
  for (const item of applied) {
    notifyAgentIslandSessionPatch(item.sessionId, {
      title: item.newTitle,
      workingDir: item.workingDir,
    });
    broadcastSessionPatched(item.sessionId, { title: item.newTitle }, ownerScope);
  }
  return applied;
}

export interface SessionStatusChangeRow {
  sessionId: string;
  title: string | null;
  workingDir: string | null;
  status: 'active' | 'archived';
}

/**
 * 批量归档 / 取消归档:把一组 session 的 status 置为 archived / active。
 *
 * 供 MCP 工具(archive_sessions / unarchive_sessions)调用,让 agent 能批量整理历史会话。
 *  - 原子写入:存在性预检 + 状态更新在 `sessions.setStatus` 事务里一把完成,任一 id 缺失
 *    整批回滚(全有才写,绝不半应用 —— 这点比逐个 patchSessionMetaInDb 更强)。
 *  - 事务提交成功后,再逐个 notifyAgentIslandSessionPatch + 广播 sessions:patched,与
 *    device-link 远程归档(patchSessionMetaInDb)同口径,sidebar / agent-island 即时收敛
 *    (归档移出 active 桶),无需刷新或重启。
 */
export async function setSessionsStatusInDb(
  sessionIds: string[],
  status: 'active' | 'archived',
): Promise<SessionStatusChangeRow[]> {
  if (sessionIds.length === 0) return [];
  const ownerScope = captureOwnerScope();
  const applied = await getDbClient()
    .tx('sessions.setStatus', { sessionIds, status })
    .catch((err) => {
      const code = (err as { code?: string }).code;
      const message = err instanceof Error ? err.message : String(err);
      if (code === 'NOT_FOUND' || code === 'INVALID_PARAMS') {
        throwIpcError(code, message);
      }
      throw err;
    });
  if (!isOwnerScopeCurrent(ownerScope))
    return applied.map((item) => ({
      sessionId: item.sessionId,
      title: item.title,
      workingDir: item.workingDir,
      status: item.status,
    }));
  for (const item of applied) {
    notifyAgentIslandSessionPatch(item.sessionId, {
      status: item.status,
      title: item.title,
      workingDir: item.workingDir,
      workspaceKind: item.workspaceKind,
    });
    broadcastSessionPatched(item.sessionId, { status: item.status }, ownerScope);
    scheduleWorktreeRecycleForStatusChange(item.sessionId, item.status);
    notifyGhostSessionStatusChange(item.sessionId, item.status, item.workingDir);
    removeHookAttachmentDir(item.sessionId, item.status);
  }
  return applied.map((item) => ({
    sessionId: item.sessionId,
    title: item.title,
    workingDir: item.workingDir,
    status: item.status,
  }));
}

/**
 * hook 入站附件目录回收(fire-and-forget): deleted/archived 都是终态,
 * 文件在 turn 送出后即无用。所有把 session 置为终态的路径都应调用。
 */
function removeHookAttachmentDir(sessionId: string, status: unknown): void {
  if (status !== 'deleted' && status !== 'archived') return;
  const attachRoot = path.join(app.getPath('userData'), 'hook-attachments');
  const attachDir = path.join(attachRoot, sessionId);
  if (!attachDir.startsWith(attachRoot + path.sep)) return;
  void fs.rm(attachDir, { recursive: true, force: true }).catch((err) => {
    log.warn('hook attachment dir cleanup failed', {
      sessionId,
      err: err instanceof Error ? err.message : String(err),
    });
  });
}

/** {@link selectSessionListRows} 的行形状——与 sessionToCamel 的入参对齐。 */
interface SessionListRow {
  session: typeof sessions.$inferSelect;
  messageCount: number;
  latestMessageContent: string | null;
  latestMessageRole: string | null;
}

/**
 * sessions:list 的行查询——**两段式**：CTE 先按排序取够 `cap` 个 id，主查询只对这批行算
 * messageCount 与 preview。
 *
 * 为什么不能沿用一段式的 `LEFT JOIN messages + GROUP BY`：那个形状下 `LIMIT` 在 GROUP BY
 * **之后**才生效，于是每个候选会话的全部消息都要参与聚合，成本与"最终只要 1000 行"无关。
 * 4.7GB / 111 万条消息的真实库上，把聚合面从 1743 个会话收窄到 1000 个，热缓存 104ms →
 * 54ms。会话越多、limit 占比越小，收益越大。
 *
 * 用单条 CTE 而不是"先查 id 再 IN (...)"两次往返，有两个理由：
 *   1. 一致性——两次查询之间会话可能被删/改状态，第二段就会比第一段少行，列表凭空少一条。
 *      CTE 是单条语句、单一致性快照。
 *   2. 参数——`IN (...)` 要绑 cap 个参数（当前 MAX_LIMIT=1000），CTE 只绑一个 limit。
 *
 * messageCount 在这里是**标量子查询**里的 `count(*)`，与一段式的 `count(MESSAGE_COUNT_COL)`
 * 语义一致：无匹配行时聚合返回 0，不存在 LEFT JOIN 那个"空会话数出 1"的坑（那也是为什么
 * 一段式不能图快改用 `count(*)`）。它同样只扫 idx_messages_session_created，不回表。
 *
 * @param where 行过滤条件，同时作用于 CTE 与主查询（CTE 决定取哪些、主查询决定算哪些）。
 * @param cap   取前 N 行；`null` = 不限（置顶补齐分支用，pinned 行数天然很少）。
 */
function selectSessionListRows(
  db: DbClient['drizzle'],
  where: SQL | undefined,
  cap: number | null,
): Promise<SessionListRow[]> {
  const pickedBase = db.select({ id: sessions.id }).from(sessions).where(where);
  const picked = db
    .$with('picked')
    .as(
      cap === null
        ? pickedBase.orderBy(desc(sessions.updatedAt))
        : pickedBase.orderBy(desc(sessions.updatedAt)).limit(cap),
    );
  return db
    .with(picked)
    .select({
      session: sessions,
      messageCount: SESSION_MESSAGE_COUNT_SQL,
      latestMessageContent: LATEST_MSG_CONTENT_SQL,
      latestMessageRole: LATEST_MSG_ROLE_SQL,
    })
    .from(sessions)
    .innerJoin(picked, eq(picked.id, sessions.id))
    .where(where)
    .orderBy(desc(sessions.updatedAt));
}

/** 单行 SELECT + messages count：LEFT JOIN + GROUP BY 保证 0 条消息时 count 为 0。
 *  preview 子查询同步带出——get/update 路径返回的 Session 会整体替换 store 里的行，
 *  缺字段会把列表查询带回的 preview 冲掉。
 *  count 目标列同 list 路径走 {@link MESSAGE_COUNT_COL}：这里虽只数一个会话，但消息多的
 *  会话回表一样要读几万行主表，而 get/update 在每次改标题、切模型后都会跑。 */
async function selectSessionWithCount(
  db: DbClient['drizzle'],
  id: string,
): Promise<SessionRowWithCount | undefined> {
  const [r] = await db
    .select({
      session: sessions,
      messageCount: count(MESSAGE_COUNT_COL),
      latestMessageContent: LATEST_MSG_CONTENT_SQL,
      latestMessageRole: LATEST_MSG_ROLE_SQL,
    })
    .from(sessions)
    .leftJoin(messages, eq(messages.sessionId, sessions.id))
    .where(eq(sessions.id, id))
    .groupBy(sessions.id)
    .limit(1);
  if (!r) return undefined;
  return {
    ...r.session,
    messageCount: r.messageCount,
    latestMessageContent: r.latestMessageContent,
    latestMessageRole: r.latestMessageRole,
  };
}

function clampLimit(raw: unknown, fallback: number): number {
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.max(Math.floor(n), 1), MAX_LIMIT);
}

function shouldIncludePinnedSessions(options: unknown): boolean {
  return !!(
    options &&
    typeof options === 'object' &&
    (options as { includePinned?: unknown }).includePinned === true
  );
}

function mergeSessionListRows<T extends { session: { id: string } }>(
  recentRows: readonly T[],
  pinnedRows: readonly T[],
): T[] {
  const seen = new Set<string>();
  const merged: T[] = [];
  for (const row of recentRows) {
    seen.add(row.session.id);
    merged.push(row);
  }
  for (const row of pinnedRows) {
    if (seen.has(row.session.id)) continue;
    seen.add(row.session.id);
    merged.push(row);
  }
  return merged;
}

/**
 * worktree-parallel-sessions: 把 sessions.worktree_path 同步到 DB（反范式快照）。
 * source of truth 是 worktreeStore（electron-store）；DB 字段仅为 sidebar 渲染优化。
 *
 * 故意不通过 sessions:update IPC 暴露——renderer 不应也不能直接改这个字段。
 * 仅由 main 侧 worktreeStore.set/delete 内部调用；worktreeStore.delete 不调本函数
 * （保留历史值，徽标按 store 是否存在判定）。
 *
 * 失败仅日志告警，不抛——store 是 source of truth，DB 只是快照，落败不阻塞主流程。
 */
export async function setWorktreePathInDb(
  sessionId: string,
  worktreePath: string | null,
): Promise<void> {
  try {
    const db = getDbClient().drizzle;
    await db.update(sessions).set({ worktreePath }).where(eq(sessions.id, sessionId));
  } catch (err) {
    log.warn(
      `[localDb] setWorktreePathInDb failed for ${sessionId}:`,
      err instanceof Error ? err.message : String(err),
    );
  }
}

/**
 * 无人值守建会话(hook 等)把显式选定的来源(供应商)落 sessions.provider_id。
 *
 * 背景: DesktopSessionStorage.create() 的 INSERT 字段清单不含 provider_id
 * (SessionMeta 接口没有 provider 字段, 该列由 SET_MODEL 回流 / 各无人值守
 * 入口自行补写), 不补的话会话来源恒为 NULL —— 聊天里打开时来源 picker 显示
 * 默认来源、冷 resume 时 register 的 hydrate funnel 读不到用户设置的来源。
 * 与 scheduler 的 backfillSessionMeta({providerId}) 同语义, 但只动这一列,
 * 不碰 hook v1 刻意保留默认值的 permission_mode / source; updatedAt 也不
 * bump(时间轴推进由同流程的 touchUserSendInDb 负责)。
 *
 * 失败仅日志告警, 不抛 —— 运行时路由以 session-provider-store 为准, DB 是
 * 持久化快照, 落败不阻塞 turn 主流程。
 */
export async function setSessionProviderIdInDb(
  sessionId: string,
  providerId: string,
): Promise<void> {
  try {
    const db = getDbClient().drizzle;
    await db.update(sessions).set({ providerId }).where(eq(sessions.id, sessionId));
  } catch (err) {
    log.warn(
      `[localDb] setSessionProviderIdInDb failed for ${sessionId}:`,
      err instanceof Error ? err.message : String(err),
    );
  }
}

/** Persist the provider-facing source for a newly-created shared IM session. */
export async function setSessionSourceInDb(
  sessionId: string,
  source: 'telegram' | 'x',
): Promise<void> {
  try {
    const db = getDbClient().drizzle;
    await db.update(sessions).set({ source }).where(eq(sessions.id, sessionId));
  } catch (err) {
    log.warn(
      `[localDb] setSessionSourceInDb failed for ${sessionId}:`,
      err instanceof Error ? err.message : String(err),
    );
  }
}
