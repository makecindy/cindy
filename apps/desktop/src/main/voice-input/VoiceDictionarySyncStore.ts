/**
 * 语音词典同步状态的落盘层(CRDT 正本)。
 *
 * ## 为什么是 sidecar 而不是塞进 voice-input-data.v1.json
 *
 * 旧版本客户端读写词典文件时会整份重写(`normalizeVoiceInputDataSnapshot` 只保留
 * 它认识的字段),塞进去的同步状态会被静默丢掉 —— 一次降级就把所有设备的合并
 * 历史抹平。放在旁边的独立文件里,旧版本不认识也不会碰它;升级回来后靠
 * `reconcileFromLocalSnapshot` 认领降级期间的改动。
 *
 * 另一个好处是 UI 与 IPC 完全不用改形状:词典对外仍然是
 * `VoiceInputSettings.dictionaryEntries` 那三件套,只是它们的真相变成了本状态的
 * 物化结果。
 *
 * ## 计数只在 mutate 里增长
 *
 * 运行期的一切词典变更都必须经由本类的 `mutate`(内部调 voice-input-core 的原语)。
 * 绝对不要靠「比对文件与状态的差异」来推断本地变更 —— 合并进来的远端计数会被当成
 * 本地新增再记一遍,同步一轮翻一倍。文件比对只在启动时跑一次(reconcile),且只
 * 认领存在性、不认领频次。
 */

import { app } from 'electron';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';

import {
  DEFAULT_TOMBSTONE_TTL_MS,
  createDictionaryMap,
  createEmptySyncState,
  createHlcClock,
  dictionaryTermKey,
  findMaxHlc,
  VOICE_DICTIONARY_SYNC_VERSION,
  gcTombstones,
  isValidSyncState,
  materializeDictionary,
  mergeSyncStates,
  observeHlc,
  pruneWeakAutomaticCandidates,
  reconcileFromLocalSnapshot,
  type HlcClock,
  type LocalDictionarySnapshot,
  type MaterializedDictionary,
  type DictionaryIncarnation,
  type DictionaryRecord,
  type DictionarySuppression,
  type MutationResult,
  type SyncAliasState,
  type VoiceDictionarySyncState,
} from '@cindy/voice-input-core';

import { createLogger } from '../logger.js';
import { getActiveAppSession, ownerScopedUserDataPath } from '../appSessionState.js';

const log = createLogger('voice-input:dictionary-sync');
const DATA_FILE_NAME = 'voice-dictionary-sync.v1.json';

interface StoredSyncData {
  version: 1;
  /**
   * 本设备的同步身份。本地生成并长期保持不变 —— 不能用 relay 的 deviceId:
   * 那个值在重新配对后可能变化,而计数器分桶一旦换 key 就会把同一台设备的历史
   * 事件重复计入。
   */
  nodeId: string;
  clock: { wallMs: number; counter: number };
  state: VoiceDictionarySyncState;
  /** 上次物化写进词典文件的主键集合;降级回收判断删除时用。 */
  lastMaterializedKeys: string[];
  /**
   * sidecar 不存在但投影文件里已有词典 —— 说明同步状态丢了(手工删、磁盘损坏),
   * 而不是首次安装。此时投影里的频次可能含有别的设备合并进来的计数,不能当作
   * 本机证据重新播种,否则与那台设备再同步时同一份事件会被记两遍。
   * 只是本次加载的判断结果,不落盘。
   */
  lostSidecarWithProjection?: boolean;
  /**
   * 盘上的 sidecar 是更高版本(更新的客户端写的),本进程读不懂。
   *
   * 此时整个 store 进入旁路:不读、不合并、更不写。降级回来的旧客户端如果照常
   * 走流程,会把读不懂的状态当成空状态物化出一份空词典,再用 markMaterialized
   * 把空的 v1 状态覆盖写回 —— 用户的词典和所有设备的合并历史一起没了。
   * 这个标记不落盘,只是本次加载的判断结果。
   */
  incompatible?: boolean;
}

