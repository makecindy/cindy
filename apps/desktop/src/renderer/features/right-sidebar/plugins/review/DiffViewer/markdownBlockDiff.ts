/**
 * markdownBlockDiff — 审查页 Markdown 富文本预览的块级对齐器。
 *
 * 输入 before / after 两份完整源码，输出一份「渲染计划」：把 after 切成
 * 未改动（context）/ 新增（added）/ 删除（removed）/ 词级修订（revision）
 * 片段，交给 MarkdownDiffPreview 逐段渲染。
 *
 * revision 片段：
 *  - 由 1:1 配对的修改块（或纯新增 / 纯删除块）经 markdownRevision 做词级
 *    diff，注入 `{++ ++}` / `{-- --}` 标记后产出；渲染时需要
 *    MarkdownRenderer 打开 `reviewAnnotations`（<ins>/<del> 已带 diff 语义样式）。
 *  - 无法安全注入的块逐块回退为 added / removed 段（删除线 / 下划线装饰）。
 *
 * 为什么以 top-level mdast 块为对齐单元，而不是行：
 *  - 富文本按块渲染，片段必须落在块边界上；行级切分会切断列表 / 代码块 /
 *    引用 / 表格等结构，渲染结果不再是原文。
 *  - 块级对齐天然回答“哪里改了”，且不受行内改动跨块拆分的影响。
 * 已知边界（有意接受，写在这里避免后来者当 bug 修）：
 *  - 块内任何改动会把整个块标成改动（例如列表只改一项，整表高亮）。
 *  - 含脚注定义的文档放弃对齐（降级整篇渲染）：分片渲染会让脚注 section
 *    在每个片段重复出现。
 *  - 片段末尾会补上 after 侧全部链接引用定义（渲染为空），否则被切走的
 *    `[ref]: url` 定义会让片段里的 `[text][ref]` 解析失败。
 *  - 比较使用去行尾空白 + 去首尾空行的归一化文本：只调整缩进/空白的编辑
 *    不算改动（与“隐藏空白变更”的审查习惯一致）。
 */

import { diffArrays } from 'diff';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import { unified } from 'unified';
import type { Root, RootContent } from 'mdast';

import { buildMarkdownMathRevision } from './markdownMathRevision';
import { buildMarkdownRevision } from './markdownRevision';
import { buildMarkdownTableRevision } from './markdownTableRevision';

export type MarkdownPreviewSegmentKind = 'context' | 'added' | 'removed' | 'revision';

export interface MarkdownPreviewSegment {
  kind: MarkdownPreviewSegmentKind;
  key: string;
  /**
   * 该片段对应的源码：未改/新增取 after，删除取 before，修订取注入标记后的
   * after（含 `{++ ++}` / `{-- --}`）。
   */
  content: string;
  /** 片段在所属版本源码中的行范围（1-based，含两端）。 */
  startLine: number;
  endLine: number;
}

export interface MarkdownPreviewPlan {
  segments: MarkdownPreviewSegment[];
  /** 是否存在改动段（added / removed）。 */
  hasChanges: boolean;
  /**
   * 是否完成块级对齐。false = 已降级为整篇单段渲染：没有 before 基线、
   * 解析失败、含脚注定义或片段数超限。
   */
  blockAligned: boolean;
}

/**
 * 片段数上限。每个片段都会独立渲染一次 MarkdownRenderer（remark + rehype），
 * 改动极碎的大文档会因此变慢；超过上限宁可放弃高亮，也不能让预览卡住。
 */
export const MARKDOWN_PREVIEW_MAX_SEGMENTS = 120;

const parser = unified().use(remarkParse).use(remarkGfm);

interface SourceBlock {
  /** 比较用的归一化文本。 */
  normalized: string;
  startLine: number;
  endLine: number;
  /** mdast 顶层节点类型（heading / paragraph / table / list / code …）：配对只能发生在同类型块之间。 */
  nodeType: string;
  /** 链接引用定义（renders nothing）—— 需要复制进每个片段。 */
  isDefinition: boolean;
  /** 脚注定义会生成脚注 section，分片渲染会重复，出现即放弃对齐。 */
  isFootnoteDefinition: boolean;
}

