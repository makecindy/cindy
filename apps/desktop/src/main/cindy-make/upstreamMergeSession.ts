import { and, eq } from 'drizzle-orm';
import { getDbClient } from '../localDb/client/current.js';
import { sessions, messages } from '../localDb/schema.js';
import { sessionCreateToRow } from '../localDb/mapper.js';
import { emitSessionCreated } from '../localDb/ipc/sessionCreatedBroadcast.js';
import {
  captureDataOwnerBroadcastScope,
  isDataOwnerBroadcastScopeCurrent,
} from '../device-link/broadcast-tap.js';
import { createBusinessSessionId } from '../sessionIds.js';
import { normalizeDbAgentKind, dbToMakerAgentKind } from '../../shared/agentKindConversion.js';
import type { CindyMakeTaskOptions } from '../../shared/cindyMakeDoctor.js';
import {
  CINDY_MAKE_MERGE_SESSION_SOURCE,
  type CindyMakeMergeState,
} from '../../shared/cindyMakeMerge.js';
import { normalizeWorkingDirForStorage } from '../../shared/workingDir.js';
import { formatCindyMakeMergeTitle } from '../../shared/cindyMakeMergeTitle.js';
import { dispatchCindyMakeMergeTask } from './taskRuntime.js';
import { mergeError, mergeWorktree } from './upstreamMerge.js';
import { t } from '../i18n.js';

/** What to do about personal changes the check found missing from the result. */
export function missingChangesPrompt(state: CindyMakeMergeState): string {
  const missing = state.missing;
  if (!missing) return '';
  return `Cindy 核对发现结果里缺少 ${missing.count} 项个人修改：${missing.commits.join('、')}${missing.count > missing.commits.length ? ' 等' : ''}。请用 git show 逐个查看它们实现的功能，在当前目录把这些功能补回到结果里（可以直接修改文件，不需要提交，Cindy 会在本轮结束后提交并重新核对），然后运行相关验证并说明结果。确实应当舍弃其中某项时，向用户说明原因，并请用户在 Cindy 设置页的同步状态里自己选择「仍然使用这个结果」；不要自行舍弃。`;
}

