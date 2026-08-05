/**
 * composerDraftStore — Per-session draft for the chat composer (text + attachments).
 * ---------------------------------------------------------------------------
 * Purpose: Keep "in-flight" composer state isolated per CC Agent session.
 *
 * Without this store, the parent-held attachment list (`useAttachments` in
 * CCAgentSessionView) and the Tiptap editor instance inside ChatInput are
 * single instances that survive `sessionId` changes, so a draft typed in
 * session A leaks into session B when the user clicks B in the sidebar.
 *
 * Scope:
 * - In-memory only. The Map lives for the lifetime of the renderer process.
 * - NOT persisted across app restart (intentional — matches current product
 *   expectation that "session-scoped draft" is a soft convenience, not durable
 *   state).
 *
 * Lifecycle:
 * - `saveDraft` is called by `useAttachments` (when sessionId changes, before
 *   the new session's attachments are restored) and by `ChatInput`'s editor
 *   `onUpdate` hook (every keystroke; cheap Map.set).
 * - `getDraft` is called by `useAttachments` and `ChatInput` after the
 *   sessionId switches, to restore whatever the user left in the new session.
 * - `clearDraft` is called from `dispatchSend` (after a successful send) and
 *   from the session delete/archive flow in `CCAgentSidebarUpper` (to avoid
 *   the Map holding orphan entries for sessions that no longer exist).
 *
 * Why a separate module instead of expanding `makerChatStore`:
 * - `makerChatStore` is the chat business state (messages, streaming flags,
 *   askUser bookkeeping). The composer draft is a UI/input concern. Mixing
 *   them blurs responsibility — keep this small and focused.
 */

import type { AttachedFile } from '@/lib/fileTypes';
import type { BrowserCommentDraftItem } from '@/lib/browserComments';
import type { ChatQuote } from '@/lib/chatQuotes';
import {
  appendQuoteToComposerDocument,
  prependLegacyQuotesToComposerDocument,
  COMPOSER_QUOTE_NODE_TYPE,
} from '@/lib/composerQuoteDocument';
import type { JSONContent } from '@tiptap/core';
import { createLogger } from '@/lib/logger';
import { cleanupStagedChatAttachmentFiles } from './chatAttachmentStageCleanup';
import {
  insertComposerDocumentForRestore,
  normalizeComposerDocumentJSON,
  plainTextToComposerDocument,
} from './composerListDocument';

const log = createLogger('ComposerDraftStore');

export interface ComposerDraft {
  /** Tiptap JSON document. `null` means "no text draft saved" (treat as empty). */
  text: JSONContent | null;
  /** Snapshot of attachments at save time. Empty array means no attachments. */
  attachments: AttachedFile[];
  /** Plugin-page handoff consumed by ChatInput after its editor hydration. */
  pendingGhostId?: string;
  /**
   * One-shot routed-entry intent: hydrate this draft, then place the caret at
   * the final editable position. ChatInput consumes and clears the flag so a
   * later ordinary remount does not steal focus.
   */
  focusAtEnd?: boolean;
  /** @deprecated 旧 renderer 的独立引用数组;saveDraft 会提升为正文节点。 */
  quotes?: ChatQuote[];
  /**
   * 内置浏览器页面评论(browser-comment-chip):待随下一条消息发送的评论列表,
   * composer 渲染为「N 条注释」胶囊,发送时序列化为 `# Browser comments:` 段
   * 拼在正文后、截图并入附件。可选,旧写入点不带该字段时视为无评论——
   * 会**覆写同会话草稿**的 saveDraft 调用方负责保留已有值;为新会话整体
   * 预填(fork / rewind / skillhub)的写入点属有意重置,
   * 不需要带。
   */
  browserComments?: BrowserCommentDraftItem[];
}

export interface RemoteOptimisticDraftFragment {
  clientId: string;
  text: JSONContent | null;
  attachments: readonly AttachedFile[];
  browserComments: readonly BrowserCommentDraftItem[];
}

export interface RemoteOptimisticDraftSnapshot {
  text: JSONContent | null;
  attachments: readonly AttachedFile[];
  browserComments: readonly BrowserCommentDraftItem[];
}

/**
 * Process-local discard boundary captured by async composer work. A successful
 * send uses `clearDraft` and deliberately does not invalidate this token:
 * files added while the send is settling are newer composer input. Explicit
 * discard (session delete/archive) advances the generation so late work can
 * recycle its files instead of resurrecting the removed draft.
 */
