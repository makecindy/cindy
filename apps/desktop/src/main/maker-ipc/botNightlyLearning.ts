/**
 * 伙伴「夜间学习」的执行与撤销（规则见 docs/product-rules/bot-routines.md「内置夜间学习」）。
 *
 * - 到点由内置例行任务触发；没有新的主人对话时调用方直接跳过，这里不调用模型。
 * - 在宿主里调用辅助模型，不进伙伴主对话；同一伙伴的整理、撤销与观察项操作按伙伴串行。
 * - 模型只提议，宿主逐条校验后落盘：新记忆要主人原话证据；技能只从上次已在观察、
 *   这次又出现的做法转正；只改快照里读到全文的记录。每条改动前后内容存进撤销备份。
 * - 整理成功才推进水位并扣减计数；失败保留，下一次再整理。
 */
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { buildBotMemoryScopeKey, MemoryError, type AgentKind, type MemoryRecord } from '@cindy/maker-core';
import { activeOwnerScopeKey, isAppSessionBoundaryPending, ownerScopedUserDataPath } from '../appSessionState.js';
import { getDbClient } from '../localDb/client/current.js';
import { drainPersistQueue } from '../messagePersistBroadcaster.js';
import { createLogger } from '../logger.js';
import { listInstalledSkills } from '../learn-host/skillsIndex.js';
import { isSyntheticTriggerText } from '@cindy/maker-shared/synthetic-trigger';
import { isAutomaticInputOriginKind } from '../../shared/agentInputQueue.js';
import type { NightlyLearningItem, NightlyLearningRun } from '../../shared/botNightlyLearning.js';
import { hasLearningEvidence, learningSnapshotBudget, learningSnapshotPrefix } from './botLearningReviewPlan.js';
import { nightlyLearningInstructions, nightlyLearningSchema, type NightlyLearningPlan } from './botNightlyLearningPlan.js';
import {
  MAX_NIGHTLY_CANDIDATES,
  readNightlyLearningBackup,
  readNightlyLearningState,
  updateNightlyLearningState,
  writeNightlyLearningBackup,
  type MemorySnapshot,
  type NightlyLearningBackup,
  type NightlyLearningCandidateRecord,
  type NightlyLearningState,
  type SkillSnapshot,
} from './botNightlyLearningState.js';
import {
  deleteBotSkillForBot,
  listBotSkillsForBot,
  readBotSkillForBot,
  readBotSkillSourceForBot,
  saveBotSkillSourceForBot,
} from './botSkillService.js';
import { botSkillRootDir, normalizeBotSkillSlug, renderBotSkillFile } from './botSkillStore.js';
import { requestBotRuntimeEpochRefresh } from './botRuntimeEpochRefreshSignal.js';

const log = createLogger('bot-nightly-learning');

/** 一次最多读多少条回复、多少字；读不完的留给下一次，水位只推进到读完的位置。 */
const MAX_REPLIES = 400;
const MESSAGE_BUDGET = 60_000;
const USER_TEXT_CHARS = 4_000;
const ASSISTANT_TEXT_CHARS = 3_000;
/** 这么久以内开始、还没完成的回复会挡住水位，等它完成后再学；更早的视为已中断，不再等。 */
const IN_FLIGHT_HOLD_MS = 6 * 60 * 60_000;

export class NightlyLearningError extends Error {
  constructor(readonly code: 'NOT_FOUND' | 'CHANGED' | 'BUSY' | 'UNAVAILABLE', message: string) {
    super(message);
    this.name = 'NightlyLearningError';
  }
}

const runningBots = new Set<string>();
const queues = new Map<string, Promise<unknown>>();

/** 同一伙伴的整理、撤销、观察项操作串行执行；key 带账号作用域，换账号不会排到旧账号后面。 */
async function runSerializedForTeammate<T>(botId: string, work: () => Promise<T>): Promise<T> {
  const key = `${activeOwnerScopeKey()}:${botId}`;
  const job = (queues.get(key) ?? Promise.resolve()).catch(() => {}).then(work);
  const settled = job.then(() => {}, () => {});
  queues.set(key, settled);
  try {
    return await job;
  } finally {
    if (queues.get(key) === settled) queues.delete(key);
  }
}
export function isNightlyLearningRunning(botId: string): boolean {
  return runningBots.has(`${activeOwnerScopeKey()}:${botId}`);
}

type Message = { id: string; role: 'user' | 'assistant'; text: string };
type Turn = { sessionId: string; createdAt: number; messages: Message[] };

function textOf(raw: string): string {
  let parsed: unknown = raw;
  try { parsed = JSON.parse(raw); } catch { /* Plain text is already the content. */ }
  if (typeof parsed === 'string') return parsed;
  const text = (parsed as { text?: unknown } | null)?.text;
  return typeof text === 'string' ? text : '';
}

