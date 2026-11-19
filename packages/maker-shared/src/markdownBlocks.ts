/** Shared physical Markdown block boundaries for Mobile and math preprocessing. */
interface MarkdownTableBlock {
  header: string[];
  rows: Array<{ lineIndex: number; cells: string[] }>;
  endIndex: number;
}


export const COMPLETE_MARKDOWN_HTML_TAG_LINE = /^ {0,3}(?:<[A-Za-z][A-Za-z0-9-]*(?:[ \t]+[A-Za-z_:][A-Za-z0-9_.:-]*(?:[ \t]*=[ \t]*(?:[^ \t"'=<>`]+|'[^']*'|"[^"]*"))?)*[ \t]*\/?>|<\/[A-Za-z][A-Za-z0-9-]*[ \t]*>)[ \t]*$/;

export const MARKDOWN_BLOCK_HTML_LINE = /^ {0,3}<\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hgroup|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|pre|script|search|section|summary|style|table|tbody|td|tfoot|th|thead|title|tr|track|textarea|ul)(?=[\s/>])/i;

export function markdownRawHtmlEnd(line: string): RegExp | null {
  if (/^ {0,3}(?:<![A-Z]|<\?|<!\[CDATA\[)/.test(line)) {
    return line.trimStart().startsWith('<?') ? /\?>/
      : line.trimStart().startsWith('<![CDATA[') ? /\]\]>/ : />/;
  }
  const tag = /^ {0,3}<(script|pre|style|textarea)(?=[\s>])/i.exec(line);
  return tag ? new RegExp(`</${tag[1]}\\s*>`, 'i') : null;
}

export function advanceMarkdownHtmlCommentState(line: string, inComment: boolean): boolean {
  const scan = line.replace(/`[^`]*`/g, span => ' '.repeat(span.length));
  let pos = 0;
  let state = inComment;
  while (pos < scan.length) {
    if (state) {
      const close = scan.indexOf('-->', pos);
      if (close === -1) return true;
      state = false;
      pos = close + 3;
    } else {
      const open = scan.indexOf('<!--', pos);
      if (open === -1) return false;
      state = true;
      pos = open + 4;
    }
  }
  return state;
}


export function parseMarkdownTableBlock(lines: readonly string[], index: number): MarkdownTableBlock | null {
  const header = parseTableRow(lines[index]);
  if (!isTableDataRow(lines[index]) || header.length < 2) return null;

  if (isTableSeparator(lines[index + 1] ?? '')) {
    const rows: MarkdownTableBlock['rows'] = [];
    let rowIndex = index + 2;
    while (rowIndex < lines.length && isTableDataRow(lines[rowIndex])) {
      rows.push({
        lineIndex: rowIndex,
        cells: parseTableRow(lines[rowIndex]),
      });
      rowIndex += 1;
    }
    return {
      header,
      rows,
      endIndex: rowIndex - 1,
    };
  }

  return parseLooseTableBlock(lines, index, header);
}

function parseLooseTableBlock(
  lines: readonly string[],
  index: number,
  header: string[],
): MarkdownTableBlock | null {
  if (!isLooseTableDataRow(lines[index])) return null;
  const columnCount = header.length;
  const rows: MarkdownTableBlock['rows'] = [];
  let rowIndex = index + 1;
  while (rowIndex < lines.length && isLooseTableDataRow(lines[rowIndex])) {
    const cells = parseTableRow(lines[rowIndex]);
    if (cells.length !== columnCount) break;
    rows.push({
      lineIndex: rowIndex,
      cells,
    });
    rowIndex += 1;
  }
  if (rows.length === 0) return null;
  return {
    header,
    rows,
    endIndex: rowIndex - 1,
  };
}

function isTableDataRow(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.includes('|') && !isTableSeparator(trimmed);
}

function isLooseTableDataRow(line: string): boolean {
  const cells = parseTableRow(line);
  return isTableDataRow(line) && cells.length >= 2 && cells.every((cell) => cell.length > 0);
}

function isTableSeparator(line: string): boolean {
  const cells = parseTableRow(line);
  if (cells.length < 2) return false;
  return cells.every((cell) => /^:?-{3,}:?$/.test(cell.trim()));
}

function parseTableRow(line: string): string[] {
  let trimmed = line.trim();
  if (trimmed.startsWith('|')) trimmed = trimmed.slice(1);
  if (endsWithUnescapedPipe(trimmed)) trimmed = trimmed.slice(0, -1);
  const cells: string[] = [];
  let cell = '';
  for (let index = 0; index < trimmed.length; index++) {
    const char = trimmed[index];
    if (char === '\\' && trimmed[index + 1] === '|') {
      cell += '|';
      index += 1;
      continue;
    }
    if (char === '|') {
      cells.push(cell.trim());
      cell = '';
      continue;
    }
    cell += char;
  }
  cells.push(cell.trim());
  return cells;
}

function endsWithUnescapedPipe(value: string): boolean {
  if (!value.endsWith('|')) return false;
  let backslashCount = 0;
  for (let index = value.length - 2; index >= 0 && value[index] === '\\'; index--) {
    backslashCount += 1;
  }
  return backslashCount % 2 === 0;
}
