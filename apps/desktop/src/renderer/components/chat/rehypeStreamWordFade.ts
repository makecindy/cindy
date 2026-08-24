/**
 * rehypeStreamWordFade — 流式正文分段淡入(DESIGN.md §14.4 第五个 sanctioned
 * motion class,2026-08-07)。
 *
 * 形态:流式输出时,每个新词与 inline-code 原子以 150ms opacity 淡入「浮现」。
 * 这**不是**被红线禁止的逐字打字机 —— 段整体已渲染就位,只有透明度渐变;
 * 设计裁决(2026-08-07)按「浮现 ≠ 打字」放行。
 *
 * 架构:CSS 管形态、JS 只管时序:
 *   - 本插件仅在 isStreaming 且非 reduced-motion 时挂进 rehype 链尾,把文本词段
 *     与 inline-code 原子包 `<span class="stream-word" style="--wf-delay:Nms">`;动画本体是
 *     globals.css 的 stream-word-in(--motion-fast 淡入,`both` 填充,delay 前隐藏)。
 *   - **不重播 —— 内容匹配的稳定 key**:delay 与 settled 都按段的稳定 key 记账,
 *     不按文档序号。每次 parse 把本次段列表与上一次(state.previous)做匹配:
 *     同位置内容相等或前缀延续(chunk 边界半个词长成整词)→ 复用旧 key;错位则
 *     按内容从后往前找未被占用的旧 key(结构变化整体平移的词都能找回自己);都
 *     没有才发新 key。markdown 结构变化(列表标记吃掉 "2. "、加粗闭合劈开文本
 *     节点、Segmenter 对 chunk 尾部的切分变化)只会让**词序号**漂移,key 不漂 ——
 *     漂移序号曾让已稳定的整片前文被当新词重淡(2026-08-08 实测)。
 *   - **settled 落袋 + settled 前缀还原纯文本**:span 带 data-wf-key,
 *     MarkdownRenderer 根节点监听冒泡的 animationend(markSettledFromAnimationEnd),
 *     播完的 key 进 state.settled;settled 词从槽位中还原为合并后的原生文本,
 *     settled inline code 则恢复原始 code 节点,
 *     只保留仍在播放的尾部 span——流式长文档的元素数因此回落到与无动效渲染
 *     同阶,react-markdown 每 tick 的重建 + diff 不随已播完的前文线性涨
 *     (曾因全文逐词包 span,几千元素把主线程打满,流式中点击切换 session
 *     无响应,2026-08-09 实测)。部分 settled 的槽位仍整槽包 span(settled 词
 *     的负 delay 已超动画时长,both 填充直接呈现终态,不重播)。抽掉 span 引
 *     发的兄弟位置 key 平移由 remount 免疫兜底(见下),不再需要空壳保位。
 *   - **普通聊天零 stagger**(Codex Desktop 普通聊天同款,2026-08-21):同一
 *     parse tick 新到的词段都从 0ms 开始 150ms opacity 淡入,不再跨词排队。
 *     旧实现把专用展示场景的 24ms stagger 推广到普通聊天,又让行内 code
 *     完全跳过动画,导致后到的 code chip 已清晰显示、前文仍在排队的视觉反序。
 *   - **remount 免疫 —— 存开播时刻、每 tick 发剩余 delay**(2026-08-08,与
 *     Codex 的根本差异所要求的补偿):Codex 自研渲染器用 segmentKey 当 React
 *     key,span 永不 remount;我们骑在 react-markdown 上,React key 是位置
 *     序号,流式中正在生长的区域(表格尾行、成形中的列表)每 tick 都可能
 *     remount。若给 span 发固定 delay,remount 会让 CSS 动画带原始 delay 从头
 *     重等,下一 tick 又 remount —— 词永远透明(2026-08-08 表格实测)。故
 *     state 仍记**绝对开播时刻**,每个 tick 重新发出「开播时刻 - now」:
 *     已过时刻发**负 delay**,CSS 负 animation-delay 让动画从中途续播,
 *     remount 后帧级跳回正确进度,观感无缝。
 *   - 流式结束(isStreaming 翻 false)由 MarkdownRenderer 切回无插件的常量链,
 *     终版渲染没有任何 span 包装,按消息缓存的 state 同步释放。
 *
 * 原子淡入:inline code / 路径 chip 保持内部结构不拆,外层只包一个 stream-word,
 * 与同 tick 正文一起从 0ms 淡入。跳过:pre 代码块与 KaTeX 子树(公式内部是
 * 几十个定位 span,逐词包装会拆坏排版)。
 *
 * 淡入对象模型(Codex Desktop 架构 + inline-code 顺序修正):**只有文本词段、
 * 行内代码原子和列表圆点淡入,块级结构永远即时出现**。表格边框、引用 rail、分隔线不做
 * 块级整体淡入 —— 曾试过 tr/li 整块排队,大积压窗口下必然出现"空骨架先
 * 画好、文字憋一坨"(2026-08-08 两轮实测翻车)。表格格内文字与正文一样逐词
 * 淡入(Codex FIa 对 table 的处理同款)。列表圆点(::marker)单独处理:li 打
 * data-stream-marker,delay/key **借用 li 内第一个段**(listItemDecorationByToken
 * 同构)—— 圆点与正文同帧浮现,不额外占段位,空 li 长出文字也不重播。
 * 标记用 data 属性而不是 className:MarkdownRenderer 的自定义 renderer 是
 * `className={cn(...)} {...props}` 写法,hast 塞 className 会经 spread 把样式
 * 类整个覆盖掉;data-* 从 spread 直通,互不相扰。
 *
 * 切词用 Intl.Segmenter(granularity: 'word'):CJK 无空格也能按词切,避免整句
 * 中文一次性淡入退化成"逐句蹦"。空白并入前一词,不为纯空白生成 span。
 */