const parseMeta = (raw: string | null) => {
  try { return JSON.parse(raw || '{}') as Record<string, any>; } catch { return {}; }
};

type TurnScan = {
  turns: Turn[];
  /** 读到了 until 之前的全部回复；否则 scannedThrough 是这一批扫到的最后一条回复的时间。 */
  complete: boolean;
  scannedThrough: number;
  /** 最早一条仍在生成的回复的时间；水位不能越过它。 */
  holdAt: number;
};

/**
 * 读取水位之后主人和伙伴完成的对话轮次；口径与计数器（botNightlyLearningCounter.ts）一致。
 * 已经学过的回复（learned）跳过；被过滤掉的回复同样算扫过，水位照常推进。
 */
async function readTurns(botId: string, after: number, until: number, learned: Record<string, number>): Promise<TurnScan> {
  const rows = await getDbClient().query<{
    sessionId: string; id: string; content: string; meta: string; createdAt: number; role: string;
    inputId: string | null; inputContent: string | null; inputMeta: string | null;
  }>(
    `SELECT m.session_id AS sessionId, m.client_id AS id, m.content, m.agent_meta AS meta, m.created_at AS createdAt,
       COALESCE(b.role,'source') AS role, u.client_id AS inputId, u.content AS inputContent, u.agent_meta AS inputMeta
     FROM messages m JOIN sessions s ON s.id=m.session_id
     LEFT JOIN bot_session_links b ON b.session_id=s.id
     LEFT JOIN bot_task_origins origin ON origin.source_session_id=s.id
     -- 回复不一定带 replyToClientId：没有时取这条回复之前最近的一条用户消息作为它的输入。
     LEFT JOIN messages u ON u.session_id=m.session_id AND u.role='user'
       AND u.created_at > COALESCE(s.cleared_at, 0)
       AND u.rowid = COALESCE(
         (SELECT x.rowid FROM messages x WHERE x.session_id=m.session_id AND x.role='user' AND x.rewind_at IS NULL
           AND x.client_id=json_extract(m.agent_meta, '$.replyToClientId')),
         (SELECT x.rowid FROM messages x WHERE x.session_id=m.session_id AND x.role='user' AND x.rewind_at IS NULL
           AND x.rowid < m.rowid ORDER BY x.rowid DESC LIMIT 1))
     WHERE ((b.bot_id=? AND b.role IN ('canonical','thread','channel') AND b.archived_at IS NULL
       AND s.source='bot' AND s.status='active') OR
       (origin.bot_id=? AND s.status IN ('active','archived')
        AND (json_extract(m.agent_meta,'$.replyToClientId') IS NULL OR json_extract(m.agent_meta,'$.replyToClientId')=u.client_id)
        AND EXISTS (SELECT 1 FROM bot_task_origin_messages om WHERE om.bot_id=origin.bot_id AND om.message_id=m.id)
        AND EXISTS (SELECT 1 FROM bot_task_origin_messages om WHERE om.bot_id=origin.bot_id AND om.message_id=u.id)))
       AND s.remote_host_id IS NULL
       AND m.role='assistant' AND m.rewind_at IS NULL AND m.created_at > ? AND m.created_at <= ?
       AND m.created_at > COALESCE(s.cleared_at, 0)
     ORDER BY m.created_at ASC LIMIT ${MAX_REPLIES + 1} /* nightly-learning-turns */`,
    [botId, botId, after, until],
  );
  const turns: Turn[] = [];
  let holdAt = Infinity;
  for (const row of rows.slice(0, MAX_REPLIES)) {
    const meta = parseMeta(row.meta);
    if (meta.parentUuid || meta.botPrivateReply || meta.botGroupLane || learned[row.id]) continue;
    if (meta.turnCompleted !== true) {
      if (row.createdAt > until - IN_FLIGHT_HOLD_MS) holdAt = Math.min(holdAt, row.createdAt);
      continue;
    }
    const inputMeta = parseMeta(row.inputMeta);
    if (!row.inputId || isAutomaticInputOriginKind(inputMeta.origin?.kind)) continue;
    const source = inputMeta.imSource;
    if (row.role === 'channel' && source?.origin?.sender?.isOwner !== true) continue;
    const userText = row.role === 'channel' && typeof source?.userText === 'string'
      ? source.userText : textOf(row.inputContent ?? '');
    if (!userText.trim() || isSyntheticTriggerText(userText)) continue;
    turns.push({
      sessionId: row.sessionId,
      createdAt: row.createdAt,
      messages: [
        { id: row.inputId, role: 'user', text: userText.slice(0, USER_TEXT_CHARS) },
        { id: row.id, role: 'assistant', text: textOf(row.content).slice(0, ASSISTANT_TEXT_CHARS) },
      ],
    });
  }
  const complete = rows.length <= MAX_REPLIES;
  return { turns, complete, scannedThrough: complete ? until : rows[MAX_REPLIES - 1]!.createdAt, holdAt };
}

