/**
 * markdownTableRevision — 表格块的「结构级」修订注入。
 *
 * 表格和普通段落不一样：源码里的 `|` 既是内容分隔符又是结构符。通用词级注入
 * （在整块文本上 `diffWordsWithSpace`）很容易把标记跨到 `|` 两侧 —— 要么产出非法
 * 表格被校验拦下，要么整张表退回块级装饰，结果是「整表一条删除线 + 整表一条
 * 下划线」，看不出改在哪一行、哪一格。
 *
 * 这里按 Word 修订的语义做结构级处理：
 *  - 行对齐（`diffArrays`，key 为归一化行文本）：整行新增 / 删除只标记该行、
 *    其余行原样保留（行不消失，与 Word 一致）；
 *  - 相邻的 removed + added 行按顺序配对，配对行逐单元格做词级 diff，标记只
 *    出现在单元格内部，绝不跨 `|`；
 *  - 单元格内容含 `{` / `}` 时该格跳过标记（CriticMarkup 语法吃不了花括号，
 *    表格里常见于 `\frac{1}{2}` 这类公式），其余单元格不受影响；
 *  - 表头列数变化时直接放弃（返回 null），交给调用方的块级装饰回退。
 *
 * 单元格内容可能是「文本 + 公式」混排：整格增删 / 格内改写都交给 markdownMathRevision
 * 的分段注入 —— 文本段挂 CriticMarkup，公式段在公式内部加下划线 / 删除线，这样含公式
 * 的单元格也能跟整行一起带线（公式里的花括号不再导致整格跳过标记）。
 */

import { diffArrays } from 'diff';

import {
  hasUnconsumedReviewMarks,
  remarkReviewAnnotations,
} from '@/components/chat/remarkReviewAnnotations';

import { markInlineWhole, mathMarksAreIntact, reviseInlineMixed } from './markdownMathRevision';
import { parseRevisionTree, REVISION_MAX_SOURCE_CHARS } from './markdownRevision';

/** 整行标记 / 单元格标记的语义。 */
type MarkKind = 'insert' | 'delete';

/** GFM 对齐行：`| --- | :---: |` 这类。 */
const ALIGN_ROW_PATTERN = /^\s*\|?[\s:|-]+\|[\s:|-]*$/;

interface TableSource {
  header: string[];
  align: string;
  rows: string[][];
}

/** mdast table 的最小形状（GFM 类型的细节在这里用不到）。 */
interface TableShape {
  type: string;
  align?: readonly (string | null)[] | null;
  children: unknown[];
}

/** 行对齐用的 key：统一成 `a | b` 形态，忽略首尾 `|` 与多余空格。 */
function rowKey(cells: readonly string[]): string {
  return cells.join(' | ');
}

/**
 * 把表格源码切成 表头 / 对齐行 / 数据行。非表格、列数不一致或形状可疑时返回 null。
 * 对齐行必须存在（否则 mdast 不会把它解析成 table），列数必须与表头一致（GFM 会把
 * 多出来的单元格丢掉，重建时保持原样会静默改内容）。
 */
function parseTableSource(source: string): TableSource | null {
  const lines = source
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .filter((line) => line.trim().length > 0);
  if (lines.length < 2) return null;
  const [headerLine, alignLine, ...dataLines] = lines;
  if (!headerLine.includes('|') || !ALIGN_ROW_PATTERN.test(alignLine)) return null;
  const header = splitRow(headerLine);
  if (!header || header.length === 0) return null;
  const alignCells = splitRow(alignLine);
  if (!alignCells || alignCells.length !== header.length) return null;
  const rows: string[][] = [];
  for (const line of dataLines) {
    const cells = splitRow(line);
    if (!cells || cells.length !== header.length) return null;
    rows.push(cells);
  }
  return { header, align: alignLine.trim(), rows };
}

/** 按未转义的 `|` 切分一行；`\|` 还原成 `|` 字符（重建时再转义回去）。 */
/**
 * 拆表格行。反斜杠按**奇偶**处理（GFM 转义规则）：连续反斜杠个数为奇数时，最后一个
 * 才转义管道（`\|` 是字面管道，留在单元格里）；为偶数时反斜杠只是字面反斜杠，后面的
 * `|` 仍然是列分隔符（`\\|` → 两格）。旧实现见到 `\` 紧跟 `|` 就当成转义，会把
 * `\\|` 这种合法输入少拆出一列，而表格校验只比行数 / 列数，静默改写就漏过去了。
 */