export function buildMarkdownPreviewPlan(
  after: string,
  before: string | null,
): MarkdownPreviewPlan {
  if (before === null) return degrade(after);

  const afterLines = after.split(/\r?\n/);
  const beforeLines = before.split(/\r?\n/);
  const afterBlocks = parseTopLevelBlocks(after, afterLines);
  const beforeBlocks = parseTopLevelBlocks(before, beforeLines);
  if (afterBlocks === null || beforeBlocks === null) return degrade(after);
  // 脚注分片渲染会产生重复的脚注 section，直接放弃对齐（见文件头说明）。
  if (
    afterBlocks.some((block) => block.isFootnoteDefinition) ||
    beforeBlocks.some((block) => block.isFootnoteDefinition)
  ) {
    return degrade(after);
  }

  const appendix = collectDefinitionAppendix(afterLines, afterBlocks);
  const segments = alignBlocks({ afterLines, beforeLines, afterBlocks, beforeBlocks, appendix });
  if (segments === null || segments.length > MARKDOWN_PREVIEW_MAX_SEGMENTS) return degrade(after);

  return {
    segments,
    hasChanges: segments.some((segment) => segment.kind !== 'context'),
    blockAligned: true,
  };
}

function degrade(after: string): MarkdownPreviewPlan {
  return {
    segments: [
      {
        kind: 'context',
        key: 'context-whole',
        content: after,
        startLine: 1,
        endLine: after.split(/\r?\n/).length,
      },
    ],
    hasChanges: false,
    blockAligned: false,
  };
}

function parseTopLevelBlocks(content: string, lines: readonly string[]): SourceBlock[] | null {
  let tree: Root;
  try {
    tree = parser.parse(content) as Root;
  } catch {
    return null;
  }
  const blocks: SourceBlock[] = [];
  for (const node of tree.children as RootContent[]) {
    const startLine = node.position?.start?.line;
    const endLine = node.position?.end?.line;
    if (typeof startLine !== 'number' || typeof endLine !== 'number' || endLine < startLine)
      return null;
    blocks.push({
      normalized: normalizeBlockText(sliceLines(lines, startLine, endLine)),
      startLine,
      endLine,
      nodeType: node.type,
      isDefinition: node.type === 'definition',
      isFootnoteDefinition: node.type === 'footnoteDefinition',
    });
  }
  return blocks;
}

function alignBlocks(input: {
  afterLines: readonly string[];
  beforeLines: readonly string[];
  afterBlocks: readonly SourceBlock[];
  beforeBlocks: readonly SourceBlock[];
  appendix: string;
}): MarkdownPreviewSegment[] | null {
  const { afterLines, beforeLines, afterBlocks, beforeBlocks, appendix } = input;
  const parts = diffArrays(
    beforeBlocks.map((block) => block.normalized),
    afterBlocks.map((block) => block.normalized),
  );

  const segments: MarkdownPreviewSegment[] = [];
  let beforeIndex = 0;
  let afterIndex = 0;
  // 段数上限一旦触顶立即放弃对齐：上限检查必须在逐块词级尝试（diff + 解析 +
  // 校验）之前，否则大而碎的 diff 会先把主线程算完再整单丢弃。
  let overflow = false;
  // 连续的 removed / added part 组成一个改动 run。保留 part 边界（而不是拆成
  // 两个数组），贪心配对才能把「列表块改了 + 后面新增了一个引用块」这种
  // 1:N 的 run 拆成「列表 1:1 词级修订 + 引用块单独处理」。
  let run: RunPart[] = [];

  const flushRun = () => {
    if (run.length === 0 || overflow) return;
    // 上界预检：每块最多产出 2 段（removed + added）。超限就不再进入词级尝试。
    const runBlocks = run.reduce((sum, part) => sum + part.blocks.length, 0);
    if (segments.length + runBlocks * 2 > MARKDOWN_PREVIEW_MAX_SEGMENTS) {
      overflow = true;
      return;
    }
    const built = buildRevisionSegments(run, beforeLines, afterLines, appendix, segments.length);
    if (built === null) {
      overflow = true;
      return;
    }
    segments.push(...built);
    run = [];
  };

  for (const part of parts) {
    if (part.removed) {
      run.push({
        kind: 'removed',
        blocks: beforeBlocks.slice(beforeIndex, beforeIndex + part.count),
      });
      beforeIndex += part.count;
      continue;
    }
    if (part.added) {
      run.push({ kind: 'added', blocks: afterBlocks.slice(afterIndex, afterIndex + part.count) });
      afterIndex += part.count;
      continue;
    }
    flushRun();
    if (overflow) break;
    const contextBlocks = afterBlocks.slice(afterIndex, afterIndex + part.count);
    appendSegment(segments, 'context', contextBlocks, afterLines, appendix);
    if (segments.length > MARKDOWN_PREVIEW_MAX_SEGMENTS) {
      overflow = true;
      break;
    }
    afterIndex += part.count;
    beforeIndex += part.count;
  }
  flushRun();

  if (overflow) return null;
  if (afterIndex !== afterBlocks.length || beforeIndex !== beforeBlocks.length) return null;
  return segments;
}

