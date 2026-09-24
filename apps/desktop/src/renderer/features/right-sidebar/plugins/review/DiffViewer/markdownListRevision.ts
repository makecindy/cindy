/**
 * markdownListRevision — 有序 / 无序列表的**逐项**修订。
 *
 * 背景（2026-09-21，用户实机反馈）：列表在块对齐里是**一个**顶层 mdast 块，所以
 * 「追加一项」原本会走通用词级注入 —— 标记跨行会破坏列表结构、校验不过，于是整块
 * 回退成「旧列表整体删除 + 新列表整体新增」，什么都看不出来。这里补一条列表项级
 * 路径，与表格路径同构：
 *
 *  - 双侧都是列表且有序性一致才接手；
 *  - 按**项**切分（mdast `listItem` 的源码行范围），用 `diffArrays` 对齐项正文：
 *    未改项原样保留（作为 context）、纯新增项整项 `{++…++}`、纯删除项整项 `{--…--}`、
 *    改动项先尝试公式级 / 词级修订，失败才拆成「旧项删除 + 新项新增」；
 *  - 标记只包**项正文**（`- ` 前缀保持干净），否则列表标记本身也会被划掉；
 *  - 校验镜像表格路径：重新解析后仍是一个列表、项数 = after 侧项数 + 纯删除项数、
 *    无残留标记、公式标记完好，且**逐项内容比对**（去掉删除标记、展开新增标记后
 *    必须与 after 侧逐项一致）。
 *
 * 明确不接手的形态（一律返回 null，交回块级装饰，宁可少标不可标错）：
 *  - 任务列表（复选框在项首，整项标记会拆坏 `- [x]`；用户要求本期先不动）；
 *  - 多行项、含子列表（嵌套）的项；
 *  - 有序 / 无序互相转换、或者任一侧不是单一列表。
 */

import { diffArrays } from 'diff';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import remarkParse from 'remark-parse';
import { unified } from 'unified';

import {
  hasUnconsumedReviewMarks,
  remarkReviewAnnotations,
} from '@/components/chat/remarkReviewAnnotations';

import { buildMarkdownMathRevision, mathMarksAreIntact } from './markdownMathRevision';
import { buildMarkdownRevision, parseRevisionTree, REVISION_MAX_SOURCE_CHARS } from './markdownRevision';
import { mathMarksToSide } from './markdownTableRevision';

const parser = unified().use(remarkParse).use(remarkGfm).use(remarkMath);

/** 列表项拆成「标记前缀」+「正文」：标记只包正文，避免划掉列表符号本身。 */
interface ListItemSource {
  prefix: string;
  body: string;
  /** 本项与下一项之间的原文（含空行）——loose list 的结构就靠它保留。 */
  gapAfter: string;
}

interface ParsedList {
  ordered: boolean;
  /** loose list：项之间（或项内）有空行。 */
  loose: boolean;
  items: ListItemSource[];
}

function parseList(source: string): ParsedList | null {
  if (source.length > REVISION_MAX_SOURCE_CHARS) return null;
  let tree: { children?: unknown[] };
  try {
    tree = parser.parse(source) as unknown as { children?: unknown[] };
  } catch {
    return null;
  }
  const children = tree.children ?? [];
  if (children.length !== 1) return null;
  const list = children[0] as {
    type?: string;
    ordered?: boolean;
    children?: unknown[];
  };
  if (list.type !== 'list' || !Array.isArray(list.children)) return null;
  // loose list（项间有空行）本期不接手：mdast 会把尾随空行算进项的源码行范围，逐项重建
  // 容易把 loose 静默压成 tight（结构与间距变化），所以一律交回块级装饰（宁可少标不可标错）。
  if ((list as { spread?: boolean }).spread === true) return null;
  const lines = source.split(/\r?\n/);
  const items: ListItemSource[] = [];
  const loose = (list as { spread?: boolean }).spread === true;  const rawItems = list.children;
  for (let index = 0; index < rawItems.length; index += 1) {
    const rawItem = rawItems[index];
    const item = rawItem as {
      type?: string;
      checked?: boolean | null;
      position?: { start?: { line?: number }; end?: { line?: number } };
      children?: { type?: string }[];
    };
    if (item.type !== 'listItem') return null;
    const start = item.position?.start?.line;
    const end = item.position?.end?.line;
    if (typeof start !== 'number' || typeof end !== 'number') return null;
    // 多行项、任务项、含子列表的项：本期不接手（见文件头）。
    if (end !== start) return null;
    if (item.checked === true || item.checked === false) return null;
    if ((item.children ?? []).some((child) => child.type === 'list')) return null;
    const match = /^(\s*(?:[-*+]|\d{1,9}[.)])\s+)([\s\S]*)$/.exec(lines[start - 1] ?? '');
    if (!match) return null;
    // 项间原文（含空行）：用 after 侧的分隔重建，loose / tight 结构才不会静默变化。
    const nextStart = (rawItems[index + 1] as { position?: { start?: { line?: number } } } | undefined)
      ?.position?.start?.line;
    const gapAfter =
      typeof nextStart === 'number' && nextStart > end
        ? `\n${lines.slice(end, nextStart - 1).join('\n')}`
        : '';
    items.push({ prefix: match[1], body: match[2], gapAfter });
  }
  if (items.length === 0) return null;
  return { ordered: list.ordered === true, loose, items };
}

/** 项正文的「新版侧」文本：去掉删除标记与公式删除包装、展开新增标记（校验用）。 */
function afterSideBody(body: string): string {
  return mathMarksToSide(body, 'after')
    .replace(/\{--[\s\S]*?--\}/g, '')
    .replace(/\{\+\+([\s\S]*?)\+\+\}/g, '$1')
    .trim();
}