export interface ComposerDraftDiscardToken {
  ownerScopedKey: string;
  generation: number;
}

const ATTACHED_FILE_SNAPSHOT_KEYS = [
  'id',
  'name',
  'path',
  'ext',
  'size',
  'category',
  'mimeType',
  'url',
  'originalName',
  'base64',
  'textContent',
  'truncated',
  'annotated',
  'annotationSourceUrl',
  'cacheUrlShared',
] as const;

/**
 * An attachment id is stable across edits (especially annotation edits), so
 * id-only cleanup can delete a newer file that happens to reuse the id. Keep
 * every mutable serialized field in the click-time snapshot comparison.
 */
function areAttachedFileSnapshotsEqual(left: AttachedFile, right: AttachedFile): boolean {
  return (
    ATTACHED_FILE_SNAPSHOT_KEYS.every((key) => left[key] === right[key]) &&
    JSON.stringify(left.annotationStrokes ?? null) ===
      JSON.stringify(right.annotationStrokes ?? null)
  );
}

/**
 * Remove one click-time optimistic fragment while retaining newer composer
 * input. Text is removed only when the fragment is still an exact document
 * prefix; if the user edited that prefix, keeping it is safer than erasing
 * their edit. Attachments and comments use their stable ids independently.
 */
export function removeRemoteOptimisticDraftFragment(
  current: RemoteOptimisticDraftSnapshot,
  fragment: RemoteOptimisticDraftSnapshot,
): RemoteOptimisticDraftSnapshot {
  const currentDocument = current.text
    ? normalizeComposerDocumentJSON(current.text)
    : { type: 'doc' as const, content: [] };
  const fragmentDocument = fragment.text
    ? normalizeComposerDocumentJSON(fragment.text)
    : { type: 'doc' as const, content: [] };
  const currentBlocks = currentDocument.content ?? [];
  const fragmentBlocks = fragmentDocument.content ?? [];
  const prefixMatches =
    fragmentBlocks.length > 0 &&
    fragmentBlocks.length <= currentBlocks.length &&
    fragmentBlocks.every(
      (block, index) => JSON.stringify(currentBlocks[index]) === JSON.stringify(block),
    );
  const nextText = prefixMatches
    ? (() => {
        const remaining = currentBlocks.slice(fragmentBlocks.length);
        // Recovery insertion places an empty paragraph between an older
        // fragment and newer content. Remove that separator with the fragment
        // so accepting the deferred send does not leave a blank line behind.
        if (
          remaining.length > 1 &&
          remaining[0]?.type === 'paragraph' &&
          !tiptapDocHasContent(remaining[0])
        ) {
          remaining.shift();
        }
        return {
          type: 'doc' as const,
          content: remaining.length > 0 ? remaining : [{ type: 'paragraph' as const }],
        };
      })()
    : current.text;
  const fragmentAttachmentsById = new Map(fragment.attachments.map((file) => [file.id, file]));
  const fragmentCommentIds = new Set(fragment.browserComments.map((comment) => comment.id));
  return {
    text: nextText,
    attachments: current.attachments.filter((file) => {
      const fragmentFile = fragmentAttachmentsById.get(file.id);
      return !fragmentFile || !areAttachedFileSnapshotsEqual(file, fragmentFile);
    }),
    browserComments: current.browserComments.filter(
      (comment) => !fragmentCommentIds.has(comment.id),
    ),
  };
}

export interface RemoteOptimisticRecoveryCheckpoint {
  revision: number;
  textPrefix: readonly JSONContent[];
}

export interface RemoteOptimisticTransitionCheckpoint {
  storageKey: string;
  checkpoint: RemoteOptimisticRecoveryCheckpoint;
}

interface RemoteOptimisticRecoveryState {
  revision: number;
  seenClientIds: Set<string>;
  textPrefix: JSONContent[];
  attachmentPrefixIds: string[];
  commentPrefixIds: string[];
}

const drafts = new Map<string, ComposerDraft>();
const draftDiscardGenerations = new Map<string, number>();
const remoteOptimisticRecoveries = new Map<string, RemoteOptimisticRecoveryState>();
const remoteOptimisticRecoveryBatchSnapshots = new WeakMap<
  object,
  Map<string, RemoteOptimisticDraftSnapshot>
>();
let remoteOptimisticAttachmentUrls: string[] = [];
let activeDataOwnerId: string | null = null;

