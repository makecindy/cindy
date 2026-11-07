import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import { visit } from 'unist-util-visit';
import type { Definition } from 'mdast';
import { richAnswerText } from '@cindy/maker-shared/rich-answer';

const parser = unified().use(remarkParse).use(remarkGfm);

// Local Markdown line locators follow sharedTaskFileReferences/markdownTarget.
// Query-based URLs carry an explicit path; do not rewrite its literal filename.
export function withoutLineLocator(value: string): string {
  return value.includes('?') ? value : value.replace(/(?::\d+(?::\d+|-\d+)?|#L\d+(?:-L\d+)?)$/, '');
}

// Match local references, not arbitrary URI schemes or in-message anchors.
function isFileTarget(value: string): boolean {
  if (!value || /^[#?]/.test(value)) return false;
  value = withoutLineLocator(value);
  if (/^(?:file|xdt-file|sandbox):/i.test(value) || /^[A-Za-z]:[\\/]/.test(value)) return true;
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(value)) return false;
  // Match the renderer's local-path shape; `about` is navigation, while
  // `./README`, `documents/report.pdf` and `report.pdf` are explicit files.
  return /[\\/]/.test(value) || /\.[a-z0-9]{1,10}(\?.*)?$/i.test(value);
}

/** Only actual Markdown file links are deliveries; code, images and remote URLs are not. */
export function replyFileLinks(text: string, fileLabel: (label: string) => string = label => label) {
  // The reported reply HTML-escaped the angle brackets around paths with spaces.
  // Recover only these file links in prose, never examples inside code or HTML.
  const escaped: Array<{ start: number; end: number; text: string }> = [];
  visit(parser.parse(text), 'text', node => {
    const start = node.position?.start.offset, end = node.position?.end.offset;
    if (start === undefined || end === undefined) return;
    const raw = text.slice(start, end);
    // The closing label delimiter can follow a separate image AST node.
    // Definitions with escaped space-containing targets are text until reparsed.
    const normalized = raw.replace(/(\]\(|(?:^|\n)[ \t]{0,3}\[[^\]\n]+\]:[ \t]*)&lt;([^\n]*?)&gt;/g,
      (match, before, target) => isFileTarget(target) ? `${before}<${target}>` : match);
    if (normalized !== raw) escaped.push({ start, end, text: normalized });
  });
  for (const edit of escaped.sort((a, b) => b.start - a.start))
    text = text.slice(0, edit.start) + edit.text + text.slice(edit.end);
  const tree = parser.parse(text);
  const definitions = new Map<string, Definition>();
  visit(tree, 'definition', node => {
    if (!definitions.has(node.identifier)) definitions.set(node.identifier, node);
  });
  const links: Array<{ url: string; start: number; end: number; label: string }> = [];
  const usedDefinitions = new Set<string>();
  const imageDefinitions = new Set<string>();
  visit(tree, 'imageReference', node => { imageDefinitions.add(node.identifier); });
  visit(tree, node => {
    if (node.type !== 'link' && node.type !== 'linkReference') return;
    const target = node.type === 'link' ? node : definitions.get(node.identifier);
    if (!target || !isFileTarget(target.url)) return;
    const start = node.position?.start.offset, end = node.position?.end.offset;
    const first = node.children[0]?.position?.start.offset, last = node.children.at(-1)?.position?.end.offset;
    // Keep nested image markup as the label for the later image-delivery pass;
    // the outer explicit file target still needs its own attachment.
    if (start === undefined || end === undefined || first === undefined || last === undefined) return;
    links.push({ url: target.url, start, end, label: text.slice(first, last) });
    if (node.type === 'linkReference') usedDefinitions.add(node.identifier);
  });
  const edits = links.map(link => ({ start: link.start, end: link.end, text: fileLabel(link.label) }));
  for (const identifier of usedDefinitions) {
    // The image pass decides from authorized bytes whether a shared target is
    // an image or a file-only preview. Keep its definition until then.
    if (imageDefinitions.has(identifier)) continue;
    const node = definitions.get(identifier)!;
    if (node.position?.start.offset !== undefined && node.position.end.offset !== undefined)
      edits.push({ start: node.position.start.offset, end: node.position.end.offset, text: '' });
  }
  let deliveredText = text;
  for (const edit of edits.sort((a, b) => b.start - a.start))
    deliveredText = deliveredText.slice(0, edit.start) + edit.text + deliveredText.slice(edit.end);
  // Image preparation sees deliveredText, so both attachment kinds use its offsets.
  const positionedLinks = links.map(link => ({ ...link, outputStart: link.start + edits
    .filter(edit => edit.end <= link.start)
    .reduce((delta, edit) => delta + edit.text.length - (edit.end - edit.start), 0) }));
  return { links: positionedLinks, text: deliveredText };
}

const internalMedia = /^(?:cindy-(?:remote-)?media|xdt-(?:image|video|audio|model)):/i;
const escapeLabel = (value: string) => value.replace(/[\\`*_[\]<>]/g, '\\$&').replace(/[\r\n]/g, ' ');

/** Path-only labels must not turn into a visible private address after unlinking. */
function readableLabel(label: string, untitled: string): string {
  const value = label.trim().replace(/^(`+)([^`]+)\1$/, '$2');
  if (!value || internalMedia.test(value)) return untitled;
  if (!/^(?:[\\/]|\.{1,2}[\\/]|~[\\/]|[A-Za-z]:[\\/]|(?:file|xdt-file|sandbox):)/i.test(value)) return label;
  let local = value;
  if (/^(?:file|xdt-file|sandbox):/i.test(value)) {
    try {
      const url = new URL(value);
      local = url.searchParams.get('path') ?? url.pathname;
    } catch { return untitled; }
  }
  let name = withoutLineLocator(local).split(/[\\/]/).at(-1);
  if (!name) return untitled;
  try { name = decodeURIComponent(name).split(/[\\/]/).at(-1); }
  catch { /* A literal percent is still a readable filename. */ }
  return name ? escapeLabel(name) : untitled;
}

/** Text-only projection: no file reads, media imports, network calls or new grants. */
export function replyWithoutAttachments(source: string, notice: string, untitled: string): string {
  const text = replyFileLinks(richAnswerText(source), label => readableLabel(label, untitled)).text;
  const tree = parser.parse(text);
  const definitions = new Map<string, Definition>();
  visit(tree, 'definition', node => {
    if (!definitions.has(node.identifier)) definitions.set(node.identifier, node);
  });
  const edits: Array<{ start: number; end: number; text: string }> = [];
  visit(tree, (node, _index, parent) => {
    if (node.type !== 'image' && node.type !== 'imageReference' && node.type !== 'link' && node.type !== 'linkReference') return;
    const target = node.type === 'imageReference' || node.type === 'linkReference' ? definitions.get(node.identifier) : node;
    if (!target) return;
    const start = node.position?.start.offset, end = node.position?.end.offset;
    if (start === undefined || end === undefined) return;
    if (node.type === 'image' || node.type === 'imageReference') {
      const label = readableLabel(escapeLabel(node.alt ?? ''), untitled);
      // Remote media still has an accessible page; local and managed media do not.
      const web = /^https?:\/\//i.test(target.url);
      const url = target.url.replace(/[<>\r\n]/g, char => encodeURIComponent(char));
      const parentUrl = parent?.type === 'link' ? parent.url
        : parent?.type === 'linkReference' ? definitions.get(parent.identifier)?.url : undefined;
      // An image already linking to a public page keeps that outer link; nesting
      // another Markdown link would turn both destinations into broken markup.
      const linked = parentUrl && /^https?:\/\//i.test(parentUrl);
      edits.push({ start, end, text: web && !linked ? `[${label}](<${url}>)` : label });
    } else if (internalMedia.test(target.url)) {
      const first = node.children[0]?.position?.start.offset, last = node.children.at(-1)?.position?.end.offset;
      if (first !== undefined && last !== undefined) {
        const label = text.slice(first, last), readable = readableLabel(label, untitled);
        if (readable !== label) edits.push({ start, end, text: readable });
        // Keep nested image edits instead of replacing an overlapping whole link.
        else edits.push({ start, end: first, text: '' }, { start: last, end, text: '' });
      }
    }
  });
  visit(tree, 'definition', node => {
    if (!isFileTarget(node.url) && !internalMedia.test(node.url)) return;
    const start = node.position?.start.offset, end = node.position?.end.offset;
    if (start !== undefined && end !== undefined) edits.push({ start, end, text: '' });
  });
  let body = text;
  for (const edit of edits.sort((a, b) => b.start - a.start))
    body = body.slice(0, edit.start) + edit.text + body.slice(edit.end);
  body = body.trim();
  const prefix = body ? `${notice}\n\n` : notice;
  let end = Math.max(0, 16000 - prefix.length);
  // Match the existing UTF-16 wire budget without cutting a Unicode character.
  if (end < body.length && /[\uD800-\uDBFF]/.test(body.charAt(end - 1))) end--;
  return prefix + body.slice(0, end);
}
