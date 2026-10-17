import { buildBotMemoryScopeKey } from '@cindy/maker-core';
import {
  activeOwnerScopeKey,
  isAppSessionBoundaryPending,
  ownerScopedUserDataPath,
} from '../appSessionState.js';
import { getDbClient } from '../localDb/client/current.js';
import { drainPersistQueue, enqueueDurableWrite } from '../messagePersistBroadcaster.js';
import { patchMessageAgentMetaWithResult } from '../localDb/ipc/messages.js';
import { learningReceiptPublisher } from './botLearningFeedback.js';
import {
  hasLearningEvidence,
  learningSnapshotBudget,
  learningSnapshotPrefix,
  learningReviewInstructions,
  learningReviewSchema,
} from './botLearningReviewPlan.js';
import { listBotSkills, readBotSkill } from './botSkillStore.js';
import { saveBotSkillForSession } from './botSkillService.js';
import { requestBotRuntimeEpochRefresh } from './botRuntimeEpochRefreshSignal.js';
import {
  applyWorkingMemoryProposal,
  readBotWorkingMemory,
  workingMemoryForReview,
  writeBotWorkingMemory,
  type WorkingMemoryProposal,
} from './botWorkingMemory.js';

const running = new Map<string, Promise<void>>();
/** 本轮取材最多取多少条消息;超出即视为截断,水位不推进到当前回复。 */
const TURN_REVIEW_ROWS = 80;
/** 单条正文每块多少字;用户 / 伙伴的长消息按块分多次复盘,整条补完才算覆盖。 */
const MESSAGE_CHUNK_CHARS = 6000;
/** 相邻块的重叠字数:跨块的句子和不足证据最短长度(8 字)的尾段都能在某一块里完整出现。 */
const MESSAGE_CHUNK_OVERLAP = 200;
const TEXT_ROLES = new Set(['user', 'assistant']);
/** 交互答复行(AskUserQuestion 的答案、计划审阅的批准 / 反馈):正文是用户的决定,按用户消息复盘。 */
const INTERACTION_ROLES = new Set(['ask_user', 'plan_review']);

/**
 * 把交互答复行归一成用户文本(与 messagePersistBroadcaster 落库时的文本投影同口径):
 * 已回答的问题 → "问题 → 答案" 逐行;批准的计划 → 计划正文;打回的计划 → 用户反馈;
 * 取消 / 未回答 → 空串(无内容,不进取材)。
 */