/**
 * Composer keys are process-local, so a renderer owner switch must not reuse
 * the previous owner's in-flight draft (especially the global New Maker slot).
 * Keep the raw session id at call sites while namespacing the backing store.
 */
function ownerPrefix(): string {
  return `owner:${encodeURIComponent(activeDataOwnerId ?? 'signed-out')}:`;
}

function draftKey(sessionId: string): string {
  return `${ownerPrefix()}${sessionId}`;
}

export function setComposerDraftOwner(ownerId: string | null): void {
  activeDataOwnerId = ownerId;
}

/**
 * External-write subscription: when an outside source (e.g. rewind) calls
 * `saveDraft` while the same session is already mounted in ChatInput, ChatInput
 * needs a way to know it should re-read the draft and force-set editor content.
 * The editor's restore-on-sessionId-change effect doesn't fire (sessionId
 * unchanged), so we publish a notify event the editor can listen to.
 *
 * Listeners are keyed by sessionId to avoid notifying every ChatInput instance
 * for unrelated drafts. Keystroke `saveDraft` calls from ChatInput itself are
 * tagged with `silent: true` so we don't loop the editor's own writes back into
 * a setContent reset (which would clobber the cursor and trigger another
 * onUpdate → another save → ...).
 */
type DraftListener = () => void;
const listeners = new Map<string, Set<DraftListener>>();

/**
 * Draft-PRESENCE subscription channel (composer-draft-sidebar-indicator).
 * -------------------------------------------------------------------------
 * Separate from `listeners` above on purpose. `listeners` exist so a mounted
 * ChatInput can re-read + setContent when an EXTERNAL writer (rewind / fork)
 * overwrites its draft — and ChatInput's own keystroke saves pass
 * `silent: true` to stay out of that loop. The sidebar, however, needs to know
 * about EXACTLY those keystroke saves ("does session X have a non-empty
 * draft?"), so it cannot ride the `silent`-gated `listeners` channel.
 *
 * This channel fires regardless of `silent`, but only when a session's
 * has-content boolean actually FLIPS (false↔true) — see `recomputeDraftPresence`.
 * So the common case (typing more into an already-non-empty draft) notifies
 * zero sidebar items; only the empty↔non-empty transitions do.
 */
const presenceListeners = new Map<string, Set<DraftListener>>();
/** Last-known has-content boolean per session — ONLY used to diff for change
 *  detection in `recomputeDraftPresence`. NOT the read source of truth
 *  (`getDraftPresence` always computes fresh). */
const presenceCache = new Map<string, boolean>();

/**
 * Whether a Tiptap JSON doc carries any real content. Mirrors `isEditorEmpty`
 * in ChatInput: a `mentionChip` / `pastedTextChip`(长文本粘贴折叠卡)node
 * counts as content, and any text node with non-whitespace text counts.
 * Empty paragraphs / whitespace-only → no content. 两处判定必须同步演进,
 * 否则「只含 chip 的草稿」侧边栏不亮未发送标记(review P2)。
 */
export function tiptapDocHasContent(node: JSONContent | null | undefined): boolean {
  if (!node) return false;
  if (
    node.type === 'mentionChip' ||
    node.type === 'pastedTextChip' ||
    node.type === COMPOSER_QUOTE_NODE_TYPE
  )
    return true;
  if (node.type === 'bulletList' || node.type === 'orderedList') return true;
  if (typeof node.text === 'string' && node.text.trim().length > 0) return true;
  if (Array.isArray(node.content)) {
    return node.content.some(tiptapDocHasContent);
  }
  return false;
}

/**
 * Whether a draft counts as "non-empty" for the sidebar indicator: it has real
 * text OR at least one attachment (image / file). Treats `undefined` as empty.
 */
export function draftHasContent(draft: ComposerDraft | undefined): boolean {
  if (!draft) return false;
  if (draft.attachments.length > 0) return true;
  if (draft.quotes && draft.quotes.length > 0) return true;
  if (draft.browserComments && draft.browserComments.length > 0) return true;
  return tiptapDocHasContent(draft.text);
}

/**
 * Recompute the has-content boolean for `sessionId` and notify presence
 * subscribers IFF it flipped. Called at the tail of every mutator
 * (`saveDraft` / `clearDraft` / `clearDraftAndNotify`), independent of the
 * `silent` flag — `silent` only gates the content `listeners` above.
 */
