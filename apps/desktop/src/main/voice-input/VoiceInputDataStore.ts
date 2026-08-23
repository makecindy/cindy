import { app, BrowserWindow, ipcMain } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

import {
  addManualEntry,
  deleteTerms,
  dictionaryTermKey,
  recordLearningEvent,
  renameTerm,
  termKeyFromMaterializedId,
  type DictationDictionaryLearningAction,
  type MaterializedDictionary,
} from '@cindy/voice-input-core';

import { createLogger } from '../logger.js';
import { ownerScopedUserDataPath, getActiveAppSession } from '../appSessionState.js';
import { throwIpcError } from '../utils/ipcValidate.js';
import { assertTrustedAppRendererEvent } from '../security/trustedAppRenderer.js';
import { voiceDictionarySyncStore } from './VoiceDictionarySyncStore.js';
import {
  DEFAULT_DICTIONARY_SYNC_ENABLED,
  MAX_VOICE_INPUT_DICTIONARY_ALIASES,
  MAX_VOICE_INPUT_DICTIONARY_ENTRIES,
  MAX_VOICE_INPUT_DICTIONARY_ENTRY_CHARS,
  compactVoiceInputHistoryIfNeeded,
  createVoiceInputHistoryEntry,
  getDefaultVoiceInputSettings,
  normalizeVoiceInputDataSnapshot,
  normalizeVoiceInputHistory,
  normalizeVoiceInputSettings,
  type VoiceInputDataSnapshot,
  type VoiceInputDictionaryEntry,
  type VoiceInputHistoryEntry,
  type VoiceInputSettings,
  type VoiceInputSyncErrorResult,
} from '../../shared/voiceInputData.js';

const log = createLogger('voice-input:data-store');
const DATA_FILE_NAME = 'voice-input-data.v1.json';
let ipcRegistered = false;

type StoredVoiceInputData = VoiceInputDataSnapshot & {
  version: 1;
  legacyRendererStorageMigrated?: boolean;
  /**
   * 这份投影是否由「带同步的版本」写出来的。
   *
   * 用来区分两种表面完全一样的情形 —— sidecar 不在、投影里却有词典:
   *  - **首次迁移**(没有这个标记):存量用户刚升级上来。词典里的频次全是本机积累的,
   *    整份认领(含频次)才对,丢了就是把用户长期积累的排序权重清零。
   *  - **sidecar 丢失**(有这个标记):本机曾经同步过。频次里含有别的设备合并进来的
   *    部分,重新播种会让同一批事件在两个节点桶里各记一遍;而且本机丢了身份历史,
   *    直接认领会越过对端墓碑把删掉的词复活。
   *
   * 靠状态本身分不出这两者(都是空 sidecar + 有内容的投影),必须留一个持久印记。
   */
  dictionarySyncInitialized?: boolean;
};

type LegacyRendererDataPayload = {
  settingsRaw?: string | null;
  historyRaw?: string | null;
};

type DataChangedPayload = {
  settings: VoiceInputSettings;
  history: VoiceInputHistoryEntry[];
};

export class VoiceInputDataStore {
  private state: StoredVoiceInputData | null = null;
  private stateOwnerId: string | null = null;

  getSnapshot(): VoiceInputDataSnapshot {
    return cloneSnapshot(this.load());
  }

  getSettings(): VoiceInputSettings {
    return this.getSnapshot().settings;
  }

  getHistory(limit?: number): VoiceInputHistoryEntry[] {
    const history = this.load().history;
    return cloneHistory(typeof limit === 'number' ? history.slice(0, Math.max(0, limit)) : history);
  }

  getHistoryForRefinement(): VoiceInputHistoryEntry[] {
    const current = this.load();
    const compacted = compactVoiceInputHistoryIfNeeded(current.history);
    if (compacted !== current.history) {
      this.replaceState({
        ...current,
        history: compacted,
      });
    }
    return cloneHistory(compacted);
  }

  updateSettings(patch: unknown): VoiceInputSettings {
    const current = this.load();
    const syncJustEnabled = isRecord(patch)
      && patch.dictionarySyncEnabled === true
      && current.settings.dictionarySyncEnabled === false;
    const syncJustDisabled = isRecord(patch)
      && patch.dictionarySyncEnabled === false
      && current.settings.dictionarySyncEnabled === true;
    // 词典三件套的真相在同步状态里,不接受整份覆盖 —— 那会绕过 CRDT,让本地写入
    // 在下一次物化时被静默丢掉。词典变更一律走下面的语义化入口。
    const nextSettings = normalizeVoiceInputSettings({
      ...current.settings,
      ...stripDictionaryFields(patch),
    }, process.platform);
    this.replaceState({
      ...current,
      settings: nextSettings,
    });
    // 开关刚切到开或关:对端可能早已在线,既没有 presence 事件也没有词典变更。
    // 打开时立刻推当前投影;关闭时立刻推空表,清掉已经在线的手机缓存。
    if (syncJustEnabled || syncJustDisabled) notifyDictionaryChanged({ immediate: true });
    return cloneSettings(nextSettings);
  }

