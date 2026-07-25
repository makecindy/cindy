/**
 * main/im/shared/sessionRepo.ts
 * ---------------------------------------------------------------------------
 * IM 渠道的 sessions DB 层(渠道无关)。`sessions` 表与 desktop UI 会话共用
 * (见 localDb/schema.ts);按确定性 session id 查找/创建属于 (botContextId,
 * userId) 的会话行。渠道差异(id 格式 / source 列值 / 默认 title / workingDir
 * 策略 / 渠道专属列)收敛在 ImSessionNamespace, 由 adapter 注入。
 *
 * Manual INSERT (不走 maker 的 DesktopSessionStorage.create) — 为了预填渠道
 * 专属列。Maker 的 `createSession({ id })` 经 storage.get() 看到行已存在,
 * 只附加 SDK handle。
 */

import { eq } from 'drizzle-orm';
import type { AgentKind, Effort, PermissionMode } from '@cindy/maker-core';
import type { ProviderView } from '@cindy/model-providers';
import { permissionModeOrAsk } from '@cindy/maker-shared/permission-mode';

import { getDbClient } from '../../localDb/client/current';
import { sessions } from '../../localDb/schema';
import { createLogger, maskPath } from '../../logger';
import { setSessionProvider } from '../../maker-host/session-provider-store';
import {
  getImDefaultEffortFor,
  resolveImSessionDefaults,
  type ResolvedImSessionDefaults,
} from '../defaultSessionSettings';
import { broadcastSessionCreated } from './sessionBroadcast';
import type { ImOrchestratorConfig, ImSessionNamespace } from './types';

const log = createLogger('im:repo');

export function toCoreAgentKind(kind: string): AgentKind {
  return kind === 'codex' ? 'codex' : 'claude-code';
}

/** core AgentKind → sessions.agentKind 列的 legacy 存储值。 */
function toDbAgentKind(kind: AgentKind): string {
  return kind === 'codex' ? 'codex' : 'cc';
}

export interface ImSessionRow {
  id: string;
  agentKind: AgentKind;
  workingDir: string;
  model: string;
  /** Latest persisted effort (may be changed by user via /model card later). */
  effort: Effort;
  /** Latest persisted permission mode. */
  permissionMode: PermissionMode;
  fastMode: boolean;
  sdkSessionId: string | null;
  /**
   * 该会话显式选定的供应商 id(路由用,null = 跟随默认路由)。/model 卡片选行时一并持久化,
   * IM turn 启动前 hydrate 进 session-provider-store,保证按选中供应商路由。
   */
  providerId: string | null;
}

export interface SessionModelRouteSnapshot {
  model: string;
  effort: Effort;
  providerId: string | null;
}

/** 渠道维度的 session 查找/创建仓库 — per adapter 一个实例。 */
export interface ImSessionRepo {
  sessionIdFor(botContextId: string, userId: string, scopeKey?: string): string;
  findActiveSession(
    botContextId: string,
    userId: string,
    scopeKey?: string,
  ): Promise<ImSessionRow | null>;
  prepareNewSession(
    botContextId: string,
    userId: string,
    scopeKey?: string,
    providerSnapshot?: ProviderView[] | null,
  ): Promise<ImSessionRow>;
  createSession(
    botContextId: string,
    userId: string,
    scopeKey?: string,
    prepared?: ImSessionRow,
  ): Promise<ImSessionRow>;
  /**
   * 该渠道语境下 model 的默认 effort:
   *   1. config.effortOverrides[modelId] — IM 产品决策
   *   2. ModelDescriptor.defaultEffort — agent 自身推荐
   *   3. 'high' — DB NOT NULL 兜底(到这说明上游有 bug)
   */
  getDefaultEffortFor(modelId: string, agentKind?: AgentKind): Effort;
}

