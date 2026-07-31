/**
 * remoteFileOpen — 聊天流文件类交互的远程分流入口(renderer 侧)。
 * ---------------------------------------------------------------------------
 * 聊天里点文件(打开 / 定位 / 复制文件 / 文本预览)在远程会话下不能拿远端绝对
 * 路径直打本机文件系统。本模块包装 `maker:chat-file:fetch`(远端路径 → 本地缓存
 * 副本,main 侧编排见 main/file-browser/chat-file.ts),并统一「取回中 / 失败 /
 * 陈旧副本」的 toast UX:
 *
 *   - 取回超过 600ms 才弹「正在从远端获取」toast(缓存命中秒回时零打扰),
 *     完成即撤;
 *   - 失败按 code 分流文案:SSH workdir 外(本期明确不支持)/ 文件不存在 /
 *     取回失败;
 *   - 断线兜底拿到历史副本(stale)时以 warning 提示「可能不是最新版本」。
 *
 * 所有函数只在 origin 为远程时可用;local 来源的调用属于编码错误(调用方应
 * 走原有本机路径),直接抛错暴露。
 */

import { i18n } from '@/i18n';
import { toast } from './toast';
import type { SessionFileOrigin } from './sessionFileOrigin';

/** 远程来源窄化(local 不进本模块)。 */
export type RemoteFileOrigin = Exclude<SessionFileOrigin, { kind: 'local' }>;

export type ChatFileFetchOutcome =
  | { ok: true; cachePath: string; stale: boolean; size: number }
  | { ok: false; code: 'BAD_ARGS' | 'OUTSIDE_WORKDIR' | 'NOT_FOUND' | 'FETCH_FAILED'; message?: string };

/** 失败 code → i18n 文案。 */
export function chatFileErrorText(code: Exclude<ChatFileFetchOutcome, { ok: true }>['code']): string {
  if (code === 'OUTSIDE_WORKDIR') return i18n.t('chat.remoteFile.outsideWorkdir');
  if (code === 'NOT_FOUND') return i18n.t('chat.remoteFile.notFound');
  return i18n.t('chat.remoteFile.fetchFailed');
}

/** 裸取回(无 toast UX):TextLightbox 等有自己进度态的调用方用。 */
export async function fetchChatFileToCache(
  origin: RemoteFileOrigin,
  workdir: string,
  absPath: string,
): Promise<ChatFileFetchOutcome> {
  const wireOrigin =
    origin.kind === 'device'
      ? ({ kind: 'device', deviceId: origin.deviceId } as const)
      : ({ kind: 'ssh', remoteHostId: origin.remoteHostId } as const);
  try {
    return await window.electronAPI.fileBrowser.chatFetch({ origin: wireOrigin, workdir, absPath });
  } catch (err) {
    return { ok: false, code: 'FETCH_FAILED', message: String(err) };
  }
}

/**
 * 带 toast UX 的取回:成功返回缓存副本路径(stale 时附 warning 提示),失败
 * toast 后返回 null。适用于「取到副本后马上做一个本机动作」的一次性交互
 * (打开 / 定位 / 复制文件)。
 */
export async function fetchChatFileWithToasts(
  origin: RemoteFileOrigin,
  workdir: string,
  absPath: string,
): Promise<string | null> {
  let fetchingToastId: string | null = null;
  const delayed = setTimeout(() => {
    fetchingToastId = toast.warning(i18n.t('chat.remoteFile.fetching'), { duration: 120_000 });
  }, 600);
  try {
    const res = await fetchChatFileToCache(origin, workdir, absPath);
    if (!res.ok) {
      toast.error(chatFileErrorText(res.code));
      return null;
    }
    if (res.stale) toast.warning(i18n.t('chat.remoteFile.staleCopy'));
    return res.cachePath;
  } finally {
    clearTimeout(delayed);
    if (fetchingToastId) toast.dismiss(fetchingToastId);
  }
}

