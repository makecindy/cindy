/**
 * rewind-session：消息级 Rewind 业务函数。
 *
 * Stage 2 C2 重构后:SDK 调用全部走 maker-core 的 Session.previewRewindFiles /
 * commitRewindFiles。本文件只剩业务编排:
 *   - Claude: 反向找 prior assistant uuid (跳 subagent / 跳 rewinded)
 *   - Codex: 计算 target 之后要裁掉的完整 user turn 数与原生 turn 边界，交给
 *     maker-core(thread/rollback;不可用时按边界 fork,第一轮换空线程)
 *   - SQLite 事务 (messages.rewind_at + sessions reset tokens + bump userSendAt)
 *
 * Claude 三件套 (resume + resumeSessionAt + forkSession) 重启逻辑封装在
 * ClaudeCodeAgent 内部。Codex 的回退会立即更新 app-server 上下文。
 *
 * 关键 uuid 拆解 (与重构前一致):
 *   - resumeSessionAt 锚点 = **prior assistant uuid** (SDK 类型注释:
 *     "should be from SDKAssistantMessage.uuid")。从 messages 表反向查。
 *   - rewindFiles(userUuid, ...) → preview dryRun 取文件清单;
 *     commit dryRun:false 立即文件回滚。
 *     user uuid 缺失 (老消息) → preview 走 Empty, commit 跳过文件回滚交
 *     forkSession=true 兜底 (功能不残)。
 *   - Codex 没有 message uuid / file checkpoint，preview 永远是 Empty，commit 用
 *     tailTurnsToDrop + 原生边界交给 maker-core。
 */

import { and, asc, desc, eq, gt, gte, isNull, lt, or, sql } from 'drizzle-orm';

import { getDbClient } from '../localDb/client/current';
import { sessions, messages } from '../localDb/schema';
import { sessionToCamel } from '../localDb/mapper';
import { getMaker } from '../maker-host/index.js';
import { readGitSafetySettings } from '../maker-host/git-safety-settings-store.js';
import type { Session } from '../../renderer/lib/ccAgent.types';
import type { RewindFilesResult } from '@cindy/maker-core';

import { createLogger } from '../logger';
import { setLastAssistantTranscriptUuid } from '../messagePersistBroadcaster.js';
import { recomputePrRefsForSession } from '../git-context/prRefsStore.js';
import { isCodexNativeThreadStart, resolveCodexForkEventTimestamp, resolveCodexTurnAnchor } from './fork';
import {
  buildCodexFileRewindPlan,
  CodexFileRewindPlanError,
  type CodexFileRestorePlan,
  type CodexRewindPlan,
  type CodexRewindSavepoint,
  type CodexRewindUserMessage,
} from '../git-snapshot/codexFileRewindPlanner';
import {
  executeCodexFileRewindPlanWithThreadRollback,
} from '../git-snapshot/codexFileRewindExecutor';
import {
  executeCodexFileRestorePlanWithThreadRollback,
} from '../git-snapshot/codexFileRestoreExecutor';
import { enqueueGitRepoWrite } from '../git-snapshot/gitRepoWriteQueue';
import {
  chunkPathspecArgs,
  getCurrentBranch,
  getHead,
  listShadowSavepoints,
  listSnapshots,
  listUnprotectedPaths,
  writeWorktreeTreeForPaths,
  type SnapshotEntry,
} from '../git-snapshot/gitSnapshotService';
import { detectCwd } from '../worktree/WorktreeManager.js';
import { gitExec } from '../worktree/gitExec';
import {
  loadClaudeTranscriptAnchorIndex,
  parseClaudeAgentMeta,
  resolveClaudeRewindAssistantEntry,
} from './claudeTranscriptAnchors';

const log = createLogger('maker-orchestration/rewind');
const messageRowid = sql<number>`rowid`;

/** rewind 内部错误码——由 IPC 层 catch 后映射为 IPC 错误码透传给 renderer。 */
export type RewindErrorCode =
  | 'SESSION_NOT_FOUND'
  | 'MESSAGE_NOT_FOUND'
  | 'NOT_USER_MESSAGE'
  | 'NO_PRIOR_ASSISTANT'
  | 'SESSION_RUNNING'
  | 'NO_LIVE_QUERY'
  | 'REWIND_GIT_CONFLICT'
  | 'REWIND_GIT_FAILED'
  | 'REWIND_UNSUPPORTED_HISTORY'
  | 'REWIND_TARGET_NOT_LATEST';

function rewindError(code: RewindErrorCode, message: string): Error {
  const err = new Error(message);
  (err as { code?: string }).code = code;
  return err;
}

function activeSdkSessionId(value: string | undefined): string | undefined {
  return value && value !== '<pending>' ? value : undefined;
}