import type { Plugin } from 'unified';
import type { Element, ElementContent, Root } from 'hast';

type FadeSegmentKind = 'text' | 'inline-code';

interface FadeSegment {
  kind: FadeSegmentKind;
  content: string;
}

interface PreviousSegment {
  kind: FadeSegmentKind;
  content: string;
  key: string;
}

export interface WordFadeState {
  /** 稳定 key 发号器。 */
  nextId: number;
  /** 上一次 parse 的淡入段列表(文档序),类型 + 内容匹配复用 key 的依据。 */
  previous: PreviousSegment[];
  /**
   * key → 绝对开播时刻(performance.now() 基准)。只排一次;每个 tick 由
   * 「开播时刻 - now」重新发出剩余 delay(可为负,负值 = CSS 从中途续播)。
   * 存绝对时刻而不是固定 delay,是 remount 免疫的关键(见头注释)。
   */
  startAtByKey: Map<string, number>;
  /** 已播完淡入的 key(animationend 落袋)。后续 parse 摘掉动画类。 */
  settled: Set<string>;
  /** 时钟注入口,仅测试用;生产恒为 performance.now。 */
  nowFn?: () => number;
}

export function createWordFadeState(): WordFadeState {
  return {
    nextId: 0,
    previous: [],
    startAtByKey: new Map(),
    settled: new Set(),
  };
}

/**
 * React render 只允许改 candidate。真正挂载后由 MarkdownRenderer 的
 * useLayoutEffect 提交,被并发渲染放弃的 parse 不会偷跑稳定 key / 时间线。
 */
export function createWordFadeCandidate(committed: WordFadeState): WordFadeState {
  return {
    nextId: committed.nextId,
    previous: committed.previous,
    startAtByKey: new Map(committed.startAtByKey),
    settled: new Set(committed.settled),
    nowFn: committed.nowFn,
  };
}

export function commitWordFadeCandidate(committed: WordFadeState, candidate: WordFadeState): void {
  committed.nextId = candidate.nextId;
  committed.previous = candidate.previous;
  committed.startAtByKey = new Map(candidate.startAtByKey);
  // render 到 layout-effect 之间可能正好收到上一帧的 animationend；只合并，不能覆盖。
  committed.settled = new Set([...committed.settled, ...candidate.settled]);
}

