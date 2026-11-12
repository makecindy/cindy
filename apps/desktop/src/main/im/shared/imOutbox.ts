/**
 * im/shared/imOutbox.ts
 * ---------------------------------------------------------------------------
 * 企业微信的**持久出箱**:终稿一旦被宿主受理, 即使连接断了、进程重启了,
 * 也还能在恢复后把没送达的部分补发出去 —— 但**不**重新调用 Agent, 也**不**重做
 * 任何工具副作用。
 *
 * ## 账本语义(每条都对应一个真实故障)
 *
 *  1. **一个出站副作用一步**:每段正文 / 每个附件 / 正文里的外部图片各是一步。
 *     **发送前**先把这一步持久标记成 `inflight`(写失败就不能发), 发完立刻把结果
 *     写回磁盘 —— 进程在第二步中途退出时, 第一步的 `sent` 已经在盘上, 不会重发。
 *  2. **结果不明不盲发**:`deliverFinal` 抛错、或返回 undefined/`inflight` 残留,
 *     都记 `uncertain`; 它**不再自动重发**, 只保留状态到 TTL。`failed` 才会重试。
 *  3. **完成墓碑**:全部步骤确认送达后不删记录, 而是写 `completedAt` 的墓碑并保留
 *     到 TTL: 同一轮重复 finalize / 重启后重复 commit 都不会再发一次。墓碑占容量
 *     时会被有界驱逐(可接受: 只影响很久以前那一轮的幂等)。
 *  4. **到期调度**:失败后按退避算 `nextAttemptAt`, 并挂一个**有界定时器**在到期时
 *     再试一次; 停止/换账号/解绑会撤销定时器。不忙轮询。
 *  5. **身份校验**:发送前后、每次 await 边界都复核账号代次 / bot / stopped 代次;
 *     解绑后返回的结果**不得写回**被清掉的 store, 也不得发出。
 *  6. **有界**:条目数、单条大小、整文件总字节(与读侧同口径)、重试次数与 24h 过期
 *     都有上界; 满时**明确失败**而不是截掉未完成项。
 *  7. **重放安全**:`file` 步骤保存当时批准的允许根, 每次补发都重跑 realpath 校验,
 *     并用持久化的内容身份(大小 + mtimeMs + dev/ino)拒绝"已被替换"的成果;
 *     `media` 有总仓地址时按地址重新解析(内容寻址), 无地址时同样校验内容身份。
 *
 * 注意:本模块**不承诺 exactly-once**。平台侧没有幂等键, 我们只能保证"已确认成功
 * 的不重发、结果不明的不盲发、崩溃前已确认的步骤不丢"。
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  resolveAllowedOutboundFile,
  type ImFinalCommitOutcome,
  type ImFinalDeliveryPlan,
  type ImFinalDeliveryResult,
  type ImFinalOutput,
  type ImFinalStep,
} from '@cindy/im';

import { atomicWriteFileSync, readAtomicFileSync } from '../../utils/atomicWriteFile';

export const IM_OUTBOX_TTL_MS = 24 * 60 * 60_000;
const DEFAULT_MAX_ENTRIES = 64;
const MAX_ENTRY_BYTES = 256_000;
/** 与读侧上限一致: 写出超过它的文件会导致重启后整个 store 读不回来。 */
const MAX_FILE_BYTES = 1_000_000;
const MAX_ATTEMPTS = 5;
/** 退避序列: 前几次快, 后面慢下来, 但仍远小于 TTL。 */
const RETRY_DELAYS_MS = [2_000, 10_000, 60_000, 5 * 60_000, 15 * 60_000];
/** 单次定时器最长等待; 到点后重新按剩余时间续挂, 避免时钟跳变导致永不唤醒。 */
const MAX_TIMER_WAIT_MS = 60_000;

export type ImOutboxStepState = 'pending' | 'inflight' | 'sent' | 'failed' | 'uncertain';

/** 持久化的内容身份; 重放时不一致即拒绝(拒绝已被替换的成果)。 */
export interface ImOutboxFingerprint {
  size: number;
  mtimeMs: number;
  dev?: number;
  ino?: number;
}

export interface ImOutboxStep {
  id: string;
  kind: 'text' | 'media' | 'file' | 'remote';
  text?: string;
  absPath?: string;
  displayName?: string;
  /** cindy-media 总仓地址或外部 HTTPS 图片地址。 */
  url?: string;
  /** `file` 步骤当时批准的允许根; 补发时重新校验(不能因重放而跳过)。 */
  allowedRoots?: string[];
  /** 落盘时的文件身份(大小/mtime/inode); 重放前比对, 不一致就拒绝。 */
  fingerprint?: ImOutboxFingerprint;
  state: ImOutboxStepState;
  /** 这一步已经尝试过几次(含 inflight 那一次)。 */
  attempts: number;
}

