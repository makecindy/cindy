/**
 * rehypeStreamWordFade — 流式正文逐词淡入(DESIGN.md §14.4 第五个 sanctioned
 * motion class,2026-08-07)。
 *
 * 形态:流式输出时,每个新词以 150ms opacity 淡入「浮现」,而不是硬蹦出来。
 * 这**不是**被红线禁止的逐字打字机 —— 词整体已渲染就位,只有透明度渐变;
 * 设计裁决(2026-08-07)按「浮现 ≠ 打字」放行。
 *
 * 架构:CSS 管形态、JS 只管时序:
 *   - 本插件仅在 isStreaming 且非 reduced-motion 时挂进 rehype 链尾,把文本节点
 *     切词并包 `<span class="stream-word" style="--wf-delay:Nms">`;动画本体是
 *     globals.css 的 stream-word-in(--motion-fast 淡入,`both` 填充,delay 前隐藏)。
 *   - **不重播 —— 内容匹配的稳定 key**:delay 与 settled 都按词的稳定 key 记账,
 *     不按文档序号。每次 parse 把本次词列表与上一次(state.previous)做匹配:
 *     同位置内容相等或前缀延续(chunk 边界半个词长成整词)→ 复用旧 key;错位则
 *     按内容从后往前找未被占用的旧 key(结构变化整体平移的词都能找回自己);都
 *     没有才发新 key。markdown 结构变化(列表标记吃掉 "2. "、加粗闭合劈开文本
 *     节点、Segmenter 对 chunk 尾部的切分变化)只会让**词序号**漂移,key 不漂 ——
 *     漂移序号曾让已稳定的整片前文被当新词重淡(2026-08-08 实测)。
 *   - **settled 落袋 + settled 前缀还原纯文本**:span 带 data-wf-key,
 *     MarkdownRenderer 根节点监听冒泡的 animationend(markSettledFromAnimationEnd),
 *     播完的 key 进 state.settled;settled 词从槽位中还原为合并后的原生文本,
 *     只保留仍在播放的尾部 span——流式长文档的元素数因此回落到与无动效渲染
 *     同阶,react-markdown 每 tick 的重建 + diff 不随已播完的前文线性涨
 *     (曾因全文逐词包 span,几千元素把主线程打满,流式中点击切换 session
 *     无响应,2026-08-09 实测)。部分 settled 的槽位仍整槽包 span(settled 词
 *     的负 delay 已超动画时长,both 填充直接呈现终态,不重播)。抽掉 span 引
 *     发的兄弟位置 key 平移由 remount 免疫兜底(见下),不再需要空壳保位。
 *   - **timeline 队列 + 背压**(Codex Desktop 同源,2026-08-08):delay 不按
 *     tick 静态起算,而是对着 state.nextStartAtMs(队列尾部绝对时间戳)动态
 *     分配:新词排在 max(队列尾, now),随后尾部推进一个步长(上限 24ms/词,
 *     按剩余预算自适应压缩,见 planTickStep)。跨 tick 连续 —— 上游卡顿后突发
 *     的大段文字即使分落多个 parse tick,后到的词也永远排在先到的词后面
 *     (不插队、不乱序);卡顿期间队列自然排空(尾部落到过去),突发第一词
 *     从 0ms 立即开始,整段呈连贯波浪推进而不是整块蹦出。
 *   - **remount 免疫 —— 存开播时刻、每 tick 发剩余 delay**(2026-08-08,与
 *     Codex 的根本差异所要求的补偿):Codex 自研渲染器用 segmentKey 当 React
 *     key,span 永不 remount;我们骑在 react-markdown 上,React key 是位置
 *     序号,流式中正在生长的区域(表格尾行、成形中的列表)每 tick 都可能
 *     remount。若给 span 发固定 delay,remount 会让 CSS 动画带原始 delay 从头
 *     重等,下一 tick 又 remount —— 词永远透明(2026-08-08 表格实测)。故
 *     state 记的是**绝对开播时刻**,每个 tick 重新发出「开播时刻 - now」:
 *     已过时刻发**负 delay**,CSS 负 animation-delay 让动画从中途续播,
 *     remount 后帧级跳回正确进度,观感无缝。
 *   - 流式结束(isStreaming 翻 false)由 MarkdownRenderer 切回无插件的常量链,
 *     终版渲染没有任何 span 包装,state 随 memo 一起被回收。
 *
 * 跳过:code / pre(路径 chip 与代码块保持整体形态)与 KaTeX 子树(公式内部
 * 是几十个定位 span,逐词包装会拆坏排版)。
 *
 * 淡入对象模型(Codex Desktop 对齐,2026-08-08 第二版):**只有文本词段和
 * 列表圆点两类东西淡入,结构永远即时出现**。表格边框、引用 rail、分隔线不做
 * 块级整体淡入 —— 曾试过 tr/li 整块排队,大积压窗口下必然出现"空骨架先
 * 画好、文字憋一坨"(2026-08-08 两轮实测翻车)。表格格内文字与正文一样逐词
 * 淡入(Codex FIa 对 table 的处理同款)。列表圆点(::marker)单独处理:li 打
 * data-stream-marker,delay/key **借用 li 内第一个词**(listItemDecorationByToken
 * 同构)—— 圆点与它的文字同帧浮现,不占队列位,空 li 长出文字也不重播。
 * 标记用 data 属性而不是 className:MarkdownRenderer 的自定义 renderer 是
 * `className={cn(...)} {...props}` 写法,hast 塞 className 会经 spread 把样式
 * 类整个覆盖掉;data-* 从 spread 直通,互不相扰。
 *
 * 切词用 Intl.Segmenter(granularity: 'word'):CJK 无空格也能按词切,避免整句
 * 中文一次性淡入退化成"逐句蹦"。空白并入前一词,不为纯空白生成 span。
 */