/**
 * 流式消息在切换任务时会随 MessageStream 一起卸载。动画状态如果只挂在
 * MarkdownRenderer 实例上，回来后整条已有正文会被当成首次到达并重播。
 *
 * 这里按消息身份保留一个有界 LRU：同一条仍在流式中的消息 remount 后继续使用原来的
 * 绝对时间线；终态渲染会主动释放。上限只兜底清理由后台结束、此后再未打开的任务。
 */
const WORD_FADE_STATE_CACHE_MAX = 64;
const wordFadeStateCache = new Map<string, WordFadeState>();

export function getOrCreateWordFadeState(cacheKey?: string): WordFadeState {
  if (!cacheKey) return createWordFadeState();
  const cached = wordFadeStateCache.get(cacheKey);
  if (cached) {
    wordFadeStateCache.delete(cacheKey);
    wordFadeStateCache.set(cacheKey, cached);
    return cached;
  }

  const state = createWordFadeState();
  wordFadeStateCache.set(cacheKey, state);
  if (wordFadeStateCache.size > WORD_FADE_STATE_CACHE_MAX) {
    const oldest = wordFadeStateCache.keys().next().value;
    if (oldest !== undefined) wordFadeStateCache.delete(oldest);
  }
  return state;
}

export function releaseWordFadeState(cacheKey?: string): void {
  if (cacheKey) wordFadeStateCache.delete(cacheKey);
}

/** 测试专用：隔离模块级 remount 状态。 */
export function _resetWordFadeStateCacheForTests(): void {
  wordFadeStateCache.clear();
}

/**
 * animationend 落袋入口:MarkdownRenderer 根节点上监听冒泡的 animationend,
 * 把播完 stream-word-in 的段 key 记进 state.settled。按动画名过滤 —— 同一子树里
 * 其它动画(代码高亮、chip 等)的 animationend 不误伤。
 */
export function markSettledFromAnimationEnd(
  state: WordFadeState,
  event: { animationName: string; target: EventTarget | null },
): void {
  if (event.animationName !== 'stream-word-in') return;
  const target = event.target as { dataset?: { wfKey?: string } } | null;
  const key = target?.dataset?.wfKey;
  if (key) state.settled.add(key);
}

/** 整棵子树跳过(不进入):块级代码、非正文节点与公式内部结构。 */
const SKIP_TAGS = new Set(['pre', 'script', 'style', 'textarea']);

function isKatexSubtree(node: Element): boolean {
  const cls = node.properties?.className;
  return Array.isArray(cls) && cls.some((c) => typeof c === 'string' && c.startsWith('katex'));
}

// Chromium(Electron renderer)恒有 Intl.Segmenter;条件判断只为让 Node 测试
// 环境(vitest, Node ≥16 同样内置)与未来宿主差异不至于直接抛错。
const segmenter =
  typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function'
    ? new Intl.Segmenter(undefined, { granularity: 'word' })
    : null;

/**
 * 切词结果 LRU 缓存(Codex Desktop 同款优化,容量同 500):流式每 tick 全文
 * 重解析,绝大多数文本节点与上个 tick 完全相同,而 Intl.Segmenter 对 CJK 分词
 * 相对昂贵 —— 无缓存时长文档每 tick 全量重切,成本随文档长度线性涨。Map 的
 * 插入序即访问序近似(命中即删再插,超限逐出最老),对"稳定前文 + 生长尾部"
 * 的访问模式命中率接近 100%。
 */
const splitCache = new Map<string, string[]>();
const SPLIT_CACHE_MAX = 500;

function splitWordsUncached(text: string): string[] {
  const out: string[] = [];
  if (segmenter) {
    for (const seg of segmenter.segment(text)) {
      const s = seg.segment;
      if (!s.trim() && out.length > 0) out[out.length - 1] += s;
      else out.push(s);
    }
    return out;
  }
  for (const s of text.split(/(\s+)/)) {
    if (!s) continue;
    if (!s.trim() && out.length > 0) out[out.length - 1] += s;
    else out.push(s);
  }
  return out;
}

