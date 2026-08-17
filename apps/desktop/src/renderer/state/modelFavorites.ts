/**
 * modelFavorites —— 统一模型选择器的「收藏 = 配置副本」存储(model-selector-unified
 * §1.5 / §2.3),localStorage 持久化,跨会话 / 跨重启在本机生效。
 *
 * 语义(这条最容易做错,先看这里):
 *   收藏**不是**给模型打个星标,而是把「当前生效配置」(模型 + 引擎 + 深度 + Fast)
 *   **拷一份**存进收藏区。所以:
 *   - 同一个模型可以有多条收藏(Opus·high·Fast 与 Opus·low 各一条),互不牵连;
 *   - 每条有独立锚点 `uid`,选中 / hover / 浮层绑定 / 删除全按 uid 走(选中态是
 *     `{kind:'fav', uid}`,与 `{kind:'model', providerId, modelId}` 并列);
 *   - 源头模型行**不持有收藏态**(多副本下「这一行是否已收藏」不可判定),☆ 是单向的
 *     「添加副本」动作,重复添加按配置语义去重(见 addModelFavorite);
 *   - 编辑某条收藏(改引擎 / 深度 / Fast)只改这一条,不动模型默认(那是
 *     modelEnginePrefs + providerModelMemory 的事)。
 *
 * 为什么 effort 存**档位 key**('high')而不是显示文案(「高」/ 'Maximum'):
 *   规格 §2.3 明写的教训 —— 文案随语言变,存文案会串档(中文界面存的「最大」到英文界面
 *   认不出,反之亦然)。这里只收 EFFORT_VALUES 里的 canonical key,非法值**丢字段**
 *   (不是丢整条),调用层看到 effort === undefined 就回落该 (模型, 引擎) 的推荐档。
 *
 * 为什么 agent 用 'cc' | 'codex' | 'pi':与 modelEnginePrefs 同一理由(下游是选择器 →
 * newMakerDraft 的 vendor 口径,规格 §2.4),详见那个文件的文件头。
 *
 * 只存用户显式动作的产物(configuration-and-overrides §2),唯一例外是**种子收藏**
 * (Chris 2026-08-16 裁决:去掉列表里的「默认」小节,官方默认推荐改以收藏形态一次性
 * 投放 —— gateway 用户的首个收藏即官方推荐,不想要就取消收藏):
 *   - 只在「从未投放过且收藏为空」时投放一条(seedDefaultFavorite),`seeded` 标记
 *     持久化,取消后**不复种**;已有收藏的老用户只标记不投放,不动用户整理过的列表;
 *   - 种子条目 effort / fast 缺省(跟随推荐档),不快照当前版本的推荐细节。
 *   其余条目仍全部来自用户显式动作;空列表 = 面板不显示收藏区。
 *
 * 持久化频率极低(用户点 ☆ / 在浮层编辑收藏条目才触发),**同步写** localStorage,不做
 * batch / debounce —— 与 newMakerDraft / providerModelMemory / modelEnginePrefs 一致:
 * 热更新 relaunch 走 app.exit() 强退,异步写来不及 fire 会丢最近一次改动。写失败静默吞,
 * 内存态照常生效。
 *
 * 多窗口:监听 storage 事件后**重读 localStorage**(不信 event.newValue —— 迟到事件带旧
 * 值,采信会把本窗口刚加的收藏回滚)。账号分区:key 带 dataOwnerId 后缀,与 newMakerDraft
 * 同形(setModelFavoritesOwner)。
 */

import { useSyncExternalStore } from 'react';

import { EFFORT_VALUES } from '@cindy/model-providers';

import { isSelectableVendor } from '@/lib/agentVendors';
import type { Effort } from '@/lib/userPreferences.types';

import type { ModelEngine } from './modelEnginePrefs';
import { MODEL_PRESET_SLOT_ID } from './providerModelMemory';

const STORAGE_KEY = 'xdt:modelFavorites:v1';

/** 一条收藏所描述的完整配置(不含锚点)。 */
export interface ModelFavoriteConfig {
  providerId: string;
  modelId: string;
  agent: ModelEngine;
  /** 思考深度**档位 key**('low' | 'high' | …);缺省 = 跟随该 (模型, 引擎) 的推荐档。 */
  effort?: Effort;
  /** Fast(插队加速)。**只在开启时存 true**,关闭即缺省 —— 不落「等于默认」的快照。 */
  fast?: true;
}