/**
 * edit-last-message: main 侧权威校验——target 之后是否存在更新的**可见** user
 * 消息((createdAt, rowid) 严格大于 target,跳过已软删行)。renderer 的
 * isLastUserMessage 判定基于已加载切片,且从校验到 IPC 落地存在 TOCTOU 窗口
 * (自动化任务 / goal runner / 第二控制端可能在间隙追加新 user 消息);这里在
 * SDK 副作用之前查一次做快速失败(整体未发生,renderer 保持编辑态可重试);
 * 最终断言由 rewind.commit 事务在软删同一临界区内完成(worker 单线程同步
 * 执行,见 commitRewindAtMessage 段 2),校验与软删真正原子。仅
 * requireLatestUser(编辑重发)路径启用,普通 Rewind 保持
 * "可回到任意历史消息"语义不受影响。
 */
async function targetHasNewerVisibleUserMessage(
  sessionId: string,
  target: { createdAt: number; rowid: number },
): Promise<boolean> {
  const db = getDbClient().drizzle;
  const newer = await db
    .select({ rowid: messageRowid })
    .from(messages)
    .where(
      and(
        eq(messages.sessionId, sessionId),
        eq(messages.role, 'user'),
        isNull(messages.rewindAt),
        or(
          gt(messages.createdAt, target.createdAt),
          and(eq(messages.createdAt, target.createdAt), gt(messageRowid, target.rowid)),
        ),
      ),
    )
    .limit(1);
  return newer.length > 0;
}

function findDbPreserveMessageUuidForClaudeAnchor(
  visibleAssistants: Array<{ agentMeta: string | null }>,
  anchor: { uuid: string; requestId?: string } | undefined,
): string | undefined {
  if (!anchor) return undefined;
  for (let i = visibleAssistants.length - 1; i >= 0; i--) {
    const meta = parseClaudeAgentMeta(visibleAssistants[i].agentMeta);
    if (meta.uuid === anchor.uuid) return meta.uuid;
    if (anchor.requestId && meta.requestId === anchor.requestId && meta.uuid) {
      return meta.uuid;
    }
  }
  return anchor.uuid;
}

/**
 * 共享前置：校验 session live、非 running、target 是 user 消息。
 * Claude 反向找 prior assistant SDK uuid；Codex 计算要裁掉的 tail turn 数。
 */
interface RewindContext {
  /** 不可为 null：前置校验通过后必有 LiveSession entry。 */
  // 业务函数自己读 isRunning / 拿 query；这里只暴露 sessionId 之类的元数据
  targetCreatedAt: number;
  /** target 行的 rowid(同 createdAt 时的次序键);Codex 原生边界查询用。 */
  targetRowid?: number;
  targetMessageId: string;
  targetClientId: string;
  /** 当前 agent kind；Claude checkpoint 与 conversation-tree rollback 机制不同。 */
  agentKind: 'claude-code' | 'codex' | 'pi';
  /** prior assistant uuid（Claude 必填）——SDK resumeSessionAt 用。 */
  assistantUuid?: string;
  /** target user 消息的 SDK uuid——仅 preview 的 rewindFiles dryRun 用，老消息可能 NULL。 */
  userUuid?: string;
  /** Codex thread/rollback 或 Pi fork(entryId) 从尾部裁剪的完整 turn 数。 */
  tailTurnsToDrop?: number;
  codexUserMessages?: CodexRewindUserMessage[];
  /** DB 事务保留用 uuid；旧数据里可能是 synthetic block uuid，和 SDK anchor 不同。 */
  preserveMessageUuid?: string;
}

