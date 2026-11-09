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
  if (open) {
    const close = open[1] ? `</think:${open[1]}>` : '</think>';
    const end = text.toLowerCase().indexOf(close.toLowerCase(), open[0].length);
    if (end < 0) return final ? { thinking: text.slice(open[0].length), text: '' } : null;
    return { thinking: text.slice(open[0].length, end), text: text.slice(end + close.length) };
  }
  // The observed gateway dialect omits the opening tag. A bare </think> alone
  // is not enough evidence; only the salted HY4 control token enables this path.
  // Fenced code closes only on a delimiter-only line, never on a run inside a
  // string/comment. Inline code instead closes on an exactly matching run.
  let fence = '';
  let fenceQuoteDepth = 0;
  let fenceIndent = 0;
  let inlineWidth = 0;
  let offset = 0;
  for (const line of text.split('\n')) {
    let fenceLine: string | null = line;
    for (let depth = 0; fence && depth < fenceQuoteDepth; depth++) {
      const quote = /^ {0,3}>[\t ]?/.exec(fenceLine!);
      if (!quote) { fenceLine = null; fence = ''; break; }
      fenceLine = fenceLine!.slice(quote[0].length);
    }
    if (fence) {
      const close = /^( *)(`+|~+)[\t ]*\r?$/.exec(fenceLine!);
      if (close && close[1].length <= fenceIndent + 3
          && close[2][0] === fence[0] && close[2].length >= fence.length) fence = '';
    } else {
      // Strip quote/list containers before checking code indentation. Protect
      // nested-list fences too: their absolute indentation can exceed three.
      let codeLine = line;
      while (true) {
        const container = /^ {0,3}(?:>[\t ]?|(?:[-+*]|\d+[.)])[\t ])/.exec(codeLine);
        if (!container) break;
        codeLine = codeLine.slice(container[0].length);
      }
      if (!inlineWidth && /^(?: {4}| {0,3}\t)/.test(codeLine)) {
        offset += line.length + 1;
        continue;
      }
      const open = inlineWidth === 0
        ? /^((?: {0,3}>[\t ]?)*)( {0,3})((?:(?:[-+*]|\d+[.)])[\t ]+)*)(`{3,}|~{3,})(.*)$/.exec(line)
        : null;
      if (open && (open[4][0] === '~' || !open[5].includes('`'))) {
        fence = open[4];
        fenceQuoteDepth = (open[1].match(/>/g) ?? []).length;
        fenceIndent = open[2].length + open[3].length;
      } else for (const match of line.matchAll(/`+|<\/think:[a-f0-9]{8}>/gi)) {
        const token = match[0];
        if (token[0] === '`') {
          // Escapes apply outside code spans; inside, backslashes are literal.
          let backslashes = 0;
          for (let i = match.index - 1; i >= 0 && line[i] === '\\'; i--) backslashes++;
          if (!inlineWidth && backslashes % 2) continue;
          if (!inlineWidth) inlineWidth = token.length;
          else if (inlineWidth === token.length) inlineWidth = 0;
        } else if (!inlineWidth) {
          const end = offset + match.index;
          return { thinking: text.slice(0, end), text: text.slice(end + token.length) };
        }
      }
    }
    offset += line.length + 1;
  }
  return null;
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