  deleteDictionaryEntries(entryIds: string[]): VoiceInputSettings {
    const state = voiceDictionarySyncStore.getState();
    const termKeys = entryIds
      .map((entryId) => termKeyFromMaterializedId(state, entryId))
      .filter((key): key is string => Boolean(key));
    if (termKeys.length === 0) return cloneSettings(this.load().settings);
    return this.applyDictionaryMutation((current, clock) =>
      deleteTerms(current, clock, { termKeys, nowMs: Date.now() }),
    );
  }

  addManualDictionaryEntry(text: string): VoiceInputSettings {
    return this.applyDictionaryMutation((current, clock) =>
      addManualEntry(current, clock, { text, nowMs: Date.now() }),
    );
  }

  /** CSV 导入:整批按手动词条认领,单条失败不影响其余。 */
  importManualDictionaryEntries(texts: string[]): VoiceInputSettings {
    // 已有多少条也要算进上限:否则对着一份满词典反复导入,记录数可以无限增长,
    // 撑过物化上限与 relay 单帧上限(同步会因此永久停摆)。
    const existing = this.load().settings.dictionaryEntries.length;
    const budget = Math.max(0, MAX_VOICE_INPUT_DICTIONARY_ENTRIES - existing);
    if (budget === 0) return cloneSettings(this.load().settings);
    const accepted = texts.slice(0, budget);
    return this.applyDictionaryMutation((current, clock) => {
      let state = current;
      let nextClock = clock;
      let changed = false;
      const nowMs = Date.now();
      for (const text of accepted) {
        const result = addManualEntry(state, nextClock, { text, nowMs });
        state = result.state;
        nextClock = result.clock;
        changed = changed || result.changed;
      }
      return { state, clock: nextClock, changed };
    });
  }

  renameDictionaryEntry(entryId: string, nextText: string): VoiceInputSettings {
    const termKey = termKeyFromMaterializedId(voiceDictionarySyncStore.getState(), entryId);
    if (!termKey) return cloneSettings(this.load().settings);
    return this.applyDictionaryMutation((current, clock) =>
      renameTerm(current, clock, { termKey, nextText, nowMs: Date.now() }),
    );
  }

  recordDictionaryLearningActions(actions: DictationDictionaryLearningAction[]): {
    settings: VoiceInputSettings;
    newAutomaticEntries: Array<Pick<VoiceInputDictionaryEntry, 'id' | 'text'>>;
  } {
    const current = this.load();
    if (!current.settings.refinementEnabled || !current.settings.autoDictionaryEnabled) {
      return { settings: cloneSettings(current.settings), newAutomaticEntries: [] };
    }
    const previousEntryKeys = new Set(
      current.settings.dictionaryEntries
        .filter((entry) => entry.source === 'automatic')
        .map((entry) => dictionaryTermKey(entry.text)),
    );

    const nextSettings = this.applyDictionaryMutation((state, clock) => {
      let nextState = state;
      let nextClock = clock;
      let changed = false;
      const nowMs = Date.now();
      for (const action of actions) {
        // 与单机学习路径一致:低置信度或没有别名证据的建议不进词典。
        if (action.confidence === 'low') continue;
        const aliases = action.aliases ?? [];
        if (aliases.length === 0) continue;
        const result = recordLearningEvent(nextState, nextClock, {
          text: action.term,
          aliases,
          stage: action.action === 'add_candidate' ? 'candidate' : 'entry',
          nowMs,
        });
        nextState = result.state;
        nextClock = result.clock;
        changed = changed || result.changed;
      }
      return { state: nextState, clock: nextClock, changed };
    });

    const newAutomaticEntries = nextSettings.dictionaryEntries
      .filter((entry) => entry.source === 'automatic')
      .filter((entry) => !previousEntryKeys.has(dictionaryTermKey(entry.text)))
      .map((entry) => ({ id: entry.id, text: entry.text }));
    return { settings: cloneSettings(nextSettings), newAutomaticEntries };
  }

  /**
   * 合并远端设备送来的同步状态。返回是否引入了新信息(调用方据此决定要不要回传
   * 自己的状态)。
   */
  mergeRemoteDictionaryState(remote: unknown): boolean {
    // 与本地变更同样是两段写入,同样需要回滚点:sidecar 已经吸收了远端状态而
    // 投影文件写失败时,重投同一帧会因为「合并没有引入新信息」直接返回 false,
    // 投影就永远停在旧内容上。
    const rollbackPoint = voiceDictionarySyncStore.snapshotForRollback();
    try {
      // mergeRemote 自己写盘失败时也会先推进内存状态再抛 —— 不圈进 try 的话,重投
      // 同一帧会因为「合并没有引入新信息」直接返回 false,投影永远停在旧内容上。
      const materialized = voiceDictionarySyncStore.mergeRemote(remote);
      if (!materialized) return false;
      this.commitMaterializedDictionary(materialized);
    } catch (error) {
      voiceDictionarySyncStore.rollbackTo(rollbackPoint);
      throw error;
    }
    return true;
  }