export class VoiceDictionarySyncStore {
  private data: StoredSyncData | null = null;
  private dataOwnerId: string | null = null;
  /**
   * sidecar 丢了、但投影里还有词典时,挂起的认领。
   *
   * 这种恢复不能立刻做:本机丢掉了全部身份历史,认领会为每个词造出全新化身,而
   * 别的设备上「删掉某个词」的墓碑指向的是老化身 —— 盖不住新化身,那个词就在合并
   * 后复活了。所以先挂起,等第一次与对端合并(墓碑到齐)之后再认领,并且认领时
   * 不越过墓碑。用户在这之前动词典的话就地落地,不能让编辑等一个不知何时到来的对端。
   */
  private pendingRecovery: LocalDictionarySnapshot | null = null;

  /** 告知本次加载:投影文件里已有词典(用于判断 sidecar 是丢了还是首次安装)。 */
  noteProjectionHasDictionary(): void {
    const current = this.load();
    if (current.lostSidecarWithProjection !== undefined) return;
    if (Object.keys(current.state.records).length > 0) {
      this.data = { ...current, lostSidecarWithProjection: false };
      return;
    }
    this.data = { ...current, lostSidecarWithProjection: true };
  }

  /** 盘上的同步状态是否来自更新的客户端。true 时调用方必须完全绕开同步。 */
  isIncompatible(): boolean {
    return this.load().incompatible === true;
  }

  getNodeId(): string {
    return this.load().nodeId;
  }

  getState(): VoiceDictionarySyncState {
    return this.load().state;
  }

  materialize(): MaterializedDictionary {
    return materializeDictionary(this.load().state);
  }

  /**
   * 执行一次本地变更。返回物化结果;状态没变时返回 null,调用方据此跳过写盘与广播。
   */
  mutate(
    apply: (state: VoiceDictionarySyncState, clock: HlcClock) => MutationResult,
  ): MaterializedDictionary | null {
    const current = this.load();
    // 读不懂盘上的 sidecar 时,本机没有可信的同步状态 —— 基于空状态算出来的物化
    // 结果会把用户现有词典覆盖成空。这条路径必须硬失败,由调用方决定怎么办。
    if (current.incompatible) throw new VoiceDictionarySyncUnavailableError();
    // 挂起的恢复必须先落地:否则这次变更基于一份空状态物化,会把用户词典覆盖成空。
    this.flushPendingRecovery('local-edit');
    const base = this.load();
    const result = apply(base.state, this.readClock(base));
    if (!result.changed) return null;
    return this.commit(result.state, result.clock);
  }

  /**
   * 合并远端设备送来的状态。返回物化结果;没有引入任何新信息时返回 null。
   *
   * 入参是未经校验的隧道 payload,先过结构校验:形状不对或版本更高时会被归一化成
   * 空状态,合并即无变化,坏帧不会污染本机词典。合并本身幂等,所以重复投递、乱序、
   * 迟到的帧都可以无条件喂进来。
   */
  mergeRemote(remote: unknown): MaterializedDictionary | null {
    const current = this.load();
    if (current.incompatible) return null;
    // 坏帧、版本更高的帧都会被归一化成空状态 —— 那不是「对端词典是空的」,而是
    // 「这一帧没法用」。挂起的恢复等的是一份**真的**对端状态(墓碑随它一起到达),
    // 拿坏帧当信号会在墓碑到齐之前就播种新化身,对端删掉的词随后复活。
    const isUsableFrame = isValidSyncState(remote);
    const remoteState = isUsableFrame ? (remote as VoiceDictionarySyncState) : createEmptySyncState();
    const merged = mergeSyncStates(current.state, remoteState);
    if (isSameState(merged, current.state)) {
      // 合并没引入新信息,但「收到了一份合法的对端状态」本身就是挂起恢复在等的信号:
      // 对端是新机器、或它的词典也是空的时,每次握手都会走到这里 —— 不在这里落地的话,
      // 本机会一直只显示投影、对外发空状态,直到用户手动改一次词典才自愈。
      return isUsableFrame ? this.flushPendingRecovery('merged') : null;
    }
    // 抬高本地时钟,保证本机之后产出的时间戳大于已经观察到的一切。
    const maxRemote = findMaxHlc(remoteState);
    const clock = maxRemote
      ? observeHlc(this.readClock(current), maxRemote, Date.now())
      : this.readClock(current);
    const materialized = this.commit(merged, clock);
    // 对端墓碑已经在本地了,挂起的恢复现在可以安全落地。
    return this.flushPendingRecovery('merged') ?? materialized;
  }

