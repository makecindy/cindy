/**
 * 流式正文分段淡入（DESIGN.md §14.4）。文本词段、行内 code 原子和列表圆点
 * 共用消息级连续时间线；块级结构即时出现。稳定 key 记录绝对开播时刻，结构
 * 调整导致节点重挂载时用负 delay 恢复进度，不会从头重播。
 *
 * settled 段在流式期间保留原 span 身份，只摘动画 class；稳定 Markdown 前缀
 * 由外层分片组件保留解析结果和 DOM。消息结束后切回普通 Markdown，一次性移除
 * 所有流式包装。pre 代码块与 KaTeX 子树不进入逐词处理。
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

export interface WordFadeTimeline {
  /** key → 绝对开播时刻(performance.now() 基准)。 */
  startAtByKey: Map<string, number>;
  /** 已完成淡入的 key。流式期间只摘动画 class，节点留到终态统一回收。 */
  settled: Set<string>;
  /** 下一段最早可开播的绝对时刻；同一条消息的所有 Markdown 分片共享。 */
  nextSegmentStartAtMs: number;
  /** 时钟注入口，仅测试使用。 */
  nowFn?: () => number;
}

export interface WordFadeState {
  /** 稳定 key 发号器。 */
  nextId: number;
  /** 上一次 parse 的淡入段列表(文档序),类型 + 内容匹配复用 key 的依据。 */
  previous: PreviousSegment[];
  /** 分片 key 前缀，保证同一条消息的并行 Markdown 分片不会撞 key。 */
  keyPrefix: string;
  /** 同一条消息的连续时间线。 */
  timeline: WordFadeTimeline;
  /** 稳定前缀分片与增长尾部分别维护匹配状态，但共享 timeline。 */
  sourceStateByKey: Map<string, WordFadeState>;
}

/** 与 globals.css 的 --motion-fast 保持一致,用于 animationend 丢失时的到期兜底。 */
const FADE_DURATION_MS = 150;
/** 普通流式正文的连续节奏：正常 16ms，积压到 96ms 后压缩为 4ms。 */
export const WORD_FADE_SEGMENT_DELAY_MS = 16;
export const WORD_FADE_MAX_DELAY_MS = 96;
/** 高速突发时最多让文字等待这么久；超过窗口的段同帧淡入，避免透明内容长期占位。 */
export const WORD_FADE_MAX_VISIBLE_DELAY_MS = 160;
const WORD_FADE_BACKLOG_STEP_MS = WORD_FADE_SEGMENT_DELAY_MS * 0.25;

function createWordFadeTimeline(): WordFadeTimeline {
  return {
    startAtByKey: new Map(),
    settled: new Set(),
    nextSegmentStartAtMs: 0,
  };
}

export function createWordFadeState(
  keyPrefix = '',
  timeline = createWordFadeTimeline(),
): WordFadeState {
  return {
    nextId: 0,
    previous: [],
    keyPrefix,
    timeline,
    sourceStateByKey: new Map(),
  };
}

export function getOrCreateWordFadeSourceState(
  owner: WordFadeState,
  sourceKey: string,
): WordFadeState {
  const cached = owner.sourceStateByKey.get(sourceKey);
  if (cached) return cached;
  const state = createWordFadeState(`s${sourceKey}-`, owner.timeline);
  owner.sourceStateByKey.set(sourceKey, state);
  return state;
}

/**
 * React render 只允许改 candidate。真正挂载后由 MarkdownRenderer 的
 * useLayoutEffect 提交,被并发渲染放弃的 parse 不会偷跑稳定 key / 时间线。
 */
export function createWordFadeCandidate(committed: WordFadeState): WordFadeState {
  return {
    nextId: committed.nextId,
    previous: committed.previous,
    keyPrefix: committed.keyPrefix,
    timeline: {
      startAtByKey: new Map(committed.timeline.startAtByKey),
      settled: new Set(committed.timeline.settled),
      nextSegmentStartAtMs: committed.timeline.nextSegmentStartAtMs,
      nowFn: committed.timeline.nowFn,
    },
    sourceStateByKey: new Map(),
  };
}