async function loadRewindContext(
  sessionId: string,
  clientId: string,
  opts?: { requireLatestUser?: boolean },
): Promise<RewindContext> {
  const db = getDbClient().drizzle;

  // 1. session live 校验 + running 守卫 (改走 maker.getSession, 重构前是 agentManager.getLiveSession)
  const maker = getMaker();
  const makerSession = maker.getSession(sessionId);
  if (!makerSession) {
    // session 不在内存中:app 刚启动 / 这条 session 还没在新链路激活过。
    throw rewindError(
      'NO_LIVE_QUERY',
      '会话未激活——请先发送任意一条消息（即使是 "ok"），让 SDK 起来后再 rewind',
    );
  }
  if (makerSession.isTurnRunning()) {
    throw rewindError('SESSION_RUNNING', '会话进行中，无法回滚');
  }
  const agentKind = makerSession.agentKind === 'codex'
    ? 'codex'
    : makerSession.agentKind === 'pi'
      ? 'pi'
      : 'claude-code';

  // 2. 取 target user 消息
  const [target] = await db
    .select({
      rowid: messageRowid,
      id: messages.id,
      clientId: messages.clientId,
      role: messages.role,
      agentMeta: messages.agentMeta,
      createdAt: messages.createdAt,
    })
    .from(messages)
    .where(and(eq(messages.sessionId, sessionId), eq(messages.clientId, clientId)))
    .limit(1);
  if (!target) {
    throw rewindError('MESSAGE_NOT_FOUND', `Message ${clientId} 不存在于 ${sessionId}`);
  }
  if (target.role !== 'user') {
    throw rewindError('NOT_USER_MESSAGE', 'rewind 只能在 user 消息上发起');
  }

  // edit-last-message: SDK 副作用之前的第一道 main 侧最新校验(见
  // targetHasNewerVisibleUserMessage 注释)。
  if (opts?.requireLatestUser && (await targetHasNewerVisibleUserMessage(sessionId, target))) {
    throw rewindError(
      'REWIND_TARGET_NOT_LATEST',
      'target 之后已有更新的 user 消息,编辑重发拒绝执行(防止误删新轮次)',
    );
  }

  // session-agent-switch:禁止跨引擎切换边界 rewind。target 之后存在未回滚的
  // agent_switch 行 = target 属于上一个引擎时代——当前引擎的原生会话里没有那些
  // turn 的锚点(Claude 的 assistant uuid / Codex 的 tail turn 计数都会错配),
  // 强行执行要么报错要么错删。v1 每次切换重新交接,不保留切回指针,故直接拒绝。
  // Codex / Pi 还要拦 context_rebuild(原生会话重建):重建后的 live thread 里没有
  // 重建前那些 turn,按 tail turn 数 rollback 或按边界 fork 都对不上目标(#4423
  // review P1)。Claude 路径按 assistant uuid 锚点回退,不在此处拦。
  // context_rebuild 的写入契约是 rewind_at 固定非 NULL(schema.ts),与 fork.ts 的
  // 边界查询一样对它豁免可见性过滤,否则守卫永远不命中(review P2)。
  const boundaryRole =
    agentKind === 'claude-code'
      ? and(eq(messages.role, 'agent_switch'), isNull(messages.rewindAt))
      : or(
          and(eq(messages.role, 'agent_switch'), isNull(messages.rewindAt)),
          eq(messages.role, 'context_rebuild'),
        );
  const [boundaryAfterTarget] = await db
    .select({ rowid: messageRowid })
    .from(messages)
    .where(
      and(
        eq(messages.sessionId, sessionId),
        boundaryRole,
        or(
          gt(messages.createdAt, target.createdAt),
          and(eq(messages.createdAt, target.createdAt), gt(messageRowid, target.rowid)),
        ),
      ),
    )
    .limit(1);
  if (boundaryAfterTarget) {
    throw rewindError(
      'REWIND_UNSUPPORTED_HISTORY',
      '目标消息在引擎切换或会话重建边界之前,当前引擎的会话历史无法回滚到那里',
    );
  }

  if (agentKind === 'codex' || agentKind === 'pi') {
    const tailTurns = await db
      .select({
        rowid: messageRowid,
        id: messages.id,
        clientId: messages.clientId,
        createdAt: messages.createdAt,
      })
      .from(messages)
      .where(
        and(
          eq(messages.sessionId, sessionId),
          eq(messages.role, 'user'),
          or(
            gt(messages.createdAt, target.createdAt),
            and(eq(messages.createdAt, target.createdAt), gte(messageRowid, target.rowid)),
          ),
          isNull(messages.rewindAt),
        ),
      )
      .orderBy(asc(messages.createdAt), asc(messageRowid));
    const targetStillVisible = tailTurns.some((row) => row.rowid === target.rowid);
    if (!targetStillVisible) {
      throw rewindError('MESSAGE_NOT_FOUND', `Message ${clientId} 不在当前 agent turn 时间线`);
    }
    const codexUserMessages = tailTurns.map((row) => ({ clientId: row.clientId, createdAt: row.createdAt }));
    log.debug(
      `[rewind] ${agentKind} sessionId=${sessionId.slice(0, 8)} clientId=${clientId} target.createdAt=${target.createdAt} tailTurnsToDrop=${tailTurns.length}`,
    );
    return {
      targetCreatedAt: target.createdAt,
      targetRowid: target.rowid,
      targetMessageId: target.id,
      targetClientId: target.clientId,
      agentKind,
      tailTurnsToDrop: tailTurns.length,
      codexUserMessages,
    };
  }

  // 3. 找 resumeSessionAt 锚点：Claude JSONL 可用时以真实 transcript parent
  //    chain 为准；否则再退回 DB 里仍可见的 assistant 候选。
  // （parentUuid 不为空的是 subagent 的 assistant，不能当 resumeSessionAt 锚点；
  // CD 的 rewindSession 同样过滤 `!I.parent_tool_use_id`）。
  // **跳过 rewind_at 已置位的行**：那些是上一次 rewind 软删的消息，再用它们当
  // 锚点会让 resumeSessionAt 指向一条逻辑上已不存在的 assistant，CLI 找不到。
  const targetMeta = parseClaudeAgentMeta(target.agentMeta);
  const currentSessionMeta = await maker.getSessionMeta(sessionId);
  const sdkSessionId =
    activeSdkSessionId(makerSession.sdkSessionId) ??
    activeSdkSessionId(currentSessionMeta?.sdkSessionId) ??
    targetMeta.sdkSessionId;
  const anchorIndex = sdkSessionId
    ? await loadClaudeTranscriptAnchorIndex({
        sdkSessionId,
        workingDir: makerSession.workDir,
      }).catch(() => null)
    : null;
  const assistantAnchor = resolveClaudeRewindAssistantEntry(targetMeta.uuid, anchorIndex);
  let assistantUuid = assistantAnchor?.uuid;

  const visibleAssistants = await db
    .select()
    .from(messages)
    .where(
      and(
        eq(messages.sessionId, sessionId),
        eq(messages.role, 'assistant'),
        isNull(messages.rewindAt),
      ),
    )
    .orderBy(asc(messages.createdAt));
  let preserveMessageUuid = findDbPreserveMessageUuidForClaudeAnchor(visibleAssistants, assistantAnchor);
  if (!assistantUuid && targetMeta.transcriptParentUuid) {
    for (let i = visibleAssistants.length - 1; i >= 0; i--) {
      const meta = parseClaudeAgentMeta(visibleAssistants[i].agentMeta);
      if (meta.uuid === targetMeta.transcriptParentUuid && !meta.parentUuid) {
        assistantUuid = meta.uuid;
        preserveMessageUuid = meta.uuid;
        break;
      }
    }
  }
  for (let i = visibleAssistants.length - 1; !assistantUuid && i >= 0; i--) {
    const row = visibleAssistants[i];
    if (row.createdAt >= target.createdAt) continue;
    const meta = parseClaudeAgentMeta(row.agentMeta);
    if (meta.uuid && !meta.parentUuid) {
      assistantUuid = meta.uuid;
      preserveMessageUuid = meta.uuid;
      break;
    }
  }
  if (!assistantUuid) {
    throw rewindError('NO_PRIOR_ASSISTANT', '请在 AI 回复之后的提问上 rewind');
  }

  const userUuid = targetMeta.uuid;
  log.debug(
    `[rewind] sessionId=${sessionId.slice(0, 8)} clientId=${clientId} target.createdAt=${target.createdAt} userUuid=${userUuid ?? 'NONE'} assistantUuid=${assistantUuid} preserveMessageUuid=${preserveMessageUuid ?? assistantUuid}`,
  );

  return {
    targetCreatedAt: target.createdAt,
    targetMessageId: target.id,
    targetClientId: target.clientId,
    agentKind,
    assistantUuid,
    userUuid,
    preserveMessageUuid: preserveMessageUuid ?? assistantUuid,
  };
}