  /**
   * 启动时认领「同步状态之外」对词典文件的改动(只可能来自旧版本客户端)。
   * 文件与上次物化一致时是空操作。
   */
  reconcile(
    snapshot: LocalDictionarySnapshot,
    options?: { syncEnabled?: boolean },
  ): MaterializedDictionary | null {
    const current = this.load();
    // sidecar 丢了但投影还在时(手工删、磁盘坏),这里会拿一份新 nodeId 把投影里
    // 的频次当作**本机**证据重新播种 —— 而那些数字里含有别的设备合并进来的部分。
    // 一旦与那台设备再同步,同一份事件就在两个节点桶里各记一遍,频次凭空翻倍。
    // 这种情形只认领存在性,不认领计数。
    // 同步关着就只有本机会写这份词典,认领没有复活风险,不必等对端。
    if (current.lostSidecarWithProjection && options?.syncEnabled !== false) {
      // 挂起,等对端墓碑到齐。期间 settings 保留投影文件的内容,用户照常看到词典。
      this.pendingRecovery = snapshot;
      log.info('deferred dictionary recovery until peer state is merged', {
        entries: snapshot.entries.length,
      });
      return null;
    }
    return this.reconcileNow(snapshot, { recovery: current.lostSidecarWithProjection === true });
  }

  /**
   * 落地挂起的恢复认领。合并过对端状态之后调用最安全(墓碑已到齐);本地变更前也
   * 必须调用 —— 否则 mutate 会基于空状态物化,把词典覆盖成空。
   */
  flushPendingRecovery(reason: 'merged' | 'local-edit'): MaterializedDictionary | null {
    // 必须先 load():账号边界的检查在那里面,挂起的快照可能属于上一个账号。
    this.load();
    const snapshot = this.pendingRecovery;
    if (!snapshot) return null;
    log.info('applying deferred dictionary recovery', { reason, entries: snapshot.entries.length });
    let materialized: MaterializedDictionary | null;
    try {
      materialized = this.reconcileNow(snapshot, { recovery: true });
    } catch (error) {
      // 认领没落地就不能把快照丢掉:调用方回滚后重试时,这份词典是唯一的来源 ——
      // 丢了的话重试只会物化出新编辑的那一条,把整份恢复中的词典覆盖掉。
      throw error;
    }
    this.pendingRecovery = null;
    return materialized;
  }

  hasPendingRecovery(): boolean {
    this.load();
    return this.pendingRecovery !== null;
  }

  private reconcileNow(
    snapshot: LocalDictionarySnapshot,
    options: { recovery: boolean },
  ): MaterializedDictionary | null {
    const current = this.load();
    const result = reconcileFromLocalSnapshot(current.state, this.readClock(current), {
      // 恢复模式只认领存在性:投影里的频次含有从别的设备合并进来的部分,当成本机
      // 新证据重新播种,再与那台设备同步时同一批事件会在两个节点桶里各记一遍。
      snapshot: options.recovery ? stripCountsFromSnapshot(snapshot) : snapshot,
      lastMaterializedKeys: current.lastMaterializedKeys,
      nowMs: Date.now(),
      allowTombstonedRevival: !options.recovery,
    });
    if (!result.changed) return null;
    log.info('reclaimed dictionary edits made by an older client', {
      entries: snapshot.entries.length,
    });
    return this.commit(result.state, result.clock);
  }

