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

export interface MarkdownRawMarkupState {
  raw?: { delimiter?: string; quote: string; brackets: number };
}

/** Source-ordered literal spans; retain unfinished declarations across lines. */
export function markdownLiteralMarkupSpans(
  text: string,
  startsInComment = false,
  ignoreOpening: (index: number) => boolean = () => false,
  rawState: MarkdownRawMarkupState = {},
): Array<{ start: number; end: number; comment: boolean; closed: boolean }> {
  const spans: Array<{ start: number; end: number; comment: boolean; closed: boolean }> = [];
  const opening = /<!--|<!\[CDATA\[|<!(?!--)|<\?/g;
  const consumeRaw = (start: number, from: number) => {
    const raw = rawState.raw!;
    let end = text.length;
    let closed = false;
    if (raw.delimiter) {
      const at = text.indexOf(raw.delimiter, from);
      if (at !== -1) { end = at + raw.delimiter.length; closed = true; }
    } else {
      for (let at = from; at < text.length; at++) {
        const char = text[at];
        if (raw.quote) { if (char === raw.quote) raw.quote = ''; continue; }
        if (char === '"' || char === "'") raw.quote = char;
        else if (char === '[') raw.brackets++;
        else if (char === ']') raw.brackets = Math.max(0, raw.brackets - 1);
        else if (char === '>' && raw.brackets === 0) { end = at + 1; closed = true; break; }
      }
    }
    spans.push({ start, end, comment: false, closed });
    if (closed) rawState.raw = undefined;
    opening.lastIndex = end;
    return closed;
  };
  if (rawState.raw && !consumeRaw(0, 0)) return spans;
  if (startsInComment) {
    const close = text.indexOf('-->');
    const end = close === -1 ? text.length : close + 3;
    spans.push({ start: 0, end, comment: true, closed: close !== -1 });
    if (close === -1) return spans;
    opening.lastIndex = end;
  }
  let match: RegExpExecArray | null;
  while ((match = opening.exec(text)) !== null) {
    if (ignoreOpening(match.index)) continue;
    if (match[0] === '<!--') {
      const close = text.indexOf('-->', opening.lastIndex);
      const end = close === -1 ? text.length : close + 3;
      spans.push({ start: match.index, end, comment: true, closed: close !== -1 });
      if (close === -1) break;
      opening.lastIndex = end;
    } else {
      rawState.raw = {
        delimiter: match[0] === '<?' ? '?>' : match[0] === '<![CDATA[' ? ']]>' : undefined,
        quote: '', brackets: 0,
      };
      if (!consumeRaw(match.index, opening.lastIndex)) break;
    }
  }
  return spans;
}

export function advanceMarkdownHtmlCommentState(
  line: string, inComment: boolean, rawState?: MarkdownRawMarkupState,
): boolean {
  const probe = line.replace(/`[^`]*`/g, span => ' '.repeat(span.length));
  const last = markdownLiteralMarkupSpans(
    line, inComment, at => probe[at] !== line[at], rawState,
  ).at(-1);
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