import type { Plugin } from 'unified';
import type { Element, ElementContent, Root } from 'hast';

/** 逐词 stagger 步长上限(Codex Desktop 同款 24ms;慢速输出时的标准节奏)。 */
const STEP_MS = 24;
/**
 * 排程超前量预算(有意偏离 Codex,2026-08-08):Codex 的背压是固定压缩步长
 * (800ms 积压后 6ms/词),隐含假设词到达慢于消费、队列终会排空;但吐词速率
 * 因模型而异(超快模型 300+ tok/s ≈ 3ms/词,比 6ms 消费还快一倍),任何写死
 * 的压缩步长都会在更快的模型下积压无界增长 —— 文档尾部(常见:表格)排到几
 * 秒开外,骨架长时间空等(2026-08-08 实测)。
 *
 * 故改为**自适应步长**:每个 parse tick 按「剩余预算 / 本 tick 新词数」现算
 * 本 tick 的步长(封顶 STEP_MS,见 planTickStep)。消费速率自动匹配任意到达
 * 速率:慢模型恒拿 24ms(与 Codex 观感一致),快模型步长自动压小,积压永远
 * 收敛在预算内 —— 文字落后数据到达最多约 MAX_LEAD_MS + 动画时长,与模型无关。
 *
 * 预算取值按**感知**定,不按节奏上限反推:逐词波浪只在到达速率低于人眼分辨
 * (约十几词/秒)时有美学价值;300 tok/s 的模型没人能看清单词级波浪,却要为
 * 大预算付出"结构骨架先画好、整表空着等文字"的代价(1200ms 预算 × 270 tok/s
 * ≈ 一整个表格的空骨架,2026-08-08 实测截图)。320ms 上限保证任何模型下可见
 * 文字落后数据到达 < 0.5s(320 + 150ms 动画),空骨架窗口压到亚秒级;慢模型
 * 每 tick 词少、远用不满预算,24ms 波浪节奏不受影响。
 */
const MAX_LEAD_MS = 320;

interface PreviousSegment {
  content: string;
  key: string;
}

