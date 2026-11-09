/** HY4 Chat may put reasoning in content, with an implicit opener and salted closer. */
export function isHy4Model(model: unknown): boolean {
  return typeof model === 'string' && /^(?:tencent\/)?hy4(?:-preview)?$/i.test(model);
}

export interface Hy4InlineThinking {
  thinking: string;
  text: string;
}

/** Only interpret a confirmed HY4 boundary, never infer reasoning from prose/language. */
export function splitHy4InlineThinking(text: string, final = false): Hy4InlineThinking | null {
  // Four spaces or a tab introduce literal indented code, not a protocol opener.
  const open = /^(?:[\t ]*\r?\n)* {0,3}<think(?::([a-f0-9]{8}))?>/i.exec(text);
  const start = open?.[0].length ?? 0;
  const expectedClose = open ? (open[1] ? `</think:${open[1]}>` : '</think>').toLowerCase() : null;
  const boundary = findThinkingBoundary(text.slice(start), expectedClose, final);
  if (!boundary) return open && final ? { thinking: text.slice(start), text: '' } : null;
  const end = start + boundary.index;
  return { thinking: text.slice(start, end), text: text.slice(end + boundary.length) };
}

/** Expand tabs only for Markdown structure; returned offsets always use the raw text. */
function expandTabs(line: string): string {
  if (!line.includes('\t')) return line;
  let column = 0;
  let expanded = '';
  for (const char of line) {
    const width = char === '\t' ? 4 - column % 4 : 1;
    expanded += char === '\t' ? ' '.repeat(width) : char;
    column += width;
  }
  return expanded;
}

/** Quote and list containers may alternate in either order. */
function codeStructure(line: string): { content: string; quoteDepth: number; listIndent: number } {
  let content = line;
  let quoteDepth = 0;
  let listIndent = 0;
  while (true) {
    const quote = /^ {0,3}> ?/.exec(content);
    if (quote) {
      content = content.slice(quote[0].length);
      quoteDepth++;
      // Quote continuation consumes preceding list indentation as well.
      listIndent = 0;
      continue;
    }
    const list = /^( {0,3})([-+*]|\d{1,9}[.)])( +)/.exec(content);
    if (!list) break;
    // Five or more padding spaces leave indented code after one padding space.
    const width = list[1].length + list[2].length + (list[3].length <= 4 ? list[3].length : 1);
    content = content.slice(width);
    listIndent += width;
  }
  return { content, quoteDepth, listIndent };
}

/** Both explicit and implicit openers use exactly the same literal-code protection. */
function findThinkingBoundary(text: string, expectedClose: string | null, final: boolean): { index: number; length: number } | null {
  // The observed gateway dialect omits the opening tag. A bare </think> alone
  // is not enough evidence; only the salted HY4 control token enables this path.
  // Fenced code closes only on a delimiter-only line, never on a run inside a
  // string/comment. Inline code instead closes on an exactly matching run.
  let fence: { run: string; quoteDepth: number; listIndent: number } | null = null;
  let inlineWidth = 0;
  let pendingInlineBoundary: { index: number; length: number } | null = null;
  let offset = 0;
  for (const line of text.split('\n')) {
    const structuralLine = expandTabs(line);
    let fenceLine = structuralLine;
    for (let depth = 0; fence && depth < fence.quoteDepth; depth++) {
      const quote = /^ *> ?/.exec(fenceLine);
      if (!quote) { fence = null; break; }
      fenceLine = fenceLine.slice(quote[0].length);
    }
    if (fence) {
      const close = /^( *)(`+|~+) *\r?$/.exec(fenceLine);
      if (close && close[1].length <= fence.listIndent + 3
          && close[2][0] === fence.run[0] && close[2].length >= fence.run.length) fence = null;
    } else {
      // Strip quote/list containers before checking code indentation. Protect
      // nested-list fences too: their absolute indentation can exceed three.
      const structure = codeStructure(structuralLine);
      const open = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(structure.content);
      const opensFence = open && (open[1][0] === '~' || !open[2].includes('`'));
      // Inline spans cannot cross paragraph or fenced-block boundaries. An
      // unmatched opening run is literal text once that block has ended.
      if (inlineWidth && (structure.content.trim().length === 0 || opensFence)) {
        if (pendingInlineBoundary) return pendingInlineBoundary;
        inlineWidth = 0;
      }
      if (!inlineWidth && /^ {4}/.test(structure.content)) {
        offset += line.length + 1;
        continue;
      }
      if (open && opensFence) {
        fence = { run: open[1], quoteDepth: structure.quoteDepth, listIndent: structure.listIndent };
      } else for (const match of line.matchAll(/`+|<\/think(?::[a-f0-9]{8})?>/gi)) {
        const token = match[0];
        if (token[0] === '`') {
          // Escapes apply outside code spans; inside, backslashes are literal.
          let backslashes = 0;
          for (let i = match.index - 1; i >= 0 && line[i] === '\\'; i--) backslashes++;
          const width = token.length - (!inlineWidth && backslashes % 2 ? 1 : 0);
          if (!width) continue;
          if (!inlineWidth) inlineWidth = width;
          else if (inlineWidth === width) { inlineWidth = 0; pendingInlineBoundary = null; }
        } else if (expectedClose
          ? token.toLowerCase() === expectedClose
          : token.toLowerCase().startsWith('</think:')) {
          const boundary = { index: offset + match.index, length: token.length };
          if (!inlineWidth) return boundary;
          pendingInlineBoundary ??= boundary;
        }
      }
    }
    offset += line.length + 1;
  }
  return final ? pendingInlineBoundary : null;
}

/** Shared by final RPC projection and Pi tree rehydration; raw native history is untouched. */
export function hy4ContentBlocks(model: unknown, content: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(content)) return [];
  const blocks = content.filter((block): block is Record<string, unknown> =>
    typeof block === 'object' && block !== null);
  if (!isHy4Model(model)) return blocks;
  return blocks.flatMap(block => {
    if (block.type !== 'text' || typeof block.text !== 'string') return [block];
    const split = splitHy4InlineThinking(block.text, true);
    if (!split) return [block];
    return [
      ...(split.thinking ? [{ type: 'thinking', thinking: split.thinking }] : []),
      ...(split.text ? [{ ...block, text: split.text }] : []),
    ];
  });
}
