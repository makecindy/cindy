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
 *
 * 并发写(2026-08-17 review H1 / K1 / K2)—— **同步乐观写 + 会话 op-log + 事件驱动的持续调和**
 * (机制正文在 storageOpReplay.ts 的文件头,那里是唯一权威;这里只记本 store 的落地方式):
 *   整表写回 + 「写前重读基底」只能修「另一窗口先写完、事件还没到」那一路。两个 renderer
 *   若**都在对方写回之前**读了同一份旧快照,后写者仍然整表覆盖先写者:新增丢失、编辑丢失;
 *   删除与编辑交错时(B 删了一条、A 拿旧快照 update 同一条)已删条目还会**复活**。
 *   localStorage 没有 CAS,所以这里是:
 *     1. 每个写入都表达成一个可重放的 **op**(add / seed / update / remove),核心是
 *        `applyOp(state, op) → state`(无变化时**返回原对象**,调用方按引用判等短路);
 *     2. 同步路径保持不变:freshState → applyOp → setItem(app.exit 场景不丢写);
 *     3. op 同时记进**该 storage key 的会话 op-log**,并在 `navigator.locks` 的锁内把**整条
 *        log** 重放到该 key 此刻的真相上,有差异才写回。owner 切走也照常调和(按捕获的 key
 *        自洽运行),旧分区的并发丢写不会被丢下;
 *     4. 除了提交后,**storage 事件**也触发调和 —— 别的窗口用旧基底做的迟到覆盖会以事件形式
 *        到达本窗,本窗随即把自己的 op 重新断言回去(删除同理),无差异即终止;
 *     5. 每个 op 都是幂等的(add 按配置身份去重、update 未命中 no-op、remove 幂等、seed 有
 *        seeded 门),所以「同步写 + 若干次重放」不会做出第二份效果。整条 log 的重放要保持
 *        幂等还需要归并(compactFavoriteOps:同一条收藏的 update 折进它的 add;remove 顶掉
 *        同 uid 的历史 op),否则重放会在已经是新配置的状态上再插一条旧配置的副本。
 *   `navigator.locks` 不可用(旧环境 / node 单测)时跳过调和,行为退回「重读基底 + 整表写回」。
 *   op 的退休条件(TTL / 断言次数上界)与残余边界见 storageOpReplay.ts 文件头。
 *   已知残余:两个窗口**同时新建**收藏且抢到同一个 `fav-N` 时,后重放的那条会改分到下一个
 *   序号,先前同步返回给调用方的 uid 会指到对方那条 —— 条目本身两条都在(不丢数据),
 *   只是那一瞬的选中锚点可能指错。修它要改 uid 格式(现在是 `fav-<单调序号>`,sanitize /
 *   uidSeq 的单调性契约都建在上面),代价大于收益,故按已知取舍留下。
 */

import { useSyncExternalStore } from 'react';

import { EFFORT_VALUES } from '@cindy/model-providers';

import { isSelectableVendor } from '@/lib/agentVendors';
import type { Effort } from '@/lib/userPreferences.types';

import type { ModelEngine } from './modelEnginePrefs';
import { MODEL_PRESET_SLOT_ID } from './providerModelMemory';
import { createStorageReconciler } from './storageOpReplay';

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

/**
 * 按**给定 key** 读原始 localStorage(不碰缓存)。key 可能不是当前 active 分区 ——
 * 登出 / 切号之后旧分区的调和仍要按它自己的 key 读写(见文件头「并发写」第 3 条)。
 */
function loadFromKey(key: string): FavoritesState {
  if (typeof window === 'undefined') return emptyState();
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? sanitize(JSON.parse(raw)) : emptyState();
  } catch {
    return emptyState();
  }
}

