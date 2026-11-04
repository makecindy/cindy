import type { JSONContent } from '@tiptap/core';

/**
 * Node types a plain-text rewrite can reproduce faithfully.
 *
 * Everything else (mention chips, pasted-text chips, quote chips, code
 * blocks, ...) carries structure that a string cannot restore, so a draft
 * containing them is not eligible for enhancement.
 */
const PLAIN_TEXT_NODE_TYPES = new Set([
  'doc',
  'paragraph',
  'text',
  'bulletList',
  'orderedList',
  'listItem',
  'hardBreak',
]);

/** True when the document holds nodes that a plain-text rewrite would drop. */
export function documentHasStructuredNodes(node: JSONContent | undefined): boolean {
  if (!node) return false;
  if (node.type && !PLAIN_TEXT_NODE_TYPES.has(node.type)) return true;
  for (const child of node.content ?? []) {
    if (documentHasStructuredNodes(child)) return true;
  }
  return false;
}

/**
 * Stable identity of a composer document.
 *
 * Used to tell "the draft the request was started from" apart from "the
 * draft the user has since edited", so a late answer never overwrites newer
 * text.
 */
export function documentFingerprint(node: JSONContent | undefined): string {
  return JSON.stringify(node ?? null);
}

/**
 * Whether the editor is in the middle of an IME composition.
 *
 * Replacing the document while a composition is open would drop the
 * characters the IME is still assembling.
 */
export function editorIsComposing(editor: {
  view: unknown;
}): boolean {
  const view = editor.view as { composing?: boolean } | null;
  return view?.composing === true;
}