/** 切词:词段独立,空白段并入前一段(段首空白独立保留为纯文本)。 */
export function splitWords(text: string): string[] {
  const hit = splitCache.get(text);
  if (hit) {
    // 命中即重排到队尾(近似 LRU),稳定前文不会被生长尾部逐出。
    splitCache.delete(text);
    splitCache.set(text, hit);
    return hit;
  }
  const words = splitWordsUncached(text);
  splitCache.set(text, words);
  if (splitCache.size > SPLIT_CACHE_MAX) {
    const oldest = splitCache.keys().next().value;
    if (oldest !== undefined) splitCache.delete(oldest);
  }
  return words;
}

/** pass 1 收集的待包装文本槽位:parent.children[index] 是原文本节点。 */
interface TextSlot {
  kind: 'text';
  parent: Root | Element;
  index: number;
  words: string[];
  /** 本槽第一个词在全文档淡入段列表(segments)中的下标。 */
  segmentStart: number;
}

/** 行内 code 整体作为一个淡入段,内部 chip / 路径结构保持原样。 */
interface InlineCodeSlot {
  kind: 'inline-code';
  parent: Root | Element;
  index: number;
  node: Element;
  segmentStart: number;
}

type FadeSlot = TextSlot | InlineCodeSlot;

/** 列表项圆点条目:圆点借用 li 内第一个段的 key/delay(Codex 同款)。 */
interface MarkerEntry {
  node: Element;
  /** li 内第一个段在全文档段列表中的下标;li 收集完仍相等 = 暂无内容。 */
  segmentStart: number;
  /** li 子树收集结束时的段列表长度,> segmentStart 才说明首段真在 li 内。 */
  segmentEnd: number;
}

interface Collected {
  slots: FadeSlot[];
  segments: FadeSegment[];
  markers: MarkerEntry[];
}

function elementText(node: Element): string {
  let out = '';
  for (const child of node.children) {
    if (child.type === 'text') out += child.value;
    else if (child.type === 'element') out += elementText(child);
  }
  return out;
}

/**
 * 按文档序收集文本、行内 code 槽位与列表项条目。普通文本(含表格格内)切词;
 * inline code 整体占一个原子段。其它结构元素不占段位 —— li 圆点记下首段的
 * 下标,之后与该段共享 key 和 delay(Codex Desktop listItemDecorationByToken
 * 同构),圆点与文字永远同帧浮现,不会"圆点亮了文字干等"。
 */
function collect(node: Root | Element, out: Collected): void {
  const children = node.children;
  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    if (child.type === 'element') {
      if (SKIP_TAGS.has(child.tagName) || isKatexSubtree(child)) continue;
      if (child.tagName === 'code') {
        const segmentStart = out.segments.length;
        out.slots.push({ kind: 'inline-code', parent: node, index: i, node: child, segmentStart });
        out.segments.push({ kind: 'inline-code', content: elementText(child) });
        continue;
      }
      if (child.tagName === 'li') {
        const entry: MarkerEntry = {
          node: child,
          segmentStart: out.segments.length,
          segmentEnd: 0,
        };
        out.markers.push(entry);
        collect(child, out);
        entry.segmentEnd = out.segments.length;
        continue;
      }
      collect(child, out);
      continue;
    }
    if (child.type !== 'text') continue;
    const words = splitWords(child.value);
    // 单段且是纯空白(块间换行等)→ 原样保留,不改树。
    if (words.length === 0 || (words.length === 1 && !words[0].trim())) continue;
    out.slots.push({
      kind: 'text',
      parent: node,
      index: i,
      words,
      segmentStart: out.segments.length,
    });
    // 纯空白段(只可能出现在段首)不占词位。
    for (const w of words) if (w.trim()) out.segments.push({ kind: 'text', content: w });
  }
}