/** 远程会话「打开文件」:取回缓存副本后交给系统默认应用(绝不对远端路径 openPath)。 */
export async function openRemoteChatFile(
  origin: RemoteFileOrigin,
  workdir: string,
  absPath: string,
): Promise<void> {
  const cachePath = await fetchChatFileWithToasts(origin, workdir, absPath);
  if (!cachePath) return;
  const res = await window.electronAPI.openPath(cachePath);
  if (!res.success) toast.error(res.error || i18n.t('logic.errors.openFileFailed'));
}

/** 远程会话「定位文件」:取回缓存副本后在文件管理器中定位本地副本。 */
export async function revealRemoteChatFile(
  origin: RemoteFileOrigin,
  workdir: string,
  absPath: string,
): Promise<void> {
  const cachePath = await fetchChatFileWithToasts(origin, workdir, absPath);
  if (!cachePath) return;
  const res = await window.electronAPI.showItemInFolder({ filePath: cachePath });
  if (!res.success) toast.error(res.error ?? i18n.t('chat.media.openFolderFailed'));
}

// ── chip 点亮预检(远端精确 stat)──────────────────────────────────────────
// 远程会话下 chip 点亮前先问远端「这是不是个文件」:目录 / 不存在 / SSH workdir
// 外保持纯文本(与本机"存在且唯一才点亮"的语义对齐);链路断等无法判定的情况按
// 形状分档乐观点亮(DESIGN.md §14.5 规则 5,判据见 markdownTarget.isAmbiguousPathShape)。
//
// ⚠️ **`unknown` 不是结论,只是「这一次没问到」**,因此绝不能和 file / directory /
// nonfile 同层缓存(不变量 A,与移动端 session/remotePathVerdict.ts 逐条对称):
//   - 确定态(file/directory/nonfile)按 (端点, workdir, absPath) 无 TTL 缓存——与本机
//     smartResolveCache 同款「无 TTL、容量兜底」策略,聊天引用的文件在视图生命周期内
//     视作不变,切走再回来 chip 必须同步点亮不闪烁;
//   - `unknown` 只落**短 TTL 负缓存**,不进 verdictCache、因此也不进 peek。它存在的
//     唯一理由是限流:链路差时长转录反复挂卸 chip,每次重挂都重发 stat 会打满通道
//     (移动端 2026-07 线上实捉)。TTL 过后重挂自愈重验。
//     曾把 unknown 写进 verdictCache:一次断链就把该路径永久钉成「已验证 = unknown」,
//     peek 有值 → 异步 effect 直接 return → 链路恢复后再也不重验;叠上歧义形状不吃
//     乐观点亮这道门槛,`src/components` 会永久停在纯文本(PR #1144 review 实捉)。
//     代价:断链期间乐观点亮的引用每次重挂会先画一帧纯文本再点亮(peek 拿不到
//     unknown)。这是刻意取舍——让「peek 有值」严格等价于「有确定结论」,
//     「把 unknown 当结论」这个错误在类型与结构上不可表达,比省一帧重绘值钱。

export type RemotePathVerdict = 'file' | 'directory' | 'nonfile' | 'unknown';

const VERDICT_CACHE_CAP = 1000;
/** unknown 负缓存 TTL:链路差时同 key 最多每 30s 重验一次(与移动端同值)。 */
const UNKNOWN_TTL_MS = 30_000;
const UNKNOWN_CACHE_CAP = 1000;
const verdictCache = new Map<string, RemotePathVerdict>();
const verdictInflight = new Map<string, Promise<RemotePathVerdict>>();
/** key → 负缓存过期时刻(epoch ms)。只存 unknown,永不与确定态混放。 */
const unknownUntil = new Map<string, number>();

function capMapSize(map: Map<string, unknown>, cap: number): void {
  if (map.size < cap) return;
  const oldest = map.keys().next().value;
  if (oldest !== undefined) map.delete(oldest);
}