/** 落盘 / 消费的收藏条目:配置 + 独立锚点 uid。 */
export interface ModelFavoriteItem extends ModelFavoriteConfig {
  uid: string;
}

/** 编辑一条已有收藏。**模型身份(providerId/modelId)由锚点固定,不可改**——换模型 = 另收藏一条。 */
export interface ModelFavoritePatch {
  agent?: ModelEngine;
  /** `null` = 清除该条深度(回落推荐档);`undefined`(不传该键)= 不改。 */
  effort?: Effort | null;
  fast?: boolean;
}

interface FavoritesState {
  /** 下一个 uid 的序号。单调递增,删除条目**不回收**序号 —— 防止新条目复用刚删掉的锚点。 */
  uidSeq: number;
  items: ModelFavoriteItem[];
  /**
   * 官方默认推荐的**种子收藏**是否已投放过(见 seedDefaultFavorite)。一次性标记:
   * 用户取消种子收藏后不复种 —— 取消本身就是对推荐的显式否决。
   */
  seeded?: true;
}

const UID_PREFIX = 'fav-';

let activeDataOwnerId: string | null = null;

function storageKey(): string {
  return activeDataOwnerId ? `${STORAGE_KEY}:${encodeURIComponent(activeDataOwnerId)}` : STORAGE_KEY;
}

function emptyState(): FavoritesState {
  return { uidSeq: 1, items: [] };
}

function uidOfSeq(seq: number): string {
  return `${UID_PREFIX}${seq}`;
}

function seqOfUid(uid: string): number | null {
  if (!uid.startsWith(UID_PREFIX)) return null;
  const rest = uid.slice(UID_PREFIX.length);
  if (!/^\d+$/.test(rest)) return null;
  const n = Number(rest);
  return Number.isSafeInteger(n) ? n : null;
}

function isCanonicalEffort(value: unknown): value is Effort {
  return typeof value === 'string' && (EFFORT_VALUES as readonly string[]).includes(value);
}

/**
 * `'*'` 是 providerModelMemory v2 的保留来源 id(跨来源模型预设槽)。收藏条目的 providerId
 * 必须是真实来源,撞上保留位直接丢条目(规格 §4「偏好/记忆」的防撞要求)。
 */
function isUsableProviderId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value !== MODEL_PRESET_SLOT_ID;
}

/** 归一化配置字段(供 add / update / sanitize 共用);模型身份或引擎不合法 → null。 */
function normalizeConfig(raw: {
  providerId?: unknown;
  modelId?: unknown;
  agent?: unknown;
  effort?: unknown;
  fast?: unknown;
}): ModelFavoriteConfig | null {
  const providerId = typeof raw.providerId === 'string' ? raw.providerId.trim() : '';
  const modelId = typeof raw.modelId === 'string' ? raw.modelId.trim() : '';
  if (!isUsableProviderId(providerId) || !modelId) return null;
  // agent 非法 → **丢整条**:收藏是「配置副本」,引擎是副本的必要组成部分,缺了它这条
  // 记录无法表达任何配置(与 effort 不同 —— effort 缺省有明确语义「跟随推荐档」)。
  if (!isSelectableVendor(raw.agent)) return null;
  const config: ModelFavoriteConfig = { providerId, modelId, agent: raw.agent };
  // effort 非法(显示文案 / 过期档名 / 非字符串)→ 只丢这个字段,条目保留,调用层回落推荐档。
  if (isCanonicalEffort(raw.effort)) config.effort = raw.effort;
  if (raw.fast === true) config.fast = true;
  return config;
}

/**
 * 去重身份:providerId + modelId + agent + effort + fast(缺省字段参与,与「跟随推荐」区分)。
 * 分隔符用空格而不是 NUL:源码里嵌一个裸 `\0` 会让整个文件被 git / rg / grep 判成二进制
 * (diff 显示 `Bin`、搜不到任何符号),代价远大于它能防的那点分隔符冲突 —— provider id 与
 * model id 都是 slug 形态,不含空格(与 unifiedSelection.entryKey 同一取舍)。
 */
function identityOf(config: ModelFavoriteConfig): string {
  return [
    config.providerId,
    config.modelId,
    config.agent,
    config.effort ?? '',
    config.fast === true ? '1' : '0',
  ].join(' ');
}