export function upstreamMergePrompt(state: CindyMakeMergeState): string {
  const missing = state.missing ? missingChangesPrompt(state) + '\n' : '';
  if (state.feature)
    return `请在当前独立工作目录解决 Cindy Make 的${state.feature.action === 'revert' ? '撤销合入' : '合入个人版'}冲突。
Cindy 已应用当前这一步的改动，冲突仅在当前目录。先检查 git status 和冲突文件；不要重新执行 merge、revert、rebase 或 reset，不要 push，也不要修改 main、cindy-personal 或其他工作目录。
本步之前的个人版本：${state.baselineCommit}。对应制作标记：${state.feature.runId}。
${state.feature.action === 'revert' ? '目标是撤销本次制作的个人功能，同时保留官方更新和其他制作的修改。不要把整个项目恢复到旧版本；遇到后续功能依赖它且无法判断取舍时询问用户。' : '保留本次制作的功能，也保留个人版已有的其他功能和官方更新。逐项理解冲突，不整批选择 ours/theirs。'}
解决后可以 git add 标记完成，不要自行提交；运行受影响的测试与类型检查，并说明结果。Cindy 会在正常结束后核验原个人目录未变化，创建本地提交；若本次撤销还有后续改动需要处理，将由 Cindy 继续应用。此任务不生成个人版。`;
  if (state.remote && state.strategy === 'combine') {
    const github = state.remote.commit ?? state.upstreamCommit;
    // This computer is on the newer official version: GitHub's own changes go onto it.
    const ontoLocal = github !== state.upstreamCommit;
    return (
      missing +
      (state.rebaseReview
        ? `注意：${ontoLocal ? 'GitHub 上' : '这台电脑'}的个人历史包含在合并提交中额外完成的修改，普通 rebase 不会自动保留它们。本目录的 rebase 可能已经完成，即使没有文本冲突，也必须对照下方${ontoLocal ? 'GitHub 上' : '这台电脑'}的个人版提交逐项核对功能，补回遗漏的处理结果并验证；不要重新开始 rebase。\n`
        : '') +
      `请在当前独立工作目录中合并两台电脑的 Cindy 个人版修改。目标是两边的功能都不能丢：GitHub 上的修改和这台电脑的修改都是用户自己做的，必须同时保留。
GitHub 上的个人版（由另一台电脑上传）：${github}
这台电脑的个人版：${state.baselineCommit}
合并结果基于的官方版本：${state.remote.base}
Cindy 已在当前隔离目录启动 rebase，${ontoLocal ? '这台电脑已在更新的官方版本上，正把 GitHub 上独有的修改逐个放到这台电脑的版本之上' : '正把这台电脑独有的修改逐个放到 GitHub 版本之上'}。先检查 git status、当前冲突与待重放提交，并用 git log／git show 查看两边各自的提交，理解每一边想实现的功能。不要重新执行 git merge 或重新开始 rebase，不要使用 rebase --skip、reset --hard，也不要整批选择 ours/theirs——那会丢掉其中一边的功能。
逐个冲突把两边的功能合在一起；确实无法同时保留时，向用户说明两边各自的行为并请用户决定，不要自行舍弃。
只在当前工作目录处理冲突，可以 git add 标记解决。每次解决后继续现有 rebase：git -c user.name="Cindy Make" -c user.email=cindy-make@localhost.invalid -c core.editor=true -c commit.gpgSign=false rebase --continue。后续再次遇到冲突则逐项处理，直到 rebase 完整结束。保留提交的 Signed-off-by，禁止 push，不修改 main、cindy-personal 或其他工作目录。
按仓库规则运行受影响测试和类型检查；如需修改非冲突代码，留在本目录由 Cindy 在完成时本地提交。最后分别说明 GitHub 一侧和这台电脑一侧保留了哪些功能、冲突如何处理、验证结果与未验证项。
Cindy 会在本轮正常结束后核实没有未完成的 rebase／冲突、作为基础的一边已完整包含、这台电脑的个人版未被并发修改，再把 cindy-personal 更新到这份结果并上传到用户的 GitHub；这台电脑原来的个人版会留有备份。此任务不生成个人版。`
    );
  }
  if (state.strategy === 'rebase')
    return (
      missing +
      (state.rebaseReview
        ? '注意：原个人历史包含在合并提交中额外完成的修改，普通 rebase 不会自动保留它们。本目录的 rebase 可能已经完成，即使没有文本冲突，也必须对照下方原个人分支提交逐项核对功能，补回遗漏的合并处理结果并验证；不要重新开始 rebase。\n'
        : '') +
      `请在当前独立工作目录中解决 Cindy 个人版更新到最新官方版本时的 rebase 冲突，确保不丢失本地已有功能。
个人分支更新前提交：${state.baselineCommit}
本次官方目标：${state.ref} (${state.upstreamCommit})
Cindy 已在当前隔离目录启动 rebase。先检查 git status、当前冲突与待重放提交；不要重新执行 git merge 或重新开始 rebase，不要使用 rebase --skip、reset --hard 或整批选择 ours/theirs 丢弃个人功能。
只在当前工作目录处理冲突，可以 git add 标记解决。每次解决后继续现有 rebase：git -c user.name="Cindy Make" -c user.email=cindy-make@localhost.invalid -c core.editor=true -c commit.gpgSign=false rebase --continue。后续再次遇到冲突则逐项处理，直到 rebase 完整结束。保留提交的 Signed-off-by，禁止 push，不修改 main、cindy-personal 或其他工作目录。
按仓库规则运行受影响测试和类型检查；如需修改非冲突代码，留在本目录由 Cindy 在完成时本地提交。最后说明保留的个人功能、处理结果、验证和未验证项。遇到无法判断的产品取舍向用户说明并确认。
Cindy 会在本轮正常结束后核实没有未完成的 rebase／冲突、最新官方提交已包含、原个人分支未被并发修改，再将 cindy-personal 更新到这份已提交结果。此任务不生成个人版，也不推送远端。`
    );
  return `请在当前独立工作目录中安全合并 Cindy 上游更新，解决冲突，确保不丢失本地已有功能。
个人分支原提交：${state.baselineCommit}
本次上游目标：${state.ref} (${state.upstreamCommit})
先检查 Git 状态和双方变更，逐项理解冲突，同时保留个人功能和上游修复，不要整批选择 ours/theirs，不要用 reset --hard 或删除文件来掩盖冲突。涉及无法判断的产品取舍时，向用户说明并确认。
上游文件差异已应用到当前独立工作目录，冲突保留在文件及索引中。先检查现场，不要重新执行 git merge。只在当前工作目录及当前分支中修改，不要切换、重置或直接修改 main、cindy-personal 或其他工作目录。
不要自行创建额外提交或推送。解决冲突后可以用 git add 标记已解决。按仓库规则运行与改动匹配的测试和类型检查，最后说明冲突如何解决、保留了哪些本地功能、验证结果与未验证项。
这是旧版保留的文件合并现场。Cindy 会在本轮正常结束后核实冲突已解决、个人版未被并发修改，将结果迁移到对应官方基线并本地提交个人差异，保留原有历史备份。若检查未通过，现场会保留供继续处理。此任务不生成个人版、不推送远端。`;
}