function loadFromStorage(): FavoritesState {
  return loadFromKey(storageKey());
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

/**
 * 两份状态在**用户可见语义**上是否一致(uid 锚点 + 配置身份 + 序号 + 种子标记)。
 * storage 事件的「无变化短路」与并发重放的「有差异才写」共用这一份判据 —— 各写一遍必然
 * 漂移成「一边认为变了、另一边认为没变」。
 */
function sameState(a: FavoritesState, b: FavoritesState): boolean {
  return (
    a.uidSeq === b.uidSeq
    // seeded 也要比:另一个窗口投放种子收藏后只改了这一位(已有收藏的老用户分支甚至
    // 不动 items),漏比会让本窗口的缓存永远停在 seeded 未置位的旧值 —— 下次它自己
    // 再投一遍,用户看到重复的种子收藏。
    && a.seeded === b.seeded
    && a.items.length === b.items.length
    && a.items.every((item, i) => {
      const other = b.items[i];
      return (
        other !== undefined && item.uid === other.uid && identityOf(item) === identityOf(other)
      );
    })
  );
}

// ── 可重放的写操作(见文件头「并发写」)────────────────────────────────────

/**
 * 一次写入的完整表达。**必须只依赖 op 自身 + 目标状态**,不能捕获调用时的快照 ——
 * 重放要能把它施加在另一个窗口写完之后的最新状态上。
 */
type FavoritesOp =
  | { kind: 'add'; config: ModelFavoriteConfig; preferredUid: string }
  | { kind: 'seed'; config: ModelFavoriteConfig; preferredUid: string }
  | { kind: 'update'; uid: string; patch: ModelFavoritePatch }
  | { kind: 'remove'; uid: string };

/** 追加一条(去重 + 锚点分配),供 add / seed 共用。 */
function appendFavorite(
  state: FavoritesState,
  config: ModelFavoriteConfig,
  preferredUid: string,
): FavoritesState {
  const identity = identityOf(config);
  // 幂等的关键一半:同配置已在表里(可能是本次同步写留下的,也可能是另一窗口存过的)
  // → 原样返回,重放不会堆出第二条。
  if (state.items.some((item) => identityOf(item) === identity)) return state;
  const taken = new Set(state.items.map((item) => item.uid));
  let uid = preferredUid;
  if (!uid || taken.has(uid)) {
    // 首选锚点被另一个窗口抢走 → 从最新的 uidSeq 往后找一个没被占的,绝不复用已有锚点。
    let seq = state.uidSeq;
    uid = uidOfSeq(seq);
    while (taken.has(uid)) {
      seq += 1;
      uid = uidOfSeq(seq);
    }
  }
  const seq = seqOfUid(uid);
  return {
    ...state,
    // uidSeq 只增不减(删除不回收序号),并保证盖过刚用掉的这个锚点。
    uidSeq: seq !== null ? Math.max(state.uidSeq, seq + 1) : state.uidSeq,
    items: [...state.items, { uid, ...config }],
  };
}

/** 从条目里剥出纯配置(不含锚点)。 */
function configOf(item: ModelFavoriteItem): ModelFavoriteConfig {
  return {
    providerId: item.providerId,
    modelId: item.modelId,
    agent: item.agent,
    // 缺省字段保持缺省(effort 缺省 = 跟随推荐档,fast 缺省 = 关):补一个 undefined 键会让
    // `'effort' in config` 之类的存在性判断错位,也会把 undefined 写进 JSON 之外的比较里。
    ...(item.effort ? { effort: item.effort } : {}),
    ...(item.fast ? { fast: true as const } : {}),
  };
}

/**
 * 把一次 patch 施加到一份配置上,返回新配置;`null` = **整个 patch 放弃**。
 * 单点存放 patch 语义 —— applyOp(重放) 与 compactFavoriteOps(把 update 折进 add)共用同一份,
 * 各写一遍必然漂移成「重放出来的副本和折叠出来的副本不是同一份配置」。
 */
function patchConfig(
  config: ModelFavoriteConfig,
  patch: ModelFavoritePatch,
): ModelFavoriteConfig | null {
  const next: ModelFavoriteConfig = { ...config };
  if (patch.agent !== undefined) {
    // 引擎非法 → **整个 patch 放弃**(不是只忽略这一维):引擎是配置副本的骨架,
    // 只应用剩下的深度 / Fast 会得到一份用户没要过的混合配置。
    if (!isSelectableVendor(patch.agent)) return null;
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
  return next;
}

/**
 * 把一个 op 施加到某份状态上。**无实际变化时返回入参对象本身** —— 调用方用引用判等就能
 * 判断「要不要落盘 / 要不要通知」,不必再做一次深比。
 */
function applyOp(state: FavoritesState, op: FavoritesOp): FavoritesState {
  switch (op.kind) {
    case 'add':
      return appendFavorite(state, op.config, op.preferredUid);
    case 'seed': {
      // 一次性标记:另一窗口已经投放过(或已落标记)→ 不复种、也不把标记写回成未投放。
      if (state.seeded) return state;
      // 已有收藏的用户只落标记,不动他整理过的列表。
      if (state.items.length > 0) return { ...state, seeded: true };
      const added = appendFavorite(state, op.config, op.preferredUid);
      return { ...added, seeded: true };
    }
    case 'update': {
      const index = state.items.findIndex((item) => item.uid === op.uid);
      // 幂等的另一半:uid 已被另一个窗口删掉 → no-op。整表写回时代的病根就在这里 ——
      // 拿旧快照编辑再整表写,会把已删条目原地复活。
      if (index < 0) return state;
      const current = state.items[index] as ModelFavoriteItem;
      const patched = patchConfig(configOf(current), op.patch);
      if (!patched) return state;
      const next: ModelFavoriteItem = { uid: current.uid, ...patched };
      if (identityOf(next) === identityOf(current)) return state;
      const items = [...state.items];
      items[index] = next;
      return { ...state, items };
    }
    case 'remove': {
      const items = state.items.filter((item) => item.uid !== op.uid);
      if (items.length === state.items.length) return state;
      return { ...state, items };
    }
  }
}

/** 一个 op 指向的锚点(add / seed 是它想占的首选锚点)。 */
function uidTargetOf(op: FavoritesOp): string {
  return op.kind === 'add' || op.kind === 'seed' ? op.preferredUid : op.uid;
}

/**
 * 会话 op-log 的归并 —— 让**整条 log 的重放**保持幂等(见 storageOpReplay 文件头的 `compact`)。
 *
 * 不归并会出什么事:log = [add X@fav-1, update fav-1 → 深度 low]。重放到「已经是 low」的状态上
 * 时,`add` 看到的身份是**旧配置 X**(不在表里)→ 又插一条,用户看到同一份收藏出现两遍。
 * 归并规则:
 *   · `update` 命中本会话内创建该条的 `add` / `seed` → 折进它的 config(那条 op 从此描述的是
 *     「这条收藏最终长什么样」);patch 非法(引擎不认识)则整条 patch 放弃,与 applyOp 同判据;
 *   · `update` 命中同一 uid 的历史 `update` → 后者接着前者叠(逐字段后写胜),仍是一条 op;
 *   · `remove` **顶掉**同一 uid 的全部历史 op 并保留自己:删除要能被重新断言(别窗的脏写可能
 *     把它复活),而它前面的 add / update 再断言就是把已删条目请回来。uid 单调不复用,所以
 *     这条 remove 将来不会误伤别的条目。
 */
function compactFavoriteOps(log: readonly FavoritesOp[], op: FavoritesOp): readonly FavoritesOp[] {
  if (op.kind === 'remove') {
    return [...log.filter((entry) => uidTargetOf(entry) !== op.uid), op];
  }
  if (op.kind === 'update') {
    const index = log.findIndex((entry) => uidTargetOf(entry) === op.uid);
    const target = index >= 0 ? log[index] : undefined;
    if (target && (target.kind === 'add' || target.kind === 'seed')) {
      const merged = patchConfig(target.config, op.patch);
      if (!merged) return log;
      const next = [...log];
      next[index] = { ...target, config: merged };
      return next;
    }
    if (target && target.kind === 'update') {
      const next = [...log];
      next[index] = { kind: 'update', uid: op.uid, patch: { ...target.patch, ...op.patch } };
      return next;
    }
    return [...log, op];
  }
  return [...log, op];
}

const reconciler = createStorageReconciler<FavoritesState, FavoritesOp>({
  // active 分区走 freshState(它带着「读不出来就退回内存缓存」的既有兜底,私密窗口 / 写满时
  // 不能拿空表当真相);其它分区(登出 / 切号后的旧 key)按 key 直读。
  read: (key) => (key === storageKey() ? freshState() : loadFromKey(key)),
  apply: applyOp,
  persist: (key, state) => persistTo(key, state),
  adopt: (key, state) => {
    // 调和无差异:落盘已是权威结果 —— 只把它收进本窗口缓存(storage 事件迟到时这一步顺带
    // 把缓存拉齐)。非 active 分区没有缓存可言,不动。
    if (key !== storageKey()) return;
    if (sameState(cache ?? emptyState(), state)) return;
    cache = state;
    emit();
  },
  compact: compactFavoriteOps,
  // 删除比新增 / 编辑活得久:并发窗口内两个窗口做相反动作时让删除胜出(见 storageOpReplay
  // 文件头 —— 「已删条目复活」是用户不会去复查的静默错误,「删早了」当场看得见)。
  tombstone: (op) => op.kind === 'remove',
});

/**
 * 一次写入 = **同步乐观写**(见文件头:热更强退不丢)+ 把 op 记进**当时那个 key** 的会话
 * op-log 并调度一次锁内调和。owner 随后被切走也不放弃调和 —— 调和按捕获的 key 自洽运行
 * (K1);别窗的迟到覆盖由 storage 事件再触发一次调和补回(K2)。
 */
function commitOp(op: FavoritesOp, knownBase?: FavoritesState): void {
  // 调用方已经为别的目的重读过一次(如 add 要先在这份基底上定锚点)时复用那一份,
  // 不重复 parse —— 也让「同步写只读一次 localStorage」这件事在测试里可观测。
  const base = knownBase ?? freshState();
  const next = applyOp(base, op);
  if (next !== base) persist(next);
  // 锁名 = 本分区的 storage key:不同账号各排各的队。
  const key = storageKey();
  reconciler.record(key, op);
  reconciler.schedule(key);
}

// ── 订阅(供 useSyncExternalStore)──────────────────────────────────────────
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

/**
 * 落盘到**指定 key**。缓存与通知只在该 key 恰是当前 active 分区时才做 —— 调和可能发生在
 * 登出 / 切号之后的旧分区上(见文件头「并发写」),那时本窗口的内存态属于新分区,绝不能被
 * 旧分区的内容覆盖。
 */
function persistTo(key: string, next: FavoritesState): void {
  if (typeof window !== 'undefined') {
    try {
      // 同步写:见文件头(热更 relaunch 走 app.exit(),异步写会丢最近一次改动)。
      window.localStorage.setItem(key, JSON.stringify(next));
    } catch {
      // localStorage 满 / 私密窗口禁写 —— 静默吞,内存态仍生效。
    }
  }
  if (key !== storageKey()) return;
  cache = next;
  emit();
}

function persist(next: FavoritesState): void {
  persistTo(storageKey(), next);
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
  /** 本 owner 分区的内存态跟外来写入对齐(重读真相,不采信 event.newValue)。 */
  const refreshActive = (): void => {
    // 迟到事件带旧值,直接写进内存会把本窗口刚加的收藏回滚(newMakerDraft 同款 rebase)。
    const next = loadFromStorage();
    const prev = cache ?? emptyState();
    if (sameState(prev, next)) return;
    cache = next;
    emit();
  };
  const onStorage = (event: StorageEvent): void => {
    if (event.storageArea && event.storageArea !== window.localStorage) return;
    // key === null 表示 storage.clear():本分区刷新,并让**所有**还有 op-log 的分区各自调和。
    if (event.key === null) {
      refreshActive();
      for (const key of reconciler.loggedKeys()) reconciler.schedule(key);
      return;
    }
    if (event.key === storageKey()) {
      refreshActive();
      // 外来写入可能正是「别窗用旧基底做的迟到覆盖」,抹掉了本窗刚提交的 op(K2):
      // 在锁内把本分区的整条 op-log 重新断言一遍,无差异即终止。
      reconciler.schedule(event.key);
      return;
    }
    // 非 active 分区:只要 op-log 里还有它的记录就照样调和(K1 —— 登出 / 切号之后旧分区
    // 的并发丢写仍要合并;它不影响本窗口当前的内存态,故不刷新缓存)。
    if (reconciler.hasOps(event.key)) reconciler.schedule(event.key);
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
  // uid 必须**当场**返回(调用方要拿它当选中锚点),所以先在这份基底上定下首选锚点;
  // 锁内重放时若它已被另一个窗口占走,appendFavorite 会顺延到下一个空位(见文件头
  // 「已知残余」)。
  commitOp({ kind: 'add', config: normalized, preferredUid: uid }, state);
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
  // 非法配置不落标记:下次给出合法推荐时仍要能投放。
  const normalized = normalizeConfig(config);
  if (!normalized) return;
  commitOp({ kind: 'seed', config: normalized, preferredUid: uidOfSeq(state.uidSeq) }, state);
}

/**
 * 就地编辑一条收藏(浮层里改引擎 / 深度 / Fast 立即存回本条),**不影响模型默认配置**。
 * uid 不存在 → 静默 no-op;无实际变化 → 短路,不落盘不通知。
 * 刻意**不做去重合并**:编辑后即便与另一条重合,也保留两个锚点 —— 悄悄合并会让用户
 * hover / 选中的那条凭空消失。
 */
export function updateModelFavorite(uid: string, patch: ModelFavoritePatch): void {
  if (!uid) return;
  // 具体的 patch 语义(引擎非法整条放弃 / effort null 即清除 / fast false 即缺省)在
  // applyOp 里,同步写与锁内重放共用同一份 —— 各写一遍必然漂移。
  commitOp({ kind: 'update', uid, patch });
}

/**
 * 删除一条收藏(浮层底栏「取消收藏」)。uidSeq 不回退 —— 新条目不复用刚释放的锚点,
 * 避免「删掉后又加一条」时旧的选中态 / hover 绑定误命中新条目。
 */
export function removeModelFavorite(uid: string): void {
  if (!uid) return;
  commitOp({ kind: 'remove', uid });
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

/** 测试用 —— 重置缓存 / owner / 订阅者 / op-log + 清 localStorage(其它代码不应调用)。 */
export function __resetForTest(): void {
  const keyBeforeReset = storageKey();
  cache = null;
  listeners.clear();
  reconciler.__resetForTest();
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
