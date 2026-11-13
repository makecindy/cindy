import type { JSONContent } from '@tiptap/core';

import { COMPOSER_ENHANCE_MAX_INPUT_CHARS } from '../../shared/composerPromptEnhance';
import { extractIpcError } from '../utils/ipcError';
import { plainTextToComposerDocument } from './composerListDocument';

/**
 * How a failed enhancement should be reported.
 *
 * - `missing-config`: the auxiliary chain has no usable candidate. The user
 *   has to configure one, so the notice points at the setting that fixes it.
 * - `failed`: the call itself failed — upstream error, empty body, or a
 *   rewrite the completeness check rejected. The notice names the operation
 *   that failed; the generic `ipcError.*` wording is not reused here, because
 *   it carries retry advice that none of these failure reasons supports.
 */
export type EnhanceErrorKind = 'missing-config' | 'failed';

/** Classify an enhancement failure for the message it should produce. */
export function resolveEnhanceErrorKind(error: unknown): EnhanceErrorKind {
  return extractIpcError(error)?.code === 'AUXILIARY_MODEL_UNAVAILABLE'
    ? 'missing-config'
    : 'failed';
}

/**
 * True when the draft is longer than the input budget the main side accepts.
 *
 * The renderer reuses the main-side constant on purpose: a draft over the
 * budget is refused by main with INVALID_PARAMS, which reaches the user as a
 * generic "invalid input" with no way to recover. Checking it here lets the
 * control say what is actually wrong and name the limit.
 */
export function draftExceedsEnhanceInputLimit(
  text: string,
  limit: number = COMPOSER_ENHANCE_MAX_INPUT_CHARS,
): boolean {
  return text.trim().length > limit;
}

/**
 * Node types a plain-text rewrite can reproduce faithfully.
 *
 * Everything else (mention chips, pasted-text chips, quote chips, code
 * blocks, lists, ...) carries structure that a string cannot restore, so a
 * draft containing them is not eligible for enhancement.
 */
const PLAIN_TEXT_NODE_TYPES = new Set([
  'doc',
  'paragraph',
  'text',
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

/**
 * The draft a rewrite request was started from.
 *
 * Every field is captured when the request is dispatched, so a late answer
 * can be checked against the live state instead of the closure it was
 * created in (which by construction always matches).
 */
export interface EnhanceRequestOrigin {
  /** The editor instance the request was dispatched from. */
  editor: unknown;
  /** Identifies the draft; changes when the composer switches session. */
  draftKey: string | undefined;
  /** Fingerprint of the document the request was started from. */
  fingerprint: string;
}

/**
 * The live state of the composer when a rewrite answer comes back.
 */
export interface EnhanceLiveState {
  /** The editor instance currently mounted. */
  editor: unknown;
  /** The draft the composer currently shows. */
  draftKey: string | undefined;
  /** Fingerprint of the document currently in the editor. */
  fingerprint: string;
  /** The composer is locked (shared guest, remote session, streaming, ...). */
  disabled: boolean;
  /** The component is still mounted. */
  mounted: boolean;
  /** The editor was torn down. */
  destroyed: boolean;
  /** An IME composition is in progress. */
  composing: boolean;
}

/**
 * Whether a rewrite answer may be applied to the composer.
 *
 * The answer is dropped unless the composer still shows exactly the draft the
 * request was started from: same editor, same draft, same text, not locked,
 * not torn down, and no IME composition in progress. Anything else means the
 * user has moved on and their newer text must win.
 */
export function canApplyEnhanceResult(
  origin: EnhanceRequestOrigin,
  live: EnhanceLiveState,
): boolean {
  if (!live.mounted) return false;
  if (live.disabled) return false;
  if (live.destroyed) return false;
  if (live.composing) return false;
  if (live.editor !== origin.editor) return false;
  if (live.draftKey !== origin.draftKey) return false;
  if (live.fingerprint !== origin.fingerprint) return false;
  return true;
}

/**
 * The undo record of an applied rewrite.
 */
export interface EnhanceUndoRecord {
  /** The editor the rewrite was applied to. */
  editor: unknown;
  /** The draft the rewrite was applied to. */
  draftKey: string | undefined;
  /** The document before the rewrite. */
  original: JSONContent;
  /** Fingerprint of the document the rewrite produced. */
  applied: string;
}

/**
 * Whether the undo of an applied rewrite may still run.
 *
 * Undo restores a full document, so it is not blocked by the structured-node
 * rule that blocks the enhance action itself: a rewrite may come back as a
 * list even when the draft was plain text, and undoing it must stay possible.
 *
 * It is blocked by a running request, a locked composer, a torn-down editor,
 * an IME composition, or a document the user has changed since the rewrite.
 */
export function canUndoEnhanceResult(
  record: EnhanceUndoRecord | null,
  live: EnhanceLiveState,
  options?: { busy?: boolean },
): boolean {
  if (!record) return false;
  if (options?.busy) return false;
  if (!live.mounted) return false;
  if (live.disabled) return false;
  if (live.destroyed) return false;
  if (live.composing) return false;
  if (live.editor !== record.editor) return false;
  if (live.draftKey !== record.draftKey) return false;
  if (live.fingerprint !== record.applied) return false;
  return true;
}

/**
 * The document a rewrite is applied as.
 *
 * The model answers with plain text, so it is normalized into a composer
 * document here. `setContent(string)` is not used on purpose: it would parse
 * the answer as HTML, so a rewrite mentioning `<div>` or `<file>` would
 * silently become markup instead of text.
 */
export function buildEnhancedDocument(text: string): JSONContent {
  return plainTextToComposerDocument(text);
}