/**
 * 生成列表的逐项修订源码。返回 null 表示这一对块不走列表路径
 * （非列表、形态不受支持、或校验不过），调用方回退到公式级 / 通用词级 / 块级装饰。
 */
export function buildMarkdownListRevision(before: string, after: string): string | null {
  const beforeList = parseList(before);
  const afterList = parseList(after);
  if (!beforeList || !afterList) return null;
  if (beforeList.ordered !== afterList.ordered) return null;

  const parts = diffArrays(
    beforeList.items.map((item) => item.body),
    afterList.items.map((item) => item.body),
  );

  const out: string[] = [];
  let beforeIndex = 0;
  let afterIndex = 0;
  let removedOnly = 0;
  let cursor = 0;
  // `diffArrays` 把「改动的项」拆成**相邻的两个 part**（先 removed 后 added），所以这里
  // 前瞻合并它们再配对：只看单个 part 会把改动项误当成「整项删除 + 整项新增」。
  while (cursor < parts.length) {
    const part = parts[cursor];
    const next = parts[cursor + 1];
    const count = part.count ?? 0;
    if (!part.added && !part.removed) {
      for (let index = 0; index < count; index += 1) {
        const item = afterList.items[afterIndex];
        if (!item) return null;
        out.push(item.prefix + item.body + item.gapAfter);
        afterIndex += 1;
        beforeIndex += 1;
      }
      cursor += 1;
      continue;
    }
    const isRemovedFirst = Boolean(part.removed) && Boolean(next?.added);
    const isAddedFirst = Boolean(part.added) && Boolean(next?.removed);
    let beforeSlice: ListItemSource[] = [];
    let afterSlice: ListItemSource[] = [];
    if (isRemovedFirst || isAddedFirst) {
      const removedPart = isRemovedFirst ? part : (next as typeof part);
      const addedPart = isRemovedFirst ? (next as typeof part) : part;
      beforeSlice = beforeList.items.slice(beforeIndex, beforeIndex + (removedPart.count ?? 0));
      afterSlice = afterList.items.slice(afterIndex, afterIndex + (addedPart.count ?? 0));
      beforeIndex += removedPart.count ?? 0;
      afterIndex += addedPart.count ?? 0;
      cursor += 2;
    } else if (part.removed) {
      beforeSlice = beforeList.items.slice(beforeIndex, beforeIndex + count);
      beforeIndex += count;
      cursor += 1;
    } else {
      afterSlice = afterList.items.slice(afterIndex, afterIndex + count);
      afterIndex += count;
      cursor += 1;
    }
    // 位置配对：同位置那一对先试词级 / 公式级，配不上的整项加标记。
    const paired = Math.min(beforeSlice.length, afterSlice.length);
    for (let index = 0; index < paired; index += 1) {
      const oldItem = beforeSlice[index];
      const newItem = afterSlice[index];
      const revised =
        buildMarkdownMathRevision(oldItem.body, newItem.body) ??
        buildMarkdownRevision(oldItem.body, newItem.body);
      if (revised !== null) {
        out.push(newItem.prefix + revised + newItem.gapAfter);
        continue;
      }
      out.push(newItem.prefix + `{--${oldItem.body}--}`);
      out.push(newItem.prefix + `{++${newItem.body}++}` + newItem.gapAfter);
      removedOnly += 1;
    }
    for (const extraOld of beforeSlice.slice(paired)) {
      out.push(extraOld.prefix + `{--${extraOld.body}--}` + extraOld.gapAfter);
      removedOnly += 1;
    }
    for (const extraNew of afterSlice.slice(paired)) {
      out.push(extraNew.prefix + `{++${extraNew.body}++}` + extraNew.gapAfter);
    }
  }
  if (beforeIndex !== beforeList.items.length || afterIndex !== afterList.items.length) return null;

  // 项间分隔已随各项带入（gapAfter），所以这里直接拼接：`join('\n')` 会把
  // loose list（项间空行）压成 tight list，预览的结构与间距就静默变了。
  const injected = out.join('');
  if (!injected) return null;
  return validateListRevision(injected, afterList, removedOnly) ? injected : null;
}

/**
 * 列表路径的校验（与表格路径同源思路）：结构、项数、标记残留、公式标记完好，
 * 以及**逐项内容比对** —— 静默改写（吞项、改字）在这里被抓住。
 */
function validateListRevision(
  injected: string,
  afterList: ParsedList,
  removedOnly: number,
): boolean {
  const injectedList = parseList(injected);
  if (!injectedList) return false;
  if (injectedList.ordered !== afterList.ordered) return false;
  // 结构与间距也要一致：loose / tight 不能静默互换。
  if (injectedList.loose !== afterList.loose) return false;
  if (injectedList.items.length !== afterList.items.length + removedOnly) return false;

  const tree = parseRevisionTree(injected);
  if (!tree) return false;
  remarkReviewAnnotations()(tree);
  if (hasUnconsumedReviewMarks(tree)) return false;
  if (!mathMarksAreIntact(injected, tree)) return false;

  // 属于「新版」的项（纯删除项在新版侧为空）必须与 after 侧逐项一致，顺序也要一致。
  const survivors = injectedList.items
    .map((item) => afterSideBody(item.body))
    .filter((body) => body !== '');
  const expected = afterList.items.map((item) => item.body.trim());
  if (survivors.length !== expected.length) return false;
  return survivors.every((body, index) => body === expected[index]);
}