function recomputeDraftPresence(sessionId: string): void {
  const key = draftKey(sessionId);
  const next = draftHasContent(drafts.get(key));
  const prev = presenceCache.get(key) ?? false;
  if (next === prev) return;
  if (next) presenceCache.set(key, true);
  else presenceCache.delete(key);
  const set = presenceListeners.get(key);
  if (set)
    for (const fn of set) {
      try {
        fn();
      } catch (err) {
        log.warn('presence listener threw:', err);
      }
    }
}

/**
 * Read the draft for `sessionId`, or `undefined` if nothing was ever saved
 * (or it was cleared). Callers should treat `undefined` as "fresh, empty
 * composer".
 */
export function getDraft(sessionId: string): ComposerDraft | undefined {
  return drafts.get(draftKey(sessionId));
}

/** Capture the current process-local discard generation for async draft work. */
export function captureDraftDiscardToken(sessionId: string): ComposerDraftDiscardToken {
  const ownerScopedKey = draftKey(sessionId);
  return {
    ownerScopedKey,
    generation: draftDiscardGenerations.get(ownerScopedKey) ?? 0,
  };
}

/** Whether a captured draft scope has not been explicitly discarded. */
export function isDraftDiscardTokenCurrent(token: ComposerDraftDiscardToken): boolean {
  return (draftDiscardGenerations.get(token.ownerScopedKey) ?? 0) === token.generation;
}

/**
 * Whether `sessionId` currently has a non-empty draft (text or attachments).
 * Computed fresh on each call so it never drifts from the Map — cheap because
 * a draft doc is small. Used as the `useSyncExternalStore` getSnapshot in
 * `useComposerDraftPresence`; returns a boolean primitive so React bails out
 * of re-render when unchanged.
 */
export function getDraftPresence(sessionId: string): boolean {
  return draftHasContent(drafts.get(draftKey(sessionId)));
}

/**
 * Subscribe to has-content flips for `sessionId`. Returns an unsubscribe fn.
 * The sidebar's SessionItem uses this (via `useComposerDraftPresence`) to show
 * / hide its unsent-draft indicator.
 */
export function subscribeDraftPresence(sessionId: string, handler: DraftListener): () => void {
  const key = draftKey(sessionId);
  let set = presenceListeners.get(key);
  if (!set) {
    set = new Set();
    presenceListeners.set(key, set);
  }
  set.add(handler);
  return () => {
    const s = presenceListeners.get(key);
    if (!s) return;
    s.delete(handler);
    if (s.size === 0) presenceListeners.delete(key);
  };
}

/**
 * Save (or overwrite) the draft for `sessionId`. Called frequently — always
 * cheap (Map.set + reference copy of the attachments array).
 *
 * NOTE: `attachments` is stored by reference. The caller (`useAttachments`)
 * always holds an immutable snapshot from React state, so this is safe.
 *
 * `opts.silent` (default false): when true, skip notifying subscribers. Use
 * this from ChatInput's own keystroke handler to avoid feedback loops. Use
 * default (notify) from external writers like rewind / fork pre-fill.
 */
export function saveDraft(
  sessionId: string,
  draft: ComposerDraft,
  opts?: { silent?: boolean; preserveRemoteOptimisticRecovery?: boolean },
): void {
  const key = draftKey(sessionId);
  if (!opts?.silent && !opts?.preserveRemoteOptimisticRecovery) {
    remoteOptimisticRecoveries.delete(key);
  }
  const withQuotes =
    draft.quotes && draft.quotes.length > 0
      ? {
          ...draft,
          text: prependLegacyQuotesToComposerDocument(draft.text, draft.quotes),
          quotes: [],
        }
      : draft;
  drafts.set(key, withQuotes);
  if (!opts?.silent) {
    const set = listeners.get(key);
    if (set)
      for (const fn of set) {
        try {
          fn();
        } catch (err) {
          log.warn('listener threw:', err);
        }
      }
  }
  // Presence notify is independent of `silent` — the sidebar must learn about
  // keystroke saves (which are silent) too.
  recomputeDraftPresence(sessionId);
  syncDraftUrlsToMain();
}

/**
 * Drop the draft for `sessionId` from the Map. Idempotent.
 *
 * Call sites:
 * - After successful send (the composer is already cleared).
 * - When a session is deleted or archived (avoid Map leak).
 */
export function clearDraft(sessionId: string): void {
  const key = draftKey(sessionId);
  drafts.delete(key);
  remoteOptimisticRecoveries.delete(key);
  recomputeDraftPresence(sessionId);
  syncDraftUrlsToMain();
}