/**
 * 严格校验 + 锚点补齐。老版本 / 手改 localStorage 损坏时静默回退空表,不抛。
 *   - 形状非法的条目(非对象 / 缺模型身份 / 引擎不认识 / providerId 撞 `'*'`)整条丢弃;
 *   - effort 非法只丢字段(见 normalizeConfig);
 *   - uid 缺失 / 非字符串 / 与前面的条目重复 → 就地补一个新 uid(收藏靠 uid 做锚点,
 *     重复 uid 会让 hover / 删除 / 选中打到错误的条目);
 *   - uidSeq 非正整数,或小于已见 uid 的序号 + 1 → 抬到安全值,保证后续新 uid 不撞已有锚点。
 */
function sanitize(raw: unknown): FavoritesState {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return emptyState();
  const r = raw as { uidSeq?: unknown; items?: unknown; seeded?: unknown };
  const rawItems = Array.isArray(r.items) ? r.items : [];
  let uidSeq =
    typeof r.uidSeq === 'number' && Number.isSafeInteger(r.uidSeq) && r.uidSeq > 0 ? r.uidSeq : 1;

  const seenUids = new Set<string>();
  const parsed: Array<{ config: ModelFavoriteConfig; uid: string | null }> = [];
  for (const entry of rawItems) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const config = normalizeConfig(entry as Record<string, unknown>);
    if (!config) continue;
    const rawUid = (entry as { uid?: unknown }).uid;
    const uid = typeof rawUid === 'string' && rawUid.length > 0 && !seenUids.has(rawUid)
      ? rawUid
      : null;
    if (uid) {
      seenUids.add(uid);
      const seq = seqOfUid(uid);
      if (seq !== null && seq >= uidSeq) uidSeq = seq + 1;
    }
    parsed.push({ config, uid });
  }

  const items: ModelFavoriteItem[] = parsed.map(({ config, uid }) => {
    if (uid) return { uid, ...config };
    let next = uidOfSeq(uidSeq);
    while (seenUids.has(next)) {
      uidSeq += 1;
      next = uidOfSeq(uidSeq);
    }
    uidSeq += 1;
    seenUids.add(next);
    return { uid: next, ...config };
  });

  return { uidSeq, items, ...(r.seeded === true ? { seeded: true as const } : {}) };
}

// 进程内缓存(惰性加载)。读多写少,避免每次读都 parse localStorage。
let cache: FavoritesState | null = null;

function loadFromStorage(): FavoritesState {
  if (typeof window === 'undefined') return emptyState();
  try {
    const raw = window.localStorage.getItem(storageKey());
    return raw ? sanitize(JSON.parse(raw)) : emptyState();
  } catch {
    return emptyState();
  }
}

function load(): FavoritesState {
  if (!cache) cache = loadFromStorage();
  return cache;
}

/**
 * **写路径的基底** —— 每次写入前重读 localStorage,拿到的是此刻的共享真相,而不是本窗口
 * 的内存快照。
 *
 * 为什么读路径走缓存、写路径不能:Electron 每个 renderer 有独立模块实例,`storage` 事件是
 * **异步**的。另一个窗口刚加了一条收藏、事件还没送到本窗口时,本窗口任何写操作(点 ☆ /
 * 改一条收藏 / 删一条)都会拿陈旧的整表覆盖回去 —— 对方那条静默消失。整表写回是这个 store
 * 的既定形状(见 persist),所以修法是把**基底**换新鲜,不是改写入粒度。
 *
 * 读不到持久化值时退回内存缓存,不退回空表:私密窗口 / localStorage 写满时 `setItem` 是
 * 静默失败的(见 persist),此时 `getItem` 恒 null —— 拿空表当基底会把本次会话内已有的
 * 全部收藏一次抹掉。缓存与真相不一致的代价远小于当场清空。
 *
 * 刻意**不**在这里回写 cache / emit:那是 persist 与 storage 监听器的职责,写路径要么随后
 * persist(cache 自然收敛到合并结果),要么因无变化短路(与改动前同行为)。
 */
function freshState(): FavoritesState {
  if (typeof window === 'undefined') return load();
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(storageKey());
  } catch {
    return load();
  }
  if (raw === null) return load();
  try {
    return sanitize(JSON.parse(raw));
  } catch {
    return load();
  }
}

// ── 订阅(供 useSyncExternalStore)──────────────────────────────────────────
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