  /**
   * 把状态恢复到某次 mutate 之前。
   *
   * 词典写入是两段式的:先改同步状态(sidecar),再把物化结果写进词典文件。第二段
   * 失败时(磁盘满、重命名被拦)状态会领先于用户看到的内容,而重试往往是 no-op ——
   * sidecar 里已经有这次操作了,于是 UI 一直停在旧内容直到重启。调用方在第二段
   * 失败时用这个回滚。
   */
  rollbackTo(snapshot: SyncRollbackPoint): void {
    const current = this.load();
    this.persist({
      ...current,
      state: snapshot.state,
      clock: { wallMs: snapshot.clock.wallMs, counter: snapshot.clock.counter },
      // key 基线也要一起退。它是下次降级回收判断「哪些词被删了」的唯一依据:留着
      // 这次失败写下的新基线,回收就会拿它去对照回滚后的状态,把用户看到的那次
      // 变更反向执行一遍。
      lastMaterializedKeys: snapshot.lastMaterializedKeys,
    });
  }

  /** 供调用方在 mutate 前留存回滚点。 */
  snapshotForRollback(): SyncRollbackPoint {
    const current = this.load();
    return {
      state: current.state,
      clock: this.readClock(current),
      lastMaterializedKeys: current.lastMaterializedKeys,
    };
  }

  /** 记录本次物化写进词典文件的主键,供下次降级回收判断删除。 */
  markMaterialized(materialized: MaterializedDictionary): void {
    const current = this.load();
    // 必须与 CRDT 主键同一套折叠规则(locale 无关),否则回收判断会认错词条。
    const keys = materialized.entries.map((entry) => dictionaryTermKey(entry.text));
    if (sameKeys(keys, current.lastMaterializedKeys)) return;
    this.persist({ ...current, lastMaterializedKeys: keys });
  }

  /** 回收过期墓碑,并裁掉超出硬上限的自动候选。启动时跑一次即可,失败不影响功能。 */
  collectGarbage(): void {
    const current = this.load();
    const nowMs = Date.now();
    const collected = gcTombstones(current.state, { nowMs, ttlMs: DEFAULT_TOMBSTONE_TTL_MS });
    // 自动候选没有上限的话,状态会随学习单调增长,直到整份状态超过 relay 单帧上限 ——
    // 此后每一次同步广播都被静默丢弃,而被挤出展示的那些候选用户既看不见也删不掉。
    const pruned = pruneWeakAutomaticCandidates(collected, this.readClock(current), { nowMs });
    if (pruned.state === current.state) return;
    if (pruned.changed) log.info('pruned weak automatic candidates over the authoritative cap');
    this.persist({
      ...current,
      state: pruned.state,
      clock: { wallMs: pruned.clock.wallMs, counter: pruned.clock.counter },
    });
  }

  private commit(state: VoiceDictionarySyncState, clock: HlcClock): MaterializedDictionary {
    const current = this.load();
    this.persist({
      ...current,
      state,
      clock: { wallMs: clock.wallMs, counter: clock.counter },
    });
    // 用 persist 之后的状态物化,而不是传进来的那份:persist 会把盘上另一个进程
    // 刚写下的事件合并进来,拿合并前的状态物化会让投影少掉对方的词条。
    return materializeDictionary(this.data?.state ?? state);
  }