/** 从工具调用记录里数这个伙伴的技能被读了几次：调用技能，或读了它技能目录下的 SKILL.md。 */
async function countSkillUsage(botId: string, slugs: Set<string>, after: number, until: number) {
  const usage = new Map<string, { count: number; lastUsedAt: number }>();
  if (!slugs.size) return usage;
  const rows = await getDbClient().query<{ content: string; createdAt: number }>(
    `SELECT m.content, m.created_at AS createdAt FROM messages m
     JOIN bot_session_links b ON b.session_id=m.session_id
     WHERE b.bot_id=? AND b.role IN ('canonical','thread','channel') AND m.role='tool_use'
       AND m.rewind_at IS NULL AND m.created_at > ? AND m.created_at <= ?
     ORDER BY m.created_at ASC LIMIT 5000 /* nightly-learning-skill-usage */`,
    [botId, after, until],
  );
  const dir = path.basename(botSkillRootDir('', botId)).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const fileRef = new RegExp(`${dir}/(?:disabled-)?skills/([a-z0-9][a-z0-9-]{0,63})/(?:SKILL|skill)\\.md`, 'g');
  for (const row of rows) {
    const hit = new Set<string>();
    for (const match of row.content.matchAll(fileRef)) if (slugs.has(match[1]!)) hit.add(match[1]!);
    const tool = parseMeta(row.content);
    if (String(tool.toolName ?? '').toLowerCase() === 'skill') {
      const name = String(tool.input?.skill ?? tool.input?.name ?? '');
      const slug = name.split(':').pop() ?? '';
      if (slugs.has(slug)) hit.add(slug);
    }
    for (const slug of hit) {
      const prior = usage.get(slug) ?? { count: 0, lastUsedAt: 0 };
      usage.set(slug, { count: prior.count + 1, lastUsedAt: Math.max(prior.lastUsedAt, row.createdAt) });
    }
  }
  return usage;
}

const memorySnapshot = (record: MemoryRecord | null): MemorySnapshot => record && ({
  filename: record.filename,
  type: record.frontmatter.type,
  slug: record.slug,
  title: record.frontmatter.title,
  description: record.frontmatter.description,
  body: record.body,
  updatedAt: record.frontmatter.updatedAt,
});

type MemoryStore = {
  list(): Promise<MemoryRecord[]>;
  read(filename: string): Promise<MemoryRecord>;
  write(opts: { type: any; name: string; title: string; description: string; body: string; mode?: 'create'; preserveBody?: boolean }): Promise<unknown>;
  update(filename: string, expectedUpdatedAt: string, changes: { title: string; description: string; body: string }): Promise<MemoryRecord>;
  delete(filename: string, expectedUpdatedAt?: string): Promise<void>;
};

async function memoryStoreOf(botId: string): Promise<MemoryStore | null> {
  const { getMaker } = await import('../maker-host/index.js');
  return ((await getMaker().makerMemory?.getStore(buildBotMemoryScopeKey(botId))) as MemoryStore | undefined) ?? null;
}

async function readMemory(store: MemoryStore, filename: string): Promise<MemoryRecord | null> {
  try {
    return await store.read(filename);
  } catch (error) {
    if (error instanceof MemoryError && error.code === 'not-found') return null;
    throw error;
  }
}

const sameMemory = (a: MemorySnapshot, b: MemorySnapshot) =>
  (!a && !b) || (!!a && !!b && a.title === b.title && a.description === b.description && a.body === b.body && a.type === b.type);
const sameSkill = (a: SkillSnapshot, b: SkillSnapshot) =>
  (!a && !b) || (!!a && !!b && a.source === b.source && a.enabled === b.enabled);

/**
 * 把一条记忆改成目标内容（null = 删除），返回改完后的实际内容。expected 是调用方刚核对过的版本
 * （null = 应当不存在），直接交给存储层核对：这之间被改过就由存储层拒绝，不覆盖。
 */
async function applyMemory(store: MemoryStore, filename: string, target: MemorySnapshot, expected: string | null): Promise<MemorySnapshot> {
  if (!target) {
    if (expected !== null) await store.delete(filename, expected);
    return null;
  }
  if (expected === null) {
    await store.write({ type: target.type, name: target.slug, title: target.title, description: target.description, body: target.body, mode: 'create', preserveBody: true });
  } else {
    await store.update(filename, expected, { title: target.title, description: target.description, body: target.body });
  }
  return memorySnapshot(await readMemory(store, filename));
}

async function readSkill(botId: string, slug: string): Promise<SkillSnapshot> {
  const source = await readBotSkillSourceForBot(botId, slug);
  if (source === null) return null;
  const enabled = (await listBotSkillsForBot(botId)).find((s) => s.slug === slug)?.enabled !== false;
  return { source, enabled };
}

