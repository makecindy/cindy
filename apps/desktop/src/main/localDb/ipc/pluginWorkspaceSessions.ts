import { openSession } from '../sessionOpening.js';
/**
 * pluginWorkspaceSessions —— workspace 槽的会话判重与创建(main 侧服务)。
 *
 * 服务 cindy-brain/workspaceSlot(经 maker-ipc register 注入),两个入口:
 * - findActiveSessionByWorkdir:按"侧边栏同一工作区"口径判重——
 *   normalizeWorkingDirForGrouping 比较(worktree 折叠到主仓,与
 *   renderer projectGrouping 的 projectIdentityKey 同源),只看本机
 *   (remoteHostId 为空)、project 工作区、非 Orca worker 的 active 会话。
 *   注意:与全仓现状一致,比较**不做大小写折叠**——大小写不同的路径视为
 *   不同工作区(改口径要连 projectGrouping 一起改,不在本模块单点偏离)。
 * - createPluginDraftSession:插入 source='plugin' 的空 draft 行(不拉起
 *   agent 进程),流程对齐 `local-db:sessions:create`(git bootstrap →
 *   insert → recent-workdirs → 意识旁听通知);广播与意识旁听通知都由
 *   注入方(register.ts)提供——main 禁止运行时动态 import
 *   (docs/dev-rules/architecture-invariants.md §2),这里不直接触碰
 *   cindy-brain 与窗口。
 *
 * source='plugin' 的语义:projectGrouping 对零消息的 plugin 会话豁免草稿
 * 判定(否则空会话会掉「未分类」,插件"落到已有工作区分组"的目的不成立)。
 */

import { randomUUID } from 'node:crypto';

import { and, eq, isNull, isNotNull, ne, or } from 'drizzle-orm';

import { getDbClient } from '../client/current';
import { sessions } from '../schema';
import { upsertRecentWorkdir } from './recentWorkdirs';
import { createLogger } from '../../logger';
import { pickSessionForWorkdir } from '../pluginWorkspaceDedupe';
import { normalizeWorkingDirForStorage } from '../../../shared/workingDir.js';

const log = createLogger('plugin-workspace-sessions');

/**
 * 按目录找可复用的 active 会话:命中返回最近活跃的一条 id,查无返回 null。
 * 排除 Orca worker(侧边栏不可见,复用它等于把用户带进隐藏会话)与
 * dialogue 工作区(app-managed 临时 cwd,不是项目)。
 */
export async function findActiveSessionByWorkdir(dirAbs: string): Promise<string | null> {
  const db = getDbClient().drizzle;
  const rows = await db
    .select({ id: sessions.id, workingDir: sessions.workingDir, updatedAt: sessions.updatedAt })
    .from(sessions)
    .where(
      and(
        eq(sessions.status, 'active'),
        eq(sessions.workspaceKind, 'project'),
        isNotNull(sessions.workingDir),
        isNull(sessions.remoteHostId),
        // Orca worker 不进侧边栏,复用它等于把用户带进隐藏会话;NULL != 'worker'
        // 在 SQLite 里是 NULL(falsy),必须显式放行 NULL 行。
        or(isNull(sessions.orcaRole), ne(sessions.orcaRole, 'worker')),
      ),
    );
  return pickSessionForWorkdir(rows, dirAbs);
}

/**
 * 创建 plugin 来源的空 draft 会话,返回会话 id。调用方(workspaceSlot)已
 * 完成目录授权与存在性校验;这里只负责落库与既有 create 流程的副作用对齐。
 * Orca 字段这里显式排除:插件会话永远是普通 project 会话。
 */
