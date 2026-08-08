/**
 * rehypeStreamWordFade — 流式正文逐词淡入(DESIGN.md §14.4 第五个 sanctioned
 * motion class,2026-08-07)。
 *
 * 形态:流式输出时,每个新词以 150ms opacity 淡入「浮现」,而不是硬蹦出来。
 * 这**不是**被红线禁止的逐字打字机 —— 词整体已渲染就位,只有透明度渐变;
 * 设计裁决(2026-08-07)按「浮现 ≠ 打字」放行。
 *
 * 架构:CSS 管形态、JS 只管时序(对齐 Codex Desktop 的工程结论):
 *   - 本插件仅在 isStreaming 且非 reduced-motion 时挂进 rehype 链尾,把文本节点
 *     切词并包 `<span class="stream-word" style="--wf-delay:Nms">`;动画本体是
 *     globals.css 的 stream-word-in(--motion-fast 淡入,`both` 填充,delay 前隐藏)。
 *   - **不重播**:每个词按全局文档序号在 WordFadeState.assigned 里只分配一次
 *     delay。流式节流(100ms)每次 re-parse 重建整棵 hast 树,已见过的词拿回
 *     同一份 className/style → React 原位更新 span,不 remount → 动画不重播。
 *     (pending 行 markdown 结构闭合时的局部 remount 会让那几个词快速重淡一次,
 *     150ms 幅度在打字节奏下属于自然观感,与 Codex 行为一致。)
 *   - **背压**:每个 parse tick 内新词按 16ms/词 递进 stagger;当 tick 内积压
 *     排程超过 96ms(≈6 词)时压缩到 4ms/词,长段落一次性到达时不会排出
 *     秒级的"字幕机"队列。
 *   - 流式结束(isStreaming 翻 false)由 MarkdownRenderer 切回无插件的常量链,
 *     终版渲染没有任何 span 包装,state 随 memo 一起被回收。
 *
 * 跳过:code / pre(路径 chip 与代码块保持整体形态)与 KaTeX 子树(公式内部
 * 是几十个定位 span,逐词包装会拆坏排版)。
 *
 * 切词用 Intl.Segmenter(granularity: 'word'):CJK 无空格也能按词切,避免整句
 * 中文一次性淡入退化成"逐句蹦"。空白并入前一词,不为纯空白生成 span。
 */

import type { Plugin } from 'unified';
import type { Element, ElementContent, Root, Text } from 'hast';

/** 每个 tick 内的逐词 stagger 步长。 */
const STEP_MS = 16;
/** tick 内排程积压超过该值后切换为压缩步长(背压)。 */
const BACKLOG_MS = 96;
const COMPRESSED_STEP_MS = 4;

export interface WordFadeState {
  /** 词的全局文档序号 → 首次出现时分配的 delay(ms)。只写一次,保证不重播。 */
  assigned: Map<number, number>;
}

export function createWordFadeState(): WordFadeState {
  return { assigned: new Map() };
}

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

/** 切词:词段独立,空白段并入前一段(段首空白独立保留为纯文本)。 */
export function splitWords(text: string): string[] {
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

interface WalkCounter {
  index: number;
  cumDelay: number;
}

function makeWordNode(word: string, counter: WalkCounter, state: WordFadeState): ElementContent {
  // 纯空白段(只可能出现在段首)保持文本节点,不占词序号。
  if (!word.trim()) return { type: 'text', value: word } satisfies Text;
  const index = counter.index++;
  let delay = state.assigned.get(index);
  if (delay === undefined) {
    counter.cumDelay += counter.cumDelay >= BACKLOG_MS ? COMPRESSED_STEP_MS : STEP_MS;
    delay = counter.cumDelay;
    state.assigned.set(index, delay);
  }
  return {
    type: 'element',
    tagName: 'span',
    properties: { className: ['stream-word'], style: `--wf-delay:${delay}ms` },
    children: [{ type: 'text', value: word }],
  };
}

function walk(node: Root | Element, counter: WalkCounter, state: WordFadeState): void {
  const children = node.children;
  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    if (child.type === 'element') {
      if (SKIP_TAGS.has(child.tagName) || isKatexSubtree(child)) continue;
      walk(child, counter, state);
      continue;
    }
    if (child.type !== 'text') continue;
    const words = splitWords(child.value);
    // 单段且是纯空白(块间换行等)→ 原样保留,不改树。
    if (words.length === 0 || (words.length === 1 && !words[0].trim())) continue;
    const nodes = words.map((w) => makeWordNode(w, counter, state));
    children.splice(i, 1, ...nodes);
    i += nodes.length - 1;
  }
}

export const rehypeStreamWordFade: Plugin<[WordFadeState], Root> = (state) => {
  return (tree) => {
    // 每次 parse 从 0 号词重走全文档:已分配的词命中 map 拿回旧 delay,
    // 计数器只被"本 tick 新词"推进 —— stagger 天然从本 tick 起算。
    const counter: WalkCounter = { index: 0, cumDelay: 0 };
    walk(tree, counter, state);
  };
};