/**
 * Preview：dry-run 计算 rewind 会动哪些文件。
 *
 * - Claude target user 消息有 SDK uuid → 调 maker session.previewRewindFiles 拿真实文件清单
 *   (内部 q.rewindFiles dryRun:true)
 * - Codex 用 XDT savepoint 预览文件变化；无 savepoint / 老 Claude 消息无 user uuid 时走 Empty 态。
 *
 * SDK 抛错的容错由 maker session 内部处理 (包成 {canRewind:false, error})。
 */
export async function previewRewindAtMessage(
  sessionId: string,
  clientId: string,
): Promise<RewindFilesResult> {
  const ctx = await loadRewindContext(sessionId, clientId);

  const makerSession = getMaker().getSession(sessionId);
  if (!makerSession) {
    throw rewindError('NO_LIVE_QUERY', '会话未激活');
  }
  if (ctx.agentKind === 'codex' || ctx.agentKind === 'pi') {
    return previewCodexFileRewindPlan(await buildCodexFilePlanForSession(sessionId, clientId, ctx.codexUserMessages ?? [], makerSession));
  }
  if (!ctx.userUuid) {
    // 老 Claude 消息没有 user uuid：文件层面没有可预览 checkpoint，仅截断对话历史。
    return {
      canRewind: true,
      conversationOnly: true,
      filesChanged: [],
      insertions: 0,
      deletions: 0,
    };
  }

  log.info(`[rewind dryRun] sid=${sessionId.slice(0, 8)} userUuid=${ctx.userUuid}`);
  return await makerSession.previewRewindFiles(ctx.userUuid);
}

async function previewCodexFileRewindPlan(plan: CodexRewindPlan): Promise<RewindFilesResult> {
  if (plan.mode === 'file-restore') return previewCodexFileRestorePlan(plan);
  if (plan.mode !== 'file-rewind') {
    const gitSafetyDisabled =
      plan.fallbackReason === 'no-savepoints' && !readGitSafetySettings().autoSnapshotEnabled;
    return {
      canRewind: true,
      conversationOnly: true,
      ...(gitSafetyDisabled ? { gitSafetyDisabled: true } : {}),
      filesChanged: [],
      insertions: 0,
      deletions: 0,
    };
  }
  const files = new Set<string>(); let insertions = 0; let deletions = 0;
  for (const commit of plan.revertCommitsNewestFirst) {
    const { stdout } = await gitExec(['show', '--format=', '--numstat', commit], plan.repoRoot);
    for (const line of stdout.split('\n')) {
      const [added, deleted, file] = line.split('\t');
      if (!file) continue;
      files.add(file); insertions += parseNumstat(deleted); deletions += parseNumstat(added);
    }
  }
  return { canRewind: true, filesChanged: [...files], insertions, deletions };
}

/**
 * Restore preview: diff 当前工作区(受影响文件子集写成临时 tree)→ 目标基线树。
 * 方向就是 rewind 将执行的方向,数字无需对调;经临时 tree 而非 commit-vs-worktree
 * 的 diff,是为了把 untracked 新建文件的删除也计入。
 */