export function createImSessionRepo(
  config: ImOrchestratorConfig,
  ns: ImSessionNamespace,
): ImSessionRepo {
  function defaultEffortFor(modelId: string, agentKind: AgentKind = config.agentKind): Effort {
    return getImDefaultEffortFor(agentKind, modelId, config.effortOverrides);
  }

  return {
    sessionIdFor: (botContextId, userId, scopeKey) =>
      ns.sessionIdFor(botContextId, userId, scopeKey),
    getDefaultEffortFor: defaultEffortFor,

    /**
     * 查 (botContextId, userId) 的会话行。无行返回 null(caller 用同 id 新建)。
     *
     * 行存在但已 archived/deleted 时原地复活(status 翻回 active)并照常返回:
     * 确定性 id 意味着该行是这对身份的唯一通道行,桌面端归档/删除只是软删
     * (行仍在库里),用户从 IM 侧继续发消息应恢复对话——保留 sdkSessionId
     * (上下文)与模型/权限等全部设置。若把软删行当"不存在"返回 null,caller
     * 会用同 id INSERT 撞 UNIQUE(sessions.id),IM 消息从此全部报错(#748)。
     */
    async findActiveSession(botContextId, userId, scopeKey) {
      const id = ns.sessionIdFor(botContextId, userId, scopeKey);
      const db = getDbClient().drizzle;
      const rows = await db.select().from(sessions).where(eq(sessions.id, id)).limit(1);
      const row = rows[0];
      if (!row) return null;
      if (row.status !== 'active') {
        // 复活由用户 IM 消息触发,一并 bump userSendAt:广播 created 后 renderer
        // 立即重拉,而稍后 turnRunner 的 touchUserSent 不再广播 patched,不在这里
        // 写的话 sidebar 会按旧活跃时间排序/分组,直到下次整页刷新。
        const now = Date.now();
        await db
          .update(sessions)
          .set({
            status: 'active',
            userSendAt: now,
            updatedAt: now,
            // 渠道声明了归属分组时顺手校正(老行可能还是默认 'project')
            ...(ns.workspaceKind ? { workspaceKind: ns.workspaceKind } : {}),
          })
          .where(eq(sessions.id, id));
        log.info(`revived soft-deleted ${ns.source} session id=${row.id} (was ${row.status})`);
        // 软删行已从 sidebar 消失,patched 增量对不存在的行无效;
        // created 触发 renderer 重拉列表,让会话重新出现。
        broadcastSessionCreated(row.id);
      }
      return {
        id: row.id,
        agentKind: toCoreAgentKind(row.agentKind),
        workingDir: row.workingDir ?? ns.ensureWorkingDir(botContextId),
        model: row.model,
        effort: row.effort,
        permissionMode: row.permissionMode,
        fastMode: row.fastMode,
        sdkSessionId: row.sdkSessionId,
        providerId: row.providerId ?? null,
      };
    },

    async prepareNewSession(botContextId, userId, scopeKey, providerSnapshot) {
      const id = ns.sessionIdFor(botContextId, userId, scopeKey);
      const workingDir = ns.ensureWorkingDir(botContextId);
      return rowFromDefaults(
        id,
        workingDir,
        await resolveImSessionDefaults(config, providerSnapshot, ns.source),
      );
    },

    /**
     * 用确定性 id 新建会话行。caller 随后 `maker.createSession({ id })` —
     * Maker 复用已有行(SDK 分配 sdkSessionId 后回写)。
     *
     * upsert 兜竞态:findActiveSession 与本 insert 之间行可能被并发建出
     * (同用户连发两条首消息)或被桌面端软删。冲突时只把 status 翻回 active
     * 并刷渠道列,不碰 sdkSessionId / 模型 / 权限等列——残留行的对话上下文
     * 与设置原样保留,绝不让 UNIQUE(sessions.id) 冒泡成用户可见报错(#748)。
     */
    async createSession(botContextId, userId, scopeKey, prepared) {
      const db = getDbClient().drizzle;
      const row = prepared ?? (await this.prepareNewSession(botContextId, userId, scopeKey));
      const now = Date.now();
      await db
        .insert(sessions)
        .values({
          id: row.id,
          title: ns.defaultTitle(userId),
          ...(ns.workspaceKind ? { workspaceKind: ns.workspaceKind } : {}),
          workingDir: row.workingDir,
          model: row.model,
          effort: row.effort,
          permissionMode: row.permissionMode,
          fastMode: row.fastMode,
          status: 'active',
          agentKind: toDbAgentKind(row.agentKind),
          providerId: row.providerId,
          source: ns.source,
          ...ns.extraInsertColumns(botContextId, userId),
          createdAt: now,
          updatedAt: now,
          // IM 会话由用户消息触发创建,插入时即设 userSendAt,
          // 避免广播后 renderer 重拉到 userSendAt=null 的行被误判为草稿。
          userSendAt: now,
        })
        .onConflictDoUpdate({
          target: sessions.id,
          set: {
            status: 'active',
            source: ns.source,
            ...(ns.workspaceKind ? { workspaceKind: ns.workspaceKind } : {}),
            ...ns.extraInsertColumns(botContextId, userId),
            updatedAt: now,
            userSendAt: now,
          },
        });
      // upsert 可能走冲突分支(残留行的 sdkSessionId / 模型 / 权限被刻意保留),
      // 返回值必须以 DB 持久化结果为准——直接返回 prepared 默认值会让 turn 拿
      // sdkSessionId=null 新开对话,而 DB 里旧上下文仍标记 active,两边失配。
      const persistedRows = await db
        .select()
        .from(sessions)
        .where(eq(sessions.id, row.id))
        .limit(1);
      const persisted = persistedRows[0];
      const result: ImSessionRow = persisted
        ? {
            id: persisted.id,
            agentKind: toCoreAgentKind(persisted.agentKind),
            workingDir: persisted.workingDir ?? row.workingDir,
            model: persisted.model,
            effort: persisted.effort,
            permissionMode: persisted.permissionMode,
            fastMode: persisted.fastMode,
            sdkSessionId: persisted.sdkSessionId,
            providerId: persisted.providerId ?? null,
          }
        : row;
      log.info(
        `created ${ns.source} session id=${result.id} workingDir=${maskPath(result.workingDir)} ` +
          `agent=${result.agentKind} model=${result.model} effort=${result.effort} ` +
          `provider=${result.providerId ?? 'default'} permissionMode=${result.permissionMode}`,
      );
      // 通知 renderer sidebar / device-link 控制端有新会话行,否则要手动刷新才出现
      broadcastSessionCreated(result.id);
      return result;
    },
  };
}