function splitRow(line: string): string[] | null {
  const trimmed = line.trim();
  if (!trimmed.includes('|')) return null;
  const withoutLeading = trimmed.startsWith('|') ? trimmed.slice(1) : trimmed;
  const body = withoutLeading.endsWith('|') ? withoutLeading.slice(0, -1) : withoutLeading;
  const cells: string[] = [];
  let current = '';
  for (let i = 0; i < body.length; i += 1) {
    const char = body[i];
    if (char === '\\') {
      let run = 0;
      while (body[i + run] === '\\') run += 1;
      current += body.slice(i, i + run);
      i += run - 1;
      // 奇数个反斜杠转义了紧跟的管道：收进当前格，不当分隔符（原文保留，
      // serializeCell 会按同样的奇偶规则判断是否还要加转义）。
      if (run % 2 === 1 && body[i + 1] === '|') {
        current += '|';
        i += 1;
      }
      continue;
    }
    if (char === '|') {
      cells.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }
  cells.push(current.trim());
  return cells;
}

/**
 * 重建单元格源码：只转义**未转义**的 `|`（同样按反斜杠奇偶判定），否则
 * 原本就是 `\|` 的内容会被再加一层变成 `\\|` —— 那反而把字面管道变回了列分隔符。
 */
function serializeCell(cell: string): string {
  let out = '';
  for (const char of cell) {
    if (char !== '|') {
      out += char;
      continue;
    }
    let run = 0;
    for (let index = out.length - 1; index >= 0 && out[index] === '\\'; index -= 1) run += 1;
    out += run % 2 === 0 ? '\\|' : '|';
  }
  return out;
}

/**
 * 整格标记（新增 / 删除）：文本段挂 CriticMarkup，公式段在公式内部加线。
 * 空内容没有可标记的字符，保持原样。
 */
function markRevision(text: string, kind: MarkKind): string {
  const trimmed = text.trim();
  if (trimmed.length === 0) return trimmed;
  return markInlineWhole(trimmed, kind);
}

/**
 * 单元格内的词级修订。返回 null 表示这一格放弃词级（调用方改用新版本原文）。
 * 公式段的差异由 markdownMathRevision 在公式内部表达。
 */
function reviseCell(before: string, after: string): string | null {
  if (before === after) return after;
  return reviseInlineMixed(before, after);
}

/** 配对的两行逐格词级；列数以新版本为准（列数变化已在解析阶段挡掉）。 */
function mergeRowPair(before: readonly string[], after: readonly string[]): string[] {
  return after.map((cell, index) => reviseCell(before[index] ?? '', cell) ?? cell);
}

/**
 * 数据行对齐与标记：equal 行原样输出，removed / added run 贪心配对，配不上的
 * 整行标记。输出顺序与文档顺序一致（run 在遇到 equal 段时冲刷）。
 */
function buildRowRevision(
  beforeRows: readonly string[][],
  afterRows: readonly string[][],
): string[][] {
  const parts = diffArrays(
    beforeRows.map((row) => rowKey(row)),
    afterRows.map((row) => rowKey(row)),
  );
  const out: string[][] = [];
  const pending: { kind: 'removed' | 'added'; rows: string[][] }[] = [];
  let beforeIndex = 0;
  let afterIndex = 0;

  const flush = () => {
    while (pending.length > 0) {
      const current = pending[0];
      const next = pending[1];
      if (current.kind === 'removed' && next?.kind === 'added') {
        const pairCount = Math.min(current.rows.length, next.rows.length);
        for (let i = 0; i < pairCount; i += 1) {
          out.push(mergeRowPair(current.rows[i], next.rows[i]));
        }
        for (let i = pairCount; i < current.rows.length; i += 1) {
          out.push(current.rows[i].map((cell) => markRevision(cell, 'delete')));
        }
        for (let i = pairCount; i < next.rows.length; i += 1) {
          out.push(next.rows[i].map((cell) => markRevision(cell, 'insert')));
        }
        pending.splice(0, 2);
        continue;
      }
      const kind: MarkKind = current.kind === 'added' ? 'insert' : 'delete';
      for (const row of current.rows) {
        out.push(row.map((cell) => markRevision(cell, kind)));
      }
      pending.shift();
    }
  };

  for (const part of parts) {
    if (part.removed) {
      pending.push({
        kind: 'removed',
        rows: beforeRows.slice(beforeIndex, beforeIndex + part.count),
      });
      beforeIndex += part.count;
      continue;
    }
    if (part.added) {
      pending.push({
        kind: 'added',
        rows: afterRows.slice(afterIndex, afterIndex + part.count),
      });
      afterIndex += part.count;
      continue;
    }
    flush();
    for (let i = 0; i < part.count; i += 1) out.push(afterRows[afterIndex + i]);
    afterIndex += part.count;
    beforeIndex += part.count;
  }
  flush();
  return out;
}

/**
 * 结构自检：注入结果必须仍是**单张**表格、插件跑完后无标记残留，行数等于预期
 * 输出行数（表头 + 数据行），列数与参照版本一致。
 *
 * 行数**不能**拿参照版本比：整行删除的行会保留在输出里（与 Word 一致），
 * 行数本来就会多于新版本。
 */
function validateTableRevision(
  injected: string,
  reference: string,
  expectedDataRowCount: number,
  referenceIsAfter: boolean,
): boolean {
  const injectedTree = parseRevisionTree(injected);
  if (!injectedTree || injectedTree.children.length !== 1) return false;
  const injectedTable = injectedTree.children[0] as unknown as TableShape;
  if (injectedTable.type !== 'table') return false;
  if (injectedTable.children.length !== expectedDataRowCount + 1) return false;
  remarkReviewAnnotations()(injectedTree);
  if (hasUnconsumedReviewMarks(injectedTree)) return false;
  // 与段落路径同源的标记守卫：单元格里的公式被 remarkStrictInlineMath 降级回字面文本时
  // （如 `$5和$10` → 注入后闭合 `$` 紧跟数字），哨兵 LaTeX 会直接显示给用户，而单表/行数/
  // 列数/残留标记这些结构检查全部看不出问题。
  if (!mathMarksAreIntact(injected, injectedTree)) return false;

  const referenceTree = parseRevisionTree(reference);
  if (!referenceTree || referenceTree.children.length !== 1) return false;
  const referenceTable = referenceTree.children[0] as unknown as TableShape;
  if (referenceTable.type !== 'table') return false;
  if ((injectedTable.align?.length ?? 0) !== (referenceTable.align?.length ?? 0)) return false;
  // 逐格**内容**比对（不只行列形状，Greptile P1）：静默改写（转义误判导致合并/拆分
  // 单元格之类）在形状上看不出来，这里能拓住。注意校验链的树已经过 remarkReviewAnnotations
  // 折叠——标记不是字面 `{-- --}`，而是带 `data.hProperties.className` 的 del / ins 容器，
  // 所以按容器类取“属于某一侧”的文本，而不是做字面标记替换；同时区分参考侧是 after
  // 还是 before（整表删除时参考是 before）。
  const signature = (cells: string[]) => [...cells].sort().join('\u0000');
  const referenceCells = allCells(referenceTable);
  if (referenceIsAfter) {
    const injectedCells = afterSideCells(injectedTable);
    if (injectedCells.length !== referenceCells.length) return false;
    return signature(injectedCells) === signature(referenceCells);
  }
  // 整表删除：不应再有“新版”格子，被删内容必须与 before 侧逐格一致。
  if (afterSideCells(injectedTable).length !== 0) return false;
  const deletedCells = deletedSideCells(injectedTable);
  if (deletedCells.length !== referenceCells.length) return false;
  return signature(deletedCells) === signature(referenceCells);
}

/**
 * 把注入的公式修订包装按“某一侧”还原（公式级标记没有 `{-- --}` 容器，必须单独处理）：
 * `\textcolor{currentColor}{\sout{X}}` 只属于删除侧、`\textcolor{inherit}{\underline{Y}}`
 * 只属于新增侧（按花括号配对取内容，公式里嵌套的花括号不会被截断）。
 */
export function mathMarksToSide(text: string, side: 'after' | 'deleted'): string {
  let out = text;
  for (const [keyword, command, markSide] of [
    ['currentColor', 'sout', 'deleted'],
    ['inherit', 'underline', 'after'],
  ] as const) {
    const head = `\\textcolor{${keyword}}{\\${command}{`;
    let index = out.indexOf(head);
    while (index !== -1) {
      const bodyStart = index + head.length;
      let depth = 1;
      let cursor = bodyStart;
      while (cursor < out.length && depth > 0) {
        const char = out[cursor];
        // 跳过 LaTeX 转义序列：`\{` / `\}` 是**字面**花括号，不参与配对（否则 `$\{$`
        // 这类合法公式会把深度算错，包装剥不干净 → 内容校验不过 → 整表退回块级装饰）。
        // `\\` 同样只跳一格：第一个反斜杠转义第二个，后面假设的 `{` 仍正常计数。
        if (char === '\\') {
          cursor += 2;
          continue;
        }
        if (char === '{') depth += 1;
        else if (char === '}') {
          depth -= 1;
          if (depth === 0) break;
        }
        cursor += 1;
      }
      if (depth !== 0) break; // 不闭合：保持原样，交给标记守卫判定
      const inner = side === markSide ? out.slice(bodyStart, cursor) : '';
      out = out.slice(0, index) + inner + out.slice(cursor + 2);
      index = out.indexOf(head);
    }
  }
  return out;
}

/** 表内每个单元格的纯文本（参考侧是原文，无标记）。 */
function allCells(table: TableShape): string[] {
  const cells: string[] = [];
  for (const row of table.children as { type?: string; children?: unknown[] }[]) {
    if (row?.type !== 'tableRow' || !Array.isArray(row.children)) continue;
    cells.push(...row.children.map((cell) => nodeText(cell).trim()));
  }
  return cells;
}

/** 该节点是不是修订容器（remarkReviewAnnotations 折叠后的 del / ins 包装）。 */
function reviewContainerClass(node: unknown): 'del' | 'ins' | null {
  const className = (node as { data?: { hProperties?: { className?: unknown } } }).data?.hProperties
    ?.className;
  if (!Array.isArray(className)) return null;
  if (className.includes('cindy-md-diff-del')) return 'del';
  if (className.includes('cindy-md-diff-ins')) return 'ins';
  return null;
}

/**
 * 取节点里属于某一侧的文本：after = 跳过删除容器（只看新版），deleted = 只收删除容器里的文字。
 */
function sideText(node: unknown, side: 'after' | 'deleted'): string {
  const container = reviewContainerClass(node);
  if (container === 'del') return side === 'deleted' ? nodeText(node) : '';
  if (container === 'ins') return side === 'after' ? nodeText(node) : '';
  const children = (node as { children?: unknown[] }).children;
  if (!Array.isArray(children)) return nodeText(node);
  return children.map((child) => sideText(child, side)).join('');
}

/** 注入表里属于“新版”的格子（整行删除的行跳过，公式标记也算删除）。 */
function afterSideCells(table: TableShape): string[] {
  const cells: string[] = [];
  for (const row of table.children as { type?: string; children?: unknown[] }[]) {
    if (row?.type !== 'tableRow' || !Array.isArray(row.children)) continue;
    const texts = row.children.map((cell) =>
      mathMarksToSide(sideText(cell, 'after'), 'after').trim(),
    );
    if (texts.length > 0 && texts.every((text) => text === '')) continue;
    cells.push(...texts);
  }
  return cells;
}

/** 被删内容的格子（含公式内部的删除标记）。 */
function deletedSideCells(table: TableShape): string[] {
  const cells: string[] = [];
  for (const row of table.children as { type?: string; children?: unknown[] }[]) {
    if (row?.type !== 'tableRow' || !Array.isArray(row.children)) continue;
    for (const cell of row.children) {
      const text = mathMarksToSide(sideText(cell, 'deleted'), 'deleted').trim();
      if (text !== '') cells.push(text);
    }
  }
  return cells;
}

/** 节点纯文本（mdast 内容 → 字符串）。 */
function nodeText(node: unknown): string {
  const value = (node as { value?: unknown }).value;
  if (typeof value === 'string') return value;
  const children = (node as { children?: unknown[] }).children;
  if (!Array.isArray(children)) return '';
  return children.map((child) => nodeText(child)).join('');
}

/**
 * 生成表格块的结构级修订源码。返回 null 表示这一对块不适合表格路径
 * （不是表格、列数变了、或校验不过），调用方应回退到通用词级 / 块级装饰。
 */
export function buildMarkdownTableRevision(before: string, after: string): string | null {
  const hasBefore = before.trim().length > 0;
  const hasAfter = after.trim().length > 0;
  if (!hasBefore && !hasAfter) return null;
  if (before.length + after.length > REVISION_MAX_SOURCE_CHARS) return null;

  const beforeTable = hasBefore ? parseTableSource(before) : null;
  const afterTable = hasAfter ? parseTableSource(after) : null;
  if (hasBefore && !beforeTable) return null;
  if (hasAfter && !afterTable) return null;
  if (!beforeTable && !afterTable) return null;

  let header: string[];
  let align: string;
  let rows: string[][];
  if (beforeTable && afterTable) {
    if (beforeTable.header.length !== afterTable.header.length) return null;
    header = afterTable.header.map(
      (cell, index) => reviseCell(beforeTable.header[index] ?? '', cell) ?? cell,
    );
    align = afterTable.align;
    rows = buildRowRevision(beforeTable.rows, afterTable.rows);
  } else if (afterTable) {
    // 纯新增表格：表头连同数据行一起标记。
    header = afterTable.header.map((cell) => markRevision(cell, 'insert'));
    align = afterTable.align;
    rows = afterTable.rows.map((row) => row.map((cell) => markRevision(cell, 'insert')));
  } else {
    header = beforeTable!.header.map((cell) => markRevision(cell, 'delete'));
    align = beforeTable!.align;
    rows = beforeTable!.rows.map((row) => row.map((cell) => markRevision(cell, 'delete')));
  }

  const injected = [
    `| ${header.map(serializeCell).join(' | ')} |`,
    align,
    ...rows.map((row) => `| ${row.map(serializeCell).join(' | ')} |`),
  ].join('\n');

  const reference = afterTable ? after : before;
  return validateTableRevision(injected, reference, rows.length, afterTable !== null) ? injected : null;
}
