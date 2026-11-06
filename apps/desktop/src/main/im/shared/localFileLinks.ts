import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import { visit } from 'unist-util-visit';
import type { Definition } from 'mdast';

const parser = unified().use(remarkParse).use(remarkGfm);

/** A scheme the IM recipient can open. A single letter is a Windows drive, `file:` is this computer. */
function isOpenableTarget(url: string): boolean {
  const scheme = /^([a-z][a-z0-9+.-]+):/i.exec(url)?.[1]?.toLowerCase();
  return scheme !== undefined && scheme !== 'file';
}

/**
 * Cheap superset of what `unlinkLocalFileLinks` rewrites: a link or definition
 * target without an openable scheme, a `file:` target, or a `<file:` autolink.
 * Streaming calls this on every delta, so replies with only web links (or none)
 * must not pay for a Markdown parse.
 */
const MAY_HAVE_LOCAL_LINK =
  /\][(:](?!\s*<?[a-z][a-z0-9+.-]+:)|\][(:]\s*<?file:|<file:/i;

/**
 * IM recipients cannot open this computer's files, and channels without
 * Markdown links show `[label](</abs/path>)` verbatim. Keep only the label of
 * links to local paths, relative paths or `file:` URLs. Images, managed media
 * and attachment links (`xdt-file://`) carry a scheme and stay for the
 * channel's own delivery; code examples are not links in the AST.
 */
export function unlinkLocalFileLinks(text: string): string {
  if (!MAY_HAVE_LOCAL_LINK.test(text)) return text;
  const tree = parser.parse(text);
  const definitions = new Map<string, Definition>();
  visit(tree, 'definition', (node) => {
    if (!definitions.has(node.identifier)) definitions.set(node.identifier, node);
  });
  const imageDefinitions = new Set<string>();
  visit(tree, 'imageReference', (node) => {
    imageDefinitions.add(node.identifier);
  });
  const edits: { start: number; end: number }[] = [];
  visit(tree, (node) => {
    if (node.type !== 'link' && node.type !== 'linkReference') return;
    const url = node.type === 'link' ? node.url : definitions.get(node.identifier)?.url;
    if (url === undefined || isOpenableTarget(url)) return;
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (start === undefined || end === undefined) return;
    const first = node.children[0]?.position?.start.offset;
    const last = node.children.at(-1)?.position?.end.offset;
    if (first === undefined || last === undefined) edits.push({ start, end });
    else edits.push({ start, end: first }, { start: last, end });
  });
  visit(tree, 'definition', (node) => {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (isOpenableTarget(node.url) || imageDefinitions.has(node.identifier)) return;
    if (start !== undefined && end !== undefined) edits.push({ start, end });
  });
  let result = text;
  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    result = result.slice(0, edit.start) + result.slice(edit.end);
  }
  return result;
}
