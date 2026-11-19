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

/** Source-ordered literal spans; comment markers inside declarations are data. */
export function markdownLiteralMarkupSpans(
  text: string,
  startsInComment = false,
  ignoreOpening: (index: number) => boolean = () => false,
): Array<{ start: number; end: number; comment: boolean; closed: boolean }> {
  const spans: Array<{ start: number; end: number; comment: boolean; closed: boolean }> = [];
  const opening = /<!--|<!\[CDATA\[|<!(?!--)|<\?/g;
  if (startsInComment) {
    const close = text.indexOf('-->');
    const end = close === -1 ? text.length : close + 3;
    spans.push({ start: 0, end, comment: true, closed: close !== -1 });
    opening.lastIndex = end;
  }
  let match: RegExpExecArray | null;
  while ((match = opening.exec(text)) !== null) {
    if (ignoreOpening(match.index)) continue;
    let end = text.length;
    let closed = false;
    const comment = match[0] === '<!--';
    if (match[0] === '<?' || match[0] === '<![CDATA[' || comment) {
      const delimiter = match[0] === '<?' ? '?>' : comment ? '-->' : ']]>';
      const at = text.indexOf(delimiter, opening.lastIndex);
      if (at !== -1) { end = at + delimiter.length; closed = true; }
    } else {
      let quote = '';
      let brackets = 0;
      for (let at = opening.lastIndex; at < text.length; at++) {
        const char = text[at];
        if (quote) { if (char === quote) quote = ''; continue; }
        if (char === '"' || char === "'") quote = char;
        else if (char === '[') brackets++;
        else if (char === ']') brackets = Math.max(0, brackets - 1);
        else if (char === '>' && brackets === 0) { end = at + 1; closed = true; break; }
      }
    }
    spans.push({ start: match.index, end, comment, closed });
    opening.lastIndex = end;
  }
  return spans;
}

export function advanceMarkdownHtmlCommentState(line: string, inComment: boolean): boolean {
  const scan = line.replace(/`[^`]*`/g, span => ' '.repeat(span.length));
  const last = markdownLiteralMarkupSpans(scan, inComment).at(-1);
  return Boolean(last?.comment && !last.closed);
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