async function previewCodexFileRestorePlan(plan: CodexFileRestorePlan): Promise<RewindFilesResult> {
  return enqueueGitRepoWrite(plan.repoRoot, async () => {
    const affectedPaths = await collectRestoreAffectedPaths(plan);
    if (affectedPaths.length === 0) {
      return { canRewind: true, filesChanged: [], insertions: 0, deletions: 0 };
    }
    // 与执行侧同款的安全过滤前置:受影响文件当前若处于过滤范围(敏感/超限/
    // 嵌套仓库),预览直接报不可回退,不把这些字节写进 Git 对象库(下面的
    // 临时 worktree 树会 hash 受影响路径的当前内容)。null = status 溢出、
    // 脏文件视图未知,同样失败关闭。
    const unprotected = await listUnprotectedPaths(plan.repoRoot, affectedPaths);
    if (unprotected === null) {
      return {
        canRewind: false,
        error: '仓库脏文件过多,无法核实回退安全性(git status 输出超限),请先清理或提交部分改动',
      };
    }
    if (unprotected.length > 0) {
      return {
        canRewind: false,
        error: `受影响文件 ${unprotected.slice(0, 3).join('、')}${unprotected.length > 3 ? ' 等' : ''} 当前处于安全过滤范围(敏感路径/超大文件/嵌套仓库),回退前快照无法完整保护其内容,请先手动备份或移出这些文件`,
      };
    }
    const affectedPathspecs = affectedPaths.map((p) => `:(literal)${p}`);
    const worktreeTree = await writeWorktreeTreeForPaths(plan.repoRoot, affectedPaths);
    const files = new Set<string>(); let insertions = 0; let deletions = 0;
    for (const chunk of chunkPathspecArgs(affectedPathspecs)) {
      const { stdout } = await gitExec(
        ['diff', '--numstat', '--no-renames', '-z', worktreeTree, plan.baselineCommit, '--', ...chunk],
        plan.repoRoot,
      );
      for (const record of stdout.split('\0')) {
        const [added, deleted, file] = record.split('\t');
        if (!file) continue;
        files.add(file); insertions += parseNumstat(added); deletions += parseNumstat(deleted);
      }
    }
    return { canRewind: true, filesChanged: [...files], insertions, deletions };
  });
}

async function collectRestoreAffectedPaths(plan: CodexFileRestorePlan): Promise<string[]> {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of plan.restoreCommitsNewestFirst) {
    const { stdout } = await gitExec(
      ['diff', '--name-only', '--no-renames', '-z', entry.baselineCommit, entry.commit],
      plan.repoRoot,
    );
    for (const rawPath of stdout.split('\0')) {
      if (!rawPath || seen.has(rawPath)) continue;
      seen.add(rawPath);
      out.push(rawPath);
    }
  }
  return out;
}

function parseNumstat(value: string): number {
  const n = Number.parseInt(value, 10); return Number.isFinite(n) ? n : 0;
}

async function buildCodexFilePlanForSession(sessionId: string, targetMessageClientId: string, userMessages: readonly CodexRewindUserMessage[], makerSession: { workDir: string; remoteHostId?: string | null }) {
  try {
    return buildCodexFileRewindPlan({ sessionId, targetMessageClientId, userMessages, repo: await loadCodexFileRewindRepoContext(makerSession, sessionId) });
  } catch (err) {
    if (err instanceof CodexFileRewindPlanError) {
      if (err.code === 'MESSAGE_NOT_FOUND') throw rewindError('MESSAGE_NOT_FOUND', err.message);
      throw rewindError('REWIND_UNSUPPORTED_HISTORY', err.message);
    }
    throw err;
  }
}

function toPlannerSavepoint(snapshot: SnapshotEntry): CodexRewindSavepoint {
  return {
    commit: snapshot.commit,
    sessionId: snapshot.sessionId,
    kind: snapshot.kind,
    source: snapshot.source === 'cindy' ? 'shadow' : 'legacy',
    branch: snapshot.branch ?? '',
    parentCount: snapshot.parentCount,
    ...(snapshot.anchor ? { anchor: snapshot.anchor } : {}),
    ...(snapshot.label ? { label: snapshot.label } : {}),
    ...(snapshot.baselineCommit ? { baselineCommit: snapshot.baselineCommit } : {}),
  };
}