export async function createPluginDraftSession(params: {
  dirAbs: string;
  title: string | null;
  ghostId: string;
  /** Existing originating-call predicate; checked before bootstrap and DB submission. */
  shouldContinue?: () => boolean;
  /**
   * 由宿主解析的完整模型配置；缺省时交普通 Session 入口读取当前新任务选择。
   */
  defaults?: {
    permissionMode?: 'ask' | 'plan' | 'acceptEdits' | 'auto';
    agentKind?: 'cc' | 'codex' | 'pi';
    model?: string;
    effort?: string;
    fastMode?: boolean;
    providerId?: string | null;
  };
  /**
   * 意识旁听通知(cindy-brain notifyGhostSessionEvent,由 register 静态注入;
   * fire-and-forget,失败不阻断创建)。
   */
  notifySessionCreated?: (info: { sessionId: string; workdir?: string }) => void;
}): Promise<string | null> {
  if (params.shouldContinue && !params.shouldContinue()) return null;
  const now = Date.now();
  const id = randomUUID();
  const workingDir = normalizeWorkingDirForStorage(params.dirAbs) ?? undefined;
  let insertRow;
  try {
    ({ row: insertRow } = await openSession({ id, now, source: 'plugin',
      body: { ...params.defaults, workingDir, workspaceKind: 'project', ...(params.title ? { title: params.title } : {}) },
      assertCurrent: () => { if (params.shouldContinue && !params.shouldContinue()) throw new Error('SESSION_OPEN_CANCELLED'); },
    }));
  } catch (error) {
    if (error instanceof Error && error.message === 'SESSION_OPEN_CANCELLED') return null;
    throw error;
  }
  if (insertRow.workingDir) {
    // 用户刚为这个目录做过授权动作(亲选/确认卡),进"最近项目"列表合理;
    // 失败仅日志,不阻断创建流程(与既有 create 同纪律)。
    void upsertRecentWorkdir(insertRow.workingDir, now);
  }
  // 订阅槽①旁路通知(意识旁听会话创建):经注入回调触达 cindy-brain,
  // 失败仅日志——旁听是 best-effort,不阻断创建。
  try {
    params.notifySessionCreated?.({
      sessionId: id,
      ...(insertRow.workingDir ? { workdir: insertRow.workingDir } : {}),
    });
  } catch (error) {
    log.warn('[plugin-workspace] notifySessionCreated failed', {
      sessionId: id,
      err: error instanceof Error ? error.message : String(error),
    });
  }
  log.info('[plugin-workspace] draft session created', {
    sessionId: id,
    ghostId: params.ghostId,
    workingDir: insertRow.workingDir,
  });
  return id;
}

/**
 * Persist a visible ordinary local task created by a plugin, without starting an Agent.
 * The tasks API and legacy errand adapter both use this creator. The caller resolves
 * and validates the complete model tuple and user permission before reaching here.
 * No directory preference means a Host-managed dialogue directory; a project root
 * must have been selected/authorized by the user. This function adds no Orca identity.
 */
export async function createPluginTaskSession(params: {
  ghostId: string;
  /** Host-allocated durable task identity; never taken directly from plugin payload. */
  sessionId?: string;
  /** Synchronous boundary: after this callback, a failed INSERT is not proof of absence. */
  onPersistenceStarted?: () => void;
  shouldContinue?: () => boolean;
  title: string | null;
  agentKind?: 'cc' | 'codex' | 'pi';
  model?: string;
  effort?: string;
  fastMode?: boolean;
  providerId?: string | null;
  permissionMode: 'ask' | 'plan' | 'acceptEdits' | 'auto';
  /** 用户亲选的项目目录(绝对路径);缺省 = 专属 dialogue 目录。 */
  workingDir?: string;
  notifySessionCreated?: (info: { sessionId: string; workdir?: string }) => void;
}): Promise<string> {
  if (params.shouldContinue && !params.shouldContinue()) throw new Error('Plugin task owner changed');
  const now = Date.now();
  const id = params.sessionId ?? randomUUID();
  const projectDir = params.workingDir
    ? (normalizeWorkingDirForStorage(params.workingDir) ?? undefined)
    : undefined;
  const workspaceKind = projectDir ? ('project' as const) : ('dialogue' as const);
  const { row: insertRow } = await openSession({ id, now, source: 'plugin',
    body: { workingDir: projectDir, workspaceKind, permissionMode: params.permissionMode,
      agentKind: params.agentKind, model: params.model, effort: params.effort,
      fastMode: params.fastMode, providerId: params.providerId,
      ...(params.title ? { title: params.title } : {}) },
    assertCurrent: () => { if (params.shouldContinue && !params.shouldContinue()) throw new Error('Plugin task owner changed'); },
    onPersistenceStarted: params.onPersistenceStarted,
  });
  if (params.shouldContinue && !params.shouldContinue()) throw new Error('Plugin task owner changed');
  if (projectDir && insertRow.workingDir) {
    // 项目目录是用户在插件详情页亲手选的,进"最近项目"合理;dialogue 目录
    // 是 app 管理的临时间,不进。失败仅日志,不阻断创建。
    void upsertRecentWorkdir(insertRow.workingDir, now);
  }
  try {
    params.notifySessionCreated?.({
      sessionId: id,
      ...(insertRow.workingDir ? { workdir: insertRow.workingDir } : {}),
    });
  } catch (error) {
    log.warn('[plugin-task] notifySessionCreated failed', {
      sessionId: id,
      err: error instanceof Error ? error.message : String(error),
    });
  }
  log.info('[plugin-task] session created', {
    sessionId: id,
    ghostId: params.ghostId,
    workspaceKind,
    workingDir: insertRow.workingDir,
  });
  return id;
}