export interface ImOutboxEntry {
  version: 1;
  /** 幂等键: `${channel}:${turnId}`。 */
  id: string;
  channel: 'wecom';
  /** 稳定账号代次(owner storage key);换账号后旧记录绝不重放。 */
  accountScope: string;
  botId: string;
  /** 目标 lane(用户 id 或群 lane)。 */
  target: string;
  terminal: 'done' | 'aborted' | 'error';
  steps: ImOutboxStep[];
  /** 整条记录的重试轮次。 */
  attempts: number;
  createdAt: number;
  updatedAt: number;
  nextAttemptAt: number;
  expiresAt: number;
  /** 全部步骤确认送达的时间: 完成墓碑, 只用于幂等, 不再发送。 */
  completedAt?: number;
  /** 已经报过一次"有内容结果不明"的告警, 避免每次连接都重复。 */
  uncertaintyReported?: true;
}

interface OutboxFile {
  version: 1;
  entries: ImOutboxEntry[];
}

export interface ImOutboxFeed {
  /** 该账号 + bot 下仍需要投递的记录(不含完成墓碑与已过期)。 */
  list(scope: { accountScope: string; botId: string }): ImOutboxEntry[];
  /** 该账号 + bot 的全部记录(含完成墓碑), 用于幂等查询与清理。 */
  listAll(scope?: { accountScope?: string; botId?: string }): ImOutboxEntry[];
}