export interface WordFadeState {
  /** 稳定 key 发号器。 */
  nextId: number;
  /** 上一次 parse 的词列表(文档序),内容匹配复用 key 的依据。 */
  previous: PreviousSegment[];
  /**
   * key → 绝对开播时刻(performance.now() 基准)。只排一次;每个 tick 由
   * 「开播时刻 - now」重新发出剩余 delay(可为负,负值 = CSS 从中途续播)。
   * 存绝对时刻而不是固定 delay,是 remount 免疫的关键(见头注释)。
   */
  startAtByKey: Map<string, number>;
  /** 已播完淡入的 key(animationend 落袋)。后续 parse 摘掉动画类。 */
  settled: Set<string>;
  /** timeline 队列尾部的绝对时间戳(performance.now() 基准),跨 tick 连续。 */
  nextStartAtMs: number;
  /** 本 tick 的自适应步长(planTickStep 计算,ensureDelay 消费)。 */
  tickStepMs: number;
  /** 时钟注入口,仅测试用;生产恒为 performance.now。 */
  nowFn?: () => number;
}

export function createWordFadeState(): WordFadeState {
  return {
    nextId: 0,
    previous: [],
    startAtByKey: new Map(),
    settled: new Set(),
    nextStartAtMs: 0,
    tickStepMs: STEP_MS,
  };
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
 * 把播完 stream-word-in 的词 key 记进 state.settled。按动画名过滤 —— 同一子树里
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

/** 整棵子树跳过(不进入):代码、公式内部结构。 */
const SKIP_TAGS = new Set(['code', 'pre', 'script', 'style', 'textarea']);

function isKatexSubtree(node: Element): boolean {
  const cls = node.properties?.className;
  return (
    Array.isArray(cls) && cls.some((c) => typeof c === 'string' && c.startsWith('katex'))
  );
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
  parent: Root | Element;
  index: number;
  words: string[];
  /** 本槽第一个词在全文档词列表(contents)中的下标。 */
  wordStart: number;
}

/** 列表项圆点条目:圆点借用 li 内第一个词的 key/delay(Codex 同款)。 */
interface MarkerEntry {
  node: Element;
  /** li 内第一个词在全文档词列表中的下标;li 收集完仍等于收集前长度 = 暂无文字。 */
  wordStart: number;
  /** li 子树收集结束时的词表长度,> wordStart 才说明第一个词真在 li 内。 */
  wordEnd: number;
}

interface Collected {
  slots: TextSlot[];
  contents: string[];
  markers: MarkerEntry[];
}

/**
 * 按文档序收集文本槽位与列表项条目。所有文本(含表格格内)统一切词排队;
 * 结构元素不占队列位 —— 唯一的结构动效是 li 圆点,它记下自己第一个词的
 * 下标,之后与该词共享 key 和 delay(Codex Desktop listItemDecorationByToken
 * 同构),圆点与文字永远同帧浮现,不会"圆点亮了文字干等"。
 */
function collect(node: Root | Element, out: Collected): void {
  const children = node.children;
  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    if (child.type === 'element') {
      if (SKIP_TAGS.has(child.tagName) || isKatexSubtree(child)) continue;
      if (child.tagName === 'li') {
        const entry: MarkerEntry = { node: child, wordStart: out.contents.length, wordEnd: 0 };
        out.markers.push(entry);
        collect(child, out);
        entry.wordEnd = out.contents.length;
        continue;
      }
      collect(child, out);
      continue;
    }
    if (child.type !== 'text') continue;
    const words = splitWords(child.value);
    // 单段且是纯空白(块间换行等)→ 原样保留,不改树。
    if (words.length === 0 || (words.length === 1 && !words[0].trim())) continue;
    out.slots.push({ parent: node, index: i, words, wordStart: out.contents.length });
    // 纯空白段(只可能出现在段首)不占词位。
    for (const w of words) if (w.trim()) out.contents.push(w);
  }
}