export async function ensureUpstreamMergeSession(
  userData: string,
  state: CindyMakeMergeState,
  options: CindyMakeTaskOptions | undefined,
  bind: (id: string) => void,
  ownerCurrent: () => boolean,
): Promise<string> {
  const dbClient = getDbClient();
  const db = dbClient.drizzle;
  const owner = captureDataOwnerBroadcastScope();
  const isCurrent = () =>
    ownerCurrent() && isDataOwnerBroadcastScopeCurrent(owner) && getDbClient() === dbClient;
  const check = () => {
    if (!isCurrent()) throw mergeError('busy');
  };
  if (!options && state.feature) {
    const [origin] = await db
      .select()
      .from(sessions)
      .where(eq(sessions.id, state.feature.taskSessionId))
      .limit(1);
    check();
    if (origin?.source === 'cindy-make' && !origin.remoteHostId)
      options = {
        agentKind: normalizeDbAgentKind(origin.agentKind),
        model: origin.model ?? undefined,
        providerId: origin.providerId,
        effort: origin.effort ?? undefined,
        permissionMode: origin.permissionMode ?? undefined,
        fastMode: origin.fastMode ?? undefined,
      };
  }
  let id = state.sessionId ?? createBusinessSessionId();
  const workingDir = mergeWorktree(userData, state.id);
  const [found] = await db.select().from(sessions).where(eq(sessions.id, id)).limit(1);
  let existing: typeof found | undefined = found;
  check();
  if (
    existing &&
    (existing.source !== CINDY_MAKE_MERGE_SESSION_SOURCE ||
      existing.remoteHostId ||
      normalizeWorkingDirForStorage(existing.workingDir) !==
        normalizeWorkingDirForStorage(workingDir))
  )
    throw mergeError('unavailable');
  // An explicit Resolve click can continue retained work after the old task was removed.
  if (existing && existing.status !== 'active') {
    id = createBusinessSessionId();
    existing = undefined;
  }
  // Bind the ID before INSERT, so retries after a crash never create a second task.
  bind(id);
  const createdAt = Date.now();
  const row =
    existing ??
    sessionCreateToRow(
      id,
      {
        ...options,
        agentKind: normalizeDbAgentKind(options?.agentKind),
        title: formatCindyMakeMergeTitle(
          t(
            state.feature
              ? state.feature.action === 'revert'
                ? 'cindyMake.history.revertTaskTitle'
                : 'cindyMake.history.mergeTaskTitle'
              : state.remote
                ? 'cindyMake.merge.combine.taskTitle'
                : 'cindyMake.merge.taskTitle',
          ),
          createdAt,
        ),
        workingDir,
        workspaceKind: 'project',
        source: CINDY_MAKE_MERGE_SESSION_SOURCE,
      },
      createdAt,
    );
  if (!existing) {
    await db.insert(sessions).values(row);
    check();
    emitSessionCreated(id);
  }
  // Keep the original first-step key for restored tasks. A later delta gets
  // one new message in this same task, not another task borrowing its worktree.
  const step = state.feature?.nextStep ?? 0;
  const clientId = `cindy-make-merge-first-${state.id}${step > 0 ? `-step-${step}` : ''}`;
  const [first] = await db
    .select({ id: messages.id })
    .from(messages)
    .where(and(eq(messages.sessionId, id), eq(messages.clientId, clientId)))
    .limit(1);
  check();
  // A persisted first message belongs to the ordinary retry/continue UI, not another dispatch.
  if (
    !first &&
    row.status === 'active' &&
    row.clearedAt === null &&
    !(existing && state.error === 'interrupted')
  ) {
    await dispatchCindyMakeMergeTask(
      id,
      upstreamMergePrompt(state),
      {
        id,
        agentKind: dbToMakerAgentKind(row.agentKind),
        workingDir,
        model: row.model,
        effort: row.effort,
        providerId: row.providerId,
        fastMode: row.fastMode,
        permissionMode: row.permissionMode,
        planMode: row.planModeEnabled,
      },
      isCurrent,
      clientId,
    );
  }
  check();
  return id;
}

