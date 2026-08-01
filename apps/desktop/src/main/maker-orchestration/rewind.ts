/**
 * rewind-session：消息级 Rewind 业务函数。
 *
 * Stage 2 C2 重构后:SDK 调用全部走 maker-core 的 Session.previewRewindFiles /
 * commitRewindFiles。本文件只剩业务编排:
 *   - Claude: 反向找 prior assistant uuid (跳 subagent / 跳 rewinded)
 *   - Codex: 计算 target 之后要裁掉的完整 user turn 数，交给 thread/rollback
 *   - SQLite 事务 (messages.rewind_at + sessions reset tokens + bump userSendAt)
 *
 * Claude 三件套 (resume + resumeSessionAt + forkSession) 重启逻辑封装在
 * ClaudeCodeAgent 内部。Codex 的 thread/rollback 会立即更新 app-server 上下文。
 *
 * 关键 uuid 拆解 (与重构前一致):
 *   - resumeSessionAt 锚点 = **prior assistant uuid** (SDK 类型注释:
 *     "should be from SDKAssistantMessage.uuid")。从 messages 表反向查。
 *   - rewindFiles(userUuid, ...) → preview dryRun 取文件清单;
 *     commit dryRun:false 立即文件回滚。
 *     user uuid 缺失 (老消息) → preview 走 Empty, commit 跳过文件回滚交
 *     forkSession=true 兜底 (功能不残)。
 *   - Codex 没有 message uuid / file checkpoint，preview 永远是 Empty，commit 用
 *     tailTurnsToDrop 调 thread/rollback。
 */

import { and, asc, eq, gt, gte, isNull, or, sql } from 'drizzle-orm';

import { getDbClient } from '../localDb/client/current';
import { sessions, messages } from '../localDb/schema';
import { sessionToCamel } from '../localDb/mapper';
import { getMaker } from '../maker-host/index.js';
import type { Session } from '../../renderer/lib/ccAgent.types';
import type { RewindFilesResult } from '@cindy/maker-core';

import { createLogger } from '../logger';
import { setLastAssistantTranscriptUuid } from '../messagePersistBroadcaster.js';
import { recomputePrRefsForSession } from '../git-context/prRefsStore.js';
import {
  buildCodexFileRewindPlan,
  CodexFileRewindPlanError,
  type CodexRewindPlan,
  type CodexRewindUserMessage,
} from '../git-snapshot/codexFileRewindPlanner';
import {
  executeCodexFileRewindPlanWithThreadRollback,
} from '../git-snapshot/codexFileRewindExecutor';
import { enqueueGitRepoWrite } from '../git-snapshot/gitRepoWriteQueue';
import { getCurrentBranch, getHead, listSnapshots } from '../git-snapshot/gitSnapshotService';
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
  const [boundaryAfterTarget] = await db
    .select({ rowid: messageRowid })
    .from(messages)
    .where(
      and(
        eq(messages.sessionId, sessionId),
        eq(messages.role, 'agent_switch'),
        isNull(messages.rewindAt),
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
      '目标消息在引擎切换边界之前,当前引擎的会话历史无法回滚到那里',
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
      filesChanged: [],
      insertions: 0,
      deletions: 0,
    };
  }

  log.info(`[rewind dryRun] sid=${sessionId.slice(0, 8)} userUuid=${ctx.userUuid}`);
  return await makerSession.previewRewindFiles(ctx.userUuid);
}

async function previewCodexFileRewindPlan(plan: CodexRewindPlan): Promise<RewindFilesResult> {
  if (plan.mode !== 'file-rewind') return { canRewind: true, filesChanged: [], insertions: 0, deletions: 0 };
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

function parseNumstat(value: string): number {
  const n = Number.parseInt(value, 10); return Number.isFinite(n) ? n : 0;
}

async function buildCodexFilePlanForSession(sessionId: string, targetMessageClientId: string, userMessages: readonly CodexRewindUserMessage[], makerSession: { workDir: string; remoteHostId?: string | null }) {
  try {
    return buildCodexFileRewindPlan({ sessionId, targetMessageClientId, userMessages, repo: await loadCodexFileRewindRepoContext(makerSession) });
  } catch (err) {
    if (err instanceof CodexFileRewindPlanError) {
      if (err.code === 'MESSAGE_NOT_FOUND') throw rewindError('MESSAGE_NOT_FOUND', err.message);
      throw rewindError('REWIND_UNSUPPORTED_HISTORY', err.message);
    }
    throw err;
  }
}

async function loadCodexFileRewindRepoContext(makerSession: { workDir: string; remoteHostId?: string | null }) {
  if (makerSession.remoteHostId) return { kind: 'remote-session' as const };
  const cwd = await detectCwd(makerSession.workDir);
  if (!cwd.gitInstalled || !cwd.isGitRepo || !cwd.repoRoot || cwd.isInsideWorktree) return { kind: 'non-git-workdir' as const };

  const repoRoot = cwd.repoRoot;
  return enqueueGitRepoWrite(repoRoot, async () => {
    const snapshots = await listSnapshots(repoRoot);
    if (snapshots.length === 0) return { kind: 'local-git' as const, repoRoot, currentHead: '', currentBranch: '', savepointsNewestFirst: [] };

    const [currentHead, currentBranch] = await Promise.all([getHead(repoRoot), getCurrentBranch(repoRoot)]);

    return {
      kind: 'local-git' as const,
      repoRoot,
      currentHead,
      currentBranch,
      savepointsNewestFirst: snapshots.map((snapshot) => ({ commit: snapshot.commit, sessionId: snapshot.sessionId, kind: snapshot.kind, branch: snapshot.branch ?? '', parentCount: snapshot.parentCount, ...(snapshot.anchor ? { anchor: snapshot.anchor } : {}), ...(snapshot.label ? { label: snapshot.label } : {}) })),
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
export async function commitRewindAtMessage(
  sessionId: string,
  clientId: string,
  opts?: { requireLatestUser?: boolean },
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
  if (ctx.agentKind === 'codex' || ctx.agentKind === 'pi') {
    const filePlan = await buildCodexFilePlanForSession(sessionId, clientId, ctx.codexUserMessages ?? [], makerSession);
    const result = await executeCodexFileRewindPlanWithThreadRollback(filePlan, sessionId, {
      commitThreadRollback: () =>
        makerSession.commitRewindFiles('', '', { tailTurnsToDrop: ctx.tailTurnsToDrop }),
      onCompensationError: (compErr, execution) => {
        log.error(`[rewind commit] ${ctx.agentKind} file rewind compensation failed`, {
          sessionId,
          rollbackCommit: execution.rollbackCommit,
          error: compErr instanceof Error ? compErr.message : String(compErr),
        });
      },
    });
    rewindResult = result.threadRollback;
  } else if (ctx.userUuid) {
    rewindResult = await makerSession.commitRewindFiles(ctx.userUuid, ctx.assistantUuid!);
  } else {
    log.info(
      `[rewind commit] sid=${sessionId.slice(0, 8)} userUuid missing — skip SDK rewindFiles, only set pendingRewindTo via empty userUuid path`,
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
    log.warn(
      `DB transaction after marking pendingRewindTo failed for ${sessionId}:`,
      err,
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