/**
 * 内容匹配分配稳定 key(Codex Desktop 同源思路):
 *   1. 同位置且内容相等 / 前缀延续(旧词是新词前缀,chunk 边界补全)→ 复用;
 *   2. 错位则按内容从后往前找尚未被占用的旧 key(整体平移的词各自找回);
 *   3. 都没有 → 发新 key。
 * 匹配完成后把本次列表写回 state.previous,供下一次 parse 匹配。
 */
function assignKeys(contents: string[], state: WordFadeState): string[] {
  const unmatched = new Set<number>(state.previous.keys());
  const byContent = new Map<string, number[]>();
  for (let i = state.previous.length - 1; i >= 0; i--) {
    const content = state.previous[i].content;
    const arr = byContent.get(content);
    if (arr) arr.push(i);
    else byContent.set(content, [i]);
  }
  const keys = contents.map((content, i) => {
    const prev = state.previous[i];
    if (
      prev &&
      unmatched.has(i) &&
      (prev.content === content ||
        (prev.content.length > 0 && content.startsWith(prev.content)))
    ) {
      unmatched.delete(i);
      return prev.key;
    }
    const candidates = byContent.get(content);
    let idx = candidates?.pop();
    while (idx !== undefined && !unmatched.has(idx)) idx = candidates?.pop();
    if (idx !== undefined) {
      unmatched.delete(idx);
      return state.previous[idx].key;
    }
    return `wf-${state.nextId++}`;
  });
  state.previous = keys.map((key, i) => ({ content: contents[i], key }));
  return keys;
}

/**
 * 取(必要时分配)某个 key 的开播时刻,返回**本 tick 视角的剩余 delay**。
 * timeline 队列:新 key 排在队列尾部(尾部已落到过去则立即开始),尾部按当前
 * 积压深度推进(步长由 planTickStep 现算,超前量封顶 MAX_LEAD_MS)。
 * 已见 key 不重排,但每个 tick 都按「开播时刻 - now」重新发剩余 delay:开播
 * 时刻已过去则为负值,CSS 负 animation-delay 从中途续播 —— react-markdown
 * 位置 key 引发的 remount 只会让动画跳回正确进度,不会从头重等(remount 免疫)。
 */
/**
 * 每个 parse tick 开头调用:按「剩余排程预算 / 本 tick 新词数」现算本 tick
 * 的自适应步长。慢速输出(新词少、预算富余)恒拿 STEP_MS 上限,与 Codex 观感
 * 一致;快速输出(新词多)步长按比例压小,保证本 tick 排完后超前量仍在
 * MAX_LEAD_MS 预算内 —— 消费速率自动匹配任意模型的到达速率。
 */
function planTickStep(newWordCount: number, state: WordFadeState, nowMs: number): void {
  if (newWordCount <= 0) return;
  const backlog = Math.max(state.nextStartAtMs - nowMs, 0);
  const budget = Math.max(MAX_LEAD_MS - backlog, 0);
  state.tickStepMs = Math.min(STEP_MS, budget / newWordCount);
}

function ensureDelay(key: string, state: WordFadeState, nowMs: number): number {
  let startAt = state.startAtByKey.get(key);
  if (startAt === undefined) {
    startAt = Math.min(Math.max(state.nextStartAtMs, nowMs), nowMs + MAX_LEAD_MS);
    state.startAtByKey.set(key, startAt);
    state.nextStartAtMs = startAt + state.tickStepMs;
  }
  return Math.round(startAt - nowMs);
}

function makeWordNode(word: string, key: string, state: WordFadeState, nowMs: number): ElementContent {
  return {
    type: 'element',
    tagName: 'span',
    properties: {
      className: ['stream-word'],
      style: `--wf-delay:${ensureDelay(key, state, nowMs)}ms`,
      dataWfKey: key,
    },
    children: [{ type: 'text', value: word }],
  };
}