/** One follow-up message in the resolver's own task; never a second task. */
export async function remindUpstreamMergeSession(
  state: CindyMakeMergeState,
  isCurrent: () => boolean,
): Promise<void> {
  if (!state.sessionId || !state.missing) throw mergeError('unavailable');
  const dbClient = getDbClient();
  const owner = captureDataOwnerBroadcastScope();
  const current = () =>
    isCurrent() && isDataOwnerBroadcastScopeCurrent(owner) && getDbClient() === dbClient;
  const [row] = await dbClient.drizzle
    .select()
    .from(sessions)
    .where(eq(sessions.id, state.sessionId))
    .limit(1);
  if (!current()) throw mergeError('busy');
  if (!row || row.status !== 'active' || row.source !== CINDY_MAKE_MERGE_SESSION_SOURCE)
    throw mergeError('unavailable');
  await dispatchCindyMakeMergeTask(
    row.id,
    missingChangesPrompt(state),
    {
      id: row.id,
      agentKind: dbToMakerAgentKind(row.agentKind),
      workingDir: row.workingDir,
      model: row.model,
      effort: row.effort,
      providerId: row.providerId,
      fastMode: row.fastMode,
      permissionMode: row.permissionMode,
      planMode: row.planModeEnabled,
    },
    current,
    `cindy-make-merge-check-${state.id}`,
  );
}

export async function assertUpstreamMergeSession(
  userData: string,
  state: CindyMakeMergeState,
): Promise<void> {
  if (!state.sessionId) throw mergeError('unavailable');
  const [row] = await getDbClient()
    .drizzle.select()
    .from(sessions)
    .where(eq(sessions.id, state.sessionId))
    .limit(1);
  if (
    !row ||
    row.status !== 'active' ||
    row.source !== CINDY_MAKE_MERGE_SESSION_SOURCE ||
    row.remoteHostId ||
    normalizeWorkingDirForStorage(row.workingDir) !==
      normalizeWorkingDirForStorage(mergeWorktree(userData, state.id))
  )
    throw mergeError('unavailable');
}
