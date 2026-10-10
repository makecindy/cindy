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
  learningReviewInstructions,
  learningReviewSchema,
} from './botLearningReviewPlan.js';
import { listBotSkills, readBotSkill } from './botSkillStore.js';
import { saveBotSkillForSession } from './botSkillService.js';
import { requestBotRuntimeEpochRefresh } from './botRuntimeEpochRefreshSignal.js';

const running = new Map<string, Promise<void>>();
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
      const records = await db.query<{ id: string; role: string; content: string; order: number }>(
        `
      SELECT client_id AS id, role, content, rowid AS 'order' FROM messages
      WHERE session_id=? AND rewind_at IS NULL AND rowid <= ? AND rowid > COALESCE((
        SELECT MAX(rowid) FROM messages WHERE session_id=? AND rowid < ? AND rewind_at IS NULL
        AND role='assistant' AND json_valid(agent_meta) AND json_extract(agent_meta, '$.turnCompleted')=1
      ), 0) AND role IN ('user','assistant','tool_use','tool_result') ORDER BY CASE WHEN role='user' THEN 0 ELSE 1 END, rowid DESC LIMIT 80
    `,
        [sessionId, row.rowid, sessionId, row.rowid],
      );
      const messages = learningSnapshotBudget(
        records.map((m) => ({
          id: m.id,
          role: m.role,
          order: m.order,
          text: (typeof JSON.parse(m.content) === 'string'
            ? JSON.parse(m.content)
            : m.content
          ).slice(0, 6000),
        })),
        40000,
      ).sort((a, b) => a.order - b.order);
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
      const root = ownerScopedUserDataPath();
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