function persist(next: FavoritesState): void {
  cache = next;
  if (typeof window !== 'undefined') {
    try {
      // 同步写:见文件头(热更 relaunch 走 app.exit(),异步写会丢最近一次改动)。
      window.localStorage.setItem(storageKey(), JSON.stringify(next));
    } catch {
      // localStorage 满 / 私密窗口禁写 —— 静默吞,内存态仍生效。
    }
  }
  emit();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

function getItemsSnapshot(): readonly ModelFavoriteItem[] {
  return load().items;
}

const removeStorageListener = (() => {
  if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return null;
  const onStorage = (event: StorageEvent): void => {
    // key === null 表示 storage.clear();其余只认本 owner 分区的 key。
    if (event.key !== null && event.key !== storageKey()) return;
    if (event.storageArea && event.storageArea !== window.localStorage) return;
    // 重读共享真相而不是采信 event.newValue:迟到事件带旧值,直接写进内存会把本窗口刚加
    // 的收藏回滚(newMakerDraft 同款 rebase)。
    const next = loadFromStorage();
    const prev = cache ?? emptyState();
    if (
      prev.uidSeq === next.uidSeq
      // seeded 也要比:另一个窗口投放种子收藏后只改了这一位(已有收藏的老用户分支甚至
      // 不动 items),漏比会让本窗口的缓存永远停在 seeded 未置位的旧值 —— 下次它自己
      // 再投一遍,用户看到重复的种子收藏。
      && prev.seeded === next.seeded
      && prev.items.length === next.items.length
      && prev.items.every((item, i) => {
        const other = next.items[i];
        return (
          other !== undefined
          && item.uid === other.uid
          && identityOf(item) === identityOf(other)
        );
      })
    ) return;
    cache = next;
    emit();
  };
  window.addEventListener('storage', onStorage);
  return () => window.removeEventListener('storage', onStorage);
})();

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    removeStorageListener?.();
  });
}

/** 读全部收藏(展示顺序即添加顺序)。返回的数组视为只读,写操作一律走下面的 API。 */
export function listModelFavorites(): readonly ModelFavoriteItem[] {
  return getItemsSnapshot();
}

/** 按锚点取一条收藏(hover / 浮层绑定 / 选中态解析)。 */
export function getModelFavorite(uid: string): ModelFavoriteItem | undefined {
  if (!uid) return undefined;
  return load().items.find((item) => item.uid === uid);
}

/**
 * 添加一份配置副本,返回其锚点 uid。
 *
 * 去重:按 providerId + modelId + agent + effort + fast 的**语义**判等 —— 完全相同的
 * 配置重复点 ☆ 不会堆出多条,直接返回已有条目的 uid(规格 §1.5「重复添加去重」)。
 * 只要有一维不同(如深度 high vs low)就是**另一份副本**,同模型多条并存。
 *
 * 非法入参(空模型身份 / providerId 撞保留位 `'*'` / 引擎不认识)返回 `''` 且不写入;
 * effort 非法只丢该字段(条目仍建,回落推荐档)。
 */
export function addModelFavorite(config: ModelFavoriteConfig): string {
  const normalized = normalizeConfig(config);
  if (!normalized) return '';
  // 基底取**重读后的**持久化快照(见 freshState):另一窗口刚加的条目要一起带上,
  // 否则本次整表写回会把它抹掉。uidSeq 的单调性、identityOf 去重都在这份新鲜基底上判。
  const state = freshState();
  const identity = identityOf(normalized);
  const existing = state.items.find((item) => identityOf(item) === identity);
  if (existing) return existing.uid;
  const uid = uidOfSeq(state.uidSeq);
  persist({
    ...state,
    uidSeq: state.uidSeq + 1,
    items: [...state.items, { uid, ...normalized }],
  });
  return uid;
}

/**
 * 一次性投放官方默认推荐的**种子收藏**(Chris 2026-08-16 裁决,替代列表里的「默认」
 * 小节):gateway 用户首次见到的第一条收藏即官方推荐,不想要就取消收藏。
 *
 * 规则(全部违反即 no-op):
 *   - 只投放一次:`seeded` 标记持久化,取消后不复种(取消即显式否决推荐);
 *   - 只对**从未收藏过**的用户投放:已有收藏说明用户在整理自己的列表,不打扰,
 *     但同样落下标记(这一版的推荐对 TA 已经「见过即弃权」);
 *   - 配置字段与普通收藏同一套校验(normalizeConfig),effort / fast 缺省跟随推荐档。
 */
