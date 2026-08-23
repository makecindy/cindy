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

import { eq, sql } from 'drizzle-orm';
import type { AgentKind, Effort, PermissionMode } from '@cindy/maker-core';
import type { ProviderView } from '@cindy/model-providers';
import { permissionModeOrAsk } from '@cindy/maker-shared/permission-mode';

import { getDbClient } from '../../localDb/client/current';
import { normalizeDbAgentKind } from '../../../shared/agentKindConversion';
import { sessions } from '../../localDb/schema';
import { withSessionRouteLock } from '../../localDb/sessionRouteLock';
import { retireDeletedPiSubagentState } from '../../localDb/ipc/piSubagentDeletion';
import { createLogger, maskPath } from '../../logger';
import { setSessionProvider } from '../../maker-host/session-provider-store';
import {
  getImDefaultEffortFor,
  resolveImSessionDefaults,
  type ResolvedImSessionDefaults,
} from '../defaultSessionSettings';
import { broadcastSessionCreated, broadcastSessionPatched } from './sessionBroadcast';
import type { ImOrchestratorConfig, ImSessionNamespace } from './types';

const log = createLogger('im:repo');

export function toCoreAgentKind(kind: string): AgentKind {
  return kind === 'codex' || kind === 'pi' ? kind : 'claude-code';
}