/**
 * Discard a draft and release dangerous attachment copies owned by it.
 * `clearDraft` intentionally remains a non-destructive primitive because it
 * is also used after a successful send, when message history still references
 * the attachment paths.
 */
export function discardDraft(sessionId: string): void {
  const key = draftKey(sessionId);
  const draft = drafts.get(key);
  if (draft) cleanupStagedChatAttachmentFiles(draft.attachments);
  draftDiscardGenerations.set(key, (draftDiscardGenerations.get(key) ?? 0) + 1);
  // Empty mounted editors/attachment trays before deleting the Map entry. This
  // mirrors a Mobile attachment controller dispose: unmount snapshots cannot
  // recreate the discarded draft, while late async files are fenced by the
  // generation above and recycled by their owner.
  clearDraftAndNotify(sessionId);
}

/**
 * Clear the draft for `sessionId` AND notify any mounted ChatInput subscribed
 * to this key so it empties its live editor synchronously.
 *
 * Why this exists (vs bare `clearDraft`): the New Maker draft route hands the
 * composer content off to a freshly-created session and then navigates away.
 * That route's `onSend` returns `false`, so ChatInput never runs its own
 * post-send `clearContent` — the typed text stays in the Tiptap editor. A bare
 * `clearDraft` only deletes the Map entry; on unmount ChatInput's cleanup
 * effect snapshots the still-populated editor back under the same key,
 * resurrecting the text the next time the route mounts.
 *
 * This helper publishes an explicit empty draft FIRST (so the subscriber's
 * "no text → clearContent" branch empties the live editor), THEN deletes the
 * entry. By the time the unmount cleanup runs, the editor is empty and the Map
 * has no entry, so it skips the re-save.
 */
export function clearDraftAndNotify(sessionId: string): void {
  const key = draftKey(sessionId);
  const set = listeners.get(key);
  if (set && set.size > 0) {
    // Stage an explicit empty draft, then notify: the subscriber reads
    // `getDraft` (must be present) and, seeing falsy text, clears its editor.
    drafts.set(key, { text: null, attachments: [] });
    for (const fn of set) {
      try {
        fn();
      } catch (err) {
        log.warn('clearDraftAndNotify listener threw:', err);
      }
    }
  }
  drafts.delete(key);
  remoteOptimisticRecoveries.delete(key);
  recomputeDraftPresence(sessionId);
  syncDraftUrlsToMain();
}

function normalizedDraftBlocks(document: JSONContent | null | undefined): JSONContent[] {
  if (!tiptapDocHasContent(document)) return [];
  const normalized = normalizeComposerDocumentJSON(document!);
  return normalized.type === 'doc' && Array.isArray(normalized.content) ? normalized.content : [];
}

function startsWithJsonBlocks(current: readonly JSONContent[], prefix: readonly JSONContent[]) {
  if (prefix.length > current.length) return false;
  return prefix.every((block, index) => JSON.stringify(current[index]) === JSON.stringify(block));
}

function startsWithIds(current: readonly string[], prefix: readonly string[]): boolean {
  if (prefix.length > current.length) return false;
  return prefix.every((id, index) => current[index] === id);
}

/** Snapshot the recovery prefix before an async editor/session transition. */
export function captureRemoteOptimisticRecoveryCheckpoint(
  sessionId: string,
): RemoteOptimisticRecoveryCheckpoint {
  const recovery = remoteOptimisticRecoveries.get(draftKey(sessionId));
  return {
    revision: recovery?.revision ?? 0,
    textPrefix: [...(recovery?.textPrefix ?? [])],
  };
}

/** Keep the first recovery snapshot while an editor still belongs to the same draft key. */
export function getOrCreateRemoteOptimisticTransitionCheckpoint(
  current: RemoteOptimisticTransitionCheckpoint | null,
  storageKey: string,
): RemoteOptimisticTransitionCheckpoint {
  if (current?.storageKey === storageKey) return current;
  return {
    storageKey,
    checkpoint: captureRemoteOptimisticRecoveryCheckpoint(storageKey),
  };
}

/**
 * Save an editor snapshot taken across an async transition (voice stop/refine).
 * If a remote failure restored text while the transition was waiting, retain
 * the latest recovered prefix and treat the old editor snapshot as its tail.
 */