/**
 * 全局 Markdown 上下文晚到时，外层会从多个稳定分片回退成 start=0 的整篇解析。
 * 这里按原文起点合并各分片的匹配历史，让整篇 candidate 继续认出已经播放过的段；
 * 只读 committed state，不在 React render 阶段发布状态。
 */
export function createWholeDocumentWordFadeCandidate(
  owner: WordFadeState,
  committed: WordFadeState,
): WordFadeState {
  const candidate = createWordFadeCandidate(committed);
  const previous = [...owner.sourceStateByKey.entries()]
    .sort(([left], [right]) => Number(left) - Number(right))
    .flatMap(([, sourceState]) => sourceState.previous);
  if (previous.length > 0) candidate.previous = previous;
  return candidate;
}

/** 整篇 candidate 落袋后移除旧分片匹配状态；共享 timeline 仍由保留项持有。 */
export function retainOnlyWordFadeSourceState(
  owner: WordFadeState,
  sourceKey: string,
): void {
  for (const key of owner.sourceStateByKey.keys()) {
    if (key !== sourceKey) owner.sourceStateByKey.delete(key);
  }
}

export function commitWordFadeCandidate(committed: WordFadeState, candidate: WordFadeState): void {
  committed.nextId = candidate.nextId;
  committed.previous = candidate.previous;
  // render 到 layout-effect 之间可能正好收到上一帧的 animationend；只合并，不能覆盖。
  for (const key of candidate.timeline.settled) committed.timeline.settled.add(key);
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

/** animationend 闭包的落袋入口;身份来自 render 时捕获的 key,不读取可变 DOM dataset。 */
export function markWordFadeSettled(state: WordFadeState, key: string): void {
  state.timeline.settled.add(key);
}

export function isWordFadeSettled(state: WordFadeState, key: string): boolean {
  return state.timeline.settled.has(key);
}

function nextWordFadeStep(delayMs: number): number {
  return delayMs < WORD_FADE_MAX_DELAY_MS
    ? WORD_FADE_SEGMENT_DELAY_MS
    : Math.max(1, WORD_FADE_BACKLOG_STEP_MS);
}

/**
 * DOM commit 阶段把段接入消息级连续时间线。新段正常每 16ms 开播；积压达到
 * 96ms 后步长压到 4ms，避免长批次排出明显等待。已见段只恢复原绝对时刻，
 * remount 不重排、不重播。
 */
export function scheduleWordFadeSegment(
  state: WordFadeState,
  key: string,
  element: HTMLElement,
): number {
  const { timeline } = state;
  const nowMs = (timeline.nowFn ?? (() => performance.now()))();
  let startAt = timeline.startAtByKey.get(key);
  if (startAt === undefined) {
    const queuedStartAt = Math.max(timeline.nextSegmentStartAtMs, nowMs);
    startAt = Math.min(queuedStartAt, nowMs + WORD_FADE_MAX_VISIBLE_DELAY_MS);
    const delayMs = Math.max(Math.round(startAt - nowMs), 0);
    timeline.startAtByKey.set(key, startAt);
    timeline.nextSegmentStartAtMs = startAt + nextWordFadeStep(delayMs);
  }
  const remainingDelayMs = Math.round(startAt - nowMs);
  element.style.setProperty('--wf-delay', `${remainingDelayMs}ms`);
  return remainingDelayMs;
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
 * 切词结果 LRU 缓存（容量 500）：增长尾部重解析时仍会反复遇到相同文本节点，
 * 而 Intl.Segmenter 对 CJK 分词相对昂贵。Map 的
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

/** 列表项圆点条目：圆点借用 li 内第一个段的 key/delay。 */
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
 * 下标，之后与该段共享 key 和 delay，圆点与文字永远同帧浮现。
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
 * 内容匹配分配稳定 key：
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
    return `wf-${state.keyPrefix}${state.nextId++}`;
  });
  state.previous = keys.map((key, i) => ({ ...segments[i], key }));
  return keys;
}