async function loadCodexFileRewindRepoContext(makerSession: { workDir: string; remoteHostId?: string | null }, sessionId: string) {
  if (makerSession.remoteHostId) return { kind: 'remote-session' as const };
  const cwd = await detectCwd(makerSession.workDir);
  if (!cwd.gitInstalled || !cwd.isGitRepo || !cwd.repoRoot || cwd.isInsideWorktree) return { kind: 'non-git-workdir' as const };

  const repoRoot = cwd.repoRoot;
  return enqueueGitRepoWrite(repoRoot, async () => {
    // 两个来源:隐藏引用链上的 shadow savepoint(新)+ 分支历史里的 legacy
    // savepoint(旧版本写进用户分支的,升级后仍要可回退)。planner 分桶处理,
    // 不要求两者之间有全局时间序。
    const [shadowResult, legacySnapshots] = await Promise.all([
      listShadowSavepoints(repoRoot, sessionId),
      listSnapshots(repoRoot),
    ]);
    const savepointsNewestFirst = [
      ...shadowResult.entries.map(toPlannerSavepoint),
      ...legacySnapshots.map(toPlannerSavepoint),
    ];
    if (savepointsNewestFirst.length === 0 && !shadowResult.truncated) return { kind: 'local-git' as const, repoRoot, currentHead: '', currentBranch: '', savepointsNewestFirst: [] };

    // unborn HEAD(空仓库首轮)下 shadow 链可能已存在;HEAD/branch 只影响 legacy
    // 桶的过滤与展示,取不到就退化为空串。
    const [currentHead, currentBranch] = await Promise.all([
      getHead(repoRoot).catch(() => ''),
      getCurrentBranch(repoRoot).catch(() => ''),
    ]);

    return {
      kind: 'local-git' as const,
      repoRoot,
      currentHead,
      currentBranch,
      savepointsNewestFirst,
      ...(shadowResult.truncated ? { shadowSavepointsTruncated: true } : {}),
    };
  });
}

/**
 * Commit：真执行 rewind。
 *
 * Stage 2 C2 后 agent 那一刀全部封装在 maker session.commitRewindFiles 里:
 *   - Claude: rewindFiles(userUuid, dryRun:false) + close + pendingRewindTo
 *   - Codex: thread/rollback(numTurns)
 *
 * 本函数额外负责:
 *   ④ SQLite 事务: messages.rewind_at + sessions reset tokens + bump userSendAt
 *      + 可选 sdk_session_id replacement thread id 同步写回。
 *
 * Claude 的 SDK 重启发生在用户下一次 send 时；Codex 的 thread/rollback 立即
 * 更新 app-server 里的 thread history。
 *
 * 已知 Claude V1 限制 (与重构前一致): pendingRewindTo 仅存内存, commit 后立即关 app
 * → 标记丢失, 下次启动 resume 走老 jsonl 模型仍能看到被 hide 的消息。建议用户
 * commit 后立即发一条消息把 rewind 应用掉。后续可持久化到 sessions 表新列。
 */
/**
 * Codex 回退的原生边界(#4421 / #4994):thread/rollback 不可用(分页线程,或 0.156.0 起
 * 运行时已移除该方法)时 maker-core 按它 fork。target 之前的时间线里,最近一个已完成
 * turn 的持久化 nativeForkAnchor(lastTurnId);没有锚点(旧数据/上一轮失败)时退到最近
 * 一条真实模型/工具输出的时间戳,由 maker-core 经 thread/turns/list 解析。两者都没有且
 * target 是当前原生线程的第一轮时标记 rewindsToNativeThreadStart,由 maker-core 换成空
 * 线程;否则什么都不传。判定逻辑与 fork 共用,原生 turn 计数含失败/重试轮次,不能拿
 * 可见 user 消息数去数。
 */
async function loadCodexRewindNativeBoundary(
  sessionId: string,
  ctx: Pick<RewindContext, 'targetCreatedAt' | 'targetRowid'>,
  liveSdkSessionId: string | undefined,
): Promise<{
  sdkSessionId?: string;
  lastTurnId?: string;
  forkAtTimestampMs?: number;
  rewindsToNativeThreadStart?: true;
}> {
  const currentSessionMeta = await getMaker().getSessionMeta(sessionId);
  const sdkSessionId =
    activeSdkSessionId(liveSdkSessionId) ??
    activeSdkSessionId(currentSessionMeta?.sdkSessionId ?? undefined);
  if (!sdkSessionId) return {};
  const db = getDbClient().drizzle;
  const [sessionRow] = await db
    .select({ clearedAt: sessions.clearedAt })
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .limit(1);
  const clearedAt = sessionRow?.clearedAt ?? null;
  if (clearedAt !== null && ctx.targetCreatedAt <= clearedAt) {
    // /clear 之后旧 target 已不在当前原生线程。空时间线不能当成第一轮,否则会换空
    // 线程并把 clear 之后的新消息一并软删(#4994 review P1)。
    throw rewindError(
      'REWIND_UNSUPPORTED_HISTORY',
      '目标消息在 /clear 边界之前,当前引擎的会话历史无法回滚到那里',
    );
  }
  const beforeTarget =
    ctx.targetRowid === undefined
      ? lt(messages.createdAt, ctx.targetCreatedAt)
      : or(
          lt(messages.createdAt, ctx.targetCreatedAt),
          and(eq(messages.createdAt, ctx.targetCreatedAt), lt(messageRowid, ctx.targetRowid)),
        );
  // /clear 与 context_rebuild 之后是新的原生线程,之前的行不能拿来当锚点或时间戳。
  // context_rebuild 的写入契约是 rewind_at 固定非 NULL,需豁免可见性过滤才能看到边界。
  const inTimeline = and(
    eq(messages.sessionId, sessionId),
    sql`${messages.createdAt} > ${clearedAt ?? -1}`,
    beforeTarget,
  );
  // 只需回看到上一条 user / 引擎切换边界;取最近 200 行足够覆盖一轮的工具输出。
  const recent = await db
    .select({
      role: messages.role,
      content: messages.content,
      agentMeta: messages.agentMeta,
      createdAt: messages.createdAt,
    })
    .from(messages)
    .where(and(inTimeline, or(isNull(messages.rewindAt), eq(messages.role, 'context_rebuild'))))
    .orderBy(desc(messages.createdAt), desc(messageRowid))
    .limit(200);
  const rows = [...recent].reverse();
  const lastTurnId = resolveCodexTurnAnchor(rows, sdkSessionId);
  if (lastTurnId) return { sdkSessionId, lastTurnId };
  const forkAtTimestampMs = resolveCodexForkEventTimestamp(rows);
  if (forkAtTimestampMs !== undefined) return { sdkSessionId, forkAtTimestampMs };
  // 第一轮判定要看完整时间线:切回停泊线程时,更早的片段仍属于当前线程。只取 user 与
  // 边界行,user 正文不参与判定,不读出来。
  const timeline = await db
    .select({
      role: messages.role,
      content: sql<string>`CASE WHEN ${messages.role} = 'agent_switch' THEN ${messages.content} ELSE '' END`,
      createdAt: messages.createdAt,
    })
    .from(messages)
    .where(
      and(
        inTimeline,
        or(
          and(eq(messages.role, 'user'), isNull(messages.rewindAt)),
          and(eq(messages.role, 'agent_switch'), isNull(messages.rewindAt)),
          eq(messages.role, 'context_rebuild'),
        ),
      ),
    )
    .orderBy(asc(messages.createdAt), asc(messageRowid));
  return isCodexNativeThreadStart(
    timeline.map((row) => ({ ...row, agentMeta: null })),
    sdkSessionId,
  )
    ? { sdkSessionId, rewindsToNativeThreadStart: true }
    : { sdkSessionId };
}