/** 改动 run 里的一段：removed / added 各自是一个 part，保留 part 边界用于贪心配对。 */
interface RunPart {
  kind: 'removed' | 'added';
  blocks: readonly SourceBlock[];
}

/**
 * 把一段改动 run 折叠成修订/回退段。
 *
 * 配对规则（关键）：**只在同类型块之间配对**（heading↔heading、table↔table、
 * paragraph↔paragraph…），同类型内保持文档顺序、取较少一侧的数量。
 *
 * 为什么不按 run 内位置直接配：removed / added 的数量不等时（例如两侧都有改动、
 * 但中间还删掉了一个标题），位置式配对会从删除点开始整体错位——表格和后面的段落
 * 配成一对，词级 diff 于是产出跨块乱标记与重复内容（实际踩过：`-10 +9` 把表格配到
 * 段落上）。按类型先分组后配对能把这个错位隔离在同类块内。
 *
 * 逐对/逐块独立是刻意的：一个块不能词级不应该把同一 run 里其它能词级的块一起拖回
 * 块级，否则文档里会反复出现两套观感。
 * 返回 null 表示段数超限（调用方走降级），避免继续做昂贵的词级尝试。
 */
function buildRevisionSegments(
  run: readonly RunPart[],
  beforeLines: readonly string[],
  afterLines: readonly string[],
  appendix: string,
  baseIndex: number,
): MarkdownPreviewSegment[] | null {
  const segments: MarkdownPreviewSegment[] = [];
  // key 序号必须走全局计数（baseIndex + 本轮已产出段数）：函数内的 segments 是
  // 每个 run 新建的局部数组，只用局部 length 会让不同 run 撞出重复 key。
  const nextKey = () => baseIndex + segments.length;

  const removedBlocks = run
    .filter((part) => part.kind === 'removed')
    .flatMap((part) => part.blocks);
  const addedBlocks = run.filter((part) => part.kind === 'added').flatMap((part) => part.blocks);

  // 按类型分组后在同类型内位置配对。
  const partnerOf = new Map<SourceBlock, SourceBlock>();
  const pairedAdded = new Set<SourceBlock>();
  const pendingAddedByType = new Map<string, SourceBlock[]>();
  for (const block of addedBlocks) {
    const queue = pendingAddedByType.get(block.nodeType) ?? [];
    queue.push(block);
    pendingAddedByType.set(block.nodeType, queue);
  }
  for (const block of removedBlocks) {
    const partner = pendingAddedByType.get(block.nodeType)?.shift();
    if (!partner) continue;
    partnerOf.set(block, partner);
    pairedAdded.add(partner);
  }

  const pushPair = (removedBlock: SourceBlock, addedBlock: SourceBlock): void => {
    const revision = tryRevisionSegment(
      sliceLines(beforeLines, removedBlock.startLine, removedBlock.endLine),
      sliceLines(afterLines, addedBlock.startLine, addedBlock.endLine),
      addedBlock,
      appendix,
      nextKey(),
    );
    if (revision) {
      segments.push(revision);
      return;
    }
    appendSegment(segments, 'removed', [removedBlock], beforeLines, appendix);
    appendSegment(segments, 'added', [addedBlock], afterLines, appendix);
  };

  // ── 输出顺序：按**新文档顺序**（配对块用 added 侧下标），未配对的删除块用相邻锚点插值。
  // 为什么不用 removed 侧顺序：块在新版里上移 / 下移时（交叉类型 2×2），旧顺序会把修订
  // 内容放在新文档里已经不属于它的位置——预览既然以新版为底，顺序就得跟新版一致
  // （实机目检过：标题上移后旧顺序把标题排在两个段落中间）。
  const addedIndexByBlock = new Map<SourceBlock, number>();
  addedBlocks.forEach((block, index) => addedIndexByBlock.set(block, index));

  const anchorBefore = new Array<number>(removedBlocks.length).fill(-1);
  const anchorAfter = new Array<number>(removedBlocks.length).fill(addedBlocks.length);
  let lastAnchor = -1;
  removedBlocks.forEach((block, index) => {
    anchorBefore[index] = lastAnchor;
    const partner = partnerOf.get(block);
    if (partner) lastAnchor = addedIndexByBlock.get(partner) ?? lastAnchor;
  });
  let nextAnchor = addedBlocks.length;
  for (let index = removedBlocks.length - 1; index >= 0; index -= 1) {
    anchorAfter[index] = nextAnchor;
    const partner = partnerOf.get(removedBlocks[index]);
    if (partner) nextAnchor = addedIndexByBlock.get(partner) ?? nextAnchor;
  }
  const gapTotals = new Map<string, number>();
  const gapSeen = new Map<string, number>();
  const gapOrdinals = new Map<string, number>();
  removedBlocks.forEach((block, index) => {
    if (partnerOf.has(block)) return;
    const gapKey = `${anchorBefore[index]}|${anchorAfter[index]}`;
    gapTotals.set(gapKey, (gapTotals.get(gapKey) ?? 0) + 1);
  });

  type EmitEntry =
    | { key: number; order: number; kind: 'pair'; removed: SourceBlock; added: SourceBlock }
    | { key: number; order: number; kind: 'removed'; block: SourceBlock }
    | { key: number; order: number; kind: 'added'; block: SourceBlock };
  const entries: EmitEntry[] = [];
  let order = 0;
  removedBlocks.forEach((block, index) => {
    const partner = partnerOf.get(block);
    if (partner) {
      entries.push({
        key: addedIndexByBlock.get(partner) ?? 0,
        order: order++,
        kind: 'pair',
        removed: block,
        added: partner,
      });
      return;
    }
    const gapKey = `${anchorBefore[index]}|${anchorAfter[index]}`;
    const seen = (gapSeen.get(gapKey) ?? 0) + 1;
    gapSeen.set(gapKey, seen);
    const total = gapTotals.get(gapKey) ?? 1;
    const from = anchorBefore[index];
    const to = anchorAfter[index];
    // 同一个 gap 内按顺序均分；再减「gap 序号 × 极小量」：不同 gap 的插值网格可能算出同一个
    // 值（撞了就会退化成 removed 顺序），掺入 gap 序号即可避开。
    let ordinal = gapOrdinals.get(gapKey);
    if (ordinal === undefined) {
      ordinal = gapOrdinals.size + 1;
      gapOrdinals.set(gapKey, ordinal);
    }
    const key = from + (to - from) * (seen / (total + 1)) - 1e-6 * ordinal;
    entries.push({ key, order: order++, kind: 'removed', block });
  });
  for (const block of addedBlocks) {
    if (pairedAdded.has(block)) continue;
    entries.push({ key: addedIndexByBlock.get(block) ?? 0, order: order++, kind: 'added', block });
  }
  entries.sort((left, right) => left.key - right.key || left.order - right.order);

  for (const entry of entries) {
    if (entry.kind === 'pair') pushPair(entry.removed, entry.added);
    else if (entry.kind === 'removed') {
      pushSingleBlock(segments, 'removed', entry.block, beforeLines, appendix, nextKey());
    } else {
      pushSingleBlock(segments, 'added', entry.block, afterLines, appendix, nextKey());
    }
    if (segments.length > MARKDOWN_PREVIEW_MAX_SEGMENTS) return null;
  }
  return segments;
}