  /**
   * 写盘前把盘上的状态合并进来。
   *
   * 同一个 userData 可能被多个进程共用(dev 与正式版共用目录、被动实例)。每个进程
   * 都把 sidecar 缓存在内存里各写各的,后写的那次会用自己那份过期快照整体覆盖掉
   * 另一个进程刚记下的事件 —— 词条就这么没了。
   *
   * 这里不需要真正的跨进程锁:状态本身是 CRDT,写之前重读一次再合并即可,合并幂等
   * 且可交换。剩下的窗口(读完到 rename 之间)只会丢掉极短时间内另一进程的写入,
   * 而不是整份状态,并且下一次任意一侧的写入就会把它带回来。
   *
   * **已知精度损失**:共用 sidecar 的进程也共用同一个 nodeId,同一毫秒各自 +1 时
   * 计数按节点取 max 会塌成一次。给每个进程分配独立 nodeId 能解决,但那样计数桶会
   * 随启动次数无限增长 —— 频次只是排序权重,少记几次远好过让状态无界膨胀。
   */
  private mergeWithOnDiskState(next: StoredSyncData, filePath: string): StoredSyncData {
    let onDisk: StoredSyncData;
    try {
      onDisk = normalizeStoredData(JSON.parse(fs.readFileSync(filePath, 'utf-8')) as unknown);
    } catch {
      // 文件不存在(首次写)或读不出来:没有可合并的东西,按原样写。
      return next;
    }
    // 盘上的是更新客户端写的:一个字节都不能碰,让 persist 的调用方拿到失败。
    if (onDisk.incompatible) return next;
    const mergedState = mergeSyncStates(next.state, onDisk.state);
    if (isSameState(mergedState, next.state)) return next;
    log.info('merged concurrent dictionary state from disk before persisting');
    const maxOnDisk = findMaxHlc(onDisk.state);
    const clock = maxOnDisk
      ? observeHlc(this.readClock(next), maxOnDisk, Date.now())
      : this.readClock(next);
    return {
      ...next,
      state: mergedState,
      clock: { wallMs: clock.wallMs, counter: clock.counter },
    };
  }

  private readClock(data: StoredSyncData): HlcClock {
    return { wallMs: data.clock.wallMs, counter: data.clock.counter, nodeId: data.nodeId };
  }

  private load(): StoredSyncData {
    const ownerId = getActiveAppSession().dataOwnerId;
    if (this.data && this.dataOwnerId !== ownerId) {
      this.data = null;
      // 挂起的恢复属于**上一个**账号:留着的话,新账号的第一次编辑或合并会把上个
      // 账号的词条写进它的 CRDT 和投影里。
      this.pendingRecovery = null;
    }
    this.dataOwnerId = ownerId;
    if (this.data) return this.data;

    const filePath = getDataFilePath();
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as unknown;
      this.data = normalizeStoredData(parsed);
      return this.data;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        log.warn('dictionary sync state read failed, starting fresh', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      this.data = createInitialData();
      return this.data;
    }
  }

  private persist(next: StoredSyncData): void {
    // 读不懂的 sidecar 一个字节都不能覆盖:那是更新客户端的状态,写回去就是
    // 用空状态销毁它。
    if (next.incompatible || this.data?.incompatible) return;
    const filePath = getDataFilePath();
    const merged = this.mergeWithOnDiskState(next, filePath);
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const tmp = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(toPersistedShape(merged)), 'utf-8');
      fs.renameSync(tmp, filePath);
    } catch (error) {
      // sidecar 是词典的正本,写不下去就不能报告成功:调用方据此回滚并把失败暴露
      // 给用户。早先这里只记一条 warn 就当没事 —— 于是「频次/别名涨了但只存进了
      // 投影文件」,重启后回收又刻意不认领频次与别名,那次增长就永久丢了。
      log.warn('dictionary sync state write failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      // 内存状态仍然提交:本进程后续的合并不能基于过期状态。
      this.data = merged;
      throw new VoiceDictionarySyncWriteError(error);
    }
    this.data = merged;
  }
}

/** mutate 前的回滚点:状态、时钟和 key 基线必须一起进退。 */
export interface SyncRollbackPoint {
  state: VoiceDictionarySyncState;
  clock: HlcClock;
  lastMaterializedKeys: string[];
}