/** core AgentKind → sessions.agentKind 列的 legacy 存储值。 */
function toDbAgentKind(kind: AgentKind): string {
  return normalizeDbAgentKind(kind);
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
  /**
   * 该会话的归属分组。`dialogue` = 托管目录里的临时对话, 它的目录末段是内部
   * 名字(UUID / `telegram-<botId>`), **不是项目名**。
   *
   * schema 里 workspaceKind 与路径是解耦的 —— 只比对目录等于不等于渠道托管目录
   * 判不出来(接管一条 desktop 的 dialogue 会话时路径根本不是渠道自己那条)。
   * 只读路径按需带出, 建会话路径不填(那时归属由 ns.workspaceKind 决定)。
   */
  workspaceKind?: 'project' | 'dialogue' | null;
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
  /**
   * 纯只读地看一眼这对身份的通道行 —— **不创建、不复活、不广播**。
   *
   * findActiveSession 会把软删行翻回 active 并广播 created(用户从 IM 侧继续
   * 发消息就该恢复对话)。那对「发消息」是对的, 对只读查询就是副作用: 问一句
   * 「我现在什么配置」不该把用户已删的会话拉回列表。
   *
   * 软删行照样返回它的配置 —— 用户下次发消息复活的正是这一行、沿用的正是这份
   * 设置, 报默认值反而误导。
   */
  peekSession(botContextId: string, userId: string, scopeKey?: string): Promise<ImSessionRow | null>;
  /**
   * 按 session id 只读一行 —— `/ctr` 接管期间要读的是**被接管的 desktop 会话**,
   * 它的 id 不由 `sessionIdFor` 推得出来。同样不创建、不复活、不广播。
   *
   * `workingDir` 为空视为无效(binding 指向的行已被删/数据异常), 返回 null 让
   * 调用方回落到渠道自身的会话 —— 与 turnRunner 命中无效 binding 时的落点一致。
   */
  peekSessionById(sessionId: string): Promise<ImSessionRow | null>;
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
  /**
   * 该渠道是否开着 `/project`(见 ImChannelAdapter.projectSwitching)。
   *
   * 只有开着它的渠道, 「会话目录不等于渠道托管目录」才等价于「用户把它切进了项目」。
   * 没开的渠道(微信等)只有一个托管目录, 而那个目录**可以被用户在设置页改掉** ——
   * 已有会话按产品契约保留旧目录直到 `/new`, 于是新旧目录不等, 按路径推断会把一条
   * 合法的对话会话误判成项目。这些渠道一律相信列里存的归属。
   */
  options: { projectSwitching?: boolean } = {},
): ImSessionRepo {
  const pathImpliesProject = options.projectSwitching === true;
  function defaultEffortFor(modelId: string, agentKind: AgentKind = config.agentKind): Effort {
    return getImDefaultEffortFor(agentKind, modelId, config.effortOverrides);
  }

  /**
   * 复活 / upsert 冲突分支里给 `workspaceKind` 用的 SET 片段。
   *
   * 渠道声明的归属分组只能校正**还留在渠道托管目录里**的行 —— 那种行的
   * 'project' 是老版本留下的默认值, 刷成渠道真实归属是对的。但 `/project`
   * 已经把行切到项目目录时, 'project' 是用户的显式选择: 归档后被新消息复活
   * 就一并刷回 'dialogue' 的话, 会话会跳出 sidebar 的项目分组, 而 workingDir
   * 仍指着那个项目 —— 两个 bot 的 `/project`、`/settings` 从此把真项目报成
   * 「对话」, sidebar 的归组也跟着说谎。
   *
   * 判据写进同一条 UPDATE 的 CASE 里, 不做「先读再改写」: 并发下读到的旧值
   * 会盖掉另一路刚写的新值。
   */
  function correctedWorkspaceKind(botContextId: string): Record<string, unknown> {
    if (!ns.workspaceKind) return {};
    // 不开 `/project` 的渠道: 会话只可能待在渠道自己的托管目录里, 归属就是渠道声明
    // 的那个, 与路径无关。**不能**按路径判 —— 微信的托管目录是用户可改的, 改完之后
    // 已有会话仍保留旧目录, 新旧不等会把合法的对话会话判成项目。
    if (!pathImpliesProject) return { workspaceKind: ns.workspaceKind };
    const managedDir = ns.ensureWorkingDir(botContextId);
    // else 分支写死 'project' 而不是"保留现值": 库里躺着一批老版本刷坏的行
    // (dialogue + 项目目录), 保留现值救不了它们, 那些会话会永远留在错的分组里。
    // 目录不等于托管目录 ⟺ 它是项目 —— 见 readWorkspaceKind 的说明。
    return {
      workspaceKind: sql`case when ${sessions.workingDir} is null or ${sessions.workingDir} = ${managedDir} then ${ns.workspaceKind} else 'project' end`,
    };
  }

  /**
   * 只读路径上的归属判据 —— 不看列里存着什么, 按目录现算。
   *
   * 存量脏行的自愈: 老版本的复活 / upsert 会把 `/project` 选中的 'project' 无条件
   * 刷回渠道默认的 'dialogue', 而 workingDir 还留在项目里。库里因此躺着一批
   * 「dialogue + 项目目录」的行 —— 只保护未来的复活救不了它们, 用户看到的仍是
   * 「对话」, 而且只要不再归档一次就永远不自愈。
   *
   * 这条通道的行只有两种去处: 渠道托管目录, 或用户经 `/project` 选中的项目目录
   * (cardActionHandler 的非 project 分支写的正是 ensureWorkingDir)。所以「目录不等于
   * 托管目录」⟺「它是项目」。
   *
   * 只能用在 peekSession / findActiveSession —— 它们查的是本渠道按 sessionIdFor 推出
   * 的自有行。peekSessionById 不行: `/ctr` 接管的是一条 desktop 会话, 它的目录既不是
   * 项目、也不是本渠道的托管目录(末段常是内部 UUID), 按这条判会把 UUID 当项目名。
   */
  function readWorkspaceKind(
    workingDir: string | null,
    storedKind: 'project' | 'dialogue' | null,
    botContextId: string,
  ): 'project' | 'dialogue' | null {
    // 不开 `/project` 的渠道没有"切出去"这回事, 相信列里存的 —— 它们的托管目录
    // 用户可以在设置页改, 已有会话保留旧目录, 按路径判必然误判(见构造参数说明)。
    if (!pathImpliesProject) return storedKind;
    if (ns.workspaceKind !== 'dialogue' || !workingDir) return storedKind;
    return workingDir === ns.ensureWorkingDir(botContextId) ? 'dialogue' : 'project';
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
    async peekSession(botContextId, userId, scopeKey) {
      const id = ns.sessionIdFor(botContextId, userId, scopeKey);
      const db = getDbClient().drizzle;
      const rows = await db.select().from(sessions).where(eq(sessions.id, id)).limit(1);
      const row = rows[0];
      if (!row) return null;
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
        workspaceKind: readWorkspaceKind(row.workingDir, row.workspaceKind ?? null, botContextId),
      };
    },

    async findActiveSession(botContextId, userId, scopeKey) {
      const id = ns.sessionIdFor(botContextId, userId, scopeKey);
      const db = getDbClient().drizzle;
      const result = await withSessionRouteLock(id, async () => {
        const rows = await db.select().from(sessions).where(eq(sessions.id, id)).limit(1);
        const row = rows[0];
        if (!row) return null;
        const workspaceKind = readWorkspaceKind(
          row.workingDir,
          row.workspaceKind ?? null,
          botContextId,
        );
        let revivedFrom: string | null = null;
        let workspaceKindCorrected = false;
        if (row.status !== 'active') {
          // 复活由用户 IM 消息触发,一并 bump userSendAt:广播 created 后 renderer
          // 立即重拉,而稍后 turnRunner 的 touchUserSent 不再广播 patched,不在这里
          // 写的话 sidebar 会按旧活跃时间排序/分组,直到下次整页刷新。
          if (row.status === 'deleted') {
            // Durable Subagent 墓碑与进行中的删除清理必须在翻回 active 之前撤掉，
            // 否则确定性 id 复活后每次 spawn 仍判父任务已删除。
            await retireDeletedPiSubagentState(id);
          }
          const now = Date.now();
          await db
            .update(sessions)
            .set({
              status: 'active',
              userSendAt: now,
              updatedAt: now,
              // 渠道声明了归属分组时顺手校正老行, 但不碰用户 `/project` 切出去的行
              ...correctedWorkspaceKind(botContextId),
            })
            .where(eq(sessions.id, id));
          revivedFrom = row.status;
        } else if (workspaceKind !== null && workspaceKind !== row.workspaceKind) {
          // 存量脏行**就地回写**, 不等下一次归档。sidebar 的分组直接投影 DB 那一列
          // (localDb/mapper.ts), 只在返回值上现算的话, 会话会一直待在错的分组里 ——
          // 而它现在是 active, 可能永远等不到那次归档。
          //
          // 判据仍走 correctedWorkspaceKind 的 CASE(SQL 里现算), 不把 JS 算出来的值
          // 写回去: 读和写之间行可能已被 `/project` 改过。
          await db
            .update(sessions)
            .set({ ...correctedWorkspaceKind(botContextId), updatedAt: Date.now() })
            .where(eq(sessions.id, id));
          workspaceKindCorrected = true;
        }
        return { row, workspaceKind, revivedFrom, workspaceKindCorrected };
      });
      if (!result) return null;
      const { row, workspaceKind } = result;
      if (result.revivedFrom) {
        log.info(
          `revived soft-deleted ${ns.source} session id=${row.id} (was ${result.revivedFrom})`,
        );
        // 软删行已从 sidebar 消失,patched 增量对不存在的行无效;
        // created 触发 renderer 重拉列表,让会话重新出现。
        broadcastSessionCreated(row.id);
      } else if (result.workspaceKindCorrected) {
        log.info(`corrected ${ns.source} session workspaceKind id=${row.id} -> ${workspaceKind}`);
        // 行会跨分组移动, patched 增量覆盖不了归组变化 —— 与 switchSessionWorkingDir 同理。
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
        // update 前读到的旧值不能直接回 —— 与 correctedWorkspaceKind 用同一判据现算,
        // caller 拿到的和库里落定的才是同一个答案。
        workspaceKind,
      };
    },

    async peekSessionById(sessionId) {
      const db = getDbClient().drizzle;
      const rows = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1);
      const row = rows[0];
      if (!row?.workingDir) return null;
      return {
        id: row.id,
        agentKind: toCoreAgentKind(row.agentKind),
        workingDir: row.workingDir,
        model: row.model,
        effort: row.effort,
        permissionMode: row.permissionMode,
        fastMode: row.fastMode,
        sdkSessionId: row.sdkSessionId,
        providerId: row.providerId ?? null,
        workspaceKind: row.workspaceKind ?? null,
      };
    },

    async prepareNewSession(botContextId, userId, scopeKey, providerSnapshot) {
      const id = ns.sessionIdFor(botContextId, userId, scopeKey);
      const workingDir = ns.ensureWorkingDir(botContextId);
      const row = rowFromDefaults(
        id,
        workingDir,
        await resolveImSessionDefaults(config, providerSnapshot, ns.source),
      );
      // 渠道可按 userId 覆写新会话权限档(telegram guest lane → 只读探索;
      // feishu 群 lane → 渠道设置「群聊新建任务权限档」)。
      const overridden = ns.permissionModeFor?.(userId) ?? null;
      if (overridden) row.permissionMode = overridden;
      return row;
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
      const persisted = await withSessionRouteLock(row.id, async () => {
        const priorRows = await db
          .select({ status: sessions.status })
          .from(sessions)
          .where(eq(sessions.id, row.id))
          .limit(1);
        if (priorRows[0]?.status === 'deleted') {
          await retireDeletedPiSubagentState(row.id);
        }
        const isFreshInsert = priorRows.length === 0;
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
              // 冲突分支撞的是残留行 —— 同 findActiveSession, 用户 `/project`
              // 切出去的归属不能被渠道默认值刷掉。
              ...correctedWorkspaceKind(botContextId),
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
        return { row: persistedRows[0], isFreshInsert };
      });
      const persistedRow = persisted?.row;
      const result: ImSessionRow = persistedRow
        ? {
            id: persistedRow.id,
            agentKind: toCoreAgentKind(persistedRow.agentKind),
            workingDir: persistedRow.workingDir ?? row.workingDir,
            model: persistedRow.model,
            effort: persistedRow.effort,
            permissionMode: persistedRow.permissionMode,
            fastMode: persistedRow.fastMode,
            sdkSessionId: persistedRow.sdkSessionId,
            providerId: persistedRow.providerId ?? null,
          }
        : row;
      log.info(
        `created ${ns.source} session id=${result.id} workingDir=${maskPath(result.workingDir)} ` +
          `agent=${result.agentKind} model=${result.model} effort=${result.effort} ` +
          `provider=${result.providerId ?? 'default'} permissionMode=${result.permissionMode}`,
      );
      // 通知 renderer sidebar / device-link 控制端有新会话行,否则要手动刷新才出现
      broadcastSessionCreated(result.id);
      // 渠道可异步解析正式标题(飞书群/话题 lane → 拉群名拼 [飞书·群/话题] {群名}),
      // 只对**新建行**生效 — 复活行保留自己的历史标题(首条消息 oneshot 会把
      // 话题会话升级成 [飞书·群名·简介] 格式, 不能回刷)。失败/无结果保持
      // defaultTitle, 不阻塞建行。
      if (ns.resolveSessionTitle && persisted?.isFreshInsert) {
        try {
          const resolved = await ns.resolveSessionTitle(userId, scopeKey);
          if (resolved) {
            await db
              .update(sessions)
              .set({ title: resolved })
              .where(eq(sessions.id, result.id));
            broadcastSessionPatched(result.id, { title: resolved });
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log.warn(`resolveSessionTitle failed for ${ns.source} session (non-fatal): ${msg}`);
        }
      }
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
      // Personal WeChat exposes a user-selected channel working directory.
      // It applies only at the explicit `/new` boundary; existing context is
      // never moved silently.
      ...(channel === 'wechat' && defaults.workingDir ? { workingDir: defaults.workingDir } : {}),
      sdkSessionId: null,
      clearedAt: Date.now(),
      updatedAt: Date.now(),
    })
    .where(eq(sessions.id, sessionId));
  setSessionProvider(sessionId, defaults.providerId);
}

/**
 * `/project` 语义: 把该 IM 会话行切到指定工作目录并重开上下文(sdkSessionId
 * 归零)。模型/权限/供应商等设置保留 — 换目录不该顺手改路由。workspaceKind
 * 随目录性质切换: 项目目录落 'project'(sidebar 按项目归组), 托管对话目录落
 * 'dialogue'。广播 created 让 sidebar 重拉 — 行会跨分组移动, patched 增量
 * 覆盖不了归组变化。
 */
export async function switchSessionWorkingDir(
  sessionId: string,
  workingDir: string,
  workspaceKind: 'project' | 'dialogue',
): Promise<void> {
  const db = getDbClient().drizzle;
  await db
    .update(sessions)
    .set({
      workingDir,
      workspaceKind,
      sdkSessionId: null,
      clearedAt: Date.now(),
      updatedAt: Date.now(),
    })
    .where(eq(sessions.id, sessionId));
  broadcastSessionCreated(sessionId);
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
