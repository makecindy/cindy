/**
 * 伙伴「夜间学习」的持久状态：对话计数、整理水位、频率、学习记录、观察中的做法、技能使用次数。
 *
 * 正本是伙伴 Home 下的 nightly-learning.json；每次改动的前后内容存在 learning-history/<runId>.json，
 * 撤销 / 恢复据此还原。同一主进程内按伙伴串行读改写，写入走临时文件 + rename；读到坏文件时
 * 先把它改名保留，再从空状态继续，不覆盖原文件。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  NightlyLearningCandidate,
  NightlyLearningFrequency,
  NightlyLearningRun,
} from '../../shared/botNightlyLearning.js';
import { botSkillRootDir } from './botSkillStore.js';

export const NIGHTLY_LEARNING_FILE = 'nightly-learning.json';
export const NIGHTLY_LEARNING_HISTORY_DIR = 'learning-history';
const VERSION = 1;
const MAX_RUNS = 30;
export const MAX_NIGHTLY_CANDIDATES = 20;
const MAX_DECLINED = 40;

export interface NightlyLearningCandidateRecord extends NightlyLearningCandidate {
  /** 转正时直接用的技能草稿；不加载、不进提示词，只在转正时写成技能。 */
  draft: { name: string; description: string; body: string };
}

export interface NightlyLearningState {
  version: number;
  revision: number;
  /** 只存用户改过的值；缺省 = 每天。 */
  frequency?: NightlyLearningFrequency;
  /** 上次整理之后新增的主人对话轮次（只增；整理成功后按处理过的轮数扣减）。 */
  pending: { turns: number; sessions: Record<string, number>; firstAt?: number };
  /** 已整理到的回复时间（created_at，毫秒）；之后的回复留给下一次。 */
  throughAt?: number;
  /**
   * 水位之后已经学过的回复（回复 client_id → created_at）。水位为等仍在生成的回复而停在前面，
   * 或一批没读完时，下一次跳过这些回复，不重复学同一轮；水位越过后随之删除。
   */
  learned?: Record<string, number>;
  runs: NightlyLearningRun[];
  candidates: NightlyLearningCandidateRecord[];
  /** 用户点过「不用学」的做法标题，避免下次又加回观察。 */
  declined: string[];
  skillUsage: Record<string, { count: number; lastUsedAt: number }>;
}

/** 一条改动前后的内容。记忆存记录原文，技能存 SKILL.md 原文与启用状态；null = 不存在。 */
export type MemorySnapshot = {
  filename: string; type: string; slug: string; title: string; description: string; body: string; updatedAt: string;
} | null;
export type SkillSnapshot = { source: string; enabled: boolean } | null;
export interface NightlyLearningBackupItem {
  kind: 'memory' | 'skill';
  before: MemorySnapshot | SkillSnapshot;
  after: MemorySnapshot | SkillSnapshot;
}
export type NightlyLearningBackup = Record<string, NightlyLearningBackupItem>;

export function emptyNightlyLearningState(): NightlyLearningState {
  return { version: VERSION, revision: 0, pending: { turns: 0, sessions: {} }, runs: [], candidates: [], declined: [], skillUsage: {} };
}

export function nightlyLearningPath(userDataDir: string, botId: string): string {
  return path.join(botSkillRootDir(userDataDir, botId), NIGHTLY_LEARNING_FILE);
}

function historyPath(userDataDir: string, botId: string, runId: string): string {
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(runId)) throw new Error('Invalid learning run id');
  return path.join(botSkillRootDir(userDataDir, botId), NIGHTLY_LEARNING_HISTORY_DIR, `${runId}.json`);
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const num = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0);

export function parseNightlyLearningState(raw: unknown): NightlyLearningState {
  if (!isRecord(raw)) throw new Error('Invalid nightly learning state');
  const pending = isRecord(raw.pending) ? raw.pending : {};
  const sessions: Record<string, number> = {};
  if (isRecord(pending.sessions)) for (const [id, n] of Object.entries(pending.sessions)) if (num(n) > 0) sessions[id] = num(n);
  const learned: Record<string, number> = {};
  if (isRecord(raw.learned)) for (const [id, at] of Object.entries(raw.learned)) if (num(at) > 0) learned[id] = num(at);
  const usage: NightlyLearningState['skillUsage'] = {};
  if (isRecord(raw.skillUsage)) for (const [slug, value] of Object.entries(raw.skillUsage))
    if (isRecord(value)) usage[slug] = { count: num(value.count), lastUsedAt: num(value.lastUsedAt) };
  return {
    version: VERSION,
    revision: num(raw.revision),
    ...(raw.frequency === 'weekly' ? { frequency: 'weekly' as const } : {}),
    pending: { turns: num(pending.turns), sessions, ...(num(pending.firstAt) ? { firstAt: num(pending.firstAt) } : {}) },
    ...(num(raw.throughAt) ? { throughAt: num(raw.throughAt) } : {}),
    ...(Object.keys(learned).length ? { learned } : {}),
    runs: Array.isArray(raw.runs) ? (raw.runs.filter(isRecord) as unknown as NightlyLearningRun[]).slice(0, MAX_RUNS) : [],
    candidates: Array.isArray(raw.candidates)
      ? (raw.candidates.filter((c) => isRecord(c) && typeof c.id === 'string' && isRecord(c.draft)) as unknown as NightlyLearningCandidateRecord[])
        .slice(0, MAX_NIGHTLY_CANDIDATES)
      : [],
    declined: Array.isArray(raw.declined) ? raw.declined.filter((t): t is string => typeof t === 'string').slice(-MAX_DECLINED) : [],
    skillUsage: usage,
  };
}