/**
 * 落盘形状。只写稳定字段 —— `incompatible`、`lostSidecarWithProjection` 这些是
 * **本次加载**的判断结果,写进文件就变成了会被后续进程读回来的持久事实。
 */
function toPersistedShape(data: StoredSyncData): Record<string, unknown> {
  return {
    version: data.version,
    nodeId: data.nodeId,
    clock: data.clock,
    state: data.state,
    lastMaterializedKeys: data.lastMaterializedKeys,
  };
}

/** 盘上的同步状态来自更新的客户端,本进程不能安全地改它。 */
export class VoiceDictionarySyncUnavailableError extends Error {
  constructor() {
    super('dictionary sync state was written by a newer client');
    this.name = 'VoiceDictionarySyncUnavailableError';
  }
}

/** 同步状态写盘失败;词典正本没落地,调用方必须回滚并上报。 */
export class VoiceDictionarySyncWriteError extends Error {
  constructor(cause: unknown) {
    super(`dictionary sync state write failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = 'VoiceDictionarySyncWriteError';
  }
}

export const voiceDictionarySyncStore = new VoiceDictionarySyncStore();

function createInitialData(): StoredSyncData {
  const clock = createHlcClock(randomUUID(), Date.now());
  return {
    version: 1,
    nodeId: clock.nodeId,
    clock: { wallMs: clock.wallMs, counter: clock.counter },
    state: createEmptySyncState(),
    lastMaterializedKeys: [],
  };
}

/** 外层 wrapper 的结构版本。与 CRDT `state.version` 各自演进,升级时都要照顾到。 */
const STORED_SYNC_DATA_VERSION = 1;

function normalizeStoredData(raw: unknown): StoredSyncData {
  if (!raw || typeof raw !== 'object') return createInitialData();
  const candidate = raw as Partial<StoredSyncData>;
  const nodeId = typeof candidate.nodeId === 'string' && candidate.nodeId.trim()
    ? candidate.nodeId.trim()
    : randomUUID();
  // 两层版本都要看:外层 wrapper(nodeId / clock / lastMaterializedKeys 这些字段的
  // 结构版本)和内层 CRDT state 版本是各自演进的。只看内层的话,一个写了
  // wrapper v2、state 仍是 v1 的更新客户端会被当成可写的 v1 数据,下一次
  // `toPersistedShape()` 按 v1 序列化就把它的 v2 字段全丢了。
  const incompatible = isNewerVersion(candidate.state) || isNewerStoredVersion(candidate.version);
  const state = normalizeState(candidate.state);
  return {
    version: STORED_SYNC_DATA_VERSION,
    incompatible,
    nodeId,
    clock: {
      wallMs: readNonNegative(candidate.clock?.wallMs),
      counter: readNonNegative(candidate.clock?.counter),
    },
    state,
    lastMaterializedKeys: Array.isArray(candidate.lastMaterializedKeys)
      ? candidate.lastMaterializedKeys.filter((key): key is string => typeof key === 'string')
      : [],
  };
}

/**
 * 盘上状态是否来自更新的客户端。
 *
 * 只认「版本号明确更高」这一种情况 —— 结构坏了(缺字段、被截断)属于损坏,照常
 * 重建即可;而版本更高是合法数据,必须原样留着。
 */
/** 外层 wrapper 的版本号是否高于本进程能写的版本。 */
function isNewerStoredVersion(version: unknown): boolean {
  return typeof version === 'number' && version > STORED_SYNC_DATA_VERSION;
}

function isNewerVersion(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object') return false;
  const version = (raw as { version?: unknown }).version;
  return typeof version === 'number' && version > VOICE_DICTIONARY_SYNC_VERSION;
}

/**
 * 归一化一份状态(盘上的或隧道来的)。
 *
 * 走 core 的**深度**校验:只看顶层的话,一个缺 `counters` 的化身能一路通过校验被
 * 持久化,然后在物化时才抛 —— 而这份中毒的 sidecar 每次重启都会被重新接受,词典
 * 修改与同步会一直坏下去,直到有人手工删文件。结构不合法就整份丢弃,重新开始。
 */
function normalizeState(raw: unknown): VoiceDictionarySyncState {
  return isValidSyncState(raw) ? adoptDictionaryMaps(raw) : createEmptySyncState();
}

/**
 * 把 `JSON.parse` 出来的普通对象重建成无原型字典。
 *
 * 词条主键、化身 tag、别名键、节点 id 都直接当对象键用,而 `constructor`、
 * `toString`、`__proto__` 都是合法的技术术语 —— 用户完全可能把它们加进词典。带着
 * `Object.prototype` 的对象上,`state.records['constructor']` 会取到继承来的函数,
 * 后面 `listLiveIncarnations()` 拿它当记录用就直接抛,而且这条路径每次重启都会重现。
 *
 * 校验只保证形状对,不保证原型干净;所以每一份从盘上或隧道里来的状态都要过这里。
 */
function adoptDictionaryMaps(state: VoiceDictionarySyncState): VoiceDictionarySyncState {
  const records = createDictionaryMap<DictionaryRecord>();
  for (const [key, record] of Object.entries(state.records)) {
    const incarnations = createDictionaryMap<DictionaryIncarnation>();
    for (const [tag, incarnation] of Object.entries(record.incarnations)) {
      const aliases = createDictionaryMap<SyncAliasState>();
      for (const [aliasKey, alias] of Object.entries(incarnation.aliases)) {
        aliases[aliasKey] = { ...alias, counters: adoptCounters(alias.counters) };
      }
      incarnations[tag] = {
        ...incarnation,
        counters: adoptCounters(incarnation.counters),
        aliases,
      };
    }
    const tombstones = createDictionaryMap<string>();
    for (const [tag, stamp] of Object.entries(record.tombstones)) tombstones[tag] = stamp;
    records[key] = { incarnations, tombstones };
  }
  const suppressed = createDictionaryMap<DictionarySuppression>();
  for (const [key, value] of Object.entries(state.suppressed)) suppressed[key] = { ...value };
  return { version: state.version, records, suppressed };
}

/** 计数桶的键是 nodeId,同样来自不可信输入。 */
function adoptCounters(counters: Record<string, number>): Record<string, number> {
  const adopted = createDictionaryMap<number>();
  for (const [nodeId, value] of Object.entries(counters)) adopted[nodeId] = value;
  return adopted;
}

/** 去掉快照里的频次与别名计数,只保留存在性(用于 sidecar 丢失后的重建)。 */
function stripCountsFromSnapshot(snapshot: LocalDictionarySnapshot): LocalDictionarySnapshot {
  return {
    entries: snapshot.entries.map((entry) => ({ text: entry.text, source: entry.source })),
    suppressedTexts: snapshot.suppressedTexts,
    candidates: snapshot.candidates?.map((candidate) => ({ text: candidate.text })),
  };
}

function readNonNegative(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function sameKeys(a: ReadonlyArray<string>, b: ReadonlyArray<string>): boolean {
  return a.length === b.length && a.every((key, index) => key === b[index]);
}

/**
 * 合并结果与原状态是否等价。
 *
 * 用 `isDeepStrictEqual` 而不是 `JSON.stringify` 比较:每收到一帧远端状态都要比一次,
 * 词典状态可能上百 KB,序列化两份字符串再比对会在 main 线程上制造无谓的 CPU 与 GC
 * 压力,而深比较可以在第一个差异处就返回。
 */
function isSameState(a: VoiceDictionarySyncState, b: VoiceDictionarySyncState): boolean {
  return a === b || isDeepStrictEqual(a, b);
}

function getDataFilePath(): string {
  const ownerId = getActiveAppSession().dataOwnerId;
  return ownerId ? ownerScopedUserDataPath(DATA_FILE_NAME) : path.join(app.getPath('userData'), DATA_FILE_NAME);
}