  /**
   * 执行一次词典变更并把物化结果落回 settings。
   *
   * 物化结果是**只读投影**:写回 settings 之后绝不能再被反向读成本地增量,否则
   * 合并进来的远端计数会被重复记账,词典频次随同步次数膨胀。日常路径永远是
   * 「操作 → 状态 → 物化 → settings」这一个方向。
   */
  private applyDictionaryMutation(
    apply: Parameters<typeof voiceDictionarySyncStore.mutate>[0],
  ): VoiceInputSettings {
    // 两段写入必须整体成败:同步状态先行、词典文件随后。第二段失败时状态会领先于
    // 用户看到的内容,而重试通常是 no-op(sidecar 里已经有这次操作),UI 会一直停在
    // 旧内容直到重启 —— 所以失败就把 sidecar 回滚,让重试真的能重来。
    if (voiceDictionarySyncStore.isIncompatible()) {
      // 读不懂盘上的同步状态时不能改词典:基于空状态物化会把现有词典覆盖成空。
      // 明确报错(IPC 会转成 INTERNAL),而不是假装成功。
      throw new VoiceInputDataStoreWriteError(
        new Error('dictionary sync state was written by a newer client; upgrade to edit the dictionary'),
      );
    }
    const rollbackPoint = voiceDictionarySyncStore.snapshotForRollback();
    try {
      // mutate 自己写盘失败时也会先推进内存状态再抛 —— 不把它圈进 try 的话,
      // 重试会因为「sidecar 里已经有这次操作」变成 no-op,投影一直停在旧内容。
      const materialized = voiceDictionarySyncStore.mutate(apply);
      if (!materialized) return cloneSettings(this.load().settings);
      return cloneSettings(this.commitMaterializedDictionary(materialized));
    } catch (error) {
      voiceDictionarySyncStore.rollbackTo(rollbackPoint);
      throw error;
    }
  }

  private commitMaterializedDictionary(materialized: MaterializedDictionary): VoiceInputSettings {
    const current = this.load();
    const nextSettings = normalizeVoiceInputSettings(
      { ...current.settings, ...projectMaterializedDictionary(materialized) },
      process.platform,
    );
    // 顺序要紧:sidecar(状态 + key 基线)全部写完,最后才写投影并广播。
    //
    // 反过来的话,`markMaterialized` 抛错时投影文件已经落盘、UI 也已经更新,而调用方
    // 的 catch 只回滚 sidecar —— 用户看到「保存失败」,盘上却留着这次改动,重启后
    // 降级回收还会拿这份投影去对照被回滚的 CRDT,把它当成「旧版本客户端做的改动」
    // 重新认领回来。现在任一段失败时投影都还没写,回滚后两边一致。
    voiceDictionarySyncStore.markMaterialized(materialized);
    this.replaceState({ ...current, dictionarySyncInitialized: true, settings: nextSettings });
    notifyDictionaryChanged();
    return nextSettings;
  }

  recordHistory(text: string): string | null {
    const normalizedText = text.trim();
    if (!normalizedText) return null;
    const current = this.load();
    const duplicate = current.history.find((entry) => entry.text === normalizedText);
    if (duplicate) return duplicate.id;
    const entry = createVoiceInputHistoryEntry(normalizedText);
    if (!entry) return null;
    const history = compactVoiceInputHistoryIfNeeded([entry, ...current.history]);
    this.replaceState({
      ...current,
      history,
    });
    return entry.id;
  }

  updateHistoryEntry(id: string, text: string): void {
    const normalizedText = text.trim();
    if (!id || !normalizedText) return;
    const current = this.load();
    const entry = current.history.find((candidate) => candidate.id === id);
    if (!entry) return;
    this.replaceState({
      ...current,
      history: normalizeVoiceInputHistory([
        {
          ...entry,
          text: normalizedText,
        },
        ...current.history.filter((candidate) => candidate.id !== id),
      ]),
    });
  }

  deleteHistoryEntry(id: string): void {
    const current = this.load();
    const history = current.history.filter((entry) => entry.id !== id);
    if (history.length === current.history.length) return;
    this.replaceState({
      ...current,
      history,
    });
  }