export function saveComposerTextAfterAsyncTransition(
  sessionId: string,
  liveText: JSONContent | null,
  checkpoint: RemoteOptimisticRecoveryCheckpoint,
): void {
  const key = draftKey(sessionId);
  const recovery = remoteOptimisticRecoveries.get(key);
  let text = liveText;
  if (recovery && recovery.revision !== checkpoint.revision) {
    const liveBlocks = normalizedDraftBlocks(liveText);
    if (startsWithJsonBlocks(liveBlocks, recovery.textPrefix)) {
      text = {
        type: 'doc',
        content:
          liveBlocks.length > recovery.textPrefix.length
            ? liveBlocks
            : [...liveBlocks, { type: 'paragraph' }],
      };
    } else {
      const liveTail = startsWithJsonBlocks(liveBlocks, checkpoint.textPrefix)
        ? liveBlocks.slice(checkpoint.textPrefix.length)
        : liveBlocks;
      text = {
        type: 'doc',
        content: [
          ...recovery.textPrefix,
          ...(liveTail.length > 0 ? liveTail : [{ type: 'paragraph' }]),
        ],
      };
    }
  }

  const existing = drafts.get(key);
  saveDraft(
    sessionId,
    {
      text,
      attachments: existing?.attachments ?? [],
      quotes: existing?.quotes ?? [],
      browserComments: existing?.browserComments ?? [],
      ...(existing?.pendingGhostId ? { pendingGhostId: existing.pendingGhostId } : {}),
      ...(existing?.focusAtEnd ? { focusAtEnd: true } : {}),
    },
    { silent: true, preserveRemoteOptimisticRecovery: true },
  );
}

/**
 * Restore a permanently failed remote optimistic send at the end of the
 * already-restored prefix for this composer key. The cursor lives beside the
 * in-memory draft, so failures that settle across reconnects remain FIFO while
 * text/files/comments added during the wait stay after that prefix.
 */
export function restoreRemoteOptimisticDraft(
  sessionId: string,
  fragment: RemoteOptimisticDraftFragment,
  currentOverride?: RemoteOptimisticDraftSnapshot,
  opts?: { recoveryBatch?: object },
): ComposerDraft {
  const key = draftKey(sessionId);
  const existing = drafts.get(key);
  let batchSnapshots: Map<string, RemoteOptimisticDraftSnapshot> | undefined;
  if (opts?.recoveryBatch) {
    batchSnapshots = remoteOptimisticRecoveryBatchSnapshots.get(opts.recoveryBatch);
    if (!batchSnapshots) {
      batchSnapshots = new Map<string, RemoteOptimisticDraftSnapshot>();
      remoteOptimisticRecoveryBatchSnapshots.set(opts.recoveryBatch, batchSnapshots);
    }
  }
  const effectiveOverride = batchSnapshots?.get(key) ?? currentOverride;
  const currentText = effectiveOverride
    ? effectiveOverride.text
    : prependLegacyQuotesToComposerDocument(existing?.text ?? null, existing?.quotes ?? []);
  const currentAttachments = [...(effectiveOverride?.attachments ?? existing?.attachments ?? [])];
  const currentComments = [
    ...(effectiveOverride?.browserComments ?? existing?.browserComments ?? []),
  ];
  const baseDraft: ComposerDraft = {
    text: currentText,
    attachments: currentAttachments,
    quotes: [],
    browserComments: currentComments,
    ...(existing?.pendingGhostId ? { pendingGhostId: existing.pendingGhostId } : {}),
    ...(existing?.focusAtEnd ? { focusAtEnd: true } : {}),
  };
  const rememberBatchSnapshot = (draft: ComposerDraft): void => {
    batchSnapshots?.set(key, {
      text: draft.text,
      attachments: draft.attachments,
      browserComments: draft.browserComments ?? [],
    });
  };

  let recovery = remoteOptimisticRecoveries.get(key);
  if (!recovery) {
    recovery = {
      revision: 0,
      seenClientIds: new Set<string>(),
      textPrefix: [],
      attachmentPrefixIds: [],
      commentPrefixIds: [],
    };
    remoteOptimisticRecoveries.set(key, recovery);
  }
  if (recovery.seenClientIds.has(fragment.clientId)) {
    rememberBatchSnapshot(baseDraft);
    return baseDraft;
  }

  const currentBlocks = normalizedDraftBlocks(currentText);
  const attachmentIds = currentAttachments.map((file) => file.id);
  const commentIds = currentComments.map((comment) => comment.id);
  if (!startsWithJsonBlocks(currentBlocks, recovery.textPrefix)) recovery.textPrefix = [];
  if (!startsWithIds(attachmentIds, recovery.attachmentPrefixIds)) {
    recovery.attachmentPrefixIds = [];
  }
  if (!startsWithIds(commentIds, recovery.commentPrefixIds)) recovery.commentPrefixIds = [];

  let restoredText = currentText;
  if (tiptapDocHasContent(fragment.text)) {
    const insertion = insertComposerDocumentForRestore(
      fragment.text!,
      currentText ?? { type: 'doc', content: [] },
      recovery.textPrefix.length,
    );
    restoredText = insertion.document;
    recovery.textPrefix.push(...insertion.insertedBlocks);
  }

  const restoredAttachments = [...currentAttachments];
  const attachmentIdSet = new Set(restoredAttachments.map((file) => file.id));
  const insertedAttachments = fragment.attachments.filter((file) => {
    if (attachmentIdSet.has(file.id)) return false;
    attachmentIdSet.add(file.id);
    return true;
  });
  restoredAttachments.splice(recovery.attachmentPrefixIds.length, 0, ...insertedAttachments);
  recovery.attachmentPrefixIds.push(...insertedAttachments.map((file) => file.id));

  const restoredComments = [...currentComments];
  const commentIdSet = new Set(restoredComments.map((comment) => comment.id));
  const insertedComments = fragment.browserComments.filter((comment) => {
    if (commentIdSet.has(comment.id)) return false;
    commentIdSet.add(comment.id);
    return true;
  });
  restoredComments.splice(recovery.commentPrefixIds.length, 0, ...insertedComments);
  recovery.commentPrefixIds.push(...insertedComments.map((comment) => comment.id));
  recovery.seenClientIds.add(fragment.clientId);
  recovery.revision += 1;

  const restored: ComposerDraft = {
    ...baseDraft,
    text: restoredText,
    attachments: restoredAttachments,
    browserComments: restoredComments,
  };
  rememberBatchSnapshot(restored);
  saveDraft(sessionId, restored, {
    // A live caller applies the returned snapshot itself to preserve its focus
    // and selection. A background recovery must notify any mounted view that
    // now owns this key, while keeping the FIFO cursor for later failures.
    silent: effectiveOverride !== undefined,
    preserveRemoteOptimisticRecovery: true,
  });
  return restored;
}