export interface ImOutboxStore extends ImOutboxFeed {
  readonly filePath: string;
  /**
   * 幂等 upsert。返回 false = 没写进磁盘(容量/大小/IO 失败), 调用方**不得**据此
   * 认为已受理; 绝不能靠丢掉未完成项来腾地方。
   */
  upsert(entry: ImOutboxEntry): boolean;
  remove(id: string): boolean;
  prune(): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isFingerprint(value: unknown): value is ImOutboxFingerprint {
  if (!isRecord(value)) return false;
  return (
    isFiniteNumber(value.size) &&
    isFiniteNumber(value.mtimeMs) &&
    (value.dev === undefined || isFiniteNumber(value.dev)) &&
    (value.ino === undefined || isFiniteNumber(value.ino))
  );
}

function isStep(value: unknown): value is ImOutboxStep {
  if (!isRecord(value)) return false;
  if (typeof value.id !== 'string' || !value.id) return false;
  if (
    value.kind !== 'text' &&
    value.kind !== 'media' &&
    value.kind !== 'file' &&
    value.kind !== 'remote'
  ) {
    return false;
  }
  if (
    value.state !== 'pending' &&
    value.state !== 'inflight' &&
    value.state !== 'sent' &&
    value.state !== 'failed' &&
    value.state !== 'uncertain'
  ) {
    return false;
  }
  if (typeof value.attempts !== 'number' || !Number.isInteger(value.attempts) || value.attempts < 0) {
    return false;
  }
  if (value.kind === 'text' && typeof value.text !== 'string') return false;
  if (value.kind === 'remote' && typeof value.url !== 'string') return false;
  if ((value.kind === 'media' || value.kind === 'file') && typeof value.absPath !== 'string') {
    return false;
  }
  if (value.displayName !== undefined && typeof value.displayName !== 'string') return false;
  if (value.url !== undefined && typeof value.url !== 'string') return false;
  if (value.fingerprint !== undefined && !isFingerprint(value.fingerprint)) return false;
  if (
    value.allowedRoots !== undefined &&
    (!Array.isArray(value.allowedRoots) || value.allowedRoots.some((root) => typeof root !== 'string'))
  ) {
    return false;
  }
  return true;
}

function isEntry(value: unknown, channel: 'wecom'): value is ImOutboxEntry {
  if (!isRecord(value)) return false;
  return (
    value.version === 1 &&
    typeof value.id === 'string' &&
    value.id.startsWith(`${channel}:`) &&
    value.channel === channel &&
    typeof value.accountScope === 'string' &&
    typeof value.botId === 'string' &&
    typeof value.target === 'string' &&
    (value.terminal === 'done' || value.terminal === 'aborted' || value.terminal === 'error') &&
    Array.isArray(value.steps) &&
    value.steps.length > 0 &&
    value.steps.every(isStep) &&
    typeof value.attempts === 'number' &&
    Number.isInteger(value.attempts) &&
    isFiniteNumber(value.createdAt) &&
    isFiniteNumber(value.updatedAt) &&
    isFiniteNumber(value.nextAttemptAt) &&
    isFiniteNumber(value.expiresAt) &&
    (value.completedAt === undefined || isFiniteNumber(value.completedAt))
  );
}

/** 允许根规范成真实路径;realpath 失败时保留原值(校验仍然失败关闭)。 */
async function canonicalizeRoots(roots: readonly string[]): Promise<string[]> {
  const result: string[] = [];
  for (const root of roots) {
    if (!root?.trim()) continue;
    result.push(await realpathSafe(root));
  }
  return result;
}

async function realpathSafe(target: string): Promise<string> {
  try {
    return await fs.promises.realpath(target);
  } catch {
    return target;
  }
}

async function fingerprintOf(absPath: string): Promise<ImOutboxFingerprint | null> {
  try {
    const stat = await fs.promises.stat(absPath, { bigint: false });
    if (!stat.isFile() || stat.size <= 0) return null;
    return {
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      ...(Number.isFinite(stat.dev) ? { dev: stat.dev } : {}),
      ...(Number.isFinite(stat.ino) ? { ino: stat.ino } : {}),
    };
  } catch {
    return null;
  }
}

/** 重放前核对内容身份: 文件被替换(大小/mtime/inode 变了)就拒绝。 */
async function matchesFingerprint(
  absPath: string,
  expected: ImOutboxFingerprint | undefined,
): Promise<boolean> {
  if (!expected) return false;
  const actual = await fingerprintOf(absPath);
  if (!actual) return false;
  if (actual.size !== expected.size) return false;
  if (actual.mtimeMs !== expected.mtimeMs) return false;
  if (expected.dev !== undefined && actual.dev !== expected.dev) return false;
  if (expected.ino !== undefined && actual.ino !== expected.ino) return false;
  return true;
}

export function createImOutbox(deps: {
  channel: 'wecom';
  filePath: string;
  log: { warn(message: string): void };
  now?: () => number;
  maxEntries?: number;
}): ImOutboxStore {
  const now = deps.now ?? Date.now;
  const maxEntries = Math.max(1, Math.floor(deps.maxEntries ?? DEFAULT_MAX_ENTRIES));
  let cached: ImOutboxEntry[] | null = null;

  /**
   * store 与调用方之间只交换**快照**: 调用方对步骤的修改在 persist 之前不得污染
   * 缓存/磁盘 —— 否则一次写失败之后, 内存里的"未持久结果"会被后续 remove/drop
   * 顺手写回, 破坏 inflight 恢复的语义。
   */
  function cloneEntry(entry: ImOutboxEntry): ImOutboxEntry {
    return structuredClone(entry);
  }

  function cloneEntries(entries: readonly ImOutboxEntry[]): ImOutboxEntry[] {
    return entries.map((entry) => cloneEntry(entry));
  }

  function read(): ImOutboxEntry[] | null {
    if (cached !== null) return cached;
    let raw: string | null;
    try {
      raw = readAtomicFileSync(deps.filePath);
    } catch {
      deps.log.warn('im outbox read failed (io)');
      return null;
    }
    if (raw === null) {
      cached = [];
      return cached;
    }
    if (Buffer.byteLength(raw, 'utf8') > MAX_FILE_BYTES) {
      deps.log.warn('im outbox read failed (oversize)');
      cached = [];
      return cached;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      deps.log.warn('im outbox read failed (invalid-json)');
      cached = [];
      return cached;
    }
    if (!isRecord(parsed) || parsed.version !== 1 || !Array.isArray(parsed.entries)) {
      deps.log.warn('im outbox read failed (invalid-shape)');
      cached = [];
      return cached;
    }
    cached = parsed.entries
      .filter((entry) => isEntry(entry, deps.channel))
      .map((entry) => ({ ...entry, channel: deps.channel }));
    return cached;
  }

  function serialize(entries: ImOutboxEntry[]): string {
    const file: OutboxFile = { version: 1, entries };
    return JSON.stringify(file);
  }

  /** 写入给定快照; 缓存也只保存这份快照(不与调用方共享对象)。 */
  function write(snapshot: ImOutboxEntry[], raw = serialize(snapshot)): boolean {
    try {
      fs.mkdirSync(path.dirname(deps.filePath), { recursive: true });
      atomicWriteFileSync(deps.filePath, raw);
      cached = cloneEntries(snapshot);
      return true;
    } catch {
      deps.log.warn('im outbox write failed');
      return false;
    }
  }

  function expired(entry: ImOutboxEntry, nowMs: number): boolean {
    return entry.expiresAt <= nowMs;
  }

  /** 完成墓碑与过期记录可以被回收; 未送达的记录绝不为了腾地方而被丢掉。 */
  function reclaimable(entry: ImOutboxEntry, nowMs: number): boolean {
    return entry.completedAt !== undefined || expired(entry, nowMs);
  }

  function prune(nowMs = now()): ImOutboxEntry[] {
    const entries = read();
    if (entries === null) return [];
    const kept = entries.filter((entry) => !expired(entry, nowMs));
    if (kept.length !== entries.length) write(kept);
    return kept;
  }

  return {
    filePath: deps.filePath,
    upsert(entry) {
      const entries = read();
      if (entries === null) return false;
      if (Buffer.byteLength(JSON.stringify(entry), 'utf8') > MAX_ENTRY_BYTES) {
        deps.log.warn('im outbox upsert rejected (entry-too-large)');
        return false;
      }
      const nowMs = now();
      // 过期记录顺手清掉, 再按 id 去重后放到最前。存进去的是**快照**: 调用方
      // 后续对步骤的修改不会污染缓存(写失败时盘/缓存停在上一成功状态)。
      const incoming = cloneEntry(entry);
      const next = entries.filter((item) => item.id !== entry.id && !expired(item, nowMs));
      next.unshift(incoming);
      // 容量: 只驱逐墓碑/过期项; 不够就明确失败(不静默丢未完成项)。
      while (next.length > maxEntries) {
        const index = next.findIndex((item) => item.id !== entry.id && reclaimable(item, nowMs));
        if (index < 0) {
          deps.log.warn('im outbox upsert rejected (capacity)');
          return false;
        }
        next.splice(index, 1);
      }
      // 总字节预算与读侧同口径: 写不进去的文件等于重启后全部丢失。
      let raw = serialize(next);
      while (Buffer.byteLength(raw, 'utf8') > MAX_FILE_BYTES) {
        const index = next.findIndex((item) => item.id !== entry.id && reclaimable(item, nowMs));
        if (index < 0) {
          deps.log.warn('im outbox upsert rejected (file-budget)');
          return false;
        }
        next.splice(index, 1);
        raw = serialize(next);
      }
      return write(next, raw);
    },
    remove(id) {
      const entries = read();
      if (entries === null) return false;
      const next = entries.filter((entry) => entry.id !== id);
      if (next.length === entries.length) return true;
      // 以磁盘上的快照为准重写(不看调用方手里被改过的对象)。
      return write(next);
    },
    list(scope) {
      const nowMs = now();
      return prune(nowMs)
        .filter(
          (entry) =>
            entry.completedAt === undefined &&
            entry.accountScope === scope.accountScope &&
            entry.botId === scope.botId,
        )
        .map((entry) => cloneEntry(entry));
    },
    listAll(scope) {
      return prune()
        .filter(
          (entry) =>
            (scope?.accountScope === undefined || entry.accountScope === scope.accountScope) &&
            (scope?.botId === undefined || entry.botId === scope.botId),
        )
        .map((entry) => cloneEntry(entry));
    },
    prune() {
      prune();
    },
  };
}

// ── 投递 ──────────────────────────────────────────────────────────────────────

export interface ImOutboxTransport {
  prepareFinal(output: ImFinalOutput): Promise<ImFinalDeliveryPlan>;
  deliverFinal(
    output: ImFinalOutput,
    plan: ImFinalDeliveryPlan,
    opts?: { onlySteps?: string[] },
  ): Promise<ImFinalDeliveryResult>;
  /**
   * 分项能力不可用 / 没有持久化上下文时的兜底。返回交付边界(旧渠道可返回 void,
   * 按"已送达"处理 —— 它们本来就是 resolve 即终态)。
   */
  commitFinal(output: ImFinalOutput): Promise<ImOutboxCommitOutcome | void>;
  /**
   * 可选: 当前连接是否可用。未提供时按"可用"处理(兼容旧宿主/测试替身)。
   *
   * 离线与"投递失败"必须分开: 离线时一个字节都不会发出去, 不该消耗重试次数,
   * 也不该为此排定时器; 恢复事件(connected)会把待发记录重新唤醒。
   */
  isConnected?(): boolean;
}

/**
 * 一次终稿交付的真实边界。runner 据此区分"已确认送达 / 已持久受理 / 没发出去",
 * 不用抛错假装"Agent 执行失败", 也不把"已受理"报成"已送达"。
 */
export type ImOutboxCommitOutcome = ImFinalCommitOutcome;

export const SENT_OUTCOME: ImOutboxCommitOutcome = { status: 'sent', unresolved: 0, retrying: 0 };
export const FAILED_OUTCOME: ImOutboxCommitOutcome = { status: 'failed', unresolved: 1, retrying: 0 };

export interface ImOutboxDeliveryDeps {
  channel: 'wecom';
  store: ImOutboxStore;
  transport(): ImOutboxTransport | null;
  /** 当前连接所属的 bot id; 未连接返回空串。 */
  botId(): string;
  /** 当前稳定账号代次(owner storage key)。 */
  accountScope(): string;
  /**
   * 创建时绑定的账号/bot(缺省取构造瞬间的值)。绑定后不允许再换: 定时器与排队
   * 任务醒来时若运行期身份已变, 本实例停用, 不会拿新身份去读/清旧 store。
   */
  boundAccountScope?: string;
  boundBotId?: string;
  /** 目标 lane 是否仍属于当前连接(bot + 账号), 用于隔离。 */
  isCurrentTarget?(entry: ImOutboxEntry): boolean;
  /** host 媒体总仓地址 → 本机绝对路径(补发时重新解析)。 */
  resolveMediaUrl?(url: string): string | null;
  log: { warn(message: string): void };
  now?: () => number;
  retryDelays?: number[];
  maxAttempts?: number;
}

export interface ImOutboxDelivery {
  /** 持久受理并立即尝试投递; 返回值说明真实送达边界。 */
  commit(output: ImFinalOutput): Promise<ImOutboxCommitOutcome>;
  /** 连接恢复/启动时补发未完成项(不重放已确认成功项, 不重做 uncertain)。 */
  flush(): Promise<void>;
  /** 解绑/换账号: 停发送并删除本 store 的全部记录。 */
  dropCurrentScope(): void;
  /** 只停发送(不删记录): 旧账号的 in-flight 结果不得落到新账号。 */
  stop(): void;
  /** 已被 stop(写盘失败等): 接线层应重建实例重新从磁盘读。 */
  isStopped(): boolean;
}

interface IdentitySnapshot {
  accountScope: string;
  botId: string;
  generation: number;
}

export function createImOutboxDelivery(deps: ImOutboxDeliveryDeps): ImOutboxDelivery {
  const now = deps.now ?? Date.now;
  const retryDelays = deps.retryDelays ?? RETRY_DELAYS_MS;
  const maxAttempts = deps.maxAttempts ?? MAX_ATTEMPTS;
  // 串行化: commit 与 flush 可能同时进来, 同一条记录不能被并发投递两次。
  let tail: Promise<unknown> = Promise.resolve();
  /** 账号/连接被更换后置位: 本 delivery 不再发起任何发送, 也不写回结果。 */
  let stopped = false;
  /** 每次 stop/drop 递增; 跨 await 携带它判断结果是否还属于当前代次。 */
  let generation = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let flushQueued = false;

  /**
   * **绑定身份**: 本实例只服务创建时那一个账号 + bot 的 store。定时器/排队任务醒来
   * 之后绝不重新采当前身份 —— 否则旧 timer 在新账号 B 醒来会拿 B 去 list/清理 A 的
   * store(空结果 + 误删 A 的记录)。失效时只能停用, 由接线层按明确生命周期重建。
   */
  const boundAccountScope = deps.boundAccountScope ?? deps.accountScope();
  const boundBotId = deps.boundBotId ?? deps.botId();

  function captureIdentity(): IdentitySnapshot {
    return { accountScope: boundAccountScope, botId: boundBotId, generation };
  }

  function identityCurrent(snapshot: IdentitySnapshot): boolean {
    if (stopped || snapshot.generation !== generation) return false;
    if (snapshot.accountScope !== boundAccountScope || snapshot.botId !== boundBotId) return false;
    // 运行期身份必须仍与绑定身份一致; 一旦变了(换账号/解绑), 本实例作废。
    if (deps.botId() !== boundBotId) return false;
    return deps.accountScope() === boundAccountScope;
  }

  function clearTimer(): void {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function stop(): void {
    if (stopped) return;
    stopped = true;
    generation += 1;
    clearTimer();
  }

  function serialize<T>(task: () => Promise<T>): Promise<T> {
    const run = tail.then(task, task);
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  function entryId(output: ImFinalOutput): string {
    const turnId = output.turnId?.trim() || randomUUID();
    return `${deps.channel}:${turnId}`;
  }

  /** 把计划落成账本步骤(含内容身份)。`file` 步骤保存当时批准的允许根。 */
  async function toSteps(
    plan: ImFinalDeliveryPlan,
    output: ImFinalOutput,
  ): Promise<ImOutboxStep[]> {
    const canonicalRoots = await canonicalizeRoots(output.allowedFileRoots ?? []);
    const steps: ImOutboxStep[] = [];
    for (const step of plan.steps) {
      if (step.kind === 'text') {
        steps.push({ id: step.id, kind: 'text', text: step.text, state: 'pending', attempts: 0 });
        continue;
      }
      if (step.kind === 'remote') {
        steps.push({
          id: step.id,
          kind: 'remote',
          url: step.url,
          displayName: step.displayName,
          state: 'pending',
          attempts: 0,
        });
        continue;
      }
      const absPath = await realpathSafe(step.absPath);
      // 媒体有总仓地址时由地址决定内容(内容寻址); 其余一律记录内容身份。
      const fingerprint = step.url ? undefined : (await fingerprintOf(absPath)) ?? undefined;
      steps.push({
        id: step.id,
        kind: step.kind,
        absPath,
        displayName: step.displayName,
        ...(step.url ? { url: step.url } : {}),
        ...(fingerprint ? { fingerprint } : {}),
        ...(step.kind === 'file' ? { allowedRoots: canonicalRoots } : {}),
        state: 'pending',
        attempts: 0,
      });
    }
    return steps;
  }

  function toPlan(entry: ImOutboxEntry): ImFinalDeliveryPlan {
    const steps: ImFinalStep[] = entry.steps.map((step) => {
      if (step.kind === 'text') {
        return { id: step.id, kind: 'text', text: step.text ?? '' };
      }
      if (step.kind === 'remote') {
        return {
          id: step.id,
          kind: 'remote',
          url: step.url ?? '',
          displayName: step.displayName ?? '',
        };
      }
      return {
        id: step.id,
        kind: step.kind,
        absPath: step.absPath ?? '',
        displayName: step.displayName ?? '',
        ...(step.url ? { url: step.url } : {}),
      };
    });
    return { steps };
  }

  function entryOutput(entry: ImOutboxEntry): ImFinalOutput {
    return {
      userId: entry.target,
      text: '',
      terminal: entry.terminal,
      turnId: entry.id.slice(entry.id.indexOf(':') + 1),
      allowedFileRoots: [],
    };
  }

  /** 写盘失败就不能再发: 停掉本实例, 让接线层从磁盘重建(记录仍是最后一次成功检查点)。 */
  /** transport 可用且（如果它声明了）当前连接正常。 */
  function transportAvailable(): boolean {
    const transport = deps.transport();
    if (!transport) return false;
    if (typeof transport.isConnected === 'function') return transport.isConnected();
    return true;
  }

  function persist(entry: ImOutboxEntry): boolean {
    entry.updatedAt = now();
    if (deps.store.upsert(entry)) return true;
    deps.log.warn(`im outbox checkpoint failed (${deps.channel}); stopping this delivery`);
    stop();
    return false;
  }

  function counts(entry: ImOutboxEntry): { unresolved: number; retrying: number } {
    // 只有还能再试的才算"会自动重试": 重试次数用尽的(含永久失败/被替换的文件)
    // 不该让记录继续挂定时器, 也不该在提示里承诺自动补发。
    const retryable = entry.steps.filter(
      (step) =>
        (step.state === 'pending' || step.state === 'failed') && step.attempts < maxAttempts,
    );
    const unresolved = entry.steps.filter((step) => step.state !== 'sent').length;
    return { unresolved, retrying: retryable.length };
  }

  /**
   * 单步补发前的安全校验:
   *  - `file`: 重跑允许根 + realpath 校验, 再比对内容身份;
   *  - `media`: 有总仓地址就重新解析(内容寻址); 无地址时比对内容身份;
   *  - `remote`: 外部图片地址, 不做本地路径校验。
   */
  async function revalidateStep(
    step: ImOutboxStep,
  ): Promise<{ ok: true; absPath?: string } | { ok: false; permanent: boolean }> {
    if (step.kind === 'text' || step.kind === 'remote') return { ok: true };
    let absPath = step.absPath ?? '';
    if (step.url) {
      const resolved = deps.resolveMediaUrl?.(step.url) ?? null;
      if (!resolved) return { ok: false, permanent: true };
      absPath = resolved;
    }
    if (!absPath) return { ok: false, permanent: true };
    if (step.kind === 'file') {
      const allowed = await resolveAllowedOutboundFile(absPath, step.allowedRoots ?? []);
      if (!allowed) return { ok: false, permanent: true };
      absPath = allowed;
    }
    // 无总仓地址时, 内容必须还是落盘时那一份(被替换的成果不能发出去)。
    if (!step.url && !(await matchesFingerprint(absPath, step.fingerprint))) {
      return { ok: false, permanent: true };
    }
    return { ok: true, absPath };
  }

  /** 上次进程在发送中退出: inflight 残留一律确定成 uncertain, 不再复查。 */
  function settleAbandonedInflight(entry: ImOutboxEntry): void {
    for (const step of entry.steps) {
      if (step.state === 'inflight') step.state = 'uncertain';
    }
  }

  async function deliverEntry(entry: ImOutboxEntry): Promise<void> {
    const identity = captureIdentity();
    if (!identityCurrent(identity)) return;
    // 记录自己的身份必须与当前账号/bot 一致 —— 否则这条是旧身份留下的, 不能发。
    if (entry.accountScope !== identity.accountScope || entry.botId !== identity.botId) return;
    if (entry.completedAt !== undefined) return;
    if (deps.isCurrentTarget && !deps.isCurrentTarget(entry)) return;

    settleAbandonedInflight(entry);
    const queued = entry.steps.filter(
      (step) => step.state === 'pending' || step.state === 'failed',
    );
    if (queued.length === 0) {
      finalizeEntry(entry, identity);
      return;
    }
    // 离线时一个字节都发不出去: 不消耗重试次数、不记录 inflight, 等连接恢复事件。
    if (!transportAvailable()) return;
    entry.attempts += 1;
    if (!persist(entry)) return;

    for (const step of queued) {
      if (!identityCurrent(identity)) return;
      if (entry.completedAt !== undefined) return;
      if (step.attempts >= maxAttempts) continue;
      // 中途掉线同样不消耗这一步的次数。
      if (!transportAvailable()) return;

      // 1) 补发前的安全校验(可能含 IO)。期间解绑/换账号就不写回、不发。
      const gate = await revalidateStep(step);
      if (!identityCurrent(identity)) return;
      if (!gate.ok) {
        step.state = 'failed';
        step.attempts = gate.permanent ? maxAttempts : step.attempts + 1;
        if (!persist(entry)) return;
        continue;
      }
      if (gate.absPath) step.absPath = gate.absPath;

      // 2) **发送前**先把这一步持久标成 inflight; 写失败就不发。
      step.state = 'inflight';
      step.attempts += 1;
      if (!persist(entry)) return;

      // 3) 只投递这一步: 结果与这一项严格对应, 崩溃后不会重发已确认项。
      const transport = deps.transport();
      if (!transport) return;
      const plan = toPlan(entry);
      const index = plan.steps.findIndex((item) => item.id === step.id);
      let state: ImFinalDeliveryResult['states'][number];
      try {
        const result = await transport.deliverFinal(entryOutput(entry), plan, {
          onlySteps: [step.id],
        });
        state = result.states[index];
      } catch {
        // 抛错 = 结果未知: 计 uncertain, 绝不盲目重发。
        state = undefined;
      }
      // 结果返回后身份可能已经变了: 不得写回被清的 store, 也不得继续发。
      if (!identityCurrent(identity)) return;
      step.state = state ?? 'uncertain';
      if (!persist(entry)) return;
    }

    finalizeEntry(entry, identity);
  }

  function finalizeEntry(entry: ImOutboxEntry, identity: IdentitySnapshot): void {
    if (!identityCurrent(identity)) return;
    if (entry.completedAt !== undefined) return;
    const { unresolved, retrying } = counts(entry);
    if (unresolved === 0) {
      // 完成墓碑: 保留幂等凭据到 TTL, 不删记录 —— 否则同一轮还能被再发一次。
      entry.completedAt = now();
      entry.nextAttemptAt = entry.expiresAt;
      persist(entry);
      return;
    }
    if (retrying === 0) {
      // 只剩结果不明: 不再自动重发, 记录保留到 TTL, 只报一次。
      if (!entry.uncertaintyReported) {
        entry.uncertaintyReported = true;
        deps.log.warn(
          `im outbox has ${unresolved} uncertain delivery item(s) (${deps.channel}); not resending`,
        );
      }
      entry.nextAttemptAt = entry.expiresAt;
      persist(entry);
      return;
    }
    const delay = retryDelays[Math.min(entry.attempts, retryDelays.length - 1)] ?? 15 * 60_000;
    entry.nextAttemptAt = now() + delay;
    persist(entry);
    armTimer();
  }

  /** 有界定时器: 到点续挂, 不做忙轮询; 停止/换账号时撤销。 */
  function armTimer(): void {
    if (stopped || timer) return;
    const identity = captureIdentity();
    if (!identity.accountScope || !identity.botId) return;
    // 身份已经变了(哪怕还没 stop): 不排定时器, 更不能用新身份去读旧 store。
    if (!identityCurrent(identity)) return;
    // 离线时不排定时器: 连接恢复事件(connected → flush)会可靠地唤醒待发记录,
    // 这里排 60s 一次的空转只会白烧 IO。
    if (!transportAvailable()) return;
    const nowMs = now();
    const upcoming = deps.store
      .list({ accountScope: identity.accountScope, botId: identity.botId })
      // 到期与未来到期的可重试项都需要唤醒，批次内刚到期的项不能漏掉。
      // 只有**真的还能重试**的记录才值得唤醒: 结果不明/次数用尽的记录 nextAttemptAt
      // 设在过期时刻, 给它排定时器等于每 60 秒空转一次直到 TTL。
      .filter(
        (entry) =>
          (!deps.isCurrentTarget || deps.isCurrentTarget(entry)) &&
          entry.steps.some(
            (step) =>
              (step.state === 'pending' || step.state === 'failed') &&
              step.attempts < maxAttempts,
          ),
      );
    if (upcoming.length === 0) return;
    const due = Math.min(...upcoming.map((entry) => entry.nextAttemptAt));
    const wait = Math.max(0, Math.min(due - nowMs, MAX_TIMER_WAIT_MS));
    timer = setTimeout(() => {
      timer = null;
      // 到点时身份可能已经变了: 直接作废, 不再读/清任何记录。
      if (!identityCurrent(identity)) return;
      void runFlush();
    }, wait);
    (timer as unknown as { unref?: () => void }).unref?.();
  }

  function runFlush(): Promise<void> {
    if (stopped) return Promise.resolve();
    // 入口就核对**绑定身份**: 旧 timer 或排队的 flush 在换账号后醒来时直接失效。
    const callIdentity = captureIdentity();
    if (!identityCurrent(callIdentity)) return Promise.resolve();
    if (flushQueued) return Promise.resolve();
    flushQueued = true;
    return serialize(async () => {
      flushQueued = false;
      if (!identityCurrent(callIdentity)) return;
      const nowMs = now();
      const entries = deps.store.list({
        accountScope: callIdentity.accountScope,
        botId: callIdentity.botId,
      });
      for (const entry of entries) {
        if (!identityCurrent(callIdentity)) return;
        if (entry.nextAttemptAt > nowMs) continue;
        await deliverEntry(entry);
      }
      // 这里**不再**清理“其他账号”的记录: 本 store 只属于绑定身份, 换账号/解绑由
      // 明确的生命周期(dropCurrentScope)处理。旧 timer 不能拿新身份去删旧记录。
      armTimer();
    });
  }

  function outcomeOf(entry: ImOutboxEntry | undefined): ImOutboxCommitOutcome {
    if (!entry) return SENT_OUTCOME;
    if (entry.completedAt !== undefined) return SENT_OUTCOME;
    const { unresolved, retrying } = counts(entry);
    return { status: 'durable', unresolved, retrying };
  }

  return {
    commit(output) {
      if (stopped) return Promise.resolve(FAILED_OUTCOME);
      // **入口即捕获身份/代次**: 排队执行时账号可能已经换了, 之后必须与这份快照
      // 比对; 任何兜底直发也要先复核, 不能把旧任务发到新账号或解绑后的渠道上。
      const callIdentity = captureIdentity();
      return serialize<ImOutboxCommitOutcome>(async () => {
        const transport = deps.transport();
        if (stopped || !identityCurrent(callIdentity)) return FAILED_OUTCOME;
        if (!transport) throw new Error('IM transport unavailable');
        const identity = callIdentity;

        if (!identity.accountScope || !identity.botId) {
          // 入口时就没有账号/连接上下文: 走渠道原有直发语义(没有持久化保障)。
          return (await transport.commitFinal(output)) ?? SENT_OUTCOME;
        }

        // 幂等: 同一轮已经完成(墓碑)就直接返回, 绝不再发。
        const id = entryId(output);
        const existing = deps.store
          .listAll({ accountScope: identity.accountScope, botId: identity.botId })
          .find((entry) => entry.id === id);
        if (existing?.completedAt !== undefined) return SENT_OUTCOME;
        if (existing) {
          // 同一轮重复 finalize / 重试: 复用已有记录, 不产生第二条, 也不把已确认
          // 成功的步骤改回 pending。
          if (existing.accountScope !== identity.accountScope || existing.botId !== identity.botId) {
            return FAILED_OUTCOME;
          }
          if (!identityCurrent(identity)) return FAILED_OUTCOME;
          existing.updatedAt = now();
          existing.terminal = output.terminal;
          await deliverEntry(existing);
          if (stopped || !identityCurrent(identity)) return FAILED_OUTCOME;
          return outcomeOf(existing);
        }

        let steps: ImOutboxStep[];
        try {
          steps = await toSteps(await transport.prepareFinal(output), output);
        } catch {
          // prepare 期间可能已经解绑/换账号: 兜底直发前必须复核原身份。
          if (stopped || !identityCurrent(identity)) return FAILED_OUTCOME;
          deps.log.warn(`im outbox prepare failed (${deps.channel}); sending directly`);
          return (await transport.commitFinal(output)) ?? SENT_OUTCOME;
        }
        // prepare 期间可能已经解绑/换账号: 不得写进旧 store。
        if (stopped || !identityCurrent(identity)) return FAILED_OUTCOME;
        const nowMs = now();
        const entry: ImOutboxEntry = {
          version: 1,
          id,
          channel: deps.channel,
          accountScope: identity.accountScope,
          botId: identity.botId,
          target: output.userId,
          terminal: output.terminal,
          steps,
          attempts: 0,
          createdAt: nowMs,
          updatedAt: nowMs,
          nextAttemptAt: nowMs,
          expiresAt: nowMs + IM_OUTBOX_TTL_MS,
        };
        // 受理(初次落盘)失败**不**走 persist(): 那会 stop 本实例。此时一个字节都还没
        // 发, 回退到旧语义(渠道直发)是安全的, 但同样要先复核身份。
        const accepted = deps.store.upsert(entry);
        if (!accepted) {
          if (stopped || !identityCurrent(identity)) return FAILED_OUTCOME;
          return (await transport.commitFinal(output)) ?? SENT_OUTCOME;
        }
        await deliverEntry(entry);
        if (stopped || !identityCurrent(identity)) return FAILED_OUTCOME;
        return outcomeOf(entry);
      });
    },

    flush() {
      return runFlush();
    },

    dropCurrentScope() {
      // 以 **本 store** 为准删除: 文件本身已经按账号目录 + bot 分片, 不靠调用时刻的
      // 当前身份去匹配 —— 换账号/登出之后 botId 可能已经清空, 按身份匹配会什么都删不掉。
      stop();
      for (const entry of deps.store.listAll()) deps.store.remove(entry.id);
    },

    stop,
    isStopped: () => stopped,
  };
}
