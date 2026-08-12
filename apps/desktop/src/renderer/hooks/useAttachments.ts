/**
 * useAttachments.ts
 * ---------------------------------------------------------------------------
 * Manages the attachment lifecycle for ChatInput (F-FI-1/2/5).
 *
 * image-local-cache (image-local-cache feature):
 *   - addFiles / addClipboardImage no longer base64-load images in the renderer.
 *     Drag-drop files are copied via IPC into userData/cc-agent/images/{sessionId}/
 *     and tracked by an xdt-image:// URL. Clipboard images go via writeBuffer.
 *   - F6 fallback: if the cache write fails, we drop back to in-memory base64
 *     and toast a warning ("会话重启后会丢失"). PDFs and text files still go
 *     through the original base64/utf8 path.
 *   - All blob-URL thumbnail logic has been removed (the same xdt-image:// URL
 *     is used for the input-area chip and persistent message rendering).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from '@/lib/toast';
import { createLogger } from '@/lib/logger';
import type { ComposerFileMentionPayload } from '@/lib/composerMentionDrag';
import { isDangerousAttachmentName } from '../../shared/attachmentSafety';

const log = createLogger('UseAttachments');
import {
  validateFiles,
  categorizeFile,
  categorizeByFilename,
  extractExt,
  getMimeType,
  type AttachedFile,
  type AttachedFileInput,
} from '@/lib/fileTypes';
import { inferFileType, base64ToUint8Array, PEEK_BYTES } from '@/lib/fileTypeInference';
import {
  captureDraftDiscardToken,
  getDraft as getComposerDraft,
  isDraftDiscardTokenCurrent,
  saveDraft as saveComposerDraft,
  subscribeDraft as subscribeComposerDraft,
  type ComposerDraftDiscardToken,
} from '@/lib/composerDraftStore';
import { cleanupStagedChatAttachmentFiles } from '@/lib/chatAttachmentStageCleanup';
import {
  getDataOwnerGeneration,
  isDataOwnerGenerationCurrent,
  type DataOwnerGeneration,
} from '@/contexts/dataOwnerGeneration';

/**
 * A single "this file did not get attached" rejection, surfaced inline in the
 * composer (next to the thumbnail strip) instead of via a top-center toast.
 * `message` is the fully-localized line (same text the toast used to show).
 */
export interface AttachmentRejection {
  id: string;
  message: string;
}

export interface UseAttachmentsReturn {
  attachments: AttachedFile[];
  hasAttachments: boolean;
  addFiles: (fileList: FileList | readonly File[]) => Promise<void>;
  addClipboardImage: (blob: Blob) => Promise<void>;
  /**
   * Files rejected on the most recent add attempt (oversize / empty / blocked
   * type / max-files / read failure). Rendered inline near the composer; stays
   * until the next add attempt, manual dismiss, or clearFiles.
   */
  rejections: AttachmentRejection[];
  /** Dismiss a single inline rejection row. */
  dismissRejection: (id: string) => void;
  /** Clear all inline rejections. */
  clearRejections: () => void;
  /** Queue a folder path for insertion as an @dir mention chip. */
  addFolderPath: (folderPath: string) => void;
  /** Bumps whenever a pending folder path is queued. */
  pendingFoldersVersion: number;
  /** Drain and return all queued folder paths (clears the queue). */
  consumePendingFolders: () => string[];
  /** Queue a file mention payload for insertion as an @file chip. */
  addFileMention: (payload: ComposerFileMentionPayload) => void;
  /** Bumps whenever a pending file mention is queued. */
  pendingFileMentionsVersion: number;
  /** Drain and return all queued file mentions (clears the queue). */
  consumePendingFileMentions: () => ComposerFileMentionPayload[];
  removeFile: (id: string) => void;
  /**
   * 就地更新一个附件(标注编辑保存后替换 url / 笔迹数据等)。id 不存在时 no-op。
   */
  updateFile: (id: string, patch: Partial<AttachedFile>) => void;
  /** Discard unsent files and remove any staged dangerous copies. */
  discardFiles: () => void;
  /** 失败时按 id 合并恢复本批附件，保留 RTT 期间新加的附件。 */
  restoreFiles: (files: readonly AttachedFile[]) => AttachedFile[];
  clearFiles: () => void;
}