/**
 * 媒体回收器活引用取证(recycler.ts 的输入框草稿暂存区):全部会话草稿附件的
 * URL。草稿附件和尚未受理的远程乐观发送都是合法的零引用 blob，而这些状态
 * 只在 renderer 内存，main 读不到——存储清理由设置页发起时把这份清单随 IPC
 * 带给 main，回收器把它们当活引用豁免。宁可多报(混着老 xdt-image 地址也
 * 没关系，main 侧只抽 cindy-media 指纹)。
 */
export function getAllDraftAttachmentUrls(): string[] {
  const urls = new Set<string>(remoteOptimisticAttachmentUrls);
  // Owner switches retain each owner's draft so switching back can restore it.
  // Protect every retained namespace as well; reporting only the active owner
  // would leave an old owner's still-restorable attachment eligible for sweep.
  for (const draft of drafts.values()) {
    for (const att of draft.attachments) {
      if (att.url) urls.add(att.url);
      if (att.annotationSourceUrl) urls.add(att.annotationSourceUrl);
    }
    for (const comment of draft.browserComments ?? []) {
      if (comment.screenshot.url) urls.add(comment.screenshot.url);
      if (comment.screenshot.annotationSourceUrl) {
        urls.add(comment.screenshot.annotationSourceUrl);
      }
    }
  }
  return [...urls];
}

/** Keep media referenced by a not-yet-accepted remote outbox item live. */
export function setRemoteOptimisticAttachmentUrls(urls: readonly string[]): void {
  const next = [...new Set(urls)].sort();
  if (
    next.length === remoteOptimisticAttachmentUrls.length &&
    next.every((url, index) => url === remoteOptimisticAttachmentUrls[index])
  ) {
    return;
  }
  remoteOptimisticAttachmentUrls = next;
  syncDraftUrlsToMain();
}

/**
 * 草稿附件集合变化时把全量 URL 推给 main 登记(多窗口防误删:每个窗口是
 * 独立 renderer 进程、各一份本 Map,别的窗口发起清理时只能靠 main 侧登记表
 * 豁免本窗口的草稿)。按序列化去重,键击级 saveDraft 不产生重复 IPC;上报
 * 失败静默——取证是尽力而为的保护信号,绝不影响输入本身。
 */
