import type { Element } from 'hast';
import rehypeHighlight from 'rehype-highlight';
import { visit } from 'unist-util-visit';

type HighlightTransformer = ReturnType<typeof rehypeHighlight>;
interface HighlightEntry {
  children: string;
  classes: string[];
  bytes: number;
}

// Bound retained message content independently of the number of mounted bubbles.
const MAX_CACHE_BYTES = 2 * 1024 * 1024;
const MAX_CACHE_ENTRIES = 128;
const cache = new Map<string, HighlightEntry>();
let cacheBytes = 0;
let sharedTransformer: HighlightTransformer | undefined;

function remember(key: string, node: Element): void {
  const children = JSON.stringify(node.children);
  const classes = node.properties.className;
  if (!Array.isArray(classes)) return;
  const bytes = 2 * (key.length + children.length + JSON.stringify(classes).length);
  if (bytes > MAX_CACHE_BYTES) return;
  const previous = cache.get(key);
  if (previous) cacheBytes -= previous.bytes;
  cache.delete(key);
  cache.set(key, { children, classes: [...classes], bytes });
  cacheBytes += bytes;
  while (cacheBytes > MAX_CACHE_BYTES || cache.size > MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value!;
    cacheBytes -= cache.get(oldest)!.bytes;
    cache.delete(oldest);
  }
}

/**
 * Share the language registry and bounded results for unchanged fenced code.
 * Full-document parsing still handles heading IDs and reference links. Cached
 * children are deserialized afresh so downstream plugins cannot mutate them.
 */
export function rehypeHighlightShared(): HighlightTransformer {
  if (sharedTransformer) return sharedTransformer;
  const highlight = rehypeHighlight();
  sharedTransformer = (tree, file) => {
    const misses: Array<{ key: string; node: Element }> = [];
    const hits: Array<{ node: Element; entry: HighlightEntry }> = [];
    visit(tree, 'element', (node, _index, parent) => {
      if (node.tagName !== 'code' || parent?.type !== 'element' || parent.tagName !== 'pre') return;
      const classes = node.properties.className;
      if (
        !Array.isArray(classes) ||
        classes.includes('no-highlight') ||
        classes.includes('nohighlight')
      )
        return;
      if (!classes.some((value) => typeof value === 'string' && /^(lang|language)-./.test(value)))
        return;
      // Already transformed trees and large, unfinished blocks use the upstream path.
      if (
        node.children.length !== 1 ||
        node.children[0].type !== 'text' ||
        node.children[0].value.length > 64 * 1024
      )
        return;
      const key = JSON.stringify([classes, node.children[0].value]);
      const entry = cache.get(key);
      if (!entry) {
        misses.push({ key, node });
        return;
      }
      cache.delete(key);
      cache.set(key, entry);
      hits.push({ node, entry });
      // Skip just this node during the upstream walk; remove the marker afterward.
      node.properties.className = [...entry.classes, 'no-highlight'];
    });
    const messagesBefore = file.messages.length;
    try {
      highlight(tree, file);
    } finally {
      // Restore after the walk: traversing cached token spans would cost almost
      // as much as highlighting them again for long code blocks.
      for (const { node, entry } of hits) {
        node.children = JSON.parse(entry.children) as Element['children'];
        node.properties.className = [...entry.classes];
      }
    }
    // Preserve upstream diagnostics (e.g. unknown languages) on every document.
    if (file.messages.length === messagesBefore) {
      for (const { key, node } of misses) remember(key, node);
    }
  };
  return sharedTransformer;
}