/** 单块处理：先试整块插入 / 删除标记，失败退回块级装饰。 */
function pushSingleBlock(
  segments: MarkdownPreviewSegment[],
  kind: 'removed' | 'added',
  block: SourceBlock,
  lines: readonly string[],
  appendix: string,
  sequence: number,
): void {
  const text = sliceLines(lines, block.startLine, block.endLine);
  const revision =
    kind === 'added'
      ? tryRevisionSegment('', text, block, appendix, sequence)
      : tryRevisionSegment(text, '', block, appendix, sequence);
  if (revision) segments.push(revision);
  else appendSegment(segments, kind, [block], lines, appendix);
}

/**
 * 单块修订尝试：成功返回 revision 段，失败返回 null（调用方退回块级装饰）。
 * key 用调用方的段序号而不是行号：纯删除块用 before 行号、新增/配对块用 after
 * 行号，两套计数器独立时会撞出重复 key（如 before=[P1,Q2] + after=[A1,S2]）。
 */
function tryRevisionSegment(
  before: string,
  after: string,
  anchor: SourceBlock,
  appendix: string,
  sequence: number,
): MarkdownPreviewSegment | null {
  // 表格块 → 含公式块 → 通用词级，逐级尝试；每个都能返回 null 表示「这个块不归我管」。
  const revision =
    buildMarkdownTableRevision(before, after) ??
    buildMarkdownMathRevision(before, after) ??
    buildMarkdownRevision(before, after);
  if (revision === null) return null;
  return {
    kind: 'revision',
    key: `revision-${sequence}`,
    content: appendix ? `${revision}\n\n${appendix}` : revision,
    startLine: anchor.startLine,
    endLine: anchor.endLine,
  };
}