export function seedDefaultFavorite(config: ModelFavoriteConfig): void {
  // 同 addModelFavorite:基底必须新鲜 —— 另一窗口若已投放过种子,这里读到的 seeded
  // 就是 true,不会重复投放,也不会把它的标记写回成未投放。
  const state = freshState();
  if (state.seeded) return;
  const normalized = normalizeConfig(config);
  if (!normalized) return;
  if (state.items.length > 0) {
    persist({ ...state, seeded: true });
    return;
  }
  const uid = uidOfSeq(state.uidSeq);
  // 与上面那条分支同形:先 spread 现有 state 再覆盖三个字段 —— 手写整个对象会在
  // FavoritesState 新增字段时静默丢掉它。
  persist({
    ...state,
    uidSeq: state.uidSeq + 1,
    items: [{ uid, ...normalized }],
    seeded: true,
  });
}

/**
 * 就地编辑一条收藏(浮层里改引擎 / 深度 / Fast 立即存回本条),**不影响模型默认配置**。
 * uid 不存在 → 静默 no-op;无实际变化 → 短路,不落盘不通知。
 * 刻意**不做去重合并**:编辑后即便与另一条重合,也保留两个锚点 —— 悄悄合并会让用户
 * hover / 选中的那条凭空消失。
 */
export function updateModelFavorite(uid: string, patch: ModelFavoritePatch): void {
  if (!uid) return;
  const state = freshState();
  const index = state.items.findIndex((item) => item.uid === uid);
  if (index < 0) return;
  const current = state.items[index];
  const next: ModelFavoriteItem = { ...current };
  if (patch.agent !== undefined) {
    // 引擎非法 → **整个 patch 放弃**(不是只忽略这一维):引擎是配置副本的骨架,
    // 只应用剩下的深度 / Fast 会得到一份用户没要过的混合配置。
    if (!isSelectableVendor(patch.agent)) return;
    next.agent = patch.agent;
  }
  if ('effort' in patch) {
    // null = 显式清除(回落推荐档);非法值同样按清除处理(不写脏档名)。
    if (isCanonicalEffort(patch.effort)) next.effort = patch.effort;
    else delete next.effort;
  }
  if (patch.fast !== undefined) {
    if (patch.fast === true) next.fast = true;
    else delete next.fast;
  }
  if (identityOf(next) === identityOf(current)) return;
  const items = [...state.items];
  items[index] = next;
  persist({ ...state, items });
}

/**
 * 删除一条收藏(浮层底栏「取消收藏」)。uidSeq 不回退 —— 新条目不复用刚释放的锚点,
 * 避免「删掉后又加一条」时旧的选中态 / hover 绑定误命中新条目。
 */
export function removeModelFavorite(uid: string): void {
  if (!uid) return;
  const state = freshState();
  const items = state.items.filter((item) => item.uid !== uid);
  if (items.length === state.items.length) return;
  persist({ ...state, items });
}

/** 订阅收藏变更(非 React 调用方)。 */
export function subscribeModelFavorites(listener: () => void): () => void {
  return subscribe(listener);
}

/**
 * React hook —— 收藏列表快照。数组身份只在真正写入 / 跨窗口同步时变化,
 * 可直接进 useMemo 依赖(useSyncExternalStore 保证 StrictMode 双 render 安全)。
 */
export function useModelFavorites(): readonly ModelFavoriteItem[] {
  return useSyncExternalStore(subscribe, getItemsSnapshot, getItemsSnapshot);
}

/**
 * 随当前数据归属账号切换持久化命名空间(与 setNewMakerDraftOwner 同形)。
 * 切换后丢缓存重新惰性加载 —— 不同账号各读各的收藏,不串号。
 */
export function setModelFavoritesOwner(ownerId: string | null): void {
  const normalized = typeof ownerId === 'string' && ownerId.trim().length > 0 ? ownerId : null;
  if (activeDataOwnerId === normalized) return;
  activeDataOwnerId = normalized;
  cache = null;
  emit();
}

/** 测试用 —— 重置缓存 / owner / 订阅者 + 清 localStorage(其它代码不应调用)。 */
export function __resetForTest(): void {
  const keyBeforeReset = storageKey();
  cache = null;
  listeners.clear();
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.removeItem(keyBeforeReset);
      window.localStorage.removeItem(STORAGE_KEY);
    } catch {
      // ignore
    }
  }
  activeDataOwnerId = null;
}

export const __STORAGE_KEY = STORAGE_KEY;
