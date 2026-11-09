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
  const open = /^\s*<think(?::([a-f0-9]{8}))?>/i.exec(text);
  if (open) {
    const close = open[1] ? `</think:${open[1]}>` : '</think>';
    const end = text.toLowerCase().indexOf(close.toLowerCase(), open[0].length);
    if (end < 0) return final ? { thinking: text.slice(open[0].length), text: '' } : null;
    return { thinking: text.slice(open[0].length, end), text: text.slice(end + close.length) };
  }
  // The observed gateway dialect omits the opening tag. A bare </think> alone
  // is not enough evidence; only the salted HY4 control token enables this path.
  // Ignore control-token examples inside inline/fenced Markdown code, including
  // unfinished fences while streaming. Opening and closing runs must match.
  let code = '';
  for (const match of text.matchAll(/`+|~{3,}|<\/think:[a-f0-9]{8}>/gi)) {
    const token = match[0];
    if (!token.startsWith('<')) {
      if (!code) code = token;
      else if (token === code) code = '';
    } else if (!code) {
      return { thinking: text.slice(0, match.index), text: text.slice(match.index + token.length) };
    }
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