let lastReportedDraftUrlsKey = '';
function syncDraftUrlsToMain(): void {
  try {
    const urls = getAllDraftAttachmentUrls();
    const key = urls.join('\n');
    if (key === lastReportedDraftUrlsKey) return;
    lastReportedDraftUrlsKey = key;
    window.electronAPI?.cindyMediaStorage?.reportDraftUrls?.(urls);
  } catch (err) {
    log.warn('draft url report failed:', err);
  }
}

/**
 * chat-text-quote:向会话草稿正文末尾追加一条引用(非 silent——挂载中的
 * ChatInput 立即刷新正文并把光标放到引用右侧)。
 */
export function appendQuoteToDraft(sessionId: string, quote: ChatQuote): void {
  const existing = getDraft(sessionId);
  const currentDocument = prependLegacyQuotesToComposerDocument(
    existing?.text,
    existing?.quotes ?? [],
  );
  saveDraft(
    sessionId,
    {
      ...existing,
      text: appendQuoteToComposerDocument(currentDocument, quote),
      attachments: existing?.attachments ?? [],
      quotes: [],
      browserComments: existing?.browserComments ?? [],
    },
    { preserveRemoteOptimisticRecovery: true },
  );
}

/**
 * browser-comment-chip:向会话草稿追加一条页面评论(非 silent——挂载中的
 * ChatInput 经 subscribeDraft 立即刷新评论胶囊)。web-browser 插件的
 * useBrowserComment 提交流程调用。
 */
export function appendBrowserCommentToDraft(
  sessionId: string,
  item: BrowserCommentDraftItem,
): void {
  const existing = getDraft(sessionId);
  saveDraft(
    sessionId,
    {
      text: existing?.text ?? null,
      attachments: existing?.attachments ?? [],
      quotes: existing?.quotes ?? [],
      browserComments: [...(existing?.browserComments ?? []), item],
    },
    { preserveRemoteOptimisticRecovery: true },
  );
}

/**
 * Wrap a plain string into a minimal Tiptap doc so it can be fed to
 * `saveDraft({ text })`. Used by the queue-tail-rewind path: when the user
 * cancels a queued message, its already-serialized plain text is re-injected
 * into the ChatInput editor via setContent. mention chips don't survive this
 * round-trip — the text shows as the literal string the chip serialized to
 * (e.g. `@some/path`), which is acceptable for an undo affordance.
 */
export function plainTextToTiptapDoc(text: string): JSONContent {
  return plainTextToComposerDocument(text);
}

/**
 * 递归给文档中所有 text 节点附加 quickStartPill mark（非 text 节点原样保留）。
 * 用于在 plainTextToComposerDocument 生成的规范化文档（含列表/围栏代码块）
 * 上统一加 mark，保证 quick-start 文本即使包含 markdown 列表标记也能
 * 正确渲染，行为与 plainTextToTiptapDoc 真正同构（review 反馈）。
 */
function applyQuickStartPillMark(node: JSONContent): JSONContent {
  if (node.type === 'text') {
    return {
      ...node,
      marks: [...(node.marks ?? []), { type: 'quickStartPill' }],
    };
  }
  if (Array.isArray(node.content)) {
    return { ...node, content: node.content.map(applyQuickStartPillMark) };
  }
  return node;
}

/**
 * 与 plainTextToTiptapDoc 相同，但给文本附加 quickStartPill mark，
 * 使编辑器渲染为黑底白字胶囊标签（视觉区分卡片预填 vs 手动输入）。
 * 复用 plainTextToComposerDocument 保证列表/围栏/空段落规范化行为一致，
 * 再递归给所有 text 节点加 mark（review：不能绕过 normalizeComposerDocumentJSON）。
 */
export function quickStartTextToTiptapDoc(text: string): JSONContent {
  const normalized = plainTextToComposerDocument(text);
  return applyQuickStartPillMark(normalized);
}

/**
 * Subscribe to external writes for `sessionId`. Returns an unsubscribe fn.
 * ChatInput uses this to force-setContent when an outside writer (rewind /
 * fork pre-fill) updates the draft for the currently-mounted session.
 */
export function subscribeDraft(sessionId: string, handler: DraftListener): () => void {
  const key = draftKey(sessionId);
  let set = listeners.get(key);
  if (!set) {
    set = new Set();
    listeners.set(key, set);
  }
  set.add(handler);
  return () => {
    const s = listeners.get(key);
    if (!s) return;
    s.delete(handler);
    if (s.size === 0) listeners.delete(key);
  };
}
