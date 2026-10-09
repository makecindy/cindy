import path from 'node:path';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import { visit } from 'unist-util-visit';
import type { Definition } from 'mdast';

const parser = unified().use(remarkParse).use(remarkGfm);

export interface TaskImageReference {
  raw: string;
  identifier?: string;
  url: string;
  alt: string;
  title?: string | null;
  start: number;
  end: number;
}

/** Parse Markdown, rather than treating examples in code or HTML as deliveries. */
export function taskImageReferences(text: string): TaskImageReference[] {
  if (!text.includes('![')) return [];
  const images: TaskImageReference[] = [];
  const tree = parser.parse(text);
  const definitions = new Map<string, Definition>();
  visit(tree, 'definition', (node) => {
    if (!definitions.has(node.identifier)) definitions.set(node.identifier, node);
  });
  visit(tree, (node) => {
    if (node.type !== 'image' && node.type !== 'imageReference') return;
    const target = node.type === 'image' ? node : definitions.get(node.identifier);
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (target && start !== undefined && end !== undefined)
      images.push({
        raw: text.slice(start, end),
        identifier: node.type === 'imageReference' ? node.identifier : undefined,
        url: target.url,
        alt: node.alt ?? '',
        title: target.title,
        start,
        end,
      });
  });
  return images;
}

export function localTaskImagePath(url: string): string | null {
  let value = url;
  // A model sometimes copies the xdt-file example and substitutes xdt-image.
  // Only this unambiguous, hostless shape is recoverable; the old protocol stays strict.
  if (value.startsWith('xdt-image:///') || value.startsWith('xdt-file:///')) {
    try {
      value = decodeURIComponent(value.slice(value.indexOf('://') + 3));
    } catch {
      return null;
    }
    if (/^\/[A-Za-z]:[\\/]/.test(value)) value = value.slice(1);
  }
  return !value.includes('\0') && path.isAbsolute(value) ? value : null;
}

export function hasLocalTaskImages(text: unknown): text is string {
  return (
    typeof text === 'string' && taskImageReferences(text).some((ref) => localTaskImagePath(ref.url))
  );
}

/** Replace exact AST spans, preserving surrounding formatting and code examples. */
export function rewriteTaskImageReferences(
  text: string,
  replacements: ReadonlyMap<string, string>,
  mode: 'url' | 'alt' | 'literal' = 'url',
): string {
  if (!replacements.size) return text;
  let result = text;
  const edits: { start: number; end: number; text: string }[] = [];
  const replacedDefinitions = new Set<string>();
  for (const image of taskImageReferences(text)) {
    const url = replacements.get(image.url);
    if (url === undefined) continue;
    const alt = image.alt.replace(/[\\\[\]]/g, '\\$&');
    const title = image.title ? ` "${image.title.replace(/[\\"]/g, '\\$&')}"` : '';
    const replacement =
      mode === 'alt' ? alt : mode === 'literal' ? url : `![${alt}](${url}${title})`;
    edits.push({ start: image.start, end: image.end, text: replacement });
    if (image.identifier) replacedDefinitions.add(image.identifier);
  }
  if (replacedDefinitions.size) {
    const tree = parser.parse(text);
    // Definitions shared with ordinary links remain intact. Image-only definitions
    // are now unused; remove them so IM text cannot expose the original local path.
    visit(tree, 'linkReference', (node) => {
      replacedDefinitions.delete(node.identifier);
    });
    visit(tree, 'definition', (node) => {
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (replacedDefinitions.has(node.identifier) && start !== undefined && end !== undefined) {
        edits.push({ start, end, text: '' });
      }
    });
  }
  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
  }
  return result;
}

export function isPathWithin(root: string, target: string): boolean {
  const fold = (v: string) => (process.platform === 'win32' ? v.toLowerCase() : v);
  const rel = path.relative(fold(root), fold(target));
  return rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

export interface TaskImageMaterializeDeps {
  /** Returns a stable managed URL. Validates scope and image bytes before importing. */
  importImage(source: string): Promise<string>;
}

export async function materializeTaskImageMarkdown(text: string, deps: TaskImageMaterializeDeps) {
  const replacements = new Map<string, string>();
  const failures: string[] = [];
  for (const ref of taskImageReferences(text)) {
    const source = localTaskImagePath(ref.url);
    if (!source || replacements.has(ref.url) || failures.includes(ref.url)) continue;
    try {
      replacements.set(ref.url, await deps.importImage(source));
    } catch {
      failures.push(ref.url);
    }
  }
  return { text: rewriteTaskImageReferences(text, replacements), replacements, failures };
}
