import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { gfm } from 'micromark-extension-gfm';

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

interface MarkdownNode {
  type: string;
  position?: { start: { offset?: number }; end: { offset?: number } };
  children?: MarkdownNode[];
}
interface TextRange { start: number; end: number }

/** Both opener dialects use the renderer's CommonMark/GFM code boundaries. */
function findThinkingBoundary(text: string, expectedClose: string | null, final: boolean): { index: number; length: number } | null {
  const candidates = [...text.matchAll(/<\/think(?::([a-f0-9]{8}))?>/gi)]
    .filter(match => expectedClose ? match[0].toLowerCase() === expectedClose : Boolean(match[1]));
  if (candidates.length === 0) return null;
  // Parse only after a complete potential boundary arrives, not on ordinary
  // deltas. These are the same CommonMark/GFM extensions used by remark-gfm.
  const root = fromMarkdown(text, {
    extensions: [gfm({ singleTilde: false })],
    mdastExtensions: [gfmFromMarkdown()],
  });
  const code: TextRange[] = [];
  const scopes: TextRange[] = [];
  const visit = (node: MarkdownNode): void => {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (typeof start === 'number' && typeof end === 'number') {
      if (node.type === 'code' || node.type === 'inlineCode') code.push({ start, end });
      if (node.type === 'paragraph' || node.type === 'heading' || node.type === 'tableCell') scopes.push({ start, end });
    }
    node.children?.forEach(visit);
  };
  visit(root);
  code.sort((a, b) => a.start - b.start);
  for (const candidate of candidates) {
    const index = candidate.index;
    const end = index + candidate[0].length;
    if (code.some(range => range.start <= index && end <= range.end)) continue;
    if (!final) {
      const scope = scopes.filter(range => range.start <= index && end <= range.end)
        .sort((a, b) => (a.end - a.start) - (b.end - b.start))[0];
      if (scope) {
        // A partial inline opener is still literal in the current AST but may
        // become code when a later chunk closes it. Hold that message until
        // closure or final authority. Never carry this state across AST scopes
        // (e.g. another list item/table cell), or choose a later candidate first.
        let cursor = scope.start;
        for (const range of code) {
          if (range.end <= cursor) continue;
          if (range.start >= index) break;
          if (text.slice(cursor, Math.min(range.start, index)).includes('`')) return null;
          cursor = Math.max(cursor, range.end);
        }
        if (text.slice(cursor, index).includes('`')) return null;
      }
    }
    return { index, length: candidate[0].length };
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