async function applySkill(botId: string, slug: string, target: SkillSnapshot): Promise<SkillSnapshot> {
  if (!target) await deleteBotSkillForBot(botId, slug);
  else await saveBotSkillSourceForBot(botId, slug, target.source, { enabled: target.enabled });
  return readSkill(botId, slug);
}

async function readBot(botId: string) {
  return getDbClient().queryOne<{
    canonicalSessionId: string | null; capabilities: string;
    agentKind: string | null; model: string | null; providerId: string | null;
  }>(
    `SELECT p.canonical_session_id AS canonicalSessionId, v.capabilities_json AS capabilities,
       s.agent_kind AS agentKind, s.model, s.provider_id AS providerId
     FROM bot_profiles p JOIN bot_profile_versions v ON v.bot_id=p.id AND v.version=p.current_version
     LEFT JOIN sessions s ON s.id=p.canonical_session_id AND s.remote_host_id IS NULL
     WHERE p.id=? AND p.status='active'`,
    [botId],
  );
}

const newRunId = () => `nl_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;

function subtractPending(state: NightlyLearningState, perSession: Map<string, number>, turns: number) {
  state.pending.turns = Math.max(0, state.pending.turns - turns);
  for (const [sessionId, n] of perSession) {
    const left = (state.pending.sessions[sessionId] ?? 0) - n;
    if (left > 0) state.pending.sessions[sessionId] = left;
    else delete state.pending.sessions[sessionId];
  }
  if (state.pending.turns === 0) {
    state.pending.sessions = {};
    delete state.pending.firstAt;
  }
}

export type NightlyLearningResult = { skipped: true; resultText: string } | { resultText: string } | { error: string };

/**
 * 执行一次夜间学习。manual=false（到点运行）且没有新对话时直接跳过，不调用模型；
 * 手动「现在整理」即使没有新对话也整理一次已有的记忆和技能。
 */
export async function runNightlyLearning(botId: string, options: { manual: boolean }): Promise<NightlyLearningResult> {
  const owner = activeOwnerScopeKey();
  const db = getDbClient();
  const root = ownerScopedUserDataPath();
  const current = () => !isAppSessionBoundaryPending() && activeOwnerScopeKey() === owner && getDbClient() === db;
  const before = await readNightlyLearningState(root, botId);
  if (!options.manual && !(before?.pending.turns)) return { skipped: true, resultText: 'No new conversations' };
  const key = `${owner}:${botId}`;
  if (runningBots.has(key)) return { skipped: true, resultText: 'Already running' };
  runningBots.add(key);
  try {
    return await runSerializedForTeammate(botId, () => runLocked(botId, root, options.manual, current));
  } finally {
    runningBots.delete(key);
  }
}

async function runLocked(
  botId: string, root: string, manual: boolean, current: () => boolean,
): Promise<NightlyLearningResult> {
  await drainPersistQueue();
  const bot = current() ? await readBot(botId) : null;
  if (!bot || !current()) return { skipped: true, resultText: 'Teammate unavailable' };
  const startedAt = Date.now();
  const state = (await readNightlyLearningState(root, botId)) ?? null;
  const snapshotTurns = state?.pending.turns ?? 0;
  const after = state?.throughAt ?? (state?.pending.firstAt ? state.pending.firstAt - 1 : startedAt);
  const scan = await readTurns(botId, after, startedAt, state?.learned ?? {});
  const selected = learningSnapshotPrefix(scan.turns, MESSAGE_BUDGET);
  const messages = selected.flatMap((turn) => turn.messages);
  const allSelected = selected.length === scan.turns.length;
  const readAll = scan.complete && allSelected;
  // 没读完时退到最后读到的那一毫秒之前，同一毫秒里还没读的回复下次仍能读到；读过的记进 learned 跳过。
  // 仍在生成的回复挡住水位，等它完成后再学。
  const frontier = !allSelected ? (selected.at(-1)?.createdAt ?? after + 1) - 1
    : scan.complete ? startedAt : scan.scannedThrough - 1;
  const throughAt = Math.max(after, Math.min(frontier, scan.holdAt - 1));
  const learnedNow: Record<string, number> = {};
  for (const turn of selected) if (turn.createdAt > throughAt) learnedNow[turn.messages[1]!.id] = turn.createdAt;
  const perSession = new Map<string, number>();
  for (const turn of selected) perSession.set(turn.sessionId, (perSession.get(turn.sessionId) ?? 0) + 1);
  const consumedTurns = readAll ? snapshotTurns : selected.length;
  const runId = newRunId();

  const recordRun = async (run: NightlyLearningRun, extra?: (s: NightlyLearningState) => void, advance = true) => {
    await updateNightlyLearningState(root, botId, (s) => {
      if (advance) {
        subtractPending(s, perSession, consumedTurns);
        s.throughAt = Math.max(s.throughAt ?? 0, throughAt);
        const learned = Object.fromEntries(Object.entries({ ...s.learned, ...learnedNow }).filter(([, at]) => at > s.throughAt!));
        if (Object.keys(learned).length) s.learned = learned;
        else delete s.learned;
      }
      extra?.(s);
      // 整理开始前已先登记了这次运行（逐条记录改动），这里补齐结果。
      const existing = s.runs.find((r) => r.id === run.id);
      if (existing) Object.assign(existing, run);
      else s.runs.unshift(run);
      return s;
    });
  };

  const config = parseMeta(bot.capabilities);
  const store = config.memory !== false ? await memoryStoreOf(botId) : null;
  const memories = store ? (await store.list()).filter((m) => ['user', 'feedback', 'project', 'reference'].includes(m.frontmatter.type)) : [];
  const memoryFull = learningSnapshotBudget(memories.filter((m) => m.body.length <= 12000), 40_000);
  const catalog = await listBotSkillsForBot(botId);
  const enabledSkills = (await Promise.all(catalog.filter((s) => s.enabled !== false).map((s) => readBotSkillForBot(botId, s.slug))))
    .filter((s) => s !== null);
  const skillFull = learningSnapshotBudget(enabledSkills.filter((s) => s.body.length <= 12000), 30_000);
  // 运行前的技能原文与启用状态；写入前核对，模型返回前被改过或停用的技能不覆盖。
  const skillBefore = new Map<string, SkillSnapshot>();
  for (const s of catalog.filter((c) => c.enabled !== false)) {
    const source = await readBotSkillSourceForBot(botId, s.slug);
    if (source !== null) skillBefore.set(s.slug, { source, enabled: true });
  }
  const usageNow = await countSkillUsage(botId, new Set(catalog.map((s) => s.slug)), after, throughAt);
  const usage = { ...(state?.skillUsage ?? {}) };
  for (const [slug, value] of usageNow) {
    const prior = usage[slug] ?? { count: 0, lastUsedAt: 0 };
    usage[slug] = { count: prior.count + value.count, lastUsedAt: Math.max(prior.lastUsedAt, value.lastUsedAt) };
  }
  const installed = await listInstalledSkills().then((r) => r.entries, () => []);
  const candidates = state?.candidates ?? [];
  if (!current()) return { skipped: true, resultText: 'Owner changed' };

  if (!messages.length && !manual) {
    await recordRun({ id: runId, at: startedAt, outcome: 'nothing', turns: 0, items: [] }, (s) => { s.skillUsage = usage; });
    return { resultText: 'No new conversations to learn from' };
  }

  const [{ getMaker }, { requestUtilityText }] = await Promise.all([
    import('../maker-host/index.js'),
    import('../utility-model/oneShotCandidates.js'),
  ]);
  const input = JSON.stringify({
      now: new Date(startedAt).toISOString(),
      messages,
      memoryEnabled: !!store,
      memoryIndex: learningSnapshotBudget(memories.map((m) => ({ filename: m.filename, type: m.frontmatter.type, title: m.frontmatter.title })), 16_000),
      memories: memoryFull.map((m) => ({ filename: m.filename, ...m.frontmatter, body: m.body })),
      skillIndex: catalog.map((s) => ({
        slug: s.slug, title: s.name, description: s.description, enabled: s.enabled !== false,
        usedTimes: usage[s.slug]?.count ?? 0,
        lastUsedAt: usage[s.slug]?.lastUsedAt ? new Date(usage[s.slug]!.lastUsedAt).toISOString() : null,
        updatedAt: s.updatedAt,
      })),
      skills: skillFull.map((s) => ({ slug: s.slug, title: s.name, description: s.description, body: s.body })),
      installedSkills: learningSnapshotBudget(installed.map((s) => ({ name: s.name, description: s.description })), 8_000),
      candidates: candidates.map((c) => ({ id: c.id, title: c.title, summary: c.summary, firstSeenAt: new Date(c.firstSeenAt).toISOString() })),
      declined: state?.declined ?? [],
    });
  const request = {
    systemPrompt: nightlyLearningInstructions,
    maxTokens: 8000,
    timeoutMs: 120_000,
    validateResponse: (text: string) => {
      try { return nightlyLearningSchema.safeParse(JSON.parse(text)).success; } catch { return false; }
    },
    beforeDispatch: async () => current() && !!(await readBot(botId)),
  };
  let result = await requestUtilityText(getMaker(), input, request);
  // 默认辅助模型链没有可用候选（例如没登录 Cindy、只连了自己的模型账号）时，改用这个伙伴主对话的模型路线。
  if (!result.ok && result.reason === 'no_candidate' && bot.agentKind && bot.model && current()) {
    result = await requestUtilityText(getMaker(), input, {
      ...request,
      agentKind: bot.agentKind as AgentKind,
      model: bot.model,
      ...(bot.providerId ? { providerId: bot.providerId } : {}),
    });
  }
  if (!current()) return { skipped: true, resultText: 'Owner changed' };
  if (!result.ok) {
    log.warn('nightly learning model call failed', { botId });
    await recordRun({ id: runId, at: startedAt, manual: manual || undefined, outcome: 'failed', turns: selected.length, items: [], errorCode: 'MODEL_UNAVAILABLE' }, undefined, false);
    return { error: 'Nightly learning could not reach the helper model' };
  }
  let plan: NightlyLearningPlan;
  try {
    plan = nightlyLearningSchema.parse(JSON.parse(result.text));
  } catch {
    await recordRun({ id: runId, at: startedAt, manual: manual || undefined, outcome: 'failed', turns: selected.length, items: [], errorCode: 'INVALID_RESULT' }, undefined, false);
    return { error: 'Nightly learning returned an invalid result' };
  }

  const items: NightlyLearningItem[] = [];
  const backup: NightlyLearningBackup = {};
  // 改动前先登记这次运行，每改一条就把备份和记录落盘：中途退出时已做的改动仍能在记录里撤销。
  await updateNightlyLearningState(root, botId, (s) => {
    s.runs.unshift({ id: runId, at: startedAt, ...(manual ? { manual: true } : {}), outcome: 'nothing', turns: selected.length, items: [] });
    return s;
  });
  const add = async (item: Omit<NightlyLearningItem, 'id'>, kind: 'memory' | 'skill', b: MemorySnapshot | SkillSnapshot, a: MemorySnapshot | SkillSnapshot) => {
    const id = `i${items.length + 1}`;
    items.push({ id, ...item });
    backup[id] = { kind, before: b, after: a };
    await writeNightlyLearningBackup(root, botId, runId, backup);
    await updateNightlyLearningState(root, botId, (s) => {
      const run = s.runs.find((r) => r.id === runId);
      if (!run) return null;
      run.items = structuredClone(items);
      run.outcome = 'learned';
      return s;
    });
  };
  const full = new Map(memoryFull.map((m) => [m.filename, m]));
  // 合并 = 更新保留的那一条 + 删除来源。保留项的更新没写成功、保留项不存在或这一轮也要删时，不删来源。
  const plannedUpdates = new Set(plan.memories.flatMap((op) => (op.op === 'update' ? [op.filename] : [])));
  const plannedDeletes = new Set(plan.memories.flatMap((op) => (op.op === 'delete' ? [op.filename] : [])));
  const appliedUpdates = new Map<string, string>();
  const titleOf = (filename: string) =>
    appliedUpdates.get(filename) ?? memories.find((m) => m.filename === filename)?.frontmatter.title ?? filename;
  const memoryOps = [...plan.memories.filter((op) => op.op !== 'delete'), ...plan.memories.filter((op) => op.op === 'delete')];

  for (const op of store ? memoryOps : []) {
    if (!current()) break;
    try {
      if (op.op === 'create') {
        if (!hasLearningEvidence(op, messages, true)) continue;
        const filename = `${op.type}_${op.name}.md`;
        if (await readMemory(store!, filename)) continue;
        const target: MemorySnapshot = { filename, type: op.type, slug: op.name, title: op.title, description: op.description, body: op.body, updatedAt: '' };
        await add({ kind: 'memory', action: 'created', target: filename, title: op.title, reason: op.reason }, 'memory', null, await applyMemory(store!, filename, target, null));
        continue;
      }
      const prior = full.get(op.filename);
      if (!prior) continue;
      const live = await readMemory(store!, op.filename);
      if (!live || live.frontmatter.updatedAt !== prior.frontmatter.updatedAt) continue;
      const beforeSnap = memorySnapshot(live);
      if (op.op === 'update') {
        if (op.body === live.body && op.title === live.frontmatter.title && op.description === live.frontmatter.description) continue;
        const afterSnap = await applyMemory(store!, op.filename, { ...beforeSnap!, title: op.title, description: op.description, body: op.body }, live.frontmatter.updatedAt);
        appliedUpdates.set(op.filename, op.title);
        await add({ kind: 'memory', action: 'updated', target: op.filename, title: op.title, reason: op.reason }, 'memory', beforeSnap, afterSnap);
      } else {
        const into = op.mergedInto;
        if (into && (plannedDeletes.has(into) || (plannedUpdates.has(into) && !appliedUpdates.has(into)) || !(await readMemory(store!, into)))) continue;
        await applyMemory(store!, op.filename, null, live.frontmatter.updatedAt);
        await add({
          kind: 'memory', action: 'deleted', target: op.filename, title: live.frontmatter.title, reason: op.reason,
          ...(into ? { mergedInto: titleOf(into) } : {}),
        }, 'memory', beforeSnap, null);
      }
    } catch (error) {
      log.warn('nightly memory change skipped', { botId, error: String(error) });
    }
  }

  const enabledSlugs = new Set(skillFull.map((s) => s.slug));
  const nameOf = (slug: string) => catalog.find((s) => s.slug === slug)?.name ?? slug;
  const plannedSkillUpdates = new Set(plan.skills.flatMap((op) => (op.op === 'update' ? [op.slug] : [])));
  const appliedSkillUpdates = new Set<string>();
  const skillOps = [...plan.skills.filter((op) => op.op === 'update'), ...plan.skills.filter((op) => op.op !== 'update')];
  for (const op of skillOps) {
    if (!current()) break;
    try {
      if (op.op === 'update' && !enabledSlugs.has(op.slug)) continue;
      if (op.op === 'disable' && op.mergedInto && plannedSkillUpdates.has(op.mergedInto) && !appliedSkillUpdates.has(op.mergedInto)) continue;
      const expected = skillBefore.get(op.slug);
      const beforeSnap = await readSkill(botId, op.slug);
      if (!beforeSnap || !expected || !sameSkill(beforeSnap, expected)) continue;
      const target: SkillSnapshot = op.op === 'update'
        ? { source: renderBotSkillFile({ slug: op.slug, name: op.title, description: op.description, updatedAt: new Date().toISOString(), body: op.body }), enabled: true }
        : { source: beforeSnap.source, enabled: false };
      const afterSnap = await applySkill(botId, op.slug, target);
      if (op.op === 'update') appliedSkillUpdates.add(op.slug);
      await add({
        kind: 'skill', action: op.op === 'update' ? 'updated' : 'disabled', target: op.slug,
        title: op.op === 'update' ? op.title : nameOf(op.slug), reason: op.reason,
        ...(op.op === 'disable' && op.mergedInto ? { mergedInto: nameOf(op.mergedInto) } : {}),
      }, 'skill', beforeSnap, afterSnap);
    } catch (error) {
      log.warn('nightly skill change skipped', { botId, error: String(error) });
    }
  }

  // 只从上次已经在观察的做法转正（candidates 读自运行前的状态）：这一轮新加的观察项不能当场转正。
  const promoted = new Set<string>();
  for (const op of plan.promote) {
    if (!current()) break;
    const candidate = candidates.find((c) => c.id === op.candidateId);
    if (!candidate || !hasLearningEvidence(op, messages, true)) continue;
    if (catalog.some((s) => s.slug === op.slug)) continue;
    try {
      if (await readSkill(botId, op.slug)) continue;
      const target: SkillSnapshot = {
        source: renderBotSkillFile({ slug: op.slug, name: op.title, description: op.description, updatedAt: new Date().toISOString(), body: op.body }),
        enabled: true,
      };
      const afterSnap = await applySkill(botId, op.slug, target);
      promoted.add(candidate.id);
      await add({ kind: 'skill', action: 'created', target: op.slug, title: op.title, reason: op.reason }, 'skill', null, afterSnap);
    } catch (error) {
      log.warn('nightly skill promotion skipped', { botId, error: String(error) });
    }
  }

  const declined = new Set(state?.declined ?? []);
  const observed: NightlyLearningCandidateRecord[] = [];
  for (const op of plan.observe) {
    // 做法既可能出自主人的要求，也可能出自伙伴这一轮实际的做法，证据可以引用任一方的原文。
    if (declined.has(op.title) || !messages.some((m) => m.id === op.evidence.messageId && m.text.includes(op.evidence.quote))) continue;
    observed.push({ id: `c_${randomUUID().slice(0, 12)}`, title: op.title, summary: op.summary, draft: op.draft, firstSeenAt: startedAt, lastSeenAt: startedAt });
  }
  const forgotten = new Set(plan.forget);

  await recordRun(
    { id: runId, at: startedAt, ...(manual ? { manual: true } : {}), outcome: items.length ? 'learned' : 'nothing', turns: selected.length, items },
    (s) => {
      s.skillUsage = usage;
      const existingTitles = new Set(s.candidates.map((c) => c.title));
      s.candidates = [
        ...observed.filter((c) => !existingTitles.has(c.title)),
        ...s.candidates.filter((c) => !promoted.has(c.id) && !forgotten.has(c.id)),
      ].slice(0, MAX_NIGHTLY_CANDIDATES);
    },
  );
  if (items.length && bot.canonicalSessionId && current())
    await requestBotRuntimeEpochRefresh(bot.canonicalSessionId, 'resource');
  return { resultText: items.length ? `Nightly learning made ${items.length} change(s)` : 'Nightly learning found nothing to change' };
}

/**
 * 排队等待期间可能换了账号：技能服务按执行时的当前账号取目录，备份目录却是入队前取的。
 * 每次读写前核对仍是入队时的账号，不是就拒绝，不写进另一个账号。
 */
function ownerGuard(): () => void {
  const owner = activeOwnerScopeKey();
  const db = getDbClient();
  return () => {
    if (isAppSessionBoundaryPending() || activeOwnerScopeKey() !== owner || getDbClient() !== db)
      throw new NightlyLearningError('UNAVAILABLE', 'Account changed');
  };
}

/** 撤销（redo=false）或恢复（redo=true）一条改动；内容在那之后被改过时拒绝，不覆盖。 */
export async function revertNightlyLearningItem(botId: string, runId: string, itemId: string, redo: boolean): Promise<void> {
  const root = ownerScopedUserDataPath();
  const assertOwner = ownerGuard();
  await runSerializedForTeammate(botId, async () => {
    assertOwner();
    const state = await readNightlyLearningState(root, botId);
    const item = state?.runs.find((r) => r.id === runId)?.items.find((i) => i.id === itemId);
    const backup = await readNightlyLearningBackup(root, botId, runId);
    const entry = backup[itemId];
    if (!item || !entry || !!item.undone === !redo) throw new NightlyLearningError('NOT_FOUND', 'Learning change not found');
    const expected = redo ? entry.before : entry.after;
    const target = redo ? entry.after : entry.before;
    let actual: MemorySnapshot | SkillSnapshot;
    if (entry.kind === 'memory') {
      const store = await memoryStoreOf(botId);
      if (!store) throw new NightlyLearningError('UNAVAILABLE', 'Memory is turned off');
      const live = memorySnapshot(await readMemory(store, item.target));
      if (!sameMemory(live, expected as MemorySnapshot)) throw new NightlyLearningError('CHANGED', 'Changed since then');
      assertOwner();
      actual = await applyMemory(store, item.target, target as MemorySnapshot, live?.updatedAt ?? null);
    } else {
      const live = await readSkill(botId, item.target);
      if (!sameSkill(live, expected as SkillSnapshot)) throw new NightlyLearningError('CHANGED', 'Changed since then');
      assertOwner();
      actual = await applySkill(botId, item.target, target as SkillSnapshot);
    }
    // 记下还原后的实际内容（记忆的更新时间会变），下一次恢复 / 撤销按它核对。
    backup[itemId] = redo ? { ...entry, after: actual } : { ...entry, before: actual };
    await writeNightlyLearningBackup(root, botId, runId, backup);
    await updateNightlyLearningState(root, botId, (s) => {
      const row = s.runs.find((r) => r.id === runId)?.items.find((i) => i.id === itemId);
      if (!row) return null;
      if (redo) delete row.undone;
      else row.undone = true;
      return s;
    });
  });
  const bot = await readBot(botId);
  if (bot?.canonicalSessionId) await requestBotRuntimeEpochRefresh(bot.canonicalSessionId, 'resource');
}

/** 「现在记成技能」直接用候选的草稿建技能并记一条可撤销记录；「不用学」移出观察且以后不再加回。 */
export async function resolveNightlyLearningCandidate(botId: string, candidateId: string, action: 'promote' | 'decline'): Promise<void> {
  const root = ownerScopedUserDataPath();
  const assertOwner = ownerGuard();
  let changed = false;
  await runSerializedForTeammate(botId, async () => {
    assertOwner();
    const state = await readNightlyLearningState(root, botId);
    const candidate = state?.candidates.find((c) => c.id === candidateId);
    if (!candidate) throw new NightlyLearningError('NOT_FOUND', 'Candidate not found');
    if (action === 'decline') {
      await updateNightlyLearningState(root, botId, (s) => {
        s.candidates = s.candidates.filter((c) => c.id !== candidateId);
        if (!s.declined.includes(candidate.title)) s.declined.push(candidate.title);
        return s;
      });
      return;
    }
    const existing = new Set((await listBotSkillsForBot(botId)).map((s) => s.slug));
    const base = normalizeBotSkillSlug(candidate.draft.name) ?? `skill-${candidateId.replace(/[^a-z0-9]/gi, '').toLowerCase().slice(-8)}`;
    let slug = base;
    for (let n = 2; existing.has(slug); n += 1) slug = `${base.slice(0, 60)}-${n}`;
    assertOwner();
    const after = await applySkill(botId, slug, {
      source: renderBotSkillFile({ slug, name: candidate.draft.name, description: candidate.draft.description, updatedAt: new Date().toISOString(), body: candidate.draft.body }),
      enabled: true,
    });
    const runId = newRunId();
    await writeNightlyLearningBackup(root, botId, runId, { i1: { kind: 'skill', before: null, after } });
    await updateNightlyLearningState(root, botId, (s) => {
      s.candidates = s.candidates.filter((c) => c.id !== candidateId);
      s.runs.unshift({
        id: runId, at: Date.now(), manual: true, outcome: 'learned', turns: 0,
        items: [{ id: 'i1', kind: 'skill', action: 'created', target: slug, title: candidate.draft.name, reason: candidate.summary }],
      });
      return s;
    });
    changed = true;
  });
  if (!changed) return;
  const bot = await readBot(botId);
  if (bot?.canonicalSessionId) await requestBotRuntimeEpochRefresh(bot.canonicalSessionId, 'resource');
}