  migrateLegacyRendererStorage(payload: LegacyRendererDataPayload | undefined): VoiceInputDataSnapshot {
    const current = this.load();
    if (current.legacyRendererStorageMigrated) return this.getSnapshot();
    let settings = current.settings;
    let history = current.history;

    if (payload?.settingsRaw) {
      try {
        settings = normalizeVoiceInputSettings(JSON.parse(payload.settingsRaw), process.platform);
      } catch (error) {
        log.warn('legacy renderer voice-input settings migration failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (payload?.historyRaw) {
      try {
        history = normalizeVoiceInputHistory(JSON.parse(payload.historyRaw));
      } catch (error) {
        log.warn('legacy renderer voice-input history migration failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // 先把迁移来的词典认领进同步状态,再提交。
    //
    // load() 早在处理 payload 之前就跑过了,那时词典文件还是空的,于是 sidecar 也
    // 被初始化成空 —— 如果直接 replaceState,词条只进了 settings,而下一次词典变更
    // 或收到远端状态都会用空 sidecar 物化出空词典,把刚迁移的内容盖掉。
    const migrated = this.reconcileMigratedDictionary(settings);

    this.replaceState({
      ...current,
      legacyRendererStorageMigrated: true,
      settings: migrated,
      history: compactVoiceInputHistoryIfNeeded(history),
    });
    return this.getSnapshot();
  }

  /** 同步状态里是否已经有词典 —— 有就说明这不是首次安装。 */
  private hasSyncedDictionary(): boolean {
    try {
      if (voiceDictionarySyncStore.isIncompatible()) return true;
      return voiceDictionarySyncStore.materialize().entries.length > 0;
    } catch {
      // 读不出来就按「有」处理:宁可少回收一次,也不能误删。
      return true;
    }
  }

  /**
   * 只把同步状态物化到 settings,不做回收、不写盘。
   *
   * 用于词典文件读失败(损坏 / 权限 / 临时不可读)的场景:此时手上的 settings 是
   * 默认空值,拿它去回收等于宣告「用户删光了词典」。只读投影既能让用户继续看到
   * 同步状态里的词典,又不会把损坏扩散到正本。
   */
  private projectDictionaryWithoutReconcile(state: StoredVoiceInputData): StoredVoiceInputData {
    try {
      if (voiceDictionarySyncStore.isIncompatible()) return state;
      const materialized = voiceDictionarySyncStore.materialize();
      return {
        ...state,
        settings: normalizeVoiceInputSettings(
          { ...state.settings, ...projectMaterializedDictionary(materialized) },
          process.platform,
        ),
      };
    } catch (error) {
      log.warn('dictionary projection failed while the data file was unreadable', {
        error: error instanceof Error ? error.message : String(error),
      });
      return state;
    }
  }

  /** 把一份来自旧存储的 settings 词典认领进 CRDT,返回物化后的 settings。 */
  private reconcileMigratedDictionary(settings: VoiceInputSettings): VoiceInputSettings {
    if (voiceDictionarySyncStore.isIncompatible()) return settings;
    try {
      voiceDictionarySyncStore.reconcile({
        entries: settings.dictionaryEntries.map((entry) => ({
          text: entry.text,
          source: entry.source,
          frequency: entry.frequency,
          aliases: entry.aliases.map((alias) => ({ text: alias.text, count: alias.count })),
        })),
        suppressedTexts: settings.suppressedAutomaticDictionaryTexts,
        candidates: settings.dictionaryCandidates.map((candidate) => ({
          text: candidate.text,
          evidenceCount: candidate.evidenceCount,
          aliases: candidate.aliases.map((alias) => ({ text: alias.text, count: alias.count })),
        })),
      }, { syncEnabled: settings.dictionarySyncEnabled });
      const materialized = voiceDictionarySyncStore.materialize();
      voiceDictionarySyncStore.markMaterialized(materialized);
      return normalizeVoiceInputSettings(
        { ...settings, ...projectMaterializedDictionary(materialized) },
        process.platform,
      );
    } catch (error) {
      log.warn('legacy renderer dictionary reconcile failed, keeping migrated settings as-is', {
        error: error instanceof Error ? error.message : String(error),
      });
      return settings;
    }
  }

  private load(): StoredVoiceInputData {
    const ownerId = getActiveAppSession().dataOwnerId;
    if (this.state && this.stateOwnerId !== ownerId) this.state = null;
    this.stateOwnerId = ownerId;
    if (this.state) return this.state;
    const filePath = getDataFilePath();
    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      const parsed = JSON.parse(raw) as unknown;
      const snapshot = normalizeVoiceInputDataSnapshot(parsed, process.platform);
      const stampedOnDisk = isRecord(parsed) && parsed.dictionarySyncInitialized === true;
      this.state = {
        version: 1,
        legacyRendererStorageMigrated: isRecord(parsed) && parsed.legacyRendererStorageMigrated === true,
        dictionarySyncInitialized: stampedOnDisk,
        ...snapshot,
      };
      const hydrated = this.hydrateDictionaryFromSyncState(this.state);
      this.state = hydrated;
      // 首次迁移刚落下印记时立刻写盘一次。只留在内存里的话,这次启动如果没有任何
      // 词典写入,盘上的投影就还是「没有印记」—— 下次 sidecar 真丢了会被再次误判成
      // 首次迁移,于是越过对端墓碑重建,别的设备上删掉的词就复活了。
      if (hydrated.dictionarySyncInitialized && !stampedOnDisk) this.save(hydrated);
      return this.state;
    } catch (error) {
      const missing = (error as NodeJS.ErrnoException).code === 'ENOENT';
      if (!missing) {
        log.warn('voice input data read failed, using defaults', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      this.state = {
        version: 1,
        settings: getDefaultVoiceInputSettings(process.platform),
        history: [],
      };
      // 读不到投影文件时手上的 settings 是默认空值,拿它去回收等于宣告「用户把
      // 词典删光了」——lastMaterializedKeys 里的每一条都会被打上墓碑并持久化,
      // 投影文件的丢失就此升级成 CRDT 正本的永久损毁。
      //
      // 「文件不存在」和「文件损坏」在这一点上没有区别:只要 sidecar 里还有内容,
      // 就说明这不是首次安装,而是投影没了。只有 sidecar 也是空的(真·首次安装)
      // 才走回收 —— 那时回收本来也没有可删的东西。
      this.state = this.hasSyncedDictionary()
        ? this.projectDictionaryWithoutReconcile(this.state)
        : this.hydrateDictionaryFromSyncState(this.state);
      return this.state;
    }
  }

  /**
   * 让内存里的词典与同步状态对齐。
   *
   * 顺带承担两件一次性工作:
   *  - **首次迁移**:同步状态为空、上次物化主键也为空时,回收会把词典文件里已有的
   *    词条整份认领进来 —— 存量用户升级后词典原样保留,不需要单独的迁移代码路径。
   *  - **降级回收**:旧版本客户端直接改过词典文件时,把那些改动认领回状态。
   *
   * 只在 `load()` 里跑,不在运行期跑:运行期的写入全部走 `applyDictionaryMutation`,
   * 物化是单向投影,绝不反向推断。
   */
  private hydrateDictionaryFromSyncState(state: StoredVoiceInputData): StoredVoiceInputData {
    try {
      // 盘上的同步状态来自更新的客户端:本进程读不懂,直接用词典文件里的内容跑,
      // 一个字节都不碰 sidecar。照常走下去会把读不懂的状态当空状态物化出空词典,
      // 再覆盖写回,把用户的词典连同所有设备的合并历史一起销毁。
      if (voiceDictionarySyncStore.isIncompatible()) {
        log.warn('dictionary sync state was written by a newer client, running without sync');
        return state;
      }
      // 先让 store 判断:sidecar 是丢了,还是首次安装 / 首次迁移。
      // 判据是投影里有没有「本机曾经同步过」的印记 —— 只看状态空不空分不出来。
      //
      // 候选词与抑制列表同样是权威投影数据:一个用户完全可能只有候选(自动学习刚
      // 起步)或只有抑制项(把自动学来的词都删了)。漏算它们的话,这台机器丢了
      // sidecar 会被当成首次迁移,把候选证据数按本机新证据重新播种 —— 与保留着
      // 原状态的对端合并时,同一批证据就在两个节点桶里各记了一遍。
      const hasProjectedDictionary =
        state.settings.dictionaryEntries.length > 0 ||
        state.settings.dictionaryCandidates.length > 0 ||
        state.settings.suppressedAutomaticDictionaryTexts.length > 0;
      if (hasProjectedDictionary && state.dictionarySyncInitialized) {
        voiceDictionarySyncStore.noteProjectionHasDictionary();
      }
      voiceDictionarySyncStore.reconcile({
        // 带上频次与别名:首次迁移时状态是空的,这些都是用户长期积累的东西 ——
        // 频次是排序权重,别名更是纠错能力的主体(「web coding → Vibe Coding」
        // 这类映射全靠它)。不带上就等于把存量用户的词典能力清零,而且下一次
        // 物化写回文件后永久丢失。seedTerm 只对状态里不存在的词条生效,不会重复记账。
        entries: state.settings.dictionaryEntries.map((entry) => ({
          text: entry.text,
          source: entry.source,
          frequency: entry.frequency,
          aliases: entry.aliases.map((alias) => ({ text: alias.text, count: alias.count })),
        })),
        suppressedTexts: state.settings.suppressedAutomaticDictionaryTexts,
        candidates: state.settings.dictionaryCandidates.map((candidate) => ({
          text: candidate.text,
          evidenceCount: candidate.evidenceCount,
          aliases: candidate.aliases.map((alias) => ({ text: alias.text, count: alias.count })),
        })),
      }, { syncEnabled: state.settings.dictionarySyncEnabled });
      voiceDictionarySyncStore.collectGarbage();
      // 认领被挂起时(sidecar 丢了、还在等对端墓碑)状态里暂时没有这些词。物化会
      // 是空的,拿它覆盖 settings 就等于让用户的词典先消失一次;保留文件内容不动。
      if (voiceDictionarySyncStore.hasPendingRecovery()) return state;
      const materialized = voiceDictionarySyncStore.materialize();
      voiceDictionarySyncStore.markMaterialized(materialized);
      return {
        ...state,
        // 印记跟着第一次成功物化落下:之后再看到「空 sidecar + 有词典的投影」,
        // 就能确定是 sidecar 丢了,而不是又一次首次迁移。
        dictionarySyncInitialized: true,
        settings: normalizeVoiceInputSettings(
          { ...state.settings, ...projectMaterializedDictionary(materialized) },
          process.platform,
        ),
      };
    } catch (error) {
      // 同步状态坏了不能让词典功能整体不可用:退回文件里的词典继续跑。
      log.warn('dictionary sync hydration failed, falling back to on-disk dictionary', {
        error: error instanceof Error ? error.message : String(error),
      });
      return state;
    }
  }

  private replaceState(next: StoredVoiceInputData): void {
    const normalizedState: StoredVoiceInputData = {
      version: 1,
      legacyRendererStorageMigrated: next.legacyRendererStorageMigrated,
      dictionarySyncInitialized: next.dictionarySyncInitialized,
      settings: normalizeVoiceInputSettings(next.settings, process.platform),
      history: compactVoiceInputHistoryIfNeeded(normalizeVoiceInputHistory(next.history)),
    };
    // 只有文件替换成功后才能提交内存状态和广播，避免 UI 显示未持久化的数据。
    this.save(normalizedState);
    this.state = normalizedState;
    broadcastVoiceInputDataChanged({
      settings: normalizedState.settings,
      history: normalizedState.history,
    });
  }

  private save(state: StoredVoiceInputData): void {
    const filePath = getDataFilePath();
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const tmp = `${filePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf-8');
      fs.renameSync(tmp, filePath);
    } catch (error) {
      log.warn('voice input data write failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw new VoiceInputDataStoreWriteError(error);
    }
  }
}

/** 语音数据写盘失败，供 IPC 层转换为标准 INTERNAL 错误。 */
export class VoiceInputDataStoreWriteError extends Error {
  constructor(cause: unknown) {
    super(`voice input data write failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = 'VoiceInputDataStoreWriteError';
  }
}

export const voiceInputDataStore = new VoiceInputDataStore();

/**
 * 词典变更监听。同步驱动订阅它来触发广播 —— 用回调而不是让 store 直接 import
 * driver,避免两个模块互相 import 形成加载期环。
 */
const dictionaryChangedListeners = new Set<DictionaryChangedListener>();

/**
 * `immediate` = 这次变更希望立刻广播,不要走去抖(用户刚打开或关闭同步开关)。
 */
export type DictionaryChangedListener = (options?: { immediate?: boolean }) => void;

export function onVoiceInputDictionaryChanged(listener: DictionaryChangedListener): () => void {
  dictionaryChangedListeners.add(listener);
  return () => dictionaryChangedListeners.delete(listener);
}

/** 一次 advice 能提交的动作条数上限。真实模型建议远低于此,超出的一律是异常来源。 */
const MAX_DICTIONARY_LEARNING_ACTIONS = 32;

/** 归一化待删除的词条 id:丢掉非字符串,并按词典总量上限截断。 */
function sanitizeDictionaryEntryIds(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const ids: string[] = [];
  for (const candidate of input) {
    if (typeof candidate !== 'string' || !candidate) continue;
    ids.push(candidate);
    if (ids.length >= MAX_VOICE_INPUT_DICTIONARY_ENTRIES) break;
  }
  return ids;
}

/**
 * 归一化单条动作的别名。
 *
 * 光过滤非字符串不够:32 条动作的上限挡不住「一条动作带十万个别名」—— 每个唯一
 * 别名都会被写进 CRDT 正本,main 线程被同步写盘卡住,sidecar 也会涨过 relay 单帧
 * 上限让同步永久停摆。条数与单条长度都要卡。
 */
function sanitizeLearningAliases(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const aliases: string[] = [];
  for (const candidate of raw) {
    if (typeof candidate !== 'string') continue;
    const alias = candidate.trim();
    if (!alias || alias.length > MAX_VOICE_INPUT_DICTIONARY_ENTRY_CHARS) continue;
    aliases.push(alias);
    if (aliases.length >= MAX_VOICE_INPUT_DICTIONARY_ALIASES) break;
  }
  return aliases;
}

/**
 * 归一化 renderer 提交的学习动作。
 *
 * 入参是未经校验的 IPC payload:形状不对的条目直接丢掉,整批也要有条数上限 ——
 * 这些动作会逐条写进 CRDT 正本,一批脏数据就是一批永久记录。
 */
export function sanitizeDictionaryLearningActions(input: unknown): DictationDictionaryLearningAction[] {
  if (!Array.isArray(input)) return [];
  const actions: DictationDictionaryLearningAction[] = [];
  for (const candidate of input) {
    if (!candidate || typeof candidate !== 'object') continue;
    const action = candidate as Partial<DictationDictionaryLearningAction>;
    if (typeof action.action !== 'string' || typeof action.term !== 'string') continue;
    const term = action.term.trim();
    if (!term || term.length > MAX_VOICE_INPUT_DICTIONARY_ENTRY_CHARS) continue;
    actions.push({
      ...(action as DictationDictionaryLearningAction),
      term,
      aliases: sanitizeLearningAliases(action.aliases),
    });
    if (actions.length >= MAX_DICTIONARY_LEARNING_ACTIONS) break;
  }
  return actions;
}

export function registerVoiceInputDataStoreIpc(): void {
  if (ipcRegistered) return;
  ipcRegistered = true;

  ipcMain.on('voice-input:data:get', (event) => {
    event.returnValue = voiceInputDataStore.getSnapshot();
  });

  ipcMain.on('voice-input:data:migrate-legacy', (event, payload: LegacyRendererDataPayload | undefined) => {
    try {
      event.returnValue = voiceInputDataStore.migrateLegacyRendererStorage(payload);
    } catch (error) {
      event.returnValue = voiceInputDataStoreIpcErrorResult(error);
    }
  });

  ipcMain.handle('voice-input:settings:update', (_event, patch: unknown): VoiceInputSettings => {
    try {
      return voiceInputDataStore.updateSettings(patch);
    } catch (error) {
      throwVoiceInputDataStoreIpcError(error);
    }
  });

  ipcMain.handle('voice-input:dictionary:delete-entries', (event, entryIds: unknown): VoiceInputSettings => {
    try {
      // 删除现在会写 CRDT 墓碑并传播到用户的每一台电脑,和 add/import/rename 是
      // 同一级别的写操作 —— 守卫不能只加在新增那几个上。超长数组也要挡:逐条
      // map 的开销全落在 main 线程。
      assertTrustedAppRendererEvent(event);
      return voiceInputDataStore.deleteDictionaryEntries(sanitizeDictionaryEntryIds(entryIds));
    } catch (error) {
      throwVoiceInputDataStoreIpcError(error);
    }
  });

  // 词典的增改都是语义化操作,不接受 renderer 整份覆盖词条数组:同步状态是词典的
  // 真相,整份覆盖既表达不了「用户到底做了什么」,也会在下一次物化时被丢掉。
  ipcMain.handle('voice-input:dictionary:add-entry', (event, text: unknown): VoiceInputSettings => {
    try {
      // 词典写入会改用户的持久数据 —— 只接受可信的主 renderer,不能让任意子框架 /
      // WebView 拿到这几个全局 channel 就能改词典。
      assertTrustedAppRendererEvent(event);
      return voiceInputDataStore.addManualDictionaryEntry(typeof text === 'string' ? text : '');
    } catch (error) {
      throwVoiceInputDataStoreIpcError(error);
    }
  });

  ipcMain.handle('voice-input:dictionary:import-entries', (event, texts: unknown): VoiceInputSettings => {
    try {
      assertTrustedAppRendererEvent(event);
      // renderer 直连时可以绕开 CSV UI 的容量裁决,这里必须自己兜底。三重上限
      // 缺一不可:只限入参条数的话,对着已经装满的词典再灌 1000 条照样能撑爆
      // sidecar,而超长单条也能用少量条目做到同一件事。
      const list = Array.isArray(texts)
        ? texts
            .filter((item): item is string => typeof item === 'string')
            .map((item) => item.slice(0, MAX_VOICE_INPUT_DICTIONARY_ENTRY_CHARS))
            .slice(0, MAX_VOICE_INPUT_DICTIONARY_ENTRIES)
        : [];
      return voiceInputDataStore.importManualDictionaryEntries(list);
    } catch (error) {
      throwVoiceInputDataStoreIpcError(error);
    }
  });

  ipcMain.handle(
    'voice-input:dictionary:rename-entry',
    (event, payload: { entryId?: unknown; text?: unknown }): VoiceInputSettings => {
      try {
        assertTrustedAppRendererEvent(event);
        const entryId = typeof payload?.entryId === 'string' ? payload.entryId : '';
        const text = typeof payload?.text === 'string' ? payload.text : '';
        if (!entryId) return voiceInputDataStore.getSettings();
        return voiceInputDataStore.renameDictionaryEntry(entryId, text);
      } catch (error) {
        throwVoiceInputDataStoreIpcError(error);
      }
    },
  );

  ipcMain.handle('voice-input:dictionary-learning:record-actions', (event, actions: unknown) => {
    try {
      // 这个 handler 直接往词典正本里写。没有守卫的话,任意子帧(webview、插件面板)
      // 都能提交一大批唯一的 add_entry:主进程被同步写盘卡住,sidecar 也被撑过物化
      // 上限和 relay 单帧上限,同步会因此永久停摆。
      assertTrustedAppRendererEvent(event);
      return voiceInputDataStore.recordDictionaryLearningActions(
        sanitizeDictionaryLearningActions(actions),
      );
    } catch (error) {
      throwVoiceInputDataStoreIpcError(error);
    }
  });

  ipcMain.on('voice-input:history:get', (event, limit?: number) => {
    event.returnValue = voiceInputDataStore.getHistory(limit);
  });

  ipcMain.on('voice-input:history:get-for-refinement', (event) => {
    try {
      event.returnValue = voiceInputDataStore.getHistoryForRefinement();
    } catch (error) {
      event.returnValue = voiceInputDataStoreIpcErrorResult(error);
    }
  });

  ipcMain.on('voice-input:history:record', (event, text: string) => {
    try {
      event.returnValue = voiceInputDataStore.recordHistory(text);
    } catch (error) {
      event.returnValue = voiceInputDataStoreIpcErrorResult(error);
    }
  });

  ipcMain.on('voice-input:history:update', (event, payload: { id?: string; text?: string }) => {
    try {
      if (typeof payload?.id === 'string' && typeof payload.text === 'string') {
        voiceInputDataStore.updateHistoryEntry(payload.id, payload.text);
      }
      // Every ipcRenderer.sendSync caller must receive a value. Leaving the
      // success path unset blocks the renderer forever after refinement.
      event.returnValue = true;
    } catch (error) {
      event.returnValue = voiceInputDataStoreIpcErrorResult(error);
    }
  });

  ipcMain.on('voice-input:history:delete', (event, id: string) => {
    try {
      if (typeof id === 'string') {
        voiceInputDataStore.deleteHistoryEntry(id);
      }
      event.returnValue = true;
    } catch (error) {
      event.returnValue = voiceInputDataStoreIpcErrorResult(error);
    }
  });
}

function throwVoiceInputDataStoreIpcError(error: unknown): never {
  if (error instanceof VoiceInputDataStoreWriteError) {
    throwIpcError('INTERNAL', error.message);
  }
  throw error;
}

function voiceInputDataStoreIpcErrorResult(error: unknown): VoiceInputSyncErrorResult {
  if (error instanceof VoiceInputDataStoreWriteError) {
    return { ok: false, code: 'INTERNAL', message: error.message };
  }
  throw error;
}

function getDataFilePath(): string {
  // Keep the pre-auth bootstrap path compatible with legacy installs. Once a
  // stable owner exists (including local-v1), all voice data is owner-scoped.
  const ownerId = getActiveAppSession().dataOwnerId;
  return ownerId ? ownerScopedUserDataPath(DATA_FILE_NAME) : path.join(app.getPath('userData'), DATA_FILE_NAME);
}

function broadcastVoiceInputDataChanged(payload: DataChangedPayload): void {
  const snapshot = cloneSnapshot(payload);
  BrowserWindow.getAllWindows().forEach((window) => {
    if (window.isDestroyed()) return;
    window.webContents.send('voice-input:data-changed', snapshot);
  });
}

function cloneSnapshot(snapshot: VoiceInputDataSnapshot): VoiceInputDataSnapshot {
  return {
    settings: cloneSettings(snapshot.settings),
    history: cloneHistory(snapshot.history),
  };
}

function cloneSettings(settings: VoiceInputSettings): VoiceInputSettings {
  return JSON.parse(JSON.stringify(settings)) as VoiceInputSettings;
}

function cloneHistory(history: VoiceInputHistoryEntry[]): VoiceInputHistoryEntry[] {
  return JSON.parse(JSON.stringify(history)) as VoiceInputHistoryEntry[];
}

function notifyDictionaryChanged(options?: { immediate?: boolean }): void {
  dictionaryChangedListeners.forEach((listener) => {
    try {
      listener(options);
    } catch {
      // 监听者(同步驱动)出问题不能影响词典本身的写入。
    }
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** 把 CRDT 物化结果投影成 settings 的词典三件套(两边字段形状本就一致)。 */
function projectMaterializedDictionary(
  materialized: MaterializedDictionary,
): Pick<
  VoiceInputSettings,
  'dictionaryEntries' | 'dictionaryCandidates' | 'suppressedAutomaticDictionaryTexts'
> {
  return {
    dictionaryEntries: materialized.entries.map((entry) => ({
      id: entry.id,
      text: entry.text,
      source: entry.source,
      frequency: entry.frequency,
      aliases: entry.aliases.map((alias) => ({ ...alias })),
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
    })),
    dictionaryCandidates: materialized.candidates.map((candidate) => ({
      text: candidate.text,
      evidenceCount: candidate.evidenceCount,
      aliases: candidate.aliases.map((alias) => ({ ...alias })),
      createdAt: candidate.createdAt,
      updatedAt: candidate.updatedAt,
    })),
    suppressedAutomaticDictionaryTexts: [...materialized.suppressedTexts],
  };
}

/**
 * 词典字段一律从通用 settings patch 里剥掉,防止绕过 CRDT 的整份覆盖。
 *
 * 同步开关额外转写:UI 传的是有效值,持久化只认 override(见
 * `configuration-and-overrides.md` §2),所以在这里把它翻译成显式自定义标记。
 */
function stripDictionaryFields(patch: unknown): Record<string, unknown> {
  if (!isRecord(patch)) return {};
  const next = { ...patch };
  delete next.dictionaryEntries;
  delete next.dictionaryCandidates;
  delete next.suppressedAutomaticDictionaryTexts;
  if (typeof next.dictionarySyncEnabled === 'boolean') {
    // 用户在开关上做的每一次显式选择都记成 override,**包括**恰好等于当前默认值的
    // 那次。规则 §2 要求「已自定义的用户保留自己的选择」:一个曾经关掉、后来又特意
    // 打开的用户是明确表过态的,如果因为「和今天的默认一样」就把 override 删掉,
    // 将来默认改成 false 会把他静默关掉。
    //
    // 规则 §5 禁止的是**没有用户表达时**把默认值固化回配置(比如 agent 代改),
    // 不是禁止记录用户的显式选择。清除 override 只由下面的「恢复默认」负责。
    next.dictionarySyncEnabledOverride = next.dictionarySyncEnabled;
    delete next.dictionarySyncEnabled;
  } else if (next.dictionarySyncEnabled === null) {
    // 显式传 null = 恢复默认。规则要求「恢复默认」是删除 override 重新跟随版本
    // 默认值,而不是写入一份静态快照;传 undefined 做不到这件事,因为 patch 是
    // 展开合并的,undefined 会被现有值盖掉。
    next.dictionarySyncEnabledOverride = null;
    delete next.dictionarySyncEnabled;
  }
  return next;
}