/**
 * 内容匹配分配稳定 key(Codex Desktop 同源思路):
 *   1. 同位置且内容相等 / 前缀延续(旧词是新词前缀,chunk 边界补全)→ 复用;
 *   2. 错位则按内容从后往前找尚未被占用的旧 key(整体平移的词各自找回);
 *   3. 都没有 → 发新 key。
 * 匹配完成后把本次列表写回 state.previous,供下一次 parse 匹配。
 */
function segmentLookupKey(segment: FadeSegment): string {
  return `${segment.kind}\u0000${segment.content}`;
}

function assignKeys(segments: FadeSegment[], state: WordFadeState): string[] {
  const unmatched = new Set<number>(state.previous.keys());
  const byContent = new Map<string, number[]>();
  for (let i = state.previous.length - 1; i >= 0; i--) {
    const lookupKey = segmentLookupKey(state.previous[i]);
    const arr = byContent.get(lookupKey);
    if (arr) arr.push(i);
    else byContent.set(lookupKey, [i]);
  }
  const keys = segments.map((segment, i) => {
    const prev = state.previous[i];
    if (
      prev &&
      unmatched.has(i) &&
      prev.kind === segment.kind &&
      (prev.content === segment.content ||
        (segment.kind === 'text' &&
          prev.content.length > 0 &&
          segment.content.startsWith(prev.content)))
    ) {
      unmatched.delete(i);
      return prev.key;
    }
    const candidates = byContent.get(segmentLookupKey(segment));
    let idx = candidates?.pop();
    while (idx !== undefined && !unmatched.has(idx)) idx = candidates?.pop();
    if (idx !== undefined) {
      unmatched.delete(idx);
      return state.previous[idx].key;
    }
    return `wf-${state.nextId++}`;
  });
  state.previous = keys.map((key, i) => ({ ...segments[i], key }));
  return keys;
}

/**
 * 取(必要时分配)某个 key 的开播时刻,返回**本 tick 视角的剩余 delay**。
 * 普通聊天不 stagger:同一 parse tick 的所有新 key 都以 nowMs 为开播时刻。
 * 已见 key 不重排,但每个 tick 都按「开播时刻 - now」重新发剩余 delay:开播
 * 时刻已过去则为负值,CSS 负 animation-delay 从中途续播 —— react-markdown
 * 位置 key 引发的 remount 只会让动画跳回正确进度,不会从头重等(remount 免疫)。
 */
function ensureDelay(key: string, state: WordFadeState, nowMs: number): number {
  let startAt = state.startAtByKey.get(key);
  if (startAt === undefined) {
    startAt = nowMs;
    state.startAtByKey.set(key, startAt);
  }
  return Math.round(startAt - nowMs);
}

function makeFadeNode(
  children: ElementContent[],
  key: string,
  state: WordFadeState,
  nowMs: number,
): ElementContent {
  return {
    type: 'element',
    tagName: 'span',
    properties: {
      className: ['stream-word'],
      style: `--wf-delay:${ensureDelay(key, state, nowMs)}ms`,
      dataWfKey: key,
    },
    children,
  };
}

/**
 * 一个槽位的词是否已全部尘埃落定(animationend 落袋进 settled)。
 * 全 settled 的槽位**完全不改树**:原文本节点原样保留 —— 这是流式长文档的
 * 性能核心。settled 词若逐个包空 span,元素数随全文词数线性涨(几千 span),
 * react-markdown 每 tick 重建 + React diff 全量元素,主线程被 parse tick 打满,
 * 点击/切换 session 全部排不上队(2026-08-09 实测:流式中无法切换会话)。
 * 还原成纯文本后,React 元素数回落到与无动效渲染同阶;只有 150ms 动画窗口
 * 内仍在播的段才有 span。安全性依赖 remount 免疫:文本节点数量变化会让后续
 * 兄弟位置 key 平移、在播 span remount,但绝对开播时刻 + 负 delay 续播保证
 * remount 后动画进度不变(而非从头重播)。
 */