interface AttachmentDraftScope {
  storageKey: string | undefined;
  dataOwner: DataOwnerGeneration;
  discardToken: ComposerDraftDiscardToken | undefined;
}

interface AttachmentOperationScope extends AttachmentDraftScope {
  sessionId: string | undefined;
}

function isSameAttachmentDraftScope(
  left: AttachmentDraftScope | undefined,
  right: AttachmentDraftScope,
): boolean {
  return (
    left !== undefined &&
    left.storageKey === right.storageKey &&
    left.dataOwner.dataOwnerId === right.dataOwner.dataOwnerId &&
    left.dataOwner.generation === right.dataOwner.generation &&
    left.discardToken?.ownerScopedKey === right.discardToken?.ownerScopedKey &&
    left.discardToken?.generation === right.discardToken?.generation
  );
}

function isAttachmentDraftScopeActive(scope: AttachmentDraftScope): boolean {
  return (
    isDataOwnerGenerationCurrent(scope.dataOwner) &&
    (scope.discardToken === undefined || isDraftDiscardTokenCurrent(scope.discardToken))
  );
}

function isSameAttachmentOperationScope(
  left: AttachmentOperationScope,
  right: AttachmentOperationScope,
): boolean {
  return left.sessionId === right.sessionId && isSameAttachmentDraftScope(left, right);
}

function mergeAttachmentsById(
  existing: readonly AttachedFile[],
  incoming: readonly AttachedFile[],
): AttachedFile[] {
  const knownIds = new Set(existing.map((file) => file.id));
  return [...existing, ...incoming.filter((file) => !knownIds.has(file.id))];
}

/**
 * Read a Blob as base64 (drops the data:URI prefix). Used only as F6
 * fallback when the cache write fails — the primary clipboard path goes
 * straight from arrayBuffer → IPC → cache file.
 */
function blobToBase64(blob: Blob): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      const idx = result.indexOf(',');
      resolve(idx >= 0 ? result.slice(idx + 1) : result);
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

export function cleanupRemovedCachedImage(file: Pick<AttachedFile, 'url'> | undefined): void {
  if (!file?.url?.startsWith('xdt-image://')) return;
  try {
    void window.electronAPI.cleanupCachedImages([file.url]).catch((err: unknown) => {
      log.warn('cleanup removed image failed:', err);
    });
  } catch (err) {
    log.warn('cleanup removed image failed:', err);
  }
}

/**
 * @param sessionId  Required for image cache writes. When undefined, image
 *                   uploads cannot be cached and fall back to base64 with a
 *                   toast warning. Non-image files are unaffected.
 * @param draftKey   Optional override for the composerDraftStore key used to
 *                   persist attachments across mount/unmount. Defaults to
 *                   `sessionId`. Pass an explicit sentinel (e.g. the new-maker
 *                   transient draft) when there is no real backend session yet
 *                   but you still want sidebar-switch survival.
 */