/**
 * 一个槽位的词是否已全部尘埃落定(animationend 落袋进 settled)。
 * 全 settled 的槽位**完全不改树**:原文本节点原样保留 —— 这是流式长文档的
 * 性能核心。settled 词若逐个包空 span,元素数随全文词数线性涨(几千 span),
 * react-markdown 每 tick 重建 + React diff 全量元素,主线程被 parse tick 打满,
 * 点击/切换 session 全部排不上队(2026-08-09 实测:流式中无法切换会话)。
 * 还原成纯文本后,React 元素数回落到与无动效渲染同阶;仍在播的词(320ms 预算
 * 内,几十个)才有 span。安全性依赖 remount 免疫:文本节点数量变化会让后续
 * 兄弟位置 key 平移、在播 span remount,但绝对开播时刻 + 负 delay 续播保证
 * remount 后动画进度不变(而非从头重播)。
 */
function isSlotFullySettled(
  slot: TextSlot,
  keys: string[],
  state: WordFadeState,
): boolean {
  let wordIndex = slot.wordStart;
  for (const w of slot.words) {
    if (!w.trim()) continue;
    if (!state.settled.has(keys[wordIndex])) return false;
    wordIndex++;
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
  slot: TextSlot,
  keys: string[],
  state: WordFadeState,
  nowMs: number,
): ElementContent[] {
  const nodes: ElementContent[] = [];
  let wordIndex = slot.wordStart;
  for (const word of slot.words) {
    if (!word.trim()) {
      appendPlainText(nodes, word);
      continue;
    }
    const key = keys[wordIndex++];
    if (state.settled.has(key)) appendPlainText(nodes, word);
    else nodes.push(makeWordNode(word, key, state, nowMs));
  }
  return nodes;
}

/**
 * 给 li 挂圆点淡入(Codex Desktop fadeListDecoration 同构)。动画打在
 * `::marker` 上(CSS 见 globals.css),delay/key 借用 li 内第一个词 ——
 * 圆点与文字同帧浮现。li 内暂无文字(结构刚长出)→ 借队列尾部当前值,
 * 不推进队列;文字到达后按词 key 正常淡入,圆点已见 key 不重播。
 * 已 settled 的 key 不打标 —— 全新 hast 树上无动画类即无重播。
 */
function applyMarkerFade(entry: MarkerEntry, keys: string[], state: WordFadeState, nowMs: number): void {
  const hasWord = entry.wordEnd > entry.wordStart;
  const key = hasWord ? keys[entry.wordStart] : undefined;
  if (key && state.settled.has(key)) return;
  const delay = key
    ? ensureDelay(key, state, nowMs)
    : Math.max(Math.round(state.nextStartAtMs - nowMs), 0);
  entry.node.properties = {
    ...entry.node.properties,
    dataStreamMarker: true,
    ...(key ? { dataWfKey: key } : {}),
    style: `--wf-delay:${delay}ms`,
  };
}

export const rehypeStreamWordFade: Plugin<[WordFadeState], Root> = (state) => {
  return (tree) => {
    // pass 1:按文档序收集文本槽位、全文档词列表与 li 圆点条目。
    const collected: Collected = { slots: [], contents: [], markers: [] };
    collect(tree, collected);
    const { slots, contents, markers } = collected;
    if (contents.length === 0 && markers.length === 0) return;
    // pass 2:内容匹配分配稳定 key(已见词命中旧 key 拿回旧 delay/settled)。
    const keys = assignKeys(contents, state);
    // pass 3:回填 span。timeline 队列只被"本 tick 新词"推进。
    // 槽位从后往前 splice,前面槽位的 index 不受影响。
    // delay 分配须按文档序(stagger 与阅读序一致),先按序生成节点再回填。
    const nowMs = (state.nowFn ?? (() => performance.now()))();
    // 自适应步长:先数本 tick 新词(未排程的 key),按剩余预算定步长。
    const newWordCount = keys.reduce(
      (n, k) => (state.startAtByKey.has(k) ? n : n + 1),
      0,
    );
    planTickStep(newWordCount, state, nowMs);
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