function rowFromDefaults(
  id: string,
  workingDir: string,
  defaults: ResolvedImSessionDefaults,
): ImSessionRow {
  return {
    id,
    agentKind: defaults.agentKind,
    workingDir,
    model: defaults.model,
    effort: defaults.effort,
    permissionMode: defaults.permissionMode,
    fastMode: defaults.fastMode,
    sdkSessionId: null,
    providerId: defaults.providerId,
  };
}

// ── sessionId 维度的更新操作(渠道无关, 无需工厂) ─────────────────────────────

/** Bump userSendAt so sidebar (if ever surfaced) sorts IM sessions correctly. */
export async function touchUserSent(sessionId: string): Promise<void> {
  const db = getDbClient().drizzle;
  const now = Date.now();
  await db
    .update(sessions)
    .set({ userSendAt: now, updatedAt: now })
    .where(eq(sessions.id, sessionId));
}

/**
 * `/new` semantic: clear the conversation context but keep the session row.
 *
 * Implementation: null out `sdkSessionId` so the next `maker.createSession`
 * for this id starts a fresh SDK conversation thread (no resume). Caller is
 * responsible for disposing the in-process maker session (so the stale
 * conversation isn't reused) and removing it from sessionStates.
 */
export async function clearContext(sessionId: string): Promise<void> {
  const db = getDbClient().drizzle;
  await db
    .update(sessions)
    .set({ sdkSessionId: null, clearedAt: Date.now(), updatedAt: Date.now() })
    .where(eq(sessions.id, sessionId));
}

/**
 * `/new` 语义:保留同一个 IM 会话行,但按当前渠道的 IM 默认重新开始一条新对话。
 *
 * 这会同时重置 agent/model/effort/provider/permission/fast 和 sdkSessionId。也就是说
 * 用户把飞书默认从 Claude Code 改成 Codex 后,在飞书里执行 `/new` 会按 Codex 开始，
 * 不影响 Discord 的下一条新会话。
 */
export async function resetSessionToDefaults(
  sessionId: string,
  config: ImOrchestratorConfig,
  prepared?: ImSessionRow,
  channel?: ImSessionNamespace['source'],
): Promise<void> {
  const defaults =
    prepared ??
    rowFromDefaults(sessionId, '', await resolveImSessionDefaults(config, undefined, channel));
  const db = getDbClient().drizzle;
  await db
    .update(sessions)
    .set({
      agentKind: toDbAgentKind(defaults.agentKind),
      model: defaults.model,
      effort: defaults.effort,
      providerId: defaults.providerId,
      permissionMode: defaults.permissionMode,
      fastMode: defaults.fastMode,
      sdkSessionId: null,
      clearedAt: Date.now(),
      updatedAt: Date.now(),
    })
    .where(eq(sessions.id, sessionId));
  setSessionProvider(sessionId, defaults.providerId);
}

/** 读取 `/model` 修改前的持久化路由快照，用于失败时恢复运行态。 */
export async function readModelRouteSnapshot(
  sessionId: string,
): Promise<SessionModelRouteSnapshot | null> {
  const db = getDbClient().drizzle;
  const rows = await db
    .select({
      model: sessions.model,
      effort: sessions.effort,
      providerId: sessions.providerId,
    })
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return {
    model: row.model,
    effort: row.effort as Effort,
    providerId: row.providerId ?? null,
  };
}

/**
 * Update model/effort columns (for /model picker)。
 *
 * `providerId` 可选,语义对齐 renderer 的 SET_MODEL 路径:
 *   - undefined → 不动 providerId 列(老调用兼容);
 *   - string    → 显式选定该供应商(路由按它走);
 *   - null      → 清除显式选择,回落默认路由。
 * 显式传入(含 null)时一并写列,使 IM 选模型与应用内一样能锁定路由源、跨重启 hydrate 仍生效。
 */
export async function updateModelEffort(
  sessionId: string,
  model: string,
  effort: Effort,
  providerId?: string | null,
): Promise<void> {
  const db = getDbClient().drizzle;
  await db
    .update(sessions)
    .set({
      model,
      effort,
      ...(providerId !== undefined ? { providerId } : {}),
      updatedAt: Date.now(),
    })
    .where(eq(sessions.id, sessionId));
}

/** Update permissionMode column (for /permission picker). */
export async function updatePermissionMode(sessionId: string, mode: PermissionMode): Promise<void> {
  const db = getDbClient().drizzle;
  await db
    .update(sessions)
    .set({ permissionMode: mode, updatedAt: Date.now() })
    .where(eq(sessions.id, sessionId));
}

/** 读取 /permission 切换前的持久化权限；非法历史值按 ask 处理。 */
export async function readPermissionMode(sessionId: string): Promise<PermissionMode | null> {
  const db = getDbClient().drizzle;
  const rows = await db
    .select({ permissionMode: sessions.permissionMode })
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .limit(1);
  return rows[0] ? permissionModeOrAsk(rows[0].permissionMode) : null;
}