/** 读状态；文件不存在为 null。坏文件同样返回 null，由下一次写入先改名保留再重建。 */
export async function readNightlyLearningState(userDataDir: string, botId: string): Promise<NightlyLearningState | null> {
  try {
    return parseNightlyLearningState(JSON.parse(await fs.readFile(nightlyLearningPath(userDataDir, botId), 'utf8')));
  } catch {
    return null;
  }
}

let writeSeq = 0;
const queues = new Map<string, Promise<unknown>>();

async function atomicWrite(target: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp-${process.pid}-${(writeSeq += 1)}`;
  await fs.writeFile(tmp, JSON.stringify(value, null, 2), 'utf8');
  try {
    await fs.rename(tmp, target);
  } catch (cause) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw cause;
  }
}

/**
 * 按伙伴串行地读改写。change 返回 null 表示不写；返回的状态 revision 自动加一。
 * 超出上限被挤掉的记录，其撤销备份一并删除。
 */
export async function updateNightlyLearningState(
  userDataDir: string,
  botId: string,
  change: (state: NightlyLearningState) => NightlyLearningState | null | Promise<NightlyLearningState | null>,
): Promise<NightlyLearningState | null> {
  const target = nightlyLearningPath(userDataDir, botId);
  const job = (queues.get(target) ?? Promise.resolve()).catch(() => {}).then(async () => {
    let current: NightlyLearningState;
    try {
      current = parseNightlyLearningState(JSON.parse(await fs.readFile(target, 'utf8')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        await fs.rename(target, `${target}.corrupt-${Date.now()}`).catch(() => {});
      current = emptyNightlyLearningState();
    }
    const next = await change(structuredClone(current));
    if (!next) return null;
    const keptRuns = next.runs.slice(0, MAX_RUNS);
    const stored: NightlyLearningState = {
      ...next,
      version: VERSION,
      revision: current.revision + 1,
      runs: keptRuns,
      candidates: next.candidates.slice(0, MAX_NIGHTLY_CANDIDATES),
      declined: next.declined.slice(-MAX_DECLINED),
    };
    await atomicWrite(target, stored);
    const kept = new Set(keptRuns.map((run) => run.id));
    for (const run of current.runs) if (!kept.has(run.id))
      await fs.rm(historyPath(userDataDir, botId, run.id), { force: true }).catch(() => {});
    return stored;
  });
  queues.set(target, job);
  try {
    return await job;
  } finally {
    if (queues.get(target) === job) queues.delete(target);
  }
}

/**
 * 主人和伙伴完成一轮真实对话：计数加一。调用方（botNightlyLearningCounter.ts）已按回复 id 认领，同一条回复只计一次。
 * 第一次计数时记下这条回复的时间，整理从这里开始，不回头学建档之前的旧历史。
 */
export async function recordNightlyLearningTurn(userDataDir: string, botId: string, sessionId: string, replyCreatedAt: number): Promise<void> {
  await updateNightlyLearningState(userDataDir, botId, (state) => {
    state.pending.turns += 1;
    state.pending.sessions[sessionId] = (state.pending.sessions[sessionId] ?? 0) + 1;
    if (!state.pending.firstAt) state.pending.firstAt = replyCreatedAt;
    if (!state.throughAt) state.throughAt = Math.max(0, replyCreatedAt - 1);
    return state;
  });
}

export async function readNightlyLearningBackup(userDataDir: string, botId: string, runId: string): Promise<NightlyLearningBackup> {
  try {
    const raw = JSON.parse(await fs.readFile(historyPath(userDataDir, botId, runId), 'utf8'));
    return isRecord(raw) ? (raw as NightlyLearningBackup) : {};
  } catch {
    return {};
  }
}

export async function writeNightlyLearningBackup(userDataDir: string, botId: string, runId: string, backup: NightlyLearningBackup): Promise<void> {
  await atomicWrite(historyPath(userDataDir, botId, runId), backup);
}