function interactionText(content: unknown): string {
  if (!content || typeof content !== 'object') return '';
  const c = content as Record<string, unknown>;
  if (c.answers && typeof c.answers === 'object') {
    if (c.status === 'cancelled') return '';
    const lines = Object.entries(c.answers as Record<string, unknown>)
      .filter(([, answer]) => typeof answer === 'string' && answer.trim())
      .map(([question, answer]) => (question.trim() ? `- ${question.trim()} → ${String(answer).trim()}` : `- ${String(answer).trim()}`));
    return lines.length ? `Clarifications:\n${lines.join('\n')}` : '';
  }
  if (typeof c.status === 'string' && ('plan' in c || 'feedback' in c)) {
    if (c.status === 'approved') return typeof c.plan === 'string' && c.plan.trim() ? `Approved plan:\n${c.plan.trim()}` : '';
    if (c.status === 'revised') return typeof c.feedback === 'string' ? c.feedback.trim() : '';
  }
  return '';
}
/** 模型省略 working(本轮没改动)时用的空提案:不加不删,只让水位跟上。 */
const EMPTY_WORKING_PROPOSAL: WorkingMemoryProposal = {
  threads: [],
  commitments: [],
  waiting: [],
  corrections: [],
  recentlyDone: [],
  resolved: [],
};
/** 缺口回补每批最多取多少条消息 / 多少字符;单条正文已截到 6000 字,所以每批至少前进一条。 */
const GAP_BACKFILL_ROWS = 40;
const GAP_BACKFILL_CHARS = 16000;
const REVIEW_ROLES = `role IN ('user','assistant','tool_use','tool_result','ask_user','plan_review')`;
/** Once per durable successful reply; serial per teammate, outside the chat/agent loop. */
export async function reviewTeammateLearning(sessionId: string, replyId: string): Promise<void> {
  const owner = activeOwnerScopeKey();
  const db = getDbClient();
  const publish = learningReceiptPublisher(sessionId);
  const current = () =>
    !isAppSessionBoundaryPending() && activeOwnerScopeKey() === owner && getDbClient() === db;
  await drainPersistQueue();
  if (!current()) return;
  const readOwner = () =>
    db.queryOne<{ botId: string; capabilities: string; rowid: number; meta: string }>(
      `
    SELECT b.bot_id AS botId, v.capabilities_json AS capabilities, m.rowid, m.agent_meta AS meta
    FROM messages m JOIN sessions s ON s.id=m.session_id
    JOIN bot_session_links b ON b.session_id=s.id JOIN bot_profiles p ON p.id=b.bot_id
    JOIN bot_profile_versions v ON v.bot_id=p.id AND v.version=p.current_version
    WHERE m.session_id=? AND m.client_id=? AND m.role='assistant' AND m.rewind_at IS NULL
      AND b.role='canonical' AND b.archived_at IS NULL AND p.status='active' AND s.source='bot' AND s.status='active'
      AND s.remote_host_id IS NULL AND (s.cleared_at IS NULL OR m.created_at > s.cleared_at)
  `,
      [sessionId, replyId],
    );
  const row = await readOwner();
  if (!current() || !row) return;
  const meta = JSON.parse(row.meta || '{}');
  if (
    meta.turnCompleted !== true ||
    meta.botLearningReviewed ||
    meta.parentUuid ||
    meta.botPrivateReply ||
    meta.botGroupLane
  )
    return;
  // Claim before awaiting the model. Restart/replayed terminals must not spend or write twice.
  const claimed = await enqueueDurableWrite(`learning-review:${sessionId}:${replyId}`, async () => {
    if (!current()) return false;
    const latest = await readOwner();
    if (!latest || JSON.parse(latest.meta || '{}').botLearningReviewed) return false;
    return !!(await patchMessageAgentMetaWithResult(sessionId, replyId, {
      botLearningReviewed: true,
    }));
  });
  if (!claimed) return;
  const key = `${owner}:${row.botId}`;
  const job = (running.get(key) ?? Promise.resolve())
    .catch(() => {})
    .then(async () => {
      if (!current() || !(await readOwner())) return;
      const root = ownerScopedUserDataPath();
      // 工作记忆账本随同一次复盘维护(不另起模型调用);读不到按空账本,写入 CAS 失败放弃本轮。
      const workingBefore = await readBotWorkingMemory(root, row.botId);
      type Record_ = { id: string; role: string; content: string; order: number };
      // 单条正文按 MESSAGE_CHUNK_CHARS 分块。用户 / 伙伴的消息被截尾即 partial——它们是账本新条目
      // 的证据来源,纠正 / 承诺可能就在长消息的尾部,没看完不能算覆盖;工具结果不是新条目的来源,
      // 截尾只影响 resolved 证据(条目多留一阵),按已覆盖处理,不为它逐块回补。
      const toSnapshot = (m: Record_, offset = 0) => {
        const parsed: unknown = JSON.parse(m.content);
        // 交互答复行的正文是用户的决定,归一成文本后按用户消息对待(证据规则同用户消息)。
        const interaction = INTERACTION_ROLES.has(m.role);
        const full: string = interaction ? interactionText(parsed) : typeof parsed === 'string' ? parsed : m.content;
        const role = interaction ? 'user' : m.role;
        return {
          id: m.id,
          role,
          order: m.order,
          text: full.slice(offset, offset + MESSAGE_CHUNK_CHARS),
          offset,
          partial: TEXT_ROLES.has(role) && full.length > offset + MESSAGE_CHUNK_CHARS,
        };
      };
      // 没有内容的交互行(取消 / 未回答)不进取材,也不算截断。
      const hasText = (m: ReturnType<typeof toSnapshot>) => m.text.length > 0;
      // /clear 之前的消息始终不取。
      const clearedAtFilter = `AND created_at > COALESCE((SELECT cleared_at FROM sessions WHERE id=?), 0)`;
      const prev = await db.queryOne<{ id: string; rowid: number }>(
        `SELECT client_id AS id, rowid FROM messages WHERE session_id=? AND rowid < ? AND rewind_at IS NULL
         AND role='assistant' AND json_valid(agent_meta) AND json_extract(agent_meta, '$.turnCompleted')=1
         ORDER BY rowid DESC LIMIT 1 /* prev-completed */`,
        [sessionId, row.rowid],
      );
      const prevCompleted = prev?.rowid ?? 0;
      // 本轮取材:上一条完成回复之后到当前回复。
      const records = await db.query<Record_>(
        `
      SELECT client_id AS id, role, content, rowid AS 'order' FROM messages
      WHERE session_id=? AND rewind_at IS NULL AND rowid <= ? AND rowid > ? ${clearedAtFilter}
      AND ${REVIEW_ROLES} ORDER BY CASE WHEN role='user' THEN 0 ELSE 1 END, rowid DESC LIMIT ${TURN_REVIEW_ROWS}
    `,
        [sessionId, row.rowid, prevCompleted, sessionId],
      );
      const turnCandidates = records.map((m) => toSnapshot(m)).filter(hasText);
      const turnMessages = learningSnapshotBudget(turnCandidates, 40000);
      // 本轮本身被 LIMIT / 预算截断(工具密集的大轮次)、或某条用户 / 伙伴消息被截尾时,漏掉的
      // 中间承诺 / 工具结果 / 长消息尾部同样不能算"已覆盖":水位停在上一条完成回复,下一次复盘
      // 由缺口回补路径按序(含分块)补齐。
      const turnTruncated =
        records.length >= TURN_REVIEW_ROWS ||
        turnMessages.length < turnCandidates.length ||
        turnMessages.some((m) => m.partial);
      // 缺口回补:账本上次覆盖到的行落后于上一条完成回复(某轮复盘 claim 后失败、CAS 冲突、
      // 模型漏回 working),那段内容不会再被单独复盘;按 rowid 升序分批补进本次取材,覆盖水位
      // 只推进到连续处理过的前缀末尾——补不完就不推进到当前回复,账本在补完前不算新鲜,换窗线
      // 不会因为一份有缺口的账本提前。每批有界且至少前进一条,几轮即收敛。
      //
      // 水位的持久判据是消息 client_id(rowid 在瘦身 VACUUM 后可能重排),按它解析回当前 rowid。
      // 存下的 rowid 数字在任何情况下都不拿来当下界:旧账本没有 client_id、或水位消息已被删 /
      // 撤回解析不到,以及根本没有账本(老对话第一次建账本、首轮复盘 claim 后失败),一律从对话
      // 开头(/clear 之后)起算——整段历史按缺口分批回补,补完之前不算新鲜,不跳过任何一轮。
      // 水位可以停在一条长消息中间(offset = 已覆盖的字符数):下一次从同一条消息的这个偏移接着取。
      type Watermark = { rowid: number; id: string | undefined; offset?: number };
      // 只认仍在可见时间线上的行:被 rewind 软删、被删成墓碑、/clear 之前的水位消息都按
      // 解析不到——否则一条已撤回的回复会把下界撑在上一条完成回复之上,跳过幸存历史的回补。
      const resolvedFloor = workingBefore?.coveredThroughMessageId
        ? (
            await db.queryOne<{ rowid: number }>(
              `SELECT rowid FROM messages WHERE session_id=? AND client_id=? AND rewind_at IS NULL
               AND role != 'message_tombstone' ${clearedAtFilter} /* ledger-floor */`,
              [sessionId, workingBefore.coveredThroughMessageId, sessionId],
            )
          )?.rowid
        : undefined;
      const floor: Watermark =
        resolvedFloor !== undefined
          ? { rowid: resolvedFloor, id: workingBefore!.coveredThroughMessageId, offset: workingBefore!.coveredThroughOffset }
          : { rowid: 0, id: undefined };
      let covered: Watermark = turnTruncated ? { rowid: prevCompleted, id: prev?.id } : { rowid: row.rowid, id: replyId };
      let gapMessages: ReturnType<typeof toSnapshot>[] = [];
      // 水位停在半条消息里时,哪怕那条消息就是上一条完成回复(后面的轮次被 rewind 掉了),
      // 剩下的部分也得接着补,所以带偏移时取等号。
      if (floor.rowid < prevCompleted || (floor.offset !== undefined && floor.rowid === prevCompleted)) {
        // 水位停在半条消息里时把那条消息本身也取回来(rowid > x-1 即 rowid >= x)。
        const gapAfter = floor.offset !== undefined ? floor.rowid - 1 : floor.rowid;
        const gapRows = await db.query<Record_>(
          `
      SELECT client_id AS id, role, content, rowid AS 'order' FROM messages
      WHERE session_id=? AND rewind_at IS NULL AND rowid > ? AND rowid <= ? ${clearedAtFilter}
      AND ${REVIEW_ROLES} ORDER BY rowid ASC LIMIT ?
    `,
          [sessionId, gapAfter, prevCompleted, sessionId, GAP_BACKFILL_ROWS + 1],
        );
        const gapCandidates = gapRows
          .slice(0, GAP_BACKFILL_ROWS)
          .map((m) => toSnapshot(m, floor.offset !== undefined && m.order === floor.rowid ? floor.offset : 0))
          .filter(hasText);
        gapMessages = learningSnapshotPrefix(gapCandidates, GAP_BACKFILL_CHARS);
        const partialAt = gapMessages.findIndex((m) => m.partial);
        if (partialAt >= 0) {
          // 连续前缀停在这条长消息的当前块:水位记到块尾,后面的消息留给下一次。
          gapMessages = gapMessages.slice(0, partialAt + 1);
          const cut = gapMessages[partialAt]!;
          // 下一块从块尾往回留一段重叠:跨块的句子、很短的尾段都能在某一块里完整出现并被引用。
          covered = { rowid: cut.order, id: cut.id, offset: cut.offset + MESSAGE_CHUNK_CHARS - MESSAGE_CHUNK_OVERLAP };
        } else if (gapRows.length > GAP_BACKFILL_ROWS || gapMessages.length < gapCandidates.length) {
          const last = gapMessages[gapMessages.length - 1];
          covered = last ? { rowid: last.order, id: last.id } : floor;
        }
      }
      const messages = [...gapMessages, ...turnMessages]
        .map(({ id, role, order, text }) => ({ id, role, order, text }))
        .sort((a, b) => a.order - b.order);
      if (!messages.some((m) => m.role === 'user') || !current()) return;
      const [{ getMaker }, { requestUtilityText }] = await Promise.all([
        import('../maker-host/index.js'),
        import('../utility-model/oneShotCandidates.js'),
      ]);
      if (!current()) return;
      const maker = getMaker();
      const config = JSON.parse((await readOwner())?.capabilities || '{}');
      const store =
        config.memory !== false
          ? await maker.makerMemory?.getStore(buildBotMemoryScopeKey(row.botId))
          : undefined;
      const memories = store
        ? (await store.list()).filter((m) =>
            ['user', 'feedback', 'project', 'reference'].includes(m.frontmatter.type),
          )
        : [];
      if (!current()) return;
      const catalog = await listBotSkills(root, row.botId);
      const skills = (
        await Promise.all(
          catalog
            .filter((s) => s.enabled !== false)
            .slice(0, 40)
            .map((s) => readBotSkill(root, row.botId, s.slug)),
        )
      ).filter((s) => s !== null);
      // Incomplete bodies must never be used as replacements for existing records.
      const memorySnapshot = learningSnapshotBudget(
        memories.filter((m) => m.body.length <= 12000),
        24000,
      );
      const skillSnapshot = learningSnapshotBudget(
        skills.filter((s) => s.body.length <= 12000),
        24000,
      );
      if (!current()) return;
      const memoryIndex = memories.map((m) => ({
        name: m.slug,
        type: m.frontmatter.type,
        title: m.frontmatter.title,
      }));
      const skillIndex = catalog.map((s) => ({
        slug: s.slug,
        name: s.name,
        description: s.description,
        enabled: s.enabled,
      }));
      if (JSON.stringify({ memoryIndex, skillIndex }).length > 24000) return;
      const result = await requestUtilityText(
        maker,
        JSON.stringify({
          messages,
          workingMemory: workingMemoryForReview(workingBefore),
          memoryEnabled: !!store,
          memoryIndex,
          memories: memorySnapshot.map((m) => ({ name: m.slug, ...m.frontmatter, body: m.body })),
          skillIndex,
          skills: skillSnapshot.map((s) => ({
            slug: s.slug,
            title: s.name,
            description: s.description,
            body: s.body,
          })),
        }),
        {
          systemPrompt: learningReviewInstructions,
          maxTokens: 6000,
          timeoutMs: 45000,
          validateResponse: (text) => {
            try {
              return learningReviewSchema.safeParse(JSON.parse(text)).success;
            } catch {
              return false;
            }
          },
          beforeDispatch: async () => current() && !!(await readOwner()),
        },
      );
      if (!result.ok || !current()) return;
      const plan = learningReviewSchema.parse(JSON.parse(result.text));
      // 每次校验通过的复盘都写回水位:模型按指令在"本轮没改动"时省略 working,但这一轮同样
      // 已被复盘过,水位必须跟上,否则一句问候就让账本被判不新鲜、70% 换窗悄悄退回 90%。
      // 没有提案时按空提案合并——旧条目原样保留,只推进水位(和 client_id)。
      if (await readOwner()) {
        try {
          await writeBotWorkingMemory(
            root,
            row.botId,
            applyWorkingMemoryProposal(workingBefore, plan.working ?? EMPTY_WORKING_PROPOSAL, messages, {
              now: Date.now(),
              coveredThroughRowid: covered.rowid,
              ...(covered.id ? { coveredThroughMessageId: covered.id } : {}),
              ...(covered.offset !== undefined ? { coveredThroughOffset: covered.offset } : {}),
              // 水位没推进到当前回复(本轮被截断 / 缺口未补完):当前这一轮之后还会被完整回补,
              // 以它为证据的删除与改写留到那时、现在只追加,免得 rewind 这一轮后账本已按撤回
              // 分支删改。回补前缀(水位之内)里的证据照常提交——它们不会再被回放第二次。
              ...(covered.rowid < row.rowid ? { deferEvidenceFrom: new Set(turnMessages.map((m) => m.id)) } : {}),
            }),
            workingBefore?.revision ?? 0,
          );
        } catch {
          /* 版本冲突或写盘失败:保留磁盘上的版本,下一次复盘再合并。 */
        }
      }
      let memorySaved = false;
      for (const proposal of plan.memories) {
        if (!current()) return;
        const latest = await readOwner();
        if (!latest || JSON.parse(latest.capabilities || '{}').memory === false) break;
        if (!store || !hasLearningEvidence(proposal, messages, true)) continue;
        const filename = `${proposal.type}_${proposal.name}.md`;
        const prior = memories.find((m) => m.filename === filename);
        if (prior && !memorySnapshot.includes(prior)) continue;
        if (prior?.body === proposal.body) continue;
        try {
          if (prior)
            await store.update(filename, prior.frontmatter.updatedAt, {
              title: proposal.title,
              description: proposal.description,
              body: proposal.body,
            });
          else await store.write({ ...proposal, mode: 'create' });
          memorySaved = true;
          if (current())
            publish(replyId, [
              {
                kind: 'memory',
                key: filename,
                title: proposal.title,
                action: prior ? 'updated' : 'created',
              },
            ]);
        } catch {
          /* A concurrent edit wins; never overwrite or claim a failed save. */
        }
      }
      for (const proposal of plan.skills) {
        if (!current() || !(await readOwner())) return;
        if (!hasLearningEvidence(proposal, messages, false)) continue;
        const prior = catalog.find((s) => s.slug === proposal.slug);
        const snapshot = skillSnapshot.find((s) => s.slug === proposal.slug);
        if (prior && (!snapshot || prior.enabled === false)) continue;
        if (snapshot?.body === proposal.body) continue;
        const saved = await saveBotSkillForSession({
          callerSessionId: sessionId,
          slug: proposal.slug,
          name: proposal.title,
          description: proposal.description,
          body: proposal.body,
          expectedUpdatedAt: prior?.updatedAt ?? null,
        });
        if (saved.ok && current())
          publish(replyId, [
            {
              kind: 'skill',
              key: saved.skill.slug,
              title: saved.skill.name,
              action: saved.created ? 'created' : 'updated',
            },
          ]);
      }
      if (memorySaved && current()) await requestBotRuntimeEpochRefresh(sessionId, 'resource');
    });
  running.set(key, job);
  try {
    await job;
  } finally {
    if (running.get(key) === job) running.delete(key);
  }
}