// ── 负缓存到期的通知 ────────────────────────────────────────────────────────
// TTL 到期**本身不是事件**:没有任何 React 依赖会因它而变。所以「TTL 过后自愈重验」
// 只在组件重挂时才真的发生 —— 一条渲染完就一直挂着不动的消息,链路恢复后仍停在纯
// 文本,直到用户切走再回来(PR #1144 review 实捉,与移动端同款缺口)。
//
// 由本模块把它翻译成一次通知,而不是让消费方各自处理:
//   - **一个**模块级定时器,对齐「最早的负缓存到期时刻」;不是每个引用挂一个表
//     (一条消息几十个引用 = 几十个定时器);
//   - 没有 unknown 待期时**零定时器**,不轮询;
//   - 到期时清掉过期条目 → 发**一次**通知(不是每 key 一次)→ 消费方重跑验证。
//     已有确定结论的引用会在 peek 处早退,所以实际重验的只有仍是 unknown 的那批,
//     节奏就是 TTL 本身(30s),正是负缓存设计时想要的 pace。
const changeListeners = new Set<(key: string) => void>();
let staleTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * 订阅「某个 key 的缓存状态变了」——**确定态落库、或 unknown 负缓存到期**都会通知。
 * listener 收到变化的 key(用 remotePathVerdictKey 构造自己的 key 做比对),按 key 过滤
 * 是刻意的:一屏几十个引用,若每次写入都通知全部订阅者,首屏 N 次 stat 会引发 N×N 次
 * 重渲染。
 *
 * 为什么需要「确定态落库也通知」:同一路径可能在多个挂载点出现,A 先按 unknown 乐观
 * 点亮,B 随后拿到确定的 nonfile 写进缓存 —— 没有这条通道,A 永远不知道,已确认不存在
 * 的路径会一直带着下划线可点(PR #1144 review 实捉)。
 */
export function subscribeRemotePathVerdictChange(listener: (key: string) => void): () => void {
  changeListeners.add(listener);
  return () => {
    changeListeners.delete(listener);
  };
}

function notifyVerdictChange(key: string): void {
  for (const listener of [...changeListeners]) listener(key);
}

function scheduleStaleSweep(delayMs: number): void {
  // 已有定时器就复用:它一定排在同一或更早的时刻,醒来后会把剩下的重新排期。
  if (staleTimer !== null) return;
  staleTimer = setTimeout(() => {
    staleTimer = null;
    const now = Date.now();
    let earliest = Number.POSITIVE_INFINITY;
    const expired: string[] = [];
    for (const [key, until] of unknownUntil) {
      if (until <= now) expired.push(key);
      else if (until < earliest) earliest = until;
    }
    for (const key of expired) unknownUntil.delete(key);
    if (earliest !== Number.POSITIVE_INFINITY) scheduleStaleSweep(earliest - now);
    for (const key of expired) notifyVerdictChange(key);
  }, Math.max(1, delayMs));
}

function verdictKey(origin: RemoteFileOrigin, workdir: string, absPath: string): string {
  const endpoint = origin.kind === 'device' ? `dev:${origin.deviceId}` : `ssh:${origin.remoteHostId}`;
  return `${endpoint}|${workdir}|${absPath}`;
}

/** 缓存 key(供订阅方按 key 过滤变化通知)。 */
export function remotePathVerdictKey(
  origin: RemoteFileOrigin,
  workdir: string,
  absPath: string,
): string {
  return verdictKey(origin, workdir, absPath);
}

/**
 * 同步读**确定结论**(未验证 / 仅负缓存 unknown → undefined,调用方走异步验证)。
 * 返回值有值 ⇔ 远端给过确定答案 —— 调用方可以直接把「peek 有值」当作「不必重验」,
 * 不会把一次断链的 unknown 误当成终态(见本节头注释的不变量 A)。
 *
 * ⚠️ **判定「要不要重验」用这个;决定「怎么渲染」用下面的 ForRender 版。** 混用会
 * 让断链期间的乐观点亮态无处表达,渲染层只能自己存一份 → 那份就会变陈旧。
 */
export function peekRemotePathVerdict(
  origin: RemoteFileOrigin,
  workdir: string,
  absPath: string,
): RemotePathVerdict | undefined {
  return verdictCache.get(verdictKey(origin, workdir, absPath));
}

/**
 * 同步读**渲染用状态**:确定态优先,否则 TTL 未过期的负缓存回 `'unknown'`,都没有回
 * `undefined`。
 *
 * 这个出口存在的理由是把「点亮态」变成**缓存的纯派生**:断链期间的乐观点亮以前只能
 * 存在组件 state 里(peek 不返回 unknown),于是渲染态有了第二个真值来源,而缓存变化
 * 传不到它 —— 三轮 review 各捉到这个状态机的一条边(TTL 到期无通道 / 派生值没被新结论
 * 覆盖 / 另一挂载点写入的确定态传不过来)。有了它,渲染层不必自己存任何结论。
 */
export function peekRemotePathVerdictForRender(
  origin: RemoteFileOrigin,
  workdir: string,
  absPath: string,
): RemotePathVerdict | undefined {
  const key = verdictKey(origin, workdir, absPath);
  const definitive = verdictCache.get(key);
  if (definitive) return definitive;
  const until = unknownUntil.get(key);
  return until !== undefined && until > Date.now() ? 'unknown' : undefined;
}

/** 异步验证(并发去重 + 落缓存)。IPC 自身异常按 unknown 处理,绝不 throw。 */
export function verifyRemotePathCached(
  origin: RemoteFileOrigin,
  workdir: string,
  absPath: string,
): Promise<RemotePathVerdict> {
  const key = verdictKey(origin, workdir, absPath);
  const hit = verdictCache.get(key);
  if (hit) return Promise.resolve(hit);
  const pending = verdictInflight.get(key);
  if (pending) return pending;
  const negativeUntil = unknownUntil.get(key);
  if (negativeUntil !== undefined) {
    // TTL 内不再发 stat(限流),但语义仍是「没问到」:TTL 过后下一次调用重验自愈。
    if (negativeUntil > Date.now()) return Promise.resolve('unknown');
    unknownUntil.delete(key);
  }
  const wireOrigin =
    origin.kind === 'device'
      ? ({ kind: 'device', deviceId: origin.deviceId } as const)
      : ({ kind: 'ssh', remoteHostId: origin.remoteHostId } as const);
  const p = window.electronAPI.fileBrowser
    .chatStat({ origin: wireOrigin, workdir, absPath })
    .then((res) => res.verdict)
    .catch(() => 'unknown' as const)
    .then((verdict) => {
      if (verdict === 'unknown') {
        // 短 TTL 负缓存,**不进 verdictCache**(见本节头注释的不变量 A)。
        capMapSize(unknownUntil, UNKNOWN_CACHE_CAP);
        unknownUntil.set(key, Date.now() + UNKNOWN_TTL_MS);
        // 到期时通知挂载中的消费方重验(否则「自愈」只在重挂时发生)。
        scheduleStaleSweep(UNKNOWN_TTL_MS);
      } else {
        capMapSize(verdictCache, VERDICT_CACHE_CAP);
        verdictCache.set(key, verdict);
      }
      // 两条分支都通知:确定态落库要让其它挂载点收敛(含把乐观点亮降级成纯文本),
      // unknown 落负缓存要让本次发起者之外的挂载点也能画出乐观点亮态。
      notifyVerdictChange(key);
      return verdict;
    })
    .finally(() => verdictInflight.delete(key));
  verdictInflight.set(key, p);
  return p;
}

/** Test-only:清空确定态缓存、unknown 负缓存、在途请求、到期定时器与订阅者
 *  (对称于移动端同名出口)。 */
export function _clearRemotePathVerdictCache(): void {
  verdictCache.clear();
  verdictInflight.clear();
  unknownUntil.clear();
  if (staleTimer !== null) {
    clearTimeout(staleTimer);
    staleTimer = null;
  }
  changeListeners.clear();
}

/** 远程会话「复制文件」:取回缓存副本后以副本作为剪贴板文件引用。 */
export async function copyRemoteChatFile(
  origin: RemoteFileOrigin,
  workdir: string,
  absPath: string,
): Promise<void> {
  const cachePath = await fetchChatFileWithToasts(origin, workdir, absPath);
  if (!cachePath) return;
  const res = await window.electronAPI.copyMediaToClipboard({ filePath: cachePath });
  if (res.success) toast.success(i18n.t('chat.markdownRenderer.fileCopied'));
  else toast.error(res.error ?? i18n.t('chat.media.copyFailed'));
}