function isSlotFullySettled(slot: FadeSlot, keys: string[], state: WordFadeState): boolean {
  if (slot.kind === 'inline-code') return state.settled.has(keys[slot.segmentStart]);
  let segmentIndex = slot.segmentStart;
  for (const w of slot.words) {
    if (!w.trim()) continue;
    if (!state.settled.has(keys[segmentIndex])) return false;
    segmentIndex++;
  }
  return true;
}

function appendPlainText(nodes: ElementContent[], value: string): void {
  if (!value) return;
  const last = nodes[nodes.length - 1];
  if (last?.type === 'text') last.value += value;
  else nodes.push({ type: 'text', value });
}

function makeSlotNodes(
  slot: FadeSlot,
  keys: string[],
  state: WordFadeState,
  nowMs: number,
): ElementContent[] {
  if (slot.kind === 'inline-code') {
    const key = keys[slot.segmentStart];
    return [makeFadeNode([slot.node], key, state, nowMs)];
  }
  const nodes: ElementContent[] = [];
  let segmentIndex = slot.segmentStart;
  for (const word of slot.words) {
    if (!word.trim()) {
      appendPlainText(nodes, word);
      continue;
    }
    const key = keys[segmentIndex++];
    if (state.settled.has(key)) appendPlainText(nodes, word);
    else nodes.push(makeFadeNode([{ type: 'text', value: word }], key, state, nowMs));
  }
  return nodes;
}

/**
 * 给 li 挂圆点淡入(Codex Desktop fadeListDecoration 同构)。动画打在
 * `::marker` 上(CSS 见 globals.css),delay/key 借用 li 内第一个段 ——
 * 圆点与正文同帧浮现。li 内暂无内容(结构刚长出)→ 直接 0ms 淡入;
 * 内容到达后按首段 key 正常淡入,圆点已见 key 不重播。
 * 已 settled 的 key 不打标 —— 全新 hast 树上无动画类即无重播。
 */
function applyMarkerFade(
  entry: MarkerEntry,
  keys: string[],
  state: WordFadeState,
  nowMs: number,
): void {
  const hasSegment = entry.segmentEnd > entry.segmentStart;
  const key = hasSegment ? keys[entry.segmentStart] : undefined;
  if (key && state.settled.has(key)) return;
  const delay = key ? ensureDelay(key, state, nowMs) : 0;
  entry.node.properties = {
    ...entry.node.properties,
    dataStreamMarker: true,
    ...(key ? { dataWfKey: key } : {}),
    style: `--wf-delay:${delay}ms`,
  };
}

export const rehypeStreamWordFade: Plugin<[WordFadeState], Root> = (state) => {
  return (tree) => {
    // pass 1:按文档序收集文本 / inline-code 槽位、全文档段列表与 li 圆点条目。
    const collected: Collected = { slots: [], segments: [], markers: [] };
    collect(tree, collected);
    const { slots, segments, markers } = collected;
    if (segments.length === 0 && markers.length === 0) return;
    // pass 2:类型 + 内容匹配分配稳定 key(已见段命中旧 key 拿回 delay/settled)。
    const keys = assignKeys(segments, state);
    // pass 3:回填 span。同 tick 新段全部 0ms 开始,旧段按绝对开播时刻续播。
    // 槽位从后往前 splice,前面槽位的 index 不受影响。
    const nowMs = (state.nowFn ?? (() => performance.now()))();
    const nodesBySlot = slots.map((slot) => {
      // 全 settled 槽位不改树(性能核心,见 isSlotFullySettled 注释)。
      if (isSlotFullySettled(slot, keys, state)) return null;
      return makeSlotNodes(slot, keys, state, nowMs);
    });
    for (let s = slots.length - 1; s >= 0; s--) {
      const nodes = nodesBySlot[s];
      if (nodes === null) continue;
      const slot = slots[s];
      slot.parent.children.splice(slot.index, 1, ...nodes);
    }
    // pass 4:圆点淡入。在词回填后执行不受影响(splice 只动文本层,不动 li)。
    for (const m of markers) applyMarkerFade(m, keys, state, nowMs);
  };
};
