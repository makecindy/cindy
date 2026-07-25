/**
 * chat-data-localization F1：本地 SQLite schema 定义（drizzle-orm）。
 *
 * 字段集与服务端 Prisma `Session` / `Message` 对齐——这是 IPC 切层零改动的前提。
 * 时间戳列存 unix ms（integer），mapper 在 IPC 边界转 ISO 8601 字符串。
 * JSON 列（messages.content）以 TEXT 形式存储 JSON.stringify 字符串，mapper 出口 JSON.parse。
 */

import { sql } from 'drizzle-orm';
import type { AnySQLiteColumn } from 'drizzle-orm/sqlite-core';
import {
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

import type { SessionSource } from '../../shared/sessionSource.js';

const SESSION_SOURCES = [
  'desktop',
  'feishu',
  'slack',
  'telegram',
  'discord',
  'scheduler',
  'learn',
  'shared',
  'plugin',
] as const satisfies readonly SessionSource[];

export const sessions = sqliteTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    title: text('title').notNull().default('New Maker'),
    workingDir: text('working_dir'),
    /**
     * 产品归属语义, 与 working_dir 解耦:
     * - project: working_dir 是项目目录, 参与侧边栏 Projects 分组。
     * - dialogue: working_dir 是对话自己的运行/文件目录, 不作为项目展示。
     */
    workspaceKind: text('workspace_kind', { enum: ['project', 'dialogue'] })
      .notNull()
      .default('project'),
    model: text('model').notNull().default('claude-sonnet-4-6'),
    effort: text('effort', {
      enum: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
    })
      .notNull()
      .default('high'),
    permissionMode: text('permission_mode', {
      enum: ['ask', 'default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions'],
    })
      .notNull()
      .default('ask'),
    status: text('status', { enum: ['active', 'archived', 'deleted'] })
      .notNull()
      .default('active'),
    sdkSessionId: text('sdk_session_id'),
    totalTokenUsage: integer('total_token_usage').notNull().default(0),
    totalCostUsd: real('total_cost_usd').notNull().default(0),
    /** 新版区域金额；legacy total_cost_usd 仍保留为历史 USD 事实。 */
    totalCostAmount: real('total_cost_amount').notNull().default(0),
    totalCostCurrency: text('total_cost_currency', { enum: ['CNY', 'USD'] }),
    totalCostIsApproximate: integer('total_cost_is_approximate', {
      mode: 'boolean',
    })
      .notNull()
      .default(false),
    contextTokens: integer('context_tokens').notNull().default(0),
    contextWindow: integer('context_window').notNull().default(0),
    fastMode: integer('fast_mode', { mode: 'boolean' }).notNull().default(false),
    /**
     * 计划模式一级开关(与 permissionMode 正交):开启时 agent 先产出计划、经用户
     * 审批后再执行(Claude 走 SDK plan mode, Codex 走 collaborationMode plan)。
     * 计划批准后 agent 自动退出, main 收 plan_mode_changed 事件回写此列。
     * 历史 permission_mode='plan' 的行由对应 migration 转换为此列=true + 'ask'。
     */
    planModeEnabled: integer('plan_mode_enabled', { mode: 'boolean' }).notNull().default(false),
    clearedAt: integer('cleared_at'), // unix ms
    pinnedAt: integer('pinned_at'), // unix ms
    /**
     * 任务现状一句话摘要（sidebar-card-mode 卡片/rail flyout 展示）。
     * 由 main/sessionTaskSummary.ts 在置顶会话 turn 结束时经 oneShot 生成,
     * NULL = 尚未生成（非置顶会话不生成）。
     */
    summary: text('summary'),
    /**
     * 模型供应商来源 id（@cindy/model-providers catalog 的 provider.id，如
     * 'anthropic' / 'openai' / 'xd'）。决定本 session 的请求路由到哪个上游 + 用哪种钥匙。
     * NULL = 未显式选择来源 → 路由 fallback 走现有默认逻辑（decideXxxRoute 按 authMode 推断），
     * 保证老会话与未升级用户行为完全不变（no-break）。由 SET_MODEL 携带 providerId 时持久化。
     */
    providerId: text('provider_id'),
    /**
     * 用户最近一次"按下发送"的时刻（unix ms，NULL = 从未发过）。
     * Sidebar Project / 组内 session 排序唯一时间轴：
     *   - 首条消息发出时由 renderer 通过 touchUserSend IPC 立刻 bump
     *   - NULL ⟺ 草稿，由 projectGrouping 直接归到未分类
     * 不被 model/effort/title 改动等"字段类"修改触发——updatedAt 才是。
     */
    userSendAt: integer('user_send_at'), // unix ms
    /**
     * Agent 来源标识——session 级别。决定本 session 内 messages.agent_meta 的 JSON 形态。
     * 默认 'cc'（Claude Code）。未来扩展 'codex' 等时新建 session 即可，老 session 不动。
     */
    agentKind: text('agent_kind').notNull().default('cc'),
    /**
     * Orca split-session role marker.
     * NULL = regular Maker session; 'lead'/'worker' = part of an Orca workflow.
     * This is intentionally separate from parent_session_id, which is reserved
     * for fork/session-branch semantics.
     */
    orcaRole: text('orca_role', { enum: ['lead', 'worker'] }),
    /**
     * fork-session：派生来源会话 id（self-FK，源被删→SET NULL 保留派生独立）。
     * NULL = 顶层会话；非 NULL = 由某个会话 fork 出来。
     */
    parentSessionId: text('parent_session_id').references((): AnySQLiteColumn => sessions.id, {
      onDelete: 'set null',
    }),
    /**
     * fork-session：在源会话哪条 user 消息上发起 fork（仅作溯源信息，无 FK）。
     * 不加外键——源消息删除时不应阻断 fork 会话存在。
     */
    forkedAtMessageId: text('forked_at_message_id'),
    /**
     * worktree-parallel-sessions: 本 session 绑定的 git worktree 绝对路径
     * (NULL = 无 worktree)。反范式快照——真 source of truth 是 electron-store
     * (worktrees.json), DB 字段仅为 sidebar 渲染时一次性出列优化。删除 worktree 时
     * **不**清此字段(保留历史值); 徽标按 worktreeStore.get(sid) 是否存在判定。
     */
    worktreePath: text('worktree_path'),
    /**
     * Session 来源标识。
     * - 'desktop' (default): 用户在 desktop 端主动创建的会话
     * - 'feishu': 由飞书 bot 收到 p2p 消息触发自动创建/续接的会话
     * - 'scheduler': 由自动化任务 fire 产生的新会话
     * - 'learn': 由 /learn 蒸馏(learn-host)产生的后台会话
     * 不同 source 的 session 共享 sessions/messages 表。desktop/scheduler/learn
     * 进入桌面 sidebar；feishu 仍由飞书模块独立查询，不混进桌面主列表。
     */
    source: text('source', { enum: SESSION_SOURCES }).notNull().default('desktop'),
    /**
     * feishu-bot: 对方的飞书 open_id（仅 source='feishu' 时有值）。
     * 99% 场景是 bot owner 自己。findActiveFeishu 用 (botAppId, openId) 复合查询。
     */
    feishuOpenId: text('feishu_open_id'),
    /**
     * feishu-bot: 触发本 session 的飞书 App ID（仅 source='feishu' 时有值）。
     * 当用户换机器人时，新 botAppId 自然产生新 session line，老 session 仍可看历史。
     */
    feishuBotAppId: text('feishu_bot_app_id'),
    /**
     * IM 渠道通用标识列(slack 等新渠道用;feishu 沿用上面两个历史列不迁移)。
     * imBotContextId = IdentityKey.botContextId(slack: teamId);
     * imUserId = IdentityKey.userId(slack: slackUserId)。
     * 仅 source 为对应 IM 渠道时有值。
     */
    imBotContextId: text('im_bot_context_id'),
    imUserId: text('im_user_id'),
    /**
     * 本 session 创建时是否注入了 project-context 知识（来自 .cindy/project-knowledge/）。
     * 仅在创建瞬间由 main IPC 写入；后续不变。
     * Render 端用此字段决定 sidebar stripe / chat header chip 显示。
     * 该快照语义由 session 创建链路与 packages/project-context/README.md 共同维护。
     */
    usedProjectContext: integer('used_project_context', { mode: 'boolean' })
      .notNull()
      .default(false),
    /**
     * Codex-only: whether the underlying thread history already contains the
     * product-level developer prompt. NULL means unknown and is treated as
     * "restore once if leaving proxy mode" by maker-core.
     */
    codexHistoryHasProductPrompt: integer('codex_history_has_product_prompt', { mode: 'boolean' }),
    /**
     * Session 附加只读引用目录列表(JSON 字符串数组,绝对路径)。
     * agent 在每 turn 透传：Claude Code 使用 options.additionalDirectories，
     * Codex 使用 runtimeWorkspaceRoots + 只读 permission profile。
     * 反序列化由 mapper 兜底 (失败 fallback []), 不抛错。
     */
    extraDirs: text('extra_dirs').notNull().default('[]'),
    /**
     * 远端目标 host id (`@cindy/maker-remote-ssh` ConnectionPool 里的 alias)。
     * 非空 = 这个 session 跑在远端机器上 (codex agent 在远端、workingDir 是远端路径)。
     * 应用重启 / session 切换都能恢复远端目标; 本地 session 字段为 null,
     * 跟历史行为兼容 (老 session 没这列, sqlite default null 即可)。
     * 仅 Codex 支持; Claude session 此列恒为 null (capability 未接通)。
     */
    remoteHostId: text('remote_host_id'),
    /**
     * interrupted-turn-resume: 最近一次 turn 的启动时刻(unix ms)。与
     * lastTurnEndedAt 配对做「疑似中断」纯读判定(startedAt > endedAt),两个
     * 时间戳都是 append-only 覆盖写、**没有清除操作**——语义详见
     * src/main/localDb/sessionActiveTurn.ts 文件头(此处不复制细节)。
     */
    activeTurnStartedAt: integer('active_turn_started_at'),
    /**
     * @deprecated 早期实现的标记 pid 列(多进程所有权协议已按 2026-07-06 产品
     * 决策整体移除),不再读写;保留列避免历史库 DROP COLUMN 迁移风险。
     */
    activeTurnPid: integer('active_turn_pid'),
    /**
     * interrupted-turn-resume: 最近一次 turn 的正常收尾时刻(unix ms):done /
     * terminal error / close / stop / 用户忽略中断提示都写它。见
     * sessionActiveTurn.ts 文件头。
     */
    lastTurnEndedAt: integer('last_turn_ended_at'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => ({
    idxUpdatedAt: index('idx_sessions_updated_at').on(t.updatedAt),
    idxUserSendAt: index('idx_sessions_user_send_at').on(t.userSendAt),
    idxSdkSessionId: index('idx_sessions_sdk_session_id').on(t.sdkSessionId),
    // 复合索引前缀覆盖 working_dir 单列查询(替代旧 idx_sessions_working_dir),
    // 并直接服务 chatHistoryReader 的 "workdir + 时间段 + 游标" 路径 ——
    // (working_dir, created_at, id) 三列有序输出, 免内存排序。
    idxWorkdirCreated: index('idx_sessions_workdir_created').on(t.workingDir, t.createdAt, t.id),
    // 服务 listSessions 仅按时间段过滤的路径, 以及游标分页 (createdAt, id) 复合比较。
    idxCreatedAtId: index('idx_sessions_created_at').on(t.createdAt, t.id),
    idxWorkspaceKind: index('idx_sessions_workspace_kind').on(t.workspaceKind),
    idxParentSessionId: index('idx_sessions_parent_session_id').on(t.parentSessionId),
    idxOrcaRole: index('idx_sessions_orca_role').on(t.orcaRole),
    idxWorktreePath: index('idx_sessions_worktree_path').on(t.worktreePath),
    idxFeishuLookup: index('idx_sessions_feishu_lookup').on(
      t.source,
      t.feishuBotAppId,
      t.feishuOpenId,
    ),
    // IM 通用标识查询(slack 等渠道按 (source, botContextId, userId) 找会话行)
    idxImLookup: index('idx_sessions_im_lookup').on(t.source, t.imBotContextId, t.imUserId),
  }),
);

export const orcaTeams = sqliteTable(
  'orca_teams',
  {
    id: text('id').primaryKey(),
    leadSessionId: text('lead_session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    status: text('status', { enum: ['active', 'completed', 'cancelled', 'failed'] })
      .notNull()
      .default('active'),
    completedAt: integer('completed_at'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => ({
    uniqActiveTeamPerLead: uniqueIndex('uniq_active_team_per_lead')
      .on(t.leadSessionId)
      .where(sql`${t.status} = 'active'`),
    idxStatus: index('idx_orca_teams_status').on(t.status),
  }),
);

export const orcaWorkers = sqliteTable(
  'orca_workers',
  {
    id: text('id').primaryKey(),
    teamId: text('team_id')
      .notNull()
      .references(() => orcaTeams.id, { onDelete: 'cascade' }),
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    status: text('status', { enum: ['idle', 'running', 'done', 'error'] })
      .notNull()
      .default('idle'),
    label: text('label'),
    worktreeBranch: text('worktree_branch'),
    /** multi-worker Phase 1: worker 角色 (developer/reviewer/tester/merger 或自定义) */
    role: text('role').notNull().default('developer'),
    /** multi-worker Phase 1: 同 workflow 内只能 1 个 focused */
    focused: integer('focused', { mode: 'boolean' }).notNull().default(false),
    /** multi-worker Phase 1: idle 释放时间戳, NULL = 非 idle */
    idleSince: integer('idle_since'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => ({
    uniqSessionId: uniqueIndex('uniq_orca_workers_session_id').on(t.sessionId),
    uniqTeamLabel: uniqueIndex('uniq_orca_workers_team_label').on(t.teamId, sql`lower(${t.label})`),
    uniqFocusedPerTeam: uniqueIndex('uniq_orca_workers_focused_per_team')
      .on(t.teamId)
      .where(sql`${t.focused} = true`),
    idxTeamId: index('idx_orca_workers_team_id').on(t.teamId),
    idxStatus: index('idx_orca_workers_status').on(t.status),
  }),
);

/**
 * 跨 renderer/main 创建 worker 的短租约。SQLite 写事务负责原子占用 label 与并发 slot；
 * 创建完成或失败后立即释放，崩溃遗留项由 expiresAt 回收。
 */
export const orcaWorkerCreationReservations = sqliteTable(
  'orca_worker_creation_reservations',
  {
    id: text('id').primaryKey(),
    teamId: text('team_id')
      .notNull()
      .references(() => orcaTeams.id, { onDelete: 'cascade' }),
    label: text('label').notNull(),
    createdAt: integer('created_at').notNull(),
    expiresAt: integer('expires_at').notNull(),
  },
  (t) => ({
    uniqTeamLabel: uniqueIndex('uniq_orca_worker_creation_reservations_team_label').on(
      t.teamId,
      sql`lower(${t.label})`,
    ),
    idxExpiresAt: index('idx_orca_worker_creation_reservations_expires_at').on(t.expiresAt),
  }),
);

export const messages = sqliteTable(
  'messages',
  {
    id: text('id').primaryKey(),
    clientId: text('client_id').notNull(),
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    role: text('role', {
      // 'error':turn 失败的 terminal error 持久化行(messagePersistBroadcaster
      // 的 onTurnErrorEvent)。drizzle 的 text enum 只是 TS 类型约束,SQLite 列
      // 无 CHECK,扩枚举不产生 migration(db:generate 应为 no-op)。
      // 'agent_switch':session 内 agent 引擎切换边界行(session-agent-switch),
      // content 存 { fromAgentKind, toAgentKind, fromModel, toModel, handoff }。
      // handoff 交接文本只进这里(供 UI 展开查看/debug),不作为可见消息渲染正文,
      // 也不落 user 消息——wire 注入与显示分离。
      // 'context_rebuild':消息内容删除后的内部重建标记。rewind_at 固定非 NULL,
      // 所有普通历史读取都不可见；content.handoff 只在下一次发送的 wire 前缀消费。
      // 'message_tombstone':被删除消息的无内容墓碑，保留 id/client_id 仅用于阻止
      // 外部原生 transcript importer 把同一消息重新导入；正文/元数据均已清空。
      enum: [
        'user',
        'assistant',
        'tool_use',
        'tool_result',
        'ask_user',
        'plan_review',
        'thinking',
        'error',
        'agent_switch',
        'context_rebuild',
        'message_tombstone',
      ],
    }).notNull(),
    content: text('content').notNull(), // JSON string
    toolUseId: text('tool_use_id'),
    /**
     * Agent SDK 元信息（JSON.stringify 后的字符串），按本行 agent_kind（NULL 时回落
     * session.agent_kind）解析。
     *  - cc: { uuid, parentUuid, sdkSessionId, model, stopReason, usage, ... }
     *  - 老消息 / 非 SDK 来源消息 / user echo 之前的 pending 消息 = NULL
     * fork、对账、token 计费、debug 都依赖这个字段。
     */
    agentMeta: text('agent_meta'),
    /**
     * 产出本行的 agent 引擎标识（值域与 sessions.agent_kind 相同:'cc' / 'codex'）。
     * session-agent-switch 后 session.agent_kind 只代表"当前活跃 agent",历史行的
     * agent_meta 形态必须按写入时的引擎解析,故落库时逐行 denormalize。
     * NULL = 切换功能上线前的老消息,按 session.agent_kind 解析(向后兼容)。
     */
    agentKind: text('agent_kind'),
    createdAt: integer('created_at').notNull(),
    /**
     * rewind-session 软删时间戳（unix ms，NULL = 未被回滚）。
     * messages list IPC 用 `IS NULL` 过滤掉被 rewind 截断的消息——保留 row 用作审计，
     * 不真删。索引服务于该过滤路径。
     */
    rewindAt: integer('rewind_at'),
  },
  (t) => ({
    uniqSessionClient: uniqueIndex('uniq_messages_session_client').on(t.sessionId, t.clientId),
    idxSessionCreated: index('idx_messages_session_created').on(t.sessionId, t.createdAt),
    // 服务 getMessagesForHistory 仅按时间窗口 / 不带 sessionId 的路径, 以及
    // 游标分页先用 createdAt 过滤；同毫秒次序在 IPC 层用 SQLite rowid 保持写入顺序。
    idxCreatedAtId: index('idx_messages_created_at').on(t.createdAt, t.id),
    idxRewindAt: index('idx_messages_rewind_at').on(t.rewindAt),
  }),
);

/**
 * session-git-pr-context: 会话关联的 GitHub PR 引用。
 * 来源是确定性提取(main 在消息落库单点扫 user/assistant 文本中的 PR URL,
 * 见 git-context/prRefExtractor.ts),不存 PR 状态——状态是易变远端数据,
 * 由 renderer 按需走 git-context:pr-status IPC 实时查询(main 短 TTL 缓存)。
 * (sessionId, owner, repo, prNumber) 唯一;重复出现只 bump lastSeenAt,
 * 让"最近提到的 PR"排在前面。
 */
export const sessionPrRefs = sqliteTable(
  'session_pr_refs',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    owner: text('owner').notNull(),
    repo: text('repo').notNull(),
    prNumber: integer('pr_number').notNull(),
    url: text('url').notNull(),
    firstSeenAt: integer('first_seen_at').notNull(), // unix ms
    lastSeenAt: integer('last_seen_at').notNull(), // unix ms
  },
  (t) => ({
    uniqRef: uniqueIndex('uniq_session_pr_refs').on(t.sessionId, t.owner, t.repo, t.prNumber),
    idxSessionLastSeen: index('idx_session_pr_refs_session_last_seen').on(
      t.sessionId,
      t.lastSeenAt,
    ),
  }),
);

/**
 * 本地"控制面"键值表——存放 schema_version 等。
 * Key/value 都是字符串；调用方按需解析。
 *
 * 已知 keys：
 *   - schema_version                       (string，"0" / "1" / ...)
 *   - codex_history_has_product_prompt_initialized_v1 ('done')
 *   - codex_history_cindy_memory_prompt_reset_v2 ('done')
 *
 * 历史 keys（只读遗留，不再写入）：cloud_migration_*——chat-data 云端迁移已随
 * 主 server 退役（2026-07），存量库里可能残留这组键，无消费方。
 */
export const migrationMeta = sqliteTable('migration_meta', {
  key: text('key').primaryKey(),
  value: text('value'),
});

/**
 * schema-drift-detection (#37)：每条已 apply 的 migration 的指纹记录。
 *
 * 启动时 `schemaDriftDetector` 用磁盘上 `NNNN_xxx.sql` 文件的 sha256 与本表对比，
 * 任一条记录 hash 不一致 = drift（典型成因：多人协作分支冲突后 migration 编号被
 * main 重排，本地 schema_version 已推进但物理表实际缺列）。
 *
 * Dev 环境下检测到 drift → 跑 schemaDriftRepair（反射 schema.ts vs PRAGMA 补缺列/缺表/缺索引）。
 * 所有环境会先收敛已确认等价的历史 hash；Release 对剩余未知 drift 仅 log + toast，
 * 不自动修改 schema。
 *
 * 0026 migration 的 TS script 负责回填：对所有 seq <= 当前 schema_version 的 sql 文件
 * 写入「当前磁盘 hash」作为初值（无法回溯检测已有 drift,这由 dev 端首次启动时的
 * schemaDriftRepair 兜底）。
 */
export const migrationHistory = sqliteTable('migration_history', {
  seq: integer('seq').primaryKey(),
  fileName: text('file_name').notNull(),
  contentHash: text('content_hash').notNull(),
  appliedAt: integer('applied_at').notNull(),
});

export const accountUsageSnapshots = sqliteTable('account_usage_snapshots', {
  agentKind: text('agent_kind').primaryKey(),
  snapshot: text('snapshot').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

/**
 * IM 身份 → desktop session 的接管绑定表 (feishu /ctr 流程产物)。
 *
 * 一行 = 一个"IM 用户当前正接管 desktop 哪个 session"的关系。
 *
 * 主键: (channel, bot_context_id, user_id) — 三元组复合 PK
 *   - 一个 IM 用户对一个 bot 实例同时只能接管一个 desktop session
 *   - 重复 attach 同 identity 走 last-write-wins 覆盖语义 (INSERT OR REPLACE)
 *
 * FK: target_session_id → sessions.id ON DELETE CASCADE
 *   - desktop 端把 session 删了, 接管关系自动消失, 不会留悬空 binding
 *
 * INDEX: target_session_id — 给 desktop "收回" 按钮反向查 identity 用
 *   (renderer 只知道 sessionId, 必须反查出 (channel, bot, user) 才能 detach)
 *
 * 启动时 main 端 BindingStore.preload() 一次性 load 全表到内存 Map, 后续 get
 * 走内存; attach/detach 双写 (DB + Map)。
 */
export const imBindings = sqliteTable(
  'im_bindings',
  {
    /** IM 渠道, 'feishu' / 'slack' / 'discord' 等 */
    channel: text('channel').notNull(),
    /** Bot 实例 id (feishu: app_id), 同 channel 下区分多 bot */
    botContextId: text('bot_context_id').notNull(),
    /** 用户 id (feishu: open_id) */
    userId: text('user_id').notNull(),
    /**
     * 会话维度键 — thread 能力渠道(slack)用 thread root ts 区分同一用户的
     * 多条并行接管;无 thread 概念的渠道(feishu)恒 ''(单接管语义不变)。
     * 进 PK 是多重接管的关键:同 (channel,bot,user) 可按 scope 并存多行。
     */
    scopeKey: text('scope_key').notNull().default(''),
    /** 接管目标 desktop session id, FK → sessions.id, 删 session 级联清掉 */
    targetSessionId: text('target_session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    /** Attach 时刻 unix ms — UI 显示"被接管 hh:mm 开始"用 */
    attachedAt: integer('attached_at').notNull(),
    /** 触发本次 attach 的 control 卡片 message id (审计/排错) */
    attachedViaCardMessageId: text('attached_via_card_message_id'),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.channel, t.botContextId, t.userId, t.scopeKey] }),
    idxTarget: index('idx_im_bindings_target').on(t.targetSessionId),
  }),
);

/**
 * scheduler 模块 (Phase 2): cron 定时任务表。
 *
 * 与 `@cindy/maker-scheduler` 的 `Schedule` 类型一一对应。注意：
 *   - `notify` 在内存类型里是嵌套对象 `{ desktop, feishu }`，DB 端拆成
 *     `notify_desktop` / `notify_feishu` 两列，由 mapper 合并/拆解。
 *   - 时间戳列存 unix ms（与 sessions 表一致），调度引擎本身就用 ms。
 *   - `target_session_id` 用于 heartbeat 模式（往已存在的 session 注入 prompt）；
 *     源 session 删除时 SET NULL，schedule 自身不级联删，留给 runner 兜底。
 *
 * 索引设计：
 *   - `idx_schedules_active_next` 服务于 Scheduler.tick 的 due 扫描
 *     （`WHERE status='active' AND next_fire_at <= now()`）。
 *   - `idx_schedules_target_session` 服务于"列出某 session 上挂的 schedule"
 *     （UI 详情页 / heartbeat 兜底自动 pause 时的反查）。
 */
export const schedules = sqliteTable(
  'schedules',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    prompt: text('prompt').notNull(),
    /**
     * Release-compat tombstone: issue-triage 子模式已下线，0028 DROP 后 0029 ADD 还原
     * 这两列，让老 release 版本仍能 SELECT。新代码 INSERT 不主动赋值，走 default
     * 'prompt' / NULL。读出后也不进入业务逻辑。
     */
    jobType: text('job_type', { enum: ['prompt', 'issue-triage'] })
      .notNull()
      .default('prompt'),
    jobConfig: text('job_config'),
    executionMode: text('execution_mode', { enum: ['agent', 'script'] })
      .notNull()
      .default('agent'),
    scriptConfig: text('script_config'),
    source: text('source').default('user'),
    projectConfigId: text('project_config_id'),
    /**
     * 是否允许用“任务名 + workspace + 工作目录”认领没有 schedule_runs 的旧会话。
     *
     * 该兜底只服务于引入稳定 scheduleId/runId 之前已经存在的任务。迁移会把升级
     * 当时的存量任务标为 true；此后新建任务保持默认 false，确保删除后同名重建
     * 仍是全新身份，不会继承上一代任务的会话、历史或费用。
     */
    legacySessionFallback: integer('legacy_session_fallback', { mode: 'boolean' })
      .notNull()
      .default(false),
    kind: text('kind', { enum: ['cron'] })
      .notNull()
      .default('cron'),
    cronExpr: text('cron_expr').notNull(),
    timezone: text('timezone').notNull(),
    recurring: integer('recurring', { mode: 'boolean' }).notNull().default(true),
    /**
     * 手动触发模式：true 时引擎不算 nextFireAt，永不自动 fire；只能通过 runNow 触发。
     * 跟 recurring 正交，但通常 manual=true 配 recurring=false（"创建一个任务存着，
     * 想跑就 Run now，不想跑就放着"）。引擎在 create / start / update 处分支跳过。
     */
    manual: integer('manual', { mode: 'boolean' }).notNull().default(false),
    /**
     * Interval 模式间隔毫秒。NULL = 走 cron 槽位语义；非 NULL = 走 "上次完成 + N" 语义。
     * 新建任务时 UI 的 "Every N minutes / Hourly / Every N hours" 这几个 preset 会回填本字段，
     * 引擎 fireOne 优先用 intervalMs 算 nextFireAt；旧 cron 数据 0015 migration 自动回填。
     */
    intervalMs: integer('interval_ms'),
    agentKind: text('agent_kind', { enum: ['claude-code', 'codex'] }).notNull(),
    model: text('model'),
    /**
     * 显式选定的供应商(来源)id。NULL = 回落该 agent 原生默认来源(no-break,
     * 与未升级行为字节级一致);非空才按 catalog RoutingDescriptor 路由。
     * runner fire 时透传给 setSessionProvider；与 sessions.provider_id 同语义。
     */
    providerId: text('provider_id'),
    effort: text('effort', {
      enum: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
    }),
    /**
     * Codex Fast 模式开关。true → runner fire 时透传给 codex agent，落到
     * app-server ServiceTier.Fast。仅 Codex 有意义，Claude 忽略。默认 false。
     */
    fastMode: integer('fast_mode', { mode: 'boolean' }).notNull().default(false),
    workingDir: text('working_dir'),
    workspaceKind: text('workspace_kind', { enum: ['project', 'dialogue'] })
      .notNull()
      .default('project'),
    useWorktree: integer('use_worktree', { mode: 'boolean' }).notNull().default(false),
    targetSessionId: text('target_session_id').references((): AnySQLiteColumn => sessions.id, {
      onDelete: 'set null',
    }),
    /**
     * 持续会话开关。true → runner 第一次 fire 后把新建 session 的 id 回写到
     * `target_session_id`，后续 fire 自动走 heartbeat resume；详见
     * `@cindy/maker-scheduler` Schedule.persistentSession。默认 false 维持旧行为。
     */
    persistentSession: integer('persistent_session', { mode: 'boolean' }).notNull().default(false),
    /**
     * 静默运行开关。true → 成功 run 默认不提醒;任务 agent 可在需要用户关注时
     * 调 schedule_notify_current_run 主动上报;
     * 详见 `@cindy/maker-scheduler` Schedule.silentWhenIdle。默认 false。
     */
    silentWhenIdle: integer('silent_when_idle', { mode: 'boolean' }).notNull().default(false),
    /**
     * 前置检查脚本(Pre-run Hook)命令。NULL = 未启用,完全走原有流程。
     * 非空 → runner fire 前先经系统 shell 执行该命令(cwd=本轮工作目录):
     * exit 0 放行 / exit 2 跳过本轮(run 记 'skipped') / 其它、超时阻止本轮并记 failed。
     * 内存对象里与 timeout 合成 `Schedule.preRunHook` 嵌套对象(同 notify 的拆列模式)。
     */
    preRunHookCommand: text('pre_run_hook_command'),
    /** 前置检查脚本超时毫秒。NULL = 不限时。仅 command 非空时有意义。 */
    preRunHookTimeoutMs: integer('pre_run_hook_timeout_ms'),
    /**
     * 跳过留痕承载会话 id(runner 管理)。前置检查拦截时合成的"已跳过"消息写进
     * 该会话;首次跳过创建、后续复用,避免高频任务每次跳过都新建会话。
     * 会话被删时 SET NULL,下次跳过 runner 重建。
     */
    skipLogSessionId: text('skip_log_session_id').references((): AnySQLiteColumn => sessions.id, {
      onDelete: 'set null',
    }),
    notifyDesktop: integer('notify_desktop', { mode: 'boolean' }).notNull().default(true),
    notifyFeishu: integer('notify_feishu', { mode: 'boolean' }).notNull().default(false),
    status: text('status', { enum: ['active', 'paused', 'expired'] })
      .notNull()
      .default('active'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    lastFiredAt: integer('last_fired_at'),
    /**
     * 上一次终态完成时间（success/failed/aborted）。NULL = 从未跑完过。
     * 与 lastFiredAt 区分：fired = 触发开始时间，finished = 跑到终点的时间。
     * UI 列表 "Last X ago" 用本字段，让用户看到的是"上次结果出来的时间"，
     * 避免长跑任务中 fired vs finished 差距带来的误导。
     */
    lastFinishedAt: integer('last_finished_at'),
    nextFireAt: integer('next_fire_at'),
    expireAt: integer('expire_at'),
  },
  (t) => ({
    idxActiveNext: index('idx_schedules_active_next').on(t.status, t.nextFireAt),
    idxTargetSession: index('idx_schedules_target_session').on(t.targetSessionId),
  }),
);

/**
 * 会话级目标(/goal 自主续跑)状态表 —— 每个 session 至多一个 goal,故 session_id 作主键。
 *
 * 设计要点:
 *   - `session_id` 既是主键也是外键,session 删除时 `ON DELETE CASCADE` 连带删 goal
 *     (goal 没有脱离 session 独立存在的意义,同 orca_workers 的 session_id 语义)。
 *   - `status` 状态机:active(续跑中)/ paused(用户打断 / 暂停 / rewind)/ blocked(需人工,
 *     如审批)/ complete(达成,终态)/ budgetLimited(撞 token 预算或轮数上限,终态)/
 *     usageLimited(账号用量受限,非终态,到 usage_reset_at 自动续)。
 *   - 三个护栏 **全部可空、per-goal 快照**(intake 交互时由用户确认、写进本行):
 *     `max_turns`(续跑轮数上限,null=不限)、`budget_tokens`(token 预算,null=不限,
 *     只按 token 不存美元——Codex costUsd 恒 0、USD 无法跨 agent)、`no_progress_limit`
 *     (连续空轮上限,null=不抑制)。运行计数 `no_progress_streak`(连续无 tool_use 轮数)。
 *     默认值来自 goal-settings-store(系统默认 + 用户 override,规则 20)。
 *   - `agent_kind` denormalize 一份,启动 resume 时无需回查 session meta 即可重建。
 *   - 时间戳 unix ms,与 sessions / schedules 一致。
 *
 * 索引:`idx_session_goals_status` 服务于重启 resume 的 `WHERE status='active'` 扫描
 * (仿 idx_schedules_active_next)。
 */
export const sessionGoals = sqliteTable(
  'session_goals',
  {
    sessionId: text('session_id')
      .primaryKey()
      .references((): AnySQLiteColumn => sessions.id, { onDelete: 'cascade' }),
    objective: text('objective').notNull(),
    status: text('status', {
      enum: ['active', 'paused', 'blocked', 'complete', 'budgetLimited', 'usageLimited'],
    })
      .notNull()
      .default('active'),
    budgetTokens: integer('budget_tokens'),
    maxTurns: integer('max_turns'),
    noProgressLimit: integer('no_progress_limit'),
    turnsUsed: integer('turns_used').notNull().default(0),
    tokensUsed: integer('tokens_used').notNull().default(0),
    noProgressStreak: integer('no_progress_streak').notNull().default(0),
    /** usageLimited 时记录的限额重置时刻(unix ms);到点自动续跑。其它状态为 null。 */
    usageResetAt: integer('usage_reset_at'),
    lastReason: text('last_reason'),
    agentKind: text('agent_kind', { enum: ['claude-code', 'codex'] }).notNull(),
    startedAt: integer('started_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => ({
    idxStatus: index('idx_session_goals_status').on(t.status),
  }),
);

/**
 * "最近工作目录"独立持久化表 —— 与 sessions 解耦,归档/删除 session 都不影响。
 *
 * 设计要点:
 *  - 主键 = 绝对路径字符串(写入时已 normalize 过,小写化由 SQL COLLATE NOCASE 兜底,
 *    Windows 大小写不敏感但实际数据集很难撞)。INSERT OR REPLACE 走 last-write-wins。
 *  - last_used_at 是 unix ms;读取按 desc 排序即可。不存 displayName,渲染时
 *    用 projectGrouping.ts 的 extractDisplayName 实时算(同 basename 冲突要追溯
 *    parent 段,语义是相对全集的,不能在写入时定下来)。
 *  - 不加上限 —— 目录数级别天然小;UI 是滚动列表,4 条以上自动滚。
 *  - 历史回填见 drizzle/scripts/0031_add_recent_workdirs.ts。
 */
export const recentWorkdirs = sqliteTable(
  'recent_workdirs',
  {
    path: text('path').primaryKey(),
    lastUsedAt: integer('last_used_at').notNull(),
  },
  (t) => ({
    idxLastUsedAt: index('idx_recent_workdirs_last_used_at').on(t.lastUsedAt),
  }),
);

export const projectAliases = sqliteTable(
  'project_aliases',
  {
    projectKey: text('project_key').primaryKey(),
    alias: text('alias').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => ({
    idxUpdatedAt: index('idx_project_aliases_updated_at').on(t.updatedAt),
  }),
);

export const projectAutomationConsents = sqliteTable('project_automation_consents', {
  workingDir: text('working_dir').primaryKey(),
  consentedAt: integer('consented_at').notNull(),
  configHash: text('config_hash').notNull(),
});

/**
 * scheduler 模块 (Phase 2): 单次触发记录。
 *
 * 与 `@cindy/maker-scheduler` 的 `ScheduleRun` 一一对应。schedule 删除级联删；
 * session 删除仅 SET NULL（保留历史可见，session 链接断了显示为"已删除"）。
 */
export const scheduleRuns = sqliteTable(
  'schedule_runs',
  {
    id: text('id').primaryKey(),
    scheduleId: text('schedule_id')
      .notNull()
      .references(() => schedules.id, { onDelete: 'cascade' }),
    sessionId: text('session_id').references(() => sessions.id, {
      onDelete: 'set null',
    }),
    firedAt: integer('fired_at').notNull(),
    finishedAt: integer('finished_at'),
    status: text('status', {
      // 'skipped': 前置检查脚本 exit 2 拦截,本轮未启动 agent(生而已读,见
      // @cindy/maker-scheduler RunStatus)。SQLite 无 CHECK 约束,enum 仅类型层。
      enum: ['running', 'success', 'failed', 'aborted', 'interrupted', 'skipped'],
    }).notNull(),
    errorMsg: text('error_msg'),
    /** 单次 run 的真实 API 账单费用；与订阅估值严格分栏。 */
    costUsd: real('cost_usd').notNull().default(0),
    /** 单次 run 的订阅 token 估算价值，不计入真实账单。 */
    estimatedValueUsd: real('estimated_value_usd').notNull().default(0),
    /** 新版区域真实费用与订阅价值；旧 USD 列只做历史兼容。 */
    costAmount: real('cost_amount').notNull().default(0),
    estimatedValueAmount: real('estimated_value_amount').notNull().default(0),
    costCurrency: text('cost_currency', { enum: ['CNY', 'USD'] }),
    costIsApproximate: integer('cost_is_approximate', { mode: 'boolean' })
      .notNull()
      .default(false),
    /**
     * zero 表示已确认零费用；unavailable 表示 agent run 尚无可靠计价；legacy
     * 表示迁移前数据缺少 runId，不能精确拆分。SQLite 无 CHECK，无需 migration。
     */
    costAttribution: text('cost_attribution', {
      enum: ['exact', 'direct', 'mixed', 'zero', 'unavailable', 'legacy'],
    })
      .notNull()
      .default('legacy'),
    /**
     * Prompt 类 run 在 success 时存 agent 这一轮 turn 的最终文本（与飞书正常对话
     * 气泡显示同源，按 text 事件 isFinal 语义聚合）。失败 run 留 NULL。
     * 供 schedule 完成通知 / UI 历史回顾使用。
     */
    resultText: text('result_text'),
    /** 前置检查一次执行的结构化 JSON 结果；NULL 表示本轮未配置/未执行检查。 */
    preRunHookResult: text('pre_run_hook_result'),
    readAt: integer('read_at'),
    /**
     * In-flight 心跳时间戳（毫秒）——跨实例的"仍有活实例在跑"租约信号。
     * 执行实例周期续期；僵尸清理只回收心跳过期的 'running' 行（NULL 按 fired_at
     * 兜底，兼容老版本写入的行）。见 @cindy/maker-scheduler ScheduleRun.heartbeatAt。
     */
    heartbeatAt: integer('heartbeat_at'),
  },
  (t) => ({
    idxBySchedule: index('idx_schedule_runs_schedule').on(t.scheduleId, t.firedAt),
  }),
);

/**
 * embedding-host (Phase 1.1): 待处理 embedding 任务队列。
 *
 * 通用 schema — 不绑定任何具体 consumer (chat/document/memory/skill/...)。
 * Consumer 通过 `EmbeddingService.enqueueJobs` 写入, Worker 按 status='pending' +
 * scheduled_at 顺序消费, embed 完成后 INSERT 到 `vec_table` 列指定的 vec0 虚表。
 *
 * 字段语义:
 *   - source        : 'chat'/'document'/... 由 consumer 自定义, Worker 据此分组找 Provider
 *   - source_id     : consumer 内部的实体 id (e.g. message.id / doc.id), Worker 透传给 Provider
 *   - chunk_index   : 同一 source_id 内的分片序号 (default 0, 非分片场景留 0 即可)
 *   - model_id      : 'voyage/voyage-4' 等; Worker 按 model 分组批量调 client.embed
 *   - vec_table     : 该 chunk 嵌入完成后写入哪张 vec0 表 (consumer 决定, 表必须已存在)
 *   - status        : pending → running → done/failed (Worker 维护)
 *   - attempts/last_error/scheduled_at : 重试调度元信息
 *   - locked_at     : 预留给"多 Worker / 跨进程并发"场景, Phase 1.1 单 Worker 不用
 *
 * UNIQUE (source, source_id, chunk_index, model_id) — 同一文本对同一模型只入队一次,
 * INSERT OR IGNORE 让 consumer 重复 enqueue 是幂等的。
 */
export const embeddingJobs = sqliteTable(
  'embedding_jobs',
  {
    rowid: integer('rowid').primaryKey({ autoIncrement: true }),
    source: text('source').notNull(),
    sourceId: text('source_id').notNull(),
    chunkIndex: integer('chunk_index').notNull().default(0),
    modelId: text('model_id').notNull(),
    vecTable: text('vec_table').notNull(),
    status: text('status', { enum: ['pending', 'running', 'done', 'failed'] })
      .notNull()
      .default('pending'),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    /** unix ms; Worker tick 时 WHERE scheduled_at <= now() 过滤。 */
    scheduledAt: integer('scheduled_at').notNull(),
    /** 预留: 多 worker 时 SELECT FOR UPDATE 的替代品。Phase 1.1 单 worker 不写。 */
    lockedAt: integer('locked_at'),
  },
  (t) => ({
    uniqJob: uniqueIndex('uniq_embedding_jobs_natural').on(
      t.source,
      t.sourceId,
      t.chunkIndex,
      t.modelId,
    ),
    idxStatusScheduled: index('idx_embedding_jobs_status_scheduled').on(t.status, t.scheduledAt),
    idxSourceId: index('idx_embedding_jobs_source_id').on(t.source, t.sourceId),
  }),
);

/**
 * embedding-host (Phase 1.1): vec 虚表元信息登记。
 *
 * 通用 schema — 本表不替 consumer 建 vec0 虚表 (那是 consumer 责任, 后续 Phase 接业务时建),
 * 只登记"这张表叫什么 / 服务哪个 source / 用哪个 model / dim 多少"。
 *
 * 用途:
 *   1. EmbeddingService.searchVectors 校验调方传的 vec_table 是已注册的
 *   2. Worker 写入前可校验 model dim 与表 dim 是否一致 (Phase 1.2 起接业务时启用)
 *   3. UI dev 面板列出"当前注册的 vec 表"
 */
export const vecTableMeta = sqliteTable('vec_table_meta', {
  /** vec0 虚表名 (consumer 自决, 建议带版本后缀如 chat_messages_vec_v1) */
  vecTable: text('vec_table').primaryKey(),
  source: text('source').notNull(),
  modelId: text('model_id').notNull(),
  /** 必须严格等于 model.dim, 否则插入会被 vec0 拒绝 */
  dim: integer('dim').notNull(),
  /** unix ms — 首次 registerVecTable 的时刻 */
  registeredAt: integer('registered_at').notNull(),
  notes: text('notes'),
});

/**
 * embedding-host consumer 用的小型 KV 表 — 存放 cutoff timestamp 之类的"per-DB
 * 一次性事实"。当前已知 keys:
 *   - chat_embedding_started_at  (string unix ms) — 用户首次启用聊天嵌入的时刻;
 *     该时刻之前的消息不补嵌入 (no backfill), 之后的新消息按设置开关入队。
 *     关闭后再开启不重置, 保持原 cutoff。
 *
 * value 全部用 TEXT 存, 调方自己 parse (Number / JSON / 直接字符串)。
 */
export const embeddingMeta = sqliteTable('embedding_meta', {
  key: text('key').primaryKey(),
  value: text('value'),
});

/**
 * 每日花费聚合表 (daily_spend) — 支撑右下角"今日 $X.XX" chip。
 *
 * 数据源: register.ts 在每个 turn done 后调用 incrementDailySpend(costUsd, ts)。
 *   Claude costUsd 是 SDK 给的 total_cost_usd delta；Codex API costUsd 是价格表折算的真实网关 API cost。
 *
 * 时区: day = 用户**本地时区** YYYY-MM-DD 字符串 (避免 UTC 跨日错配显示)。
 *
 * 与 web 看板 数据关系:
 *   - web 是 llm-proxy 网关侧统计 (含此账号所有调用方)
 *   - 本表是单机 xdt-maker 实例累加 (子集)
 *   - 同账号用多设备时本表数字会不一致 — 设计取舍, chip 点击跳 web 看完整账。
 *
 * 历史数据: 不 backfill — 安装迁移后从 0 开始累计 (用户明确接受)。
 */
export const dailySpend = sqliteTable('daily_spend', {
  /** 本地时区 YYYY-MM-DD 字符串。 */
  day: text('day').primaryKey(),
  /** 当日累计 USD (real)。SDK 单 turn 的 cost 通常是小数 (如 0.0391)。 */
  costUsd: real('cost_usd').notNull().default(0),
  costAmount: real('cost_amount').notNull().default(0),
  costCurrency: text('cost_currency', { enum: ['CNY', 'USD'] }),
  costIsApproximate: integer('cost_is_approximate', { mode: 'boolean' })
    .notNull()
    .default(false),
  /** 最后一次更新的 unix ms。 */
  updatedAt: integer('updated_at').notNull(),
});

/**
 * 每日按模型用量聚合表 (daily_model_usage) — 支撑首页用量仪表盘的"按模型拆分"。
 *
 * 数据源: register.ts 在每个 turn done 后写入:
 *   - claude-code: SDK done 事件的 modelUsage (子进程内累计) 经 delta 化后逐模型累加,
 *     costUsd 为 SDK 实报美元。
 *   - codex: done.data.usage 的 per-turn token 数 (SDK 不报 cost, costUsd 恒 0,
 *     美元在读取时用 modelPricing 价格表估算 — 价格会变, 不在写入时冻结)。
 *
 * 与 daily_spend 的关系: daily_spend 仍是日总额 canonical 来源 (热力图 / streak 用它);
 * 本表只做按模型的拆分展示, 两边求和因舍入可能有微小差异 — 设计取舍。
 *
 * 历史数据: 不 backfill — 上线后从 0 开始积累。
 */
export const dailyModelUsage = sqliteTable(
  'daily_model_usage',
  {
    /** 本地时区 YYYY-MM-DD 字符串 (localDayKey)。 */
    day: text('day').notNull(),
    /** 'claude-code' | 'codex' — 网关模型 id 可能跨 agent 撞名, 需区分。 */
    agentKind: text('agent_kind').notNull(),
    /** SDK 模型 id; 拿不到时兜底 'unknown'。 */
    model: text('model').notNull(),
    /** 当日该模型累计 USD (仅 claude-code 实报; codex 恒 0)。 */
    costUsd: real('cost_usd').notNull().default(0),
    costAmount: real('cost_amount').notNull().default(0),
    costCurrency: text('cost_currency', { enum: ['CNY', 'USD'] }),
    costIsApproximate: integer('cost_is_approximate', { mode: 'boolean' })
      .notNull()
      .default(false),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    cacheReadTokens: integer('cache_read_tokens').notNull().default(0),
    cacheCreateTokens: integer('cache_create_tokens').notNull().default(0),
    /** 最后一次更新的 unix ms。 */
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => ({
    // day 开头 → 近 N 天范围扫描直接走 PK 索引, 无需额外 index。
    pk: primaryKey({ columns: [t.day, t.agentKind, t.model] }),
  }),
);

/** Skill 使用分析的原始 transcript 扫描缓存。 */
export const skillUsageSources = sqliteTable(
  'skill_usage_sources',
  {
    /** 原始 Claude/Codex transcript 文件路径。内容不入库，只存引用和 stat。 */
    rawFilePath: text('raw_file_path').primaryKey(),
    /** 当前源文件最后一次用哪个解析器版本扫描。用于 analyzer 升级时渐进重建。 */
    analyzerVersion: text('analyzer_version').notNull().default('6'),
    agentKind: text('agent_kind', { enum: ['claude-code', 'codex'] }).notNull(),
    sessionId: text('session_id').notNull(),
    sdkSessionId: text('sdk_session_id').notNull(),
    mtimeMs: integer('mtime_ms').notNull().default(0),
    sizeBytes: integer('size_bytes').notNull().default(0),
    lastScannedAt: integer('last_scanned_at').notNull(),
    status: text('status', { enum: ['ok', 'failed'] })
      .notNull()
      .default('ok'),
    error: text('error'),
  },
  (t) => ({
    bySession: index('idx_skill_usage_sources_session').on(t.sessionId),
    bySdkSession: index('idx_skill_usage_sources_sdk_session').on(t.sdkSessionId),
  }),
);

/** Skill 被模型看到后的结构化表现数据。 */
export const skillUsageExposures = sqliteTable(
  'skill_usage_exposures',
  {
    id: text('id').primaryKey(),
    /** 解析器版本。新版索引完整构建并提升 active 前，旧版数据仍可继续展示。 */
    analyzerVersion: text('analyzer_version').notNull().default('6'),
    rawFilePath: text('raw_file_path')
      .notNull()
      .references(() => skillUsageSources.rawFilePath, { onDelete: 'cascade' }),
    rawLineNo: integer('raw_line_no').notNull(),
    sessionId: text('session_id').notNull(),
    sdkSessionId: text('sdk_session_id').notNull(),
    agentKind: text('agent_kind', { enum: ['claude-code', 'codex'] }).notNull(),
    skillName: text('skill_name').notNull(),
    skillPath: text('skill_path'),
    /** 规范 SKILL.md 文档 hash；拿不到规范文档时为 NULL，不参与版本聚合。 */
    skillDocumentHash: text('skill_document_hash'),
    /** transcript 中这次 exposure 实际出现的内容 hash，用于证据定位和调试。 */
    exposureContentHash: text('exposure_content_hash').notNull(),
    documentHashSource: text('document_hash_source', {
      enum: ['transcript_skill_content', 'transcript_file_read', 'unavailable'],
    }).notNull(),
    source: text('source', {
      enum: [
        'claude_skill_tool',
        'claude_invoked_skill_attachment',
        'claude_skill_content_injection',
        'claude_skill_file_read',
        'codex_skill_injection',
        'codex_skill_file_read',
      ],
    }).notNull(),
    toolUseId: text('tool_use_id'),
    seenAt: integer('seen_at').notNull(),
    toolCallCount: integer('tool_call_count').notNull().default(0),
    repeatedToolCallCount: integer('repeated_tool_call_count').notNull().default(0),
    toolErrorCount: integer('tool_error_count').notNull().default(0),
    commandCallCount: integer('command_call_count').notNull().default(0),
    commandFailureCount: integer('command_failure_count').notNull().default(0),
  },
  (t) => ({
    bySkillVersion: index('idx_skill_usage_exposures_skill_document_version').on(
      t.analyzerVersion,
      t.skillName,
      t.skillDocumentHash,
    ),
    bySession: index('idx_skill_usage_exposures_session').on(t.sessionId),
    byRawFile: index('idx_skill_usage_exposures_raw_file').on(t.rawFilePath),
  }),
);

/**
 * custom-model-providers：用户自定义的模型供应商**配置**（不含密钥）。
 *
 * 与 `@cindy/model-providers` 的 `CustomProviderConfig` 一一对应；加载时经 `buildUserProvider`
 * 展开成标准 `Provider`，并进 host 的 active-catalog，供路由 / 选择器 / listProviders 统一消费。
 *
 * 账号隔离：本地 db 文件本身按 userId 切片（`<userData>/xdt-maker-<userId>.db`，换账号 closeDb
 * 重开），故**不需要 owner 列**——与 `sessions`（同样不存 userId）一致。
 *
 * 密钥**不在本表**：API key 单独存 safeStorage（`provider_key_<id>`，机制同内置 XD 网关 key），
 * 在 host 路由 resolve 时注入鉴权头，绝不入库 / 绝不进 catalog / 绝不回传 renderer 明文。
 *
 * **per-runtime 配置**：`runtimes` 以 TEXT 存 JSON.stringify 字符串——按 agent 索引、每个
 * runtime 各有独立 `{baseUrl, models, headers}`（对应 `@cindy/model-providers` 的
 * `CustomProviderConfig.runtimes`）。反序列化失败安全兜底（→{}），不抛错。
 */
export const customProviders = sqliteTable(
  'custom_providers',
  {
    /** provider id slug（/^[a-z0-9_-]+$/，不撞内置 anthropic|openai|xd）；同 db（=同账号）唯一。 */
    id: text('id').primaryKey(),
    /** 展示名。 */
    name: text('name').notNull(),
    /**
     * per-runtime 配置 JSON：'{"claude-code":{"baseUrl":"...","models":[{id,name}],"headers":{}},"codex":{...}}'。
     * 只含已配置的 runtime（至少一个）。密钥不在此（走 safeStorage provider_key_<id>_<agent>）。
     */
    runtimes: text('runtimes').notNull().default('{}'),
    /**
     * 鉴权配置 JSON（可空）：'{"method":"oauth","oauth":{authorizeUrl,tokenUrl,clientId,scopes,...}}'。
     * 缺省/null = API key 形态（历史行为）。OAuth 凭证不在此（走 safeStorage provider_oauth_<id>）。
     */
    auth: text('auth'),
    /** 列表展示排序（升序）。 */
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => ({
    idxSortOrder: index('idx_custom_providers_sort_order').on(t.sortOrder),
  }),
);

/**
 * 用户自定义 MCP 服务器配置（远程 http/sse 型）。
 *
 * 与 `customProviders` 同源设计：db 文件按 userId 切片，故本表天然账号隔离、无 owner 列。
 * 一条记录 = 一个可被 Claude Code / Codex 两个 agent 共同调用的远程 MCP server。
 *
 * 密钥**不在本表**：可选 bearer token 单独存 safeStorage（`mcp_token_<id>`，见
 * `customMcpSecretStorageKey`），由 CustomMcpProvider 在 resolve 时注入，绝不入库/回传明文。
 *
 * 「配了就生效」：列表里存在即注入 agent，删除即停用，不做 per-server toggle。
 * 仅支持远程 transport（http/sse）——stdio 在 Codex 侧当前无法表达，不在范围内。
 */
export const customMcpServers = sqliteTable(
  'custom_mcp_servers',
  {
    /** MCP id slug（/^[a-z0-9_-]+$/，= agent 侧 mcpServers[name]）；同 db（=同账号）唯一。 */
    id: text('id').primaryKey(),
    /** 展示名。 */
    name: text('name').notNull(),
    /** transport 类型：'http' | 'sse'。 */
    transport: text('transport').notNull(),
    /** 远程 MCP 端点 URL（http(s)）。 */
    url: text('url').notNull(),
    /** 额外请求头 JSON：'{"X-Foo":"bar"}'。不含鉴权 token（走 safeStorage）。反序列化失败兜底 {}。 */
    headers: text('headers').notNull().default('{}'),
    /** 列表展示排序（升序）。 */
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => ({
    idxSortOrder: index('idx_custom_mcp_servers_sort_order').on(t.sortOrder),
  }),
);

/**
 * 右侧栏 Tab 持久化 —— per-session 多 Tab 容器(对标 Codex in-app browser sidebar)。
 *
 * 设计要点:
 *   - 每个 cc-agent session 一组 tab,跨 session 互不串。
 *   - kind 用字符串字段(不加 enum 约束),便于 plugin registry 增量注册新 kind 不动 schema。
 *   - state 列存 plugin 私有 JSON(各 plugin 自定义结构,文件 tab / 浏览器 tab 各填各的);
 *     IPC handler 层做 16KB 上限校验防 plugin 滥塞 dataURL 等大对象。
 *   - 联动删除:session 删除时本表 cascade,与 sessionGoals 模式一致(避免孤立行膨胀 DB)。
 *
 * 索引:`right_sidebar_tabs_session_idx` 服务于"按 session 取 tab 列表 + position 排序"主路径。
 *
 * 约束(由 IPC handler 层保证):
 *   - 单 session 最多 20 个 tab(超抛 RIGHT_SIDEBAR_TOO_MANY_TABS)。
 *   - 单 session 内 is_active 至多 1 行 true(由 setActive handler 先清旧 active 保证)。
 *   - position 由 application 维护连续(0,1,2,...);reorder handler 一次性重写整序。
 */
export const rightSidebarTabs = sqliteTable(
  'right_sidebar_tabs',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id')
      .notNull()
      .references((): AnySQLiteColumn => sessions.id, { onDelete: 'cascade' }),
    /** 'file-browser' / 'web-browser' / 未来扩展。 */
    kind: text('kind').notNull(),
    /** TabBar 上的顺序(0 起,同 session 内连续);reorder IPC 时整序更新。 */
    position: integer('position').notNull(),
    /** same session 内至多 1 行 true;由 setActive handler 保证。 */
    isActive: integer('is_active', { mode: 'boolean' }).notNull().default(false),
    /** plugin 私有状态 JSON 字符串。读时由 IPC handler JSON.parse,写时 JSON.stringify。 */
    state: text('state').notNull().default('{}'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => ({
    bySession: index('right_sidebar_tabs_session_idx').on(t.sessionId, t.position),
  }),
);

/**
 * 排队输入(pendingQueue)崩溃恢复快照 —— per-session 单行,payload 存整条队列 JSON。
 *
 * 背景(issue #761):排队中的 prompt 只活在 AgentInputCoordinator 的内存态,
 * Crash / 强杀后全部丢失。本表由 coordinator 的 emit 收口点在队列内容变化时
 * 覆盖写(队列空则删行),重启后打开会话时懒恢复为「暂停中的队列」。
 *
 * 设计要点:
 *   - payload 是 `AgentInputQueuedMessage[]` 的 JSON.stringify;读侧逐条做形状
 *     校验,坏行整体丢弃(尽力而为的恢复信号,不做跨版本迁移)。
 *   - 单行覆盖写而非逐条行:队列通常只有个位数条目,整体快照避免"逐条 CRUD 与
 *     内存态漂移"一族一致性问题;体量上限与超限降级在写入模块做。
 *   - 联动删除:session 删除时 cascade,与 rightSidebarTabs 模式一致。
 */
export const agentInputQueueSnapshots = sqliteTable('agent_input_queue_snapshots', {
  sessionId: text('session_id')
    .primaryKey()
    .references((): AnySQLiteColumn => sessions.id, { onDelete: 'cascade' }),
  /** AgentInputQueuedMessage[] 的 JSON 字符串。 */
  payload: text('payload').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

/**
 * device-link 同机多实例单持有者仲裁(single-owner arbitration)。
 *
 * 背景:多个实例共享同一 userData(同 deviceId)时,relay 服务端是 last-wins
 * 顶号语义,双活实例会无限互踢(4409 循环),手机端远程连接在实例间漂移。
 * 本表是共享 SQLite 里的互斥凭据:谁持有本行,谁才允许连 relay;其余实例保持
 * 被动,只轮询心跳。心跳过期(持有者卡死/崩溃/断电)或行被释放(正常退出/登出)
 * 时,幸存实例通过 CAS 接管。仲裁逻辑见 main/device-link/ownership.ts。
 *
 * 单行表:id 恒为 1。
 */
export const deviceLinkOwnership = sqliteTable('device_link_ownership', {
  /** 恒为 1 的单行主键 */
  id: integer('id').primaryKey(),
  /** 持有实例每次启动随机生成的标识(跨重启不复用,避免 PID 复用误判) */
  ownerId: text('owner_id').notNull(),
  /** 诊断用:持有实例进程 pid(不参与有效性判定) */
  ownerPid: integer('owner_pid').notNull(),
  /** 诊断用:持有实例描述(app 版本 / dev 标记等) */
  ownerLabel: text('owner_label'),
  /** 最近一次心跳续期时间(Date.now() 毫秒);超过 staleMs 未续即视为持有者失效 */
  heartbeatAt: integer('heartbeat_at').notNull(),
});

/**
 * ── cindy-media 媒体总仓账本(契约:docs/dev-rules/media-storage-and-protocols.md)─────────────────────
 *
 * 字节与含义分家:硬盘上的字节仓(userData/cindy-media/blobs,内容寻址,
 * 文件名=SHA-256 指纹)不含任何归属信息;文件的出生、性质、引用全部是
 * 下面两张表的行。生命周期 = 引用计数:blob 无任何 ref → 回收候选
 * (回收器在后续切片实现,本切片只做写入与归属查询)。
 *
 * 历史兼容层(cc-agent/ 各仓 + xdt-image 等协议)整体冻结,
 * 不进本账本;新写入 100% 走本体系。
 */

/** 字节仓里每个物理文件一行(指纹即身份,同内容天然去重共用一行)。 */
export const mediaBlobs = sqliteTable('media_blobs', {
  /** SHA-256 十六进制指纹(64 字符,主机侧对字节计算;外部自称指纹一律无效)。 */
  hash: text('hash').primaryKey(),
  /** 落盘扩展名(含点,如 '.png');由主机按真实 mime 定,决定渲染方式。 */
  ext: text('ext').notNull(),
  mimeType: text('mime_type').notNull(),
  bytes: integer('bytes').notNull(),
  /**
   * 性质=缓存(可再生:飞书/Jira 等下载副本)。cache blob 即使仍有 ref 也可被
   * 容量上限清理(重下同内容 = 同指纹自动复位);非 cache(附件/作品)只走引用计数。
   */
  isCache: integer('is_cache', { mode: 'boolean' }).notNull().default(false),
  createdAt: integer('created_at').notNull(),
  /** 最近被读取时间(cache LRU 依据;惰性更新,不保证每次读都刷)。 */
  lastAccessAt: integer('last_access_at').notNull(),
});

/**
 * 引用行:谁在用这个 blob(+ 这次引用的出生信息)。
 *
 * refKind/refId 是多态引用(消息 id / 会话 id / 意识 id),不设 FK——
 * 删除会话/卸载意识时由对应业务代码删自己名下的 ref(回收器对账兜底)。
 * origin* 记出生:意识面板供图的归属校验即查「该指纹是否有 origin 为本意识
 * 的行或 ghost-gallery ref」(ghostCanRead,见 main/cindy-media/ledger.ts)。
 */
export const mediaRefs = sqliteTable(
  'media_refs',
  {
    id: text('id').primaryKey(),
    hash: text('hash')
      .notNull()
      .references((): AnySQLiteColumn => mediaBlobs.hash, { onDelete: 'cascade' }),
    /** 'message' | 'session-attachment' | 'ghost-gallery' | 'import'(联合类型见 ledger.ts)。 */
    refKind: text('ref_kind').notNull(),
    /** 引用方 id:消息 clientId / 会话 id / 意识 id。 */
    refId: text('ref_id').notNull(),
    /** 出生会话(生成/导入它的会话;画廊 ref 等无会话语境时为空)。 */
    originSessionId: text('origin_session_id'),
    /** 出生来源类型:'ghost' | 'tool' | 'user' | 'integration'。 */
    originKind: text('origin_kind'),
    /** 出生来源 id:意识 id / 工具名 / 集成名。 */
    originId: text('origin_id'),
    /** 人类可读备注(画廊 caption = 生成时的描述文本等);可空。 */
    label: text('label'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => ({
    /** 归属校验与回收器"谁还引用它"主路径。 */
    byHash: index('media_refs_hash_idx').on(t.hash),
    /** 业务删除自己名下 ref 的主路径(删会话/卸载意识)。 */
    byRef: index('media_refs_ref_idx').on(t.refKind, t.refId),
  }),
);

/**
 * 意识聊天卡片(卡槽③海报模式)。
 *
 * 一行 = 一次 ghost_call 的最新卡片版本(upsert by callId,过程版被终版
 * 覆盖)。html 是主机 sanitizer 的净化产物,renderer 直接装入沙箱 iframe;
 * tool_result 里的 xdt_card_id(= callId)是配对令牌。行数由插入时的
 * GC 上限控制(保最新 N 行);被 GC 的历史卡在 renderer 侧降级为通用媒体
 * 渲染,消息不裂。卡内引用的 cindy-media 图片其引用计数走消息挂账钩子
 * (卡片令牌落在 tool_result 消息内容里,媒体地址也在),本表不重复记账。
 */
export const ghostCards = sqliteTable(
  'ghost_cards',
  {
    /** 管子配对号(pipeDispatcher 铸造;与 tool_result 的 xdt_card_id 同值)。 */
    callId: text('call_id').primaryKey(),
    ghostId: text('ghost_id').notNull(),
    /** 出生会话(best-effort:codex 路径可取,claude in-process 路径可能为空;仅统计用途)。 */
    sessionId: text('session_id'),
    /** 净化后的卡片正文(静态 HTML+CSS)。 */
    html: text('html').notNull(),
    /** 渲染高度 px(已 clamp)。 */
    height: integer('height').notNull(),
    /** 供片协议版本(海报模式 = 1;未来交互模式扩展位)。 */
    v: integer('v').notNull().default(1),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => ({
    /** GC 按最旧淘汰的扫描路径。 */
    byUpdatedAt: index('ghost_cards_updated_at_idx').on(t.updatedAt),
  }),
);