/**
 * ref 在 DOM commit 阶段写入真实消息级时间线；这里的值只负责首轮 React 属性。
 * 已排段按绝对时刻恢复进度，新段用当前分片内的静态估值避免首帧闪烁，ref 会在
 * paint 前把它校正为跨分片连续的 16ms / 96ms 时间线。
 */
function estimateWordFadeDelay(segmentIndex: number): number {
  const rawDelay = segmentIndex * WORD_FADE_SEGMENT_DELAY_MS;
  if (rawDelay <= WORD_FADE_MAX_DELAY_MS) return rawDelay;
  return Math.min(
    WORD_FADE_MAX_VISIBLE_DELAY_MS,
    WORD_FADE_MAX_DELAY_MS +
      (segmentIndex - Math.floor(WORD_FADE_MAX_DELAY_MS / WORD_FADE_SEGMENT_DELAY_MS)) *
        WORD_FADE_BACKLOG_STEP_MS,
  );
}

function renderDelay(
  key: string,
  state: WordFadeState,
  nowMs: number,
  segmentIndex: number,
): number {
  const startAt = state.timeline.startAtByKey.get(key);
  return startAt === undefined
    ? estimateWordFadeDelay(segmentIndex)
    : Math.round(startAt - nowMs);
}

function makeFadeNode(
  children: ElementContent[],
  key: string,
  state: WordFadeState,
  nowMs: number,
  segmentIndex: number,
): ElementContent {
  const settled = state.timeline.settled.has(key);
  return {
    type: 'element',
    tagName: 'span',
    properties: {
      ...(settled ? {} : { className: ['stream-word'] }),
      style: `--wf-delay:${renderDelay(key, state, nowMs, segmentIndex)}ms`,
      dataWfKey: key,
    },
    children,
  };
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
    return [makeFadeNode([slot.node], key, state, nowMs, slot.segmentStart)];
  }
  const nodes: ElementContent[] = [];
  let segmentIndex = slot.segmentStart;
  for (const word of slot.words) {
    if (!word.trim()) {
      appendPlainText(nodes, word);
      continue;
    }
    const key = keys[segmentIndex++];
    nodes.push(
      makeFadeNode(
        [{ type: 'text', value: word }],
        key,
        state,
        nowMs,
        segmentIndex - 1,
      ),
    );
  }
  return nodes;
}

/**
 * 给 li 挂圆点淡入。动画打在
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
  if (key && state.timeline.settled.has(key)) return;
  const delay = key ? renderDelay(key, state, nowMs, entry.segmentStart) : 0;
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
    // pass 3：回填 span。ref 会在 DOM commit 阶段接入共享连续时间线。
    // 槽位从后往前 splice,前面槽位的 index 不受影响。
    const nowMs = (state.timeline.nowFn ?? (() => performance.now()))();
    // 结构变化会让活动 span remount,旧节点因此可能收不到 animationend。超过动画
    // 时长的已开播段直接落袋,避免它永久保留活动包装。
    for (const key of keys) {
      const startAt = state.timeline.startAtByKey.get(key);
      if (startAt !== undefined && nowMs - startAt >= FADE_DURATION_MS) {
        state.timeline.settled.add(key);
      }
    }
    const nodesBySlot = slots.map((slot) => makeSlotNodes(slot, keys, state, nowMs));
    for (let s = slots.length - 1; s >= 0; s--) {
      const nodes = nodesBySlot[s];
      const slot = slots[s];
      slot.parent.children.splice(slot.index, 1, ...nodes);
    }
    // pass 4:圆点淡入。在词回填后执行不受影响(splice 只动文本层,不动 li)。
    for (const m of markers) applyMarkerFade(m, keys, state, nowMs);
  };
};