export function useAttachments(sessionId?: string, draftKey?: string): UseAttachmentsReturn {
  const { t } = useTranslation();
  const [attachments, setAttachments] = useState<AttachedFile[]>([]);
  const attachmentsRef = useRef<AttachedFile[]>(attachments);

  // The persistence layer is keyed by draftKey when provided, else sessionId.
  const storageKey = draftKey ?? sessionId;
  const dataOwner = getDataOwnerGeneration();
  const discardToken = useMemo(
    () => (storageKey ? captureDraftDiscardToken(storageKey) : undefined),
    [dataOwner, storageKey],
  );
  const attachmentOperationScopeRef = useRef<AttachmentOperationScope>({
    sessionId,
    storageKey,
    dataOwner,
    discardToken,
  });
  attachmentOperationScopeRef.current = { sessionId, storageKey, dataOwner, discardToken };

  // Inline rejections (file-too-large etc.). Surfaced in the composer instead
  // of a transient top-center toast, which was easy to miss. Transient UI only
  // — never persisted to composerDraftStore.
  const [rejections, setRejections] = useState<AttachmentRejection[]>([]);
  const pushRejections = useCallback((messages: string[]) => {
    if (messages.length === 0) return;
    setRejections((prev) => [
      ...prev,
      ...messages.map((message) => ({ id: crypto.randomUUID(), message })),
    ]);
  }, []);
  const dismissRejection = useCallback((id: string) => {
    setRejections((prev) => prev.filter((r) => r.id !== id));
  }, []);
  const clearRejections = useCallback(() => {
    setRejections([]);
  }, []);

  const appendAttachments = useCallback((items: readonly AttachedFile[]) => {
    if (items.length === 0) return;
    const knownIds = new Set(attachmentsRef.current.map((file) => file.id));
    attachmentsRef.current = [
      ...attachmentsRef.current,
      ...items.filter((file) => !knownIds.has(file.id)),
    ];
    setAttachments((prev) => {
      const prevIds = new Set(prev.map((file) => file.id));
      const next = [...prev, ...items.filter((file) => !prevIds.has(file.id))];
      attachmentsRef.current = next;
      return next;
    });
  }, []);

  // Keep refs in sync with latest props/state — addFiles/addClipboardImage
  // close over them via ref to avoid stale closures.
  attachmentsRef.current = attachments;

  const isAttachmentOperationScopeCurrent = useCallback(
    (scope: AttachmentOperationScope): boolean =>
      isAttachmentDraftScopeActive(scope) &&
      isSameAttachmentOperationScope(attachmentOperationScopeRef.current, scope),
    [],
  );

  const pushScopedRejections = useCallback(
    (scope: AttachmentOperationScope, messages: string[]) => {
      if (!isAttachmentOperationScopeCurrent(scope)) return;
      pushRejections(messages);
    },
    [isAttachmentOperationScopeCurrent, pushRejections],
  );

  const settleAttachmentsForScope = useCallback(
    (scope: AttachmentOperationScope, items: readonly AttachedFile[]) => {
      if (items.length === 0) return;
      if (!isAttachmentDraftScopeActive(scope)) {
        for (const item of items) cleanupRemovedCachedImage(item);
        cleanupStagedChatAttachmentFiles(items);
        return;
      }
      if (isSameAttachmentOperationScope(attachmentOperationScopeRef.current, scope)) {
        appendAttachments(items);
        return;
      }
      if (!scope.storageKey) {
        for (const item of items) cleanupRemovedCachedImage(item);
        cleanupStagedChatAttachmentFiles(items);
        return;
      }
      const existing = getComposerDraft(scope.storageKey);
      saveComposerDraft(
        scope.storageKey,
        {
          text: existing?.text ?? null,
          attachments: mergeAttachmentsById(existing?.attachments ?? [], items),
          quotes: existing?.quotes ?? [],
          browserComments: existing?.browserComments ?? [],
          ...(existing?.pendingGhostId ? { pendingGhostId: existing.pendingGhostId } : {}),
          ...(existing?.pendingHostCapabilityGhostId
            ? { pendingHostCapabilityGhostId: existing.pendingHostCapabilityGhostId }
            : {}),
          ...(existing?.focusAtEnd ? { focusAtEnd: true } : {}),
        },
        { silent: true },
      );
    },
    [appendAttachments],
  );

  // ── Per-session draft (composer-draft-per-session) ──
  // Save current attachments back to the store on unmount / sessionId-change,
  // and restore from the store on mount / sessionId-change.
  //
  // Why a cleanup-based save (instead of only saving when sessionId changes
  // within the same instance):
  //   MainLayout wraps <Outlet /> in <FadeSwitcher key={location.pathname}>.
  //   Switching sessions in the sidebar changes the pathname, which destroys
  //   the FadeSwitcher (and CCAgentSessionView underneath it) and mounts a
  //   fresh one. The OLD instance's effect never gets to "react to a sessionId
  //   change" — it just dies. Any attachments dropped in session A but not
  //   yet persisted to the store are lost. The cleanup runs on both unmount
  //   (FadeSwitcher remount path) and on dep-change (in-place sessionId path),
  //   so the snapshot is preserved either way.
  //
  // Text doesn't have this bug because ChatInput.onUpdate writes to the store
  // on every keystroke — by the time of unmount, text is already in the store.
  // Attachments only existed in React state, hence the asymmetry the user saw.
  const previousDraftScopeRef = useRef<AttachmentDraftScope | undefined>(undefined);
  useEffect(() => {
    if (!isDataOwnerGenerationCurrent(dataOwner)) return;
    const draftScope: AttachmentDraftScope = { storageKey, dataOwner, discardToken };
    if (storageKey === undefined) {
      previousDraftScopeRef.current = draftScope;
      return;
    }
    const previousScope = previousDraftScopeRef.current;
    const draftScopeChanged = !isSameAttachmentDraftScope(previousScope, draftScope);

    // In-feature session switch (e.g. /cc-agent/:sessionId keeps the same hook
    // instance): rejections are transient and belong to the previous session,
    // so drop them. Fresh mounts start at [], so this is a no-op there.
    if (previousScope !== undefined && draftScopeChanged) {
      setRejections([]);
    }

    // Restore from the store. On a fresh remount (FadeSwitcher), the store
    // may already hold attachments saved by the previous instance's cleanup.
    // On in-place key change, the cleanup that just ran for the previous key has
    // already saved the OLD session's attachments — now restore the NEW one.
    const restored = getComposerDraft(storageKey);
    if (restored?.attachments && restored.attachments.length > 0) {
      setAttachments(restored.attachments);
    } else if (previousScope !== undefined && draftScopeChanged) {
      // In-place switch to a session with no saved attachments: clear stale
      // state. (Fresh mounts already start at [], so the no-op set is skipped.)
      setAttachments([]);
    }

    previousDraftScopeRef.current = draftScope;

    return () => {
      if (!isAttachmentDraftScopeActive(draftScope)) return;
      // Snapshot current attachments under the storageKey we were associated
      // with at this render. Closure captures the right key for both
      // unmount and dep-change paths. Preserve any text the ChatInput
      // keystroke handler last wrote — this writer only owns attachments.
      const existing = getComposerDraft(storageKey);
      saveComposerDraft(
        storageKey,
        {
          text: existing?.text ?? null,
          attachments: attachmentsRef.current,
          quotes: existing?.quotes ?? [],
          browserComments: existing?.browserComments ?? [],
          ...(existing?.pendingGhostId ? { pendingGhostId: existing.pendingGhostId } : {}),
          ...(existing?.pendingHostCapabilityGhostId
            ? { pendingHostCapabilityGhostId: existing.pendingHostCapabilityGhostId }
            : {}),
          ...(existing?.focusAtEnd ? { focusAtEnd: true } : {}),
        },
        { silent: true },
      );
    };
  }, [dataOwner, storageKey]);

  // Same-session external draft writes (rewind/fork prefill) must replace the
  // parent-held attachment list immediately. Session switches are handled by
  // the restore effect above; this covers the "storageKey did not change" path.
  useEffect(() => {
    if (storageKey === undefined || !isDataOwnerGenerationCurrent(dataOwner)) return;
    return subscribeComposerDraft(storageKey, () => {
      if (!isDataOwnerGenerationCurrent(dataOwner)) return;
      const draft = getComposerDraft(storageKey);
      const next = draft?.attachments ?? [];
      attachmentsRef.current = next;
      setAttachments(next);
    });
  }, [dataOwner, storageKey]);

  // 附件变化实时(silent)镜像进 composerDraftStore,而非只在 unmount 快照。
  // 外部写入方(图片 lightbox 的"发送到对话")按 store 内容做合并追加;若 store
  // 落后于挂载中的托盘,合并会基于过期快照并经上面的订阅回灌,静默吞掉用户
  // 已添加的附件(review P2)。
  // lastSyncedKeyRef 守卫两个"state 与 key 不同步"的窗口,此时绝不能写:
  //   1. 挂载首帧:attachments 仍是初始 [],写入会把待恢复的 draft 清空一拍;
  //   2. in-place 会话切换帧:attachments 仍是旧会话值,写入会把 A 会话的
  //      附件串写进 B 会话的 draft。
  const lastSyncedDraftScopeRef = useRef<AttachmentDraftScope | undefined>(undefined);
  useEffect(() => {
    if (storageKey === undefined || !isDataOwnerGenerationCurrent(dataOwner)) return;
    const draftScope: AttachmentDraftScope = { storageKey, dataOwner, discardToken };
    if (!isAttachmentDraftScopeActive(draftScope)) return;
    if (!isSameAttachmentDraftScope(lastSyncedDraftScopeRef.current, draftScope)) {
      lastSyncedDraftScopeRef.current = draftScope;
      return;
    }
    const existing = getComposerDraft(storageKey);
    // `discardDraft` synchronously clears mounted attachment state. Its state
    // update may render once before navigation; do not recreate an empty Map
    // entry after the explicit discard boundary.
    if (!existing && attachments.length === 0) return;
    saveComposerDraft(
      storageKey,
      // saveDraft 是整对象替换:text / quotes / browserComments 都必须从
      // existing 带上,否则增删附件会静默清掉草稿里的选中引用 / 页面评论
      // (review P2 同款教训)。
      {
        text: existing?.text ?? null,
        attachments,
        quotes: existing?.quotes ?? [],
        browserComments: existing?.browserComments ?? [],
        ...(existing?.pendingGhostId ? { pendingGhostId: existing.pendingGhostId } : {}),
        ...(existing?.pendingHostCapabilityGhostId
          ? { pendingHostCapabilityGhostId: existing.pendingHostCapabilityGhostId }
          : {}),
        ...(existing?.focusAtEnd ? { focusAtEnd: true } : {}),
      },
      { silent: true },
    );
  }, [attachments, dataOwner, storageKey]);

  // ── Folder path queue ──
  // Drop handlers push folder paths here; ChatInput consumes them as
  // @dir mention chips (it has editor access, useAttachments does not).
  const pendingFoldersRef = useRef<string[]>([]);
  const [pendingFoldersVersion, setPendingFoldersVersion] = useState(0);

  const addFolderPath = useCallback((folderPath: string) => {
    pendingFoldersRef.current = [...pendingFoldersRef.current, folderPath];
    setPendingFoldersVersion((version) => version + 1);
  }, []);

  const consumePendingFolders = useCallback((): string[] => {
    const paths = pendingFoldersRef.current;
    pendingFoldersRef.current = [];
    return paths;
  }, []);

  const pendingFileMentionsRef = useRef<ComposerFileMentionPayload[]>([]);
  const [pendingFileMentionsVersion, setPendingFileMentionsVersion] = useState(0);

  const addFileMention = useCallback((payload: ComposerFileMentionPayload) => {
    pendingFileMentionsRef.current = [...pendingFileMentionsRef.current, payload];
    setPendingFileMentionsVersion((version) => version + 1);
  }, []);

  const consumePendingFileMentions = useCallback((): ComposerFileMentionPayload[] => {
    const payloads = pendingFileMentionsRef.current;
    pendingFileMentionsRef.current = [];
    return payloads;
  }, []);

  const addFiles = useCallback(
    async (fileList: FileList | readonly File[]) => {
      const operationScope = attachmentOperationScopeRef.current;
      const attachmentCountAtStart = attachmentsRef.current.length;
      // Fresh attempt: clear stale rejections so the inline strip reflects only
      // this drop's failures.
      setRejections([]);
      // ── Step 1: collect rawFiles, intercept obvious failure cases up-front ──
      // In sandboxed Electron (20+), File.path is unavailable — use
      // webUtils.getPathForFile() exposed via preload bridge instead.
      type RawFile = { name: string; path: string; size: number; file: File };
      const rawFiles: RawFile[] = [];
      const earlyErrors: { name: string; reason: string }[] = [];
      for (const f of Array.from(fileList)) {
        let filePath = '';
        try {
          filePath = window.electronAPI.getFilePath(f);
        } catch {
          // Fallback: try legacy File.path (non-sandboxed builds)
          filePath = (f as File & { path?: string }).path ?? '';
        }
        if (!filePath) {
          pushScopedRejections(operationScope, [
            t('logic.toasts.attachmentLocalOnly', { name: f.name }),
          ]);
          continue;
        }
        // F-FI-8 spec step 1: 0-byte files are intercepted here so they never
        // reach the peek IPC (would otherwise produce an "无法识别" instead of
        // the more accurate "文件为空" error).
        if (f.size === 0) {
          earlyErrors.push({ name: f.name, reason: t('logic.fileTypes.fileEmpty') });
          continue;
        }
        rawFiles.push({ name: f.name, path: filePath, size: f.size, file: f });
      }

      // ── Step 2: split into known / unknown by extension/filename ──
      const knownRaw: RawFile[] = [];
      const unknownRaw: RawFile[] = [];
      for (const raw of rawFiles) {
        const ext = extractExt(raw.name);
        const category = ext ? categorizeFile(ext) : categorizeByFilename(raw.name);
        if (category) {
          knownRaw.push(raw);
        } else {
          unknownRaw.push(raw);
        }
      }

      // ── Step 3: enrich unknown files via peek-IPC + magic/UTF-8 inference ──
      // Promise.all is fine: max 20 files per drop, IPC pressure negligible.
      type EnrichResult =
        { ok: true; raw: RawFile; ext: string } | { ok: false; raw: RawFile; reason: string };

      const enrichmentResults: EnrichResult[] = await Promise.all(
        unknownRaw.map(async (r): Promise<EnrichResult> => {
          try {
            const peek = await window.electronAPI.peekFileHeader({
              filePath: r.path,
              bytes: PEEK_BYTES,
            });
            if (!peek.success)
              return { ok: false, raw: r, reason: t('logic.fileTypes.readFailed') };
            // Defensive: step 1 already filters f.size === 0, but a file may have
            // been truncated between drop and peek.
            if (peek.actualBytes === 0 || !peek.data) {
              return { ok: false, raw: r, reason: t('logic.fileTypes.fileEmpty') };
            }
            const buffer = base64ToUint8Array(peek.data);
            const inferred = inferFileType(buffer);
            if (!inferred) return { ok: true, raw: r, ext: '' };
            return { ok: true, raw: r, ext: inferred.ext };
          } catch {
            return { ok: false, raw: r, reason: t('logic.fileTypes.readFailed') };
          }
        }),
      );
      if (!isDataOwnerGenerationCurrent(operationScope.dataOwner)) return;

      // ── Step 4: validate known via existing validateFiles, validate enriched
      //           locally (cannot reuse validateFiles — it would extractExt(name)
      //           on the original filename and discard the inferred ext) ──
      const knownResult = validateFiles(
        knownRaw.map((r) => ({ name: r.name, path: r.path, size: r.size })),
        attachmentCountAtStart,
      );

      const enrichedOk = enrichmentResults.filter(
        (r): r is Extract<EnrichResult, { ok: true }> => r.ok,
      );
      const validInferred: AttachedFileInput[] = [];
      for (const r of enrichedOk) {
        const category = r.ext ? (categorizeFile(r.ext) ?? 'file') : 'file';
        const mimeType = getMimeType(r.ext, category);
        validInferred.push({
          name: r.raw.name, // keep original filename (spec)
          path: r.raw.path,
          size: r.raw.size,
          ext: r.ext, // inferred extension drives mime + downstream branch
          category,
          mimeType,
        });
      }

      // ── Step 5: merge errors, toast each one, then merge valid lists ──
      const inferenceErrors = enrichmentResults
        .filter((r): r is Extract<EnrichResult, { ok: false }> => !r.ok)
        .map((r) => ({ name: r.raw.name, reason: r.reason }));

      const allErrors = [...earlyErrors, ...inferenceErrors, ...knownResult.errors];
      pushScopedRejections(
        operationScope,
        allErrors.map((err) =>
          t('logic.toasts.attachmentReadError', { name: err.name, reason: err.reason }),
        ),
      );

      const valid = [...knownResult.valid, ...validInferred];
      if (valid.length === 0) return;

      // IPC read for each valid file
      const newAttachments: AttachedFile[] = [];
      const currentSessionId = operationScope.sessionId;

      for (const item of valid) {
        if (!isDataOwnerGenerationCurrent(operationScope.dataOwner)) break;
        let stagedAttachmentPath: string | null = null;
        try {
          let attachmentPath = item.path;
          if (isDangerousAttachmentName(item.name) || isDangerousAttachmentName(item.path)) {
            const staged = await window.electronAPI.stageChatAttachment({
              sourcePath: item.path,
              suggestedName: item.name,
            });
            if (!staged.success) {
              pushScopedRejections(operationScope, [
                t('logic.toasts.attachmentReadFailed', {
                  name: item.name,
                  error: staged.code,
                }),
              ]);
              continue;
            }
            attachmentPath = staged.path;
            stagedAttachmentPath = staged.path;
          }

          if (item.category === 'image') {
            // image-local-cache primary path: IPC copy → xdt-image:// URL.
            // Falls back to in-memory base64 if cache write fails (F6).
            let cached: { url: string } | null = null;
            if (currentSessionId) {
              try {
                cached = await window.electronAPI.cacheImageFromPath({
                  sessionId: currentSessionId,
                  sourcePath: attachmentPath,
                  originalName: item.name,
                });
              } catch (err) {
                log.warn('cacheImageFromPath failed:', err);
                cached = null;
              }
            }

            if (!cached && !isDataOwnerGenerationCurrent(operationScope.dataOwner)) {
              cleanupStagedChatAttachmentFiles([{ path: stagedAttachmentPath ?? '' }]);
              break;
            }

            if (cached) {
              newAttachments.push({
                id: crypto.randomUUID(),
                name: item.name,
                path: attachmentPath,
                ext: item.ext,
                size: item.size,
                category: 'image',
                mimeType: item.mimeType,
                url: cached.url,
                originalName: item.name,
              });
            } else {
              // F6 fallback: read original file as base64 and warn the user that
              // the image is in-memory only (lost on restart).
              const result = await window.electronAPI.readFileForAttachment({
                filePath: attachmentPath,
                encoding: 'base64',
              });
              if (!result.success) {
                cleanupStagedChatAttachmentFiles([{ path: stagedAttachmentPath ?? '' }]);
                pushScopedRejections(operationScope, [
                  t('logic.toasts.attachmentReadFailed', { name: item.name, error: result.error }),
                ]);
                continue;
              }
              // 仅在"有 session 但缓存写失败"时告警；草稿态（无 sessionId）走 base64
              // 是设计行为,不算失败,不该打扰用户。
              if (currentSessionId && isAttachmentOperationScopeCurrent(operationScope)) {
                toast.warning(t('logic.toasts.attachmentLocalCacheFailed'));
              }
              newAttachments.push({
                id: crypto.randomUUID(),
                name: item.name,
                path: attachmentPath,
                ext: item.ext,
                size: item.size,
                category: 'image',
                mimeType: item.mimeType,
                base64: result.data,
                originalName: item.name,
              });
            }
          } else if (item.category === 'pdf') {
            // attachment-path-passthrough F2: do not base64-load PDFs in the
            // renderer; only the absolute path is forwarded. The model uses
            // its Read tool on demand.
            newAttachments.push({
              id: crypto.randomUUID(),
              name: item.name,
              path: attachmentPath,
              ext: item.ext,
              size: item.size,
              category: 'pdf',
              mimeType: item.mimeType,
            });
          } else {
            // text / office — attachment-path-passthrough F1: no
            // readFileForAttachment / textContent. Path-only; the model
            // decides whether to read or convert on demand.
            newAttachments.push({
              id: crypto.randomUUID(),
              name: item.name,
              path: attachmentPath,
              ext: item.ext,
              size: item.size,
              category: item.category,
              mimeType: item.mimeType,
            });
          }
        } catch (err) {
          cleanupStagedChatAttachmentFiles([{ path: stagedAttachmentPath ?? '' }]);
          pushScopedRejections(operationScope, [
            t('logic.toasts.attachmentReadFailed', {
              name: item.name,
              error: err instanceof Error ? err.message : String(err),
            }),
          ]);
        }
      }

      settleAttachmentsForScope(operationScope, newAttachments);
    },
    [isAttachmentOperationScopeCurrent, pushScopedRejections, settleAttachmentsForScope, t],
  );

  /**
   * Add an image directly from the clipboard (Cmd+V / Ctrl+V screenshot).
   * Primary path: blob → arrayBuffer → IPC writeBuffer → xdt-image:// URL.
   * Fallback (F6): blob → base64 in-memory + toast warning.
   */
  const addClipboardImage = useCallback(
    async (blob: Blob) => {
      const operationScope = attachmentOperationScopeRef.current;
      setRejections([]);

      const mimeType = blob.type || 'image/png';
      // Derive extension from MIME type
      const extMap: Record<string, string> = {
        'image/png': '.png',
        'image/jpeg': '.jpg',
        'image/gif': '.gif',
        'image/webp': '.webp',
      };
      const ext = extMap[mimeType] ?? '.png';
      const timestamp = Date.now();
      const name = `clipboard-${timestamp}${ext}`;

      const currentSessionId = operationScope.sessionId;

      try {
        const buffer = new Uint8Array(await blob.arrayBuffer());
        if (!isDataOwnerGenerationCurrent(operationScope.dataOwner)) return;

        let cached: { url: string } | null = null;
        if (currentSessionId) {
          try {
            cached = await window.electronAPI.cacheImageFromBuffer({
              sessionId: currentSessionId,
              buffer,
              mimeType,
              suggestedName: name,
            });
          } catch (err) {
            log.warn('cacheImageFromBuffer failed:', err);
            cached = null;
          }
        }

        if (cached) {
          settleAttachmentsForScope(operationScope, [
            {
              id: crypto.randomUUID(),
              name,
              path: `clipboard://paste-${timestamp}`,
              ext,
              size: blob.size,
              category: 'image',
              mimeType,
              url: cached.url,
              originalName: name,
            },
          ]);
        } else {
          if (!isDataOwnerGenerationCurrent(operationScope.dataOwner)) return;
          // F6 fallback
          const base64 = await blobToBase64(blob);
          // 仅在"有 session 但缓存写失败"时告警；草稿态走 base64 是设计行为。
          if (currentSessionId && isAttachmentOperationScopeCurrent(operationScope)) {
            toast.warning(t('logic.toasts.attachmentLocalCacheFailed'));
          }
          settleAttachmentsForScope(operationScope, [
            {
              id: crypto.randomUUID(),
              name,
              path: `clipboard://paste-${timestamp}`,
              ext,
              size: blob.size,
              category: 'image',
              mimeType,
              base64,
              originalName: name,
            },
          ]);
        }
      } catch (err) {
        pushScopedRejections(operationScope, [
          t('logic.toasts.attachmentPasteFailed', {
            message: err instanceof Error ? err.message : String(err),
          }),
        ]);
      }
    },
    [isAttachmentOperationScopeCurrent, pushScopedRejections, settleAttachmentsForScope, t],
  );

  const removeFile = useCallback((id: string) => {
    const removed = attachmentsRef.current.find((f) => f.id === id);
    // 共享引用(如"标注历史图"直接引用消息里的原图)不归附件所有,删除附件
    // 绝不能清理它——那是历史消息还在用的文件。
    if (!removed?.cacheUrlShared) {
      cleanupRemovedCachedImage(removed);
    }
    if (removed) cleanupStagedChatAttachmentFiles([removed]);
    setAttachments((prev) => {
      const next = prev.filter((f) => f.id !== id);
      attachmentsRef.current = next;
      return next;
    });
  }, []);

  const updateFile = useCallback((id: string, patch: Partial<AttachedFile>) => {
    setAttachments((prev) => {
      const next = prev.map((f) => (f.id === id ? { ...f, ...patch } : f));
      attachmentsRef.current = next;
      return next;
    });
  }, []);

  const restoreFiles = useCallback((files: readonly AttachedFile[]): AttachedFile[] => {
    if (files.length === 0) return attachmentsRef.current;
    const restoredIds = new Set(files.map((file) => file.id));
    const immediate = [
      ...files,
      ...attachmentsRef.current.filter((file) => !restoredIds.has(file.id)),
    ];
    attachmentsRef.current = immediate;
    setAttachments((prev) => {
      const restored = [...files, ...prev.filter((file) => !restoredIds.has(file.id))];
      attachmentsRef.current = restored;
      return restored;
    });
    return immediate;
  }, []);

  const discardFiles = useCallback(() => {
    const current = attachmentsRef.current;
    for (const file of current) {
      if (!file.cacheUrlShared) cleanupRemovedCachedImage(file);
    }
    cleanupStagedChatAttachmentFiles(current);
    setAttachments([]);
    attachmentsRef.current = [];
    setRejections([]);
  }, []);

  const clearFiles = useCallback(() => {
    // Do not delete xdt-image:// cache files here. clearFiles also runs after
    // a successful send, when those files are already referenced by history.
    setAttachments([]);
    attachmentsRef.current = [];
    setRejections([]);
  }, []);

  return {
    attachments,
    hasAttachments: attachments.length > 0,
    addFiles,
    addClipboardImage,
    rejections,
    dismissRejection,
    clearRejections,
    addFolderPath,
    pendingFoldersVersion,
    consumePendingFolders,
    addFileMention,
    pendingFileMentionsVersion,
    consumePendingFileMentions,
    removeFile,
    updateFile,
    discardFiles,
    restoreFiles,
    clearFiles,
  };
}