/**
 * 把一组连续块合成一个片段。内容取块范围之间的完整源码（含块间空行），
 * 并追加 after 侧全部链接引用定义，保证任何片段里的引用式链接都能解析。
 */
function appendSegment(
  segments: MarkdownPreviewSegment[],
  kind: MarkdownPreviewSegmentKind,
  blocks: readonly SourceBlock[],
  lines: readonly string[],
  appendix: string,
): void {
  if (blocks.length === 0) return;
  const startLine = blocks[0].startLine;
  const endLine = blocks[blocks.length - 1].endLine;
  const body = sliceLines(lines, startLine, endLine);
  segments.push({
    kind,
    key: `${kind}-${startLine}-${endLine}-${segments.length}`,
    content: appendix ? `${body}\n\n${appendix}` : body,
    startLine,
    endLine,
  });
}

function collectDefinitionAppendix(
  lines: readonly string[],
  blocks: readonly SourceBlock[],
): string {
  return blocks
    .filter((block) => block.isDefinition)
    .map((block) => sliceLines(lines, block.startLine, block.endLine))
    .join('\n\n');
}

function sliceLines(lines: readonly string[], startLine: number, endLine: number): string {
  return lines.slice(startLine - 1, endLine).join('\n');
}

function normalizeBlockText(text: string): string {
  return text
    .replace(/\r$/, '')
    .split('\n')
    .map((line) => line.replace(/\s+$/, ''))
    .join('\n')
    .replace(/^\n+/, '')
    .replace(/\n+$/, '');
}