export async function commitRewindAtMessage(
  sessionId: string,
  clientId: string,
  opts?: { requireLatestUser?: boolean; allowFileRestore?: boolean },
): Promise<Session> {
  const ctx = await loadRewindContext(sessionId, clientId, opts);

  // makerSession 必有 (loadRewindContext 已 guard); 这里只为类型收紧。
  const makerSession = getMaker().getSession(sessionId);
  if (!makerSession) {
    throw rewindError('NO_LIVE_QUERY', '会话未激活');
  }

  // ── 段 1: SDK 副作用全部委托给 maker-core ──
  // userUuid 缺失 (老消息) 时跳 SDK 文件回滚, 直接进 DB 段; ctx.assistantUuid 设进
  // pendingRewindTo, 下次 send 仍走三件套 (forkSession=true CLI 端兜底回滚)。
  let rewindResult: Awaited<ReturnType<typeof makerSession.commitRewindFiles>> | undefined;
  let nativeForkAnchorSessionMap: Array<[string, string]> | undefined;
  if (ctx.agentKind === 'codex' || ctx.agentKind === 'pi') {
    // thread/rollback 不可用(分页线程 #4421、0.156.0 起已移除 #4994):把 target 之前的
    // 原生 turn 边界(持久化锚点、事件时间戳或线程第一轮标记)一并交给 maker-core,
    // 由它改走 thread/fork 或换空线程。
    const { sdkSessionId: previousSdkSessionId, ...nativeBoundary } =
      ctx.agentKind === 'codex'
        ? await loadCodexRewindNativeBoundary(sessionId, ctx, makerSession.sdkSessionId)
        : {};
    const commitThreadRollback = () =>
      makerSession.commitRewindFiles('', '', { tailTurnsToDrop: ctx.tailTurnsToDrop, ...nativeBoundary });
    const logCompensationError = (compErr: unknown, rollbackCommit: string | null) => {
      log.error(`[rewind commit] ${ctx.agentKind} file rewind compensation failed`, {
        sessionId,
        rollbackCommit,
        error: compErr instanceof Error ? compErr.message : String(compErr),
      });
    };
    // Preview that told the user files would not change must not later restore
    // them if a savepoint appears between preview and confirm.
    if (opts?.allowFileRestore === false) {
      rewindResult = await commitThreadRollback();
    } else {
      const filePlan = await buildCodexFilePlanForSession(sessionId, clientId, ctx.codexUserMessages ?? [], makerSession);
      // shadow 保存点走文件恢复执行器,legacy 保存点走原 revert 执行器;
      // conversation-only 计划两个执行器都会直接透传 thread rollback。
      const result =
        filePlan.mode === 'file-restore'
          ? await executeCodexFileRestorePlanWithThreadRollback(filePlan, sessionId, {
              commitThreadRollback,
              onCompensationError: (compErr, execution) =>
                logCompensationError(compErr, execution.rollbackCommit),
            })
          : await executeCodexFileRewindPlanWithThreadRollback(filePlan, sessionId, {
              commitThreadRollback,
              onCompensationError: (compErr, execution) =>
                logCompensationError(compErr, execution.rollbackCommit),
            });
      rewindResult = result.threadRollback;
    }
    // thread/rollback 或分页 fork 换出新 thread id 时,保留消息里的 nativeForkAnchor
    // 仍指向旧 thread,下一次回退/fork 会把它们判为异线程锚点丢弃(#4423 review
    // P2)。与 fork.session 一样在同一事务里把 sdkSessionId 重映射到新 thread。
    if (
      ctx.agentKind === 'codex' &&
      previousSdkSessionId &&
      rewindResult?.sdkSessionId &&
      rewindResult.sdkSessionId !== previousSdkSessionId
    ) {
      nativeForkAnchorSessionMap = [[previousSdkSessionId, rewindResult.sdkSessionId]];
    }
  } else if (ctx.userUuid && opts?.allowFileRestore !== false) {
    rewindResult = await makerSession.commitRewindFiles(ctx.userUuid, ctx.assistantUuid!);
  } else {
    log.info(
      opts?.allowFileRestore === false
        ? `[rewind commit] sid=${sessionId.slice(0, 8)} allowFileRestore=false — skip SDK rewindFiles`
        : `[rewind commit] sid=${sessionId.slice(0, 8)} userUuid missing — skip SDK rewindFiles, only set pendingRewindTo via empty userUuid path`,
    );
    // 走一遍仅为了让 maker-core 设 pendingRewindTo. 它内部 rewindFiles('') 会 SDK 报错,
    // 我们 catch 了 warn + 继续 (close + 设标记仍执行)。这与老链路 "userUuid 缺时跳过
    // 文件回滚但保留三件套重启" 行为一致。
    rewindResult = await makerSession.commitRewindFiles('', ctx.assistantUuid!);
  }

  // ── 段 2：SQLite 事务（软删消息 + 同步写回 replacement sdk_session_id）──
  // edit-last-message 的第二道最新校验直接下沉进 worker 事务临界区(payload 带
  // requireLatestUser 标志,worker 在软删同一同步临界区内断言"target 之后无
  // 更新可见 user 消息"),覆盖"段 1 SDK 副作用执行期间(可达数百 ms)乃至
  // 事务排队期间落库"的全部窗口——校验与软删真正原子(bot review P2 的诉求)。
  // 命中时文件回滚可能已发生,但**对话历史仍完好**:宁可留下"文件已回退、
  // 对话未裁剪"的可恢复态并报错,也不静默软删刚追加的新轮次。
  const now = Date.now();
  try {
    await getDbClient().tx('rewind.commit', {
      sessionId,
      targetCreatedAt: ctx.targetCreatedAt,
      targetMessageId: ctx.targetMessageId,
      targetClientId: ctx.targetClientId,
      targetMessageUuid: ctx.userUuid,
      preserveMessageUuid: ctx.preserveMessageUuid,
      sdkSessionId: rewindResult?.sdkSessionId,
      now,
      ...(opts?.requireLatestUser ? { requireLatestUser: true } : {}),
      ...(nativeForkAnchorSessionMap ? { nativeForkAnchorSessionMap } : {}),
    });
    if (ctx.assistantUuid) {
      setLastAssistantTranscriptUuid(sessionId, ctx.assistantUuid);
    }
  } catch (err) {
    // 原子守卫命中:软删未发生(并发落库的新消息被保住)。必须向上抛而不能
    // 沿用"warn + 继续"——继续会让编辑链路误以为 rewind 成功并触发重发。
    if (err instanceof Error && err.message.includes('REWIND_TARGET_NOT_LATEST')) {
      log.error(
        `[rewind commit] sid=${sessionId.slice(0, 8)} target 在软删临界区内被新 user 消息超越——事务未执行(文件回滚可能已发生)`,
      );
      throw rewindError(
        'REWIND_TARGET_NOT_LATEST',
        'target 之后已有更新的 user 消息,编辑重发拒绝执行(防止误删新轮次)',
      );
    }
    // 轮 40-w4-t13 HIGH:一般 DB 事务失败(SQLite 锁/IO 等)同样必须上抛 ——
    // SDK 侧 rewind 已把 Pi 运行态切到新 session/sdkSessionId, 若 DB 停在旧
    // 身份, 调用方误以为 rewind 成功, 重启后会恢复错分支(运行态与持久化
    // 分叉)。fail-closed: 显式报错, 不把旧 row 当成功结果返回。
    log.error(
      `[rewind commit] sid=${sessionId.slice(0, 8)} DB 事务失败——SDK 已切新身份但持久化未落, rewind 状态分叉`,
      err,
    );
    throw rewindError(
      'REWIND_GIT_FAILED',
      `rewind 持久化失败(运行态已切换但 DB 未提交): ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const [row] = await getDbClient().drizzle.select().from(sessions).where(eq(sessions.id, sessionId));
  if (!row) {
    throw new Error('Rewind session 更新后查询失败');
  }
  const session = sessionToCamel({ ...row, messageCount: 0 });
  // session-git-pr-context:rewind 软删消息后重算 PR 引用——只出现在被
  // 回滚段里的 PR 不该再挂在会话徽标上。fire-and-forget,失败仅 warn。
  // 放在返回值查询之后，避免辅助重算抢占主流程的 DB 读路径。
  void recomputePrRefsForSession(sessionId).catch(() => undefined);
  return session;
}
