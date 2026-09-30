/**
 * 群聊输入框的附件（docs/product-rules/bot-group-chat.md §8）。
 *
 * 与任务输入框同一条本机附件管线：`useMobileLocalAttachments` 负责相册 / 拍照 / 文件 /
 * 粘贴的拉起与乐观上传（传 deviceId，能直传时直传给这台电脑），这里只持有已上传的附件、
 * 托盘缩略图与「最近照片」的勾选映射，写法对照会话页与新建页。
 *
 * - 附件只在发出成功后才离开托盘（电脑取走上传后自己回收中转对象）；发失败原样保留，
 *   重发沿用同一条消息。
 * - 移除或页面卸载时回收没发出去的上传；正在发送的那批不回收，避免电脑取件时对象已被删。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import * as FileSystem from 'expo-file-system/legacy';
import { useAuth } from '@/auth/AuthContext';
import { MOBILE_MAX_ATTACHMENTS } from './attachments';
import type { MobileMessageGalleryImage } from './messageGallery';
import { buildMediaPayload } from './messagePayload';
import { discardMobileUploadedAttachment } from './mobileAttachmentUpload';
import { buildMobileImageAttachmentCandidate } from './mobileImageAttachment';
import { isComposerPastedImageUri } from './pastedImageAttachment';
import type { RemoteSerializedAttachment } from './types';
import { resolveContextSheetMediaAssetForUpload, type ContextSheetMediaAsset } from './useContextSheetMediaAssets';
import { useMobileLocalAttachments } from './useMobileLocalAttachments';

export function useBotGroupComposerAttachments({ deviceId, onPicked }: {
  deviceId: string;
  /** A picker returned (or a recent photo was tapped): close the sheet and go back to typing. */
  onPicked(): void;
}) {
  const { t } = useTranslation();
  const auth = useAuth();
  const getAccessTokenRef = useRef(auth.getAccessToken);
  getAccessTokenRef.current = auth.getAccessToken;
  const onPickedRef = useRef(onPicked);
  onPickedRef.current = onPicked;
  const [attachments, setAttachments] = useState<RemoteSerializedAttachment[]>([]);
  // send() reads the list right after waiting for uploads, before React commits.
  const attachmentsRef = useRef(attachments);
  /** attachmentId → local file for tray thumbnails (images only). */
  const [previews, setPreviews] = useState<Record<string, string>>({});
  /** Recent-photo asset id → attachment id, for the strip's check marks. */
  const [mediaAssetAttachments, setMediaAssetAttachments] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const mediaTapAcceptedRef = useRef(false);
  const sendingIdsRef = useRef(new Set<string>());

  const local = useMobileLocalAttachments({
    deviceId,
    getAccessToken: () => getAccessTokenRef.current(),
    getAttachmentCount: () => attachmentsRef.current.length,
    onUploaded: (attachment, candidate) => {
      attachmentsRef.current = [...attachmentsRef.current, attachment];
      if (candidate.kind === 'image') setPreviews((current) => ({ ...current, [attachment.id]: candidate.uri }));
      const sourceId = candidate.sourceId;
      if (sourceId) setMediaAssetAttachments((current) => ({ ...current, [sourceId]: attachment.id }));
      setAttachments(attachmentsRef.current);
    },
    onError: (message) => setError(message),
    onPicked: () => onPickedRef.current(),
  });
  const { releaseUploadedSources, enqueueUploads, getPendingUploadCount, pendingUploads } = local;

  const forget = useCallback((ids: readonly string[]) => {
    if (ids.length === 0) return;
    const gone = new Set(ids);
    attachmentsRef.current = attachmentsRef.current.filter((item) => !gone.has(item.id));
    setAttachments(attachmentsRef.current);
    setPreviews((current) => {
      if (!ids.some((id) => current[id])) return current;
      const next = { ...current };
      for (const id of ids) delete next[id];
      return next;
    });
    setMediaAssetAttachments((current) => {
      const entries = Object.entries(current).filter(([, attachmentId]) => !gone.has(attachmentId));
      return entries.length === Object.keys(current).length ? current : Object.fromEntries(entries);
    });
    releaseUploadedSources(ids);
    setError(null);
  }, [releaseUploadedSources]);

  /** Tray X: the upload is no longer referenced, so its relay object is reclaimed. */
  const removeAttachment = useCallback((id: string) => {
    const removed = attachmentsRef.current.find((item) => item.id === id);
    if (removed) discardMobileUploadedAttachment(removed, { getToken: () => getAccessTokenRef.current() });
    forget([id]);
  }, [forget]);

  /** After a successful send; the computer already took (and reclaims) these uploads. */
  const clearSent = useCallback((ids: readonly string[]) => forget(ids), [forget]);

  /** Keeps a batch out of the unmount cleanup while the computer may still be fetching it. */
  const holdForSend = useCallback((ids: readonly string[]) => {
    for (const id of ids) sendingIdsRef.current.add(id);
    return () => { for (const id of ids) sendingIdsRef.current.delete(id); };
  }, []);

  useEffect(() => () => {
    // In-flight uploads are cancelled (and reclaimed) by useMobileLocalAttachments itself.
    for (const attachment of attachmentsRef.current) {
      if (sendingIdsRef.current.has(attachment.id)) continue;
      discardMobileUploadedAttachment(attachment, { getToken: () => getAccessTokenRef.current() });
    }
  }, []);

  /** Each opening of the sheet accepts one recent-photo tap (the close animation ignores more). */
  const armMediaTap = useCallback(() => { mediaTapAcceptedRef.current = false; }, []);

  const busyAssetIds = useMemo(() => {
    const ids = new Set<string>();
    for (const pending of pendingUploads) if (pending.sourceId) ids.add(pending.sourceId);
    return ids;
  }, [pendingUploads]);

  const selectedAssetIds = useMemo(() => {
    const attached = new Set(attachments.map((item) => item.id));
    return new Set(Object.entries(mediaAssetAttachments)
      .filter(([, attachmentId]) => attached.has(attachmentId))
      .map(([assetId]) => assetId));
  }, [attachments, mediaAssetAttachments]);

  /** A tap in the recent-photo strip adds that photo at once (same as the task composer). */
  const toggleMediaAsset = useCallback((asset: ContextSheetMediaAsset) => {
    if (mediaTapAcceptedRef.current || mediaAssetAttachments[asset.id] || busyAssetIds.has(asset.id)) return;
    if (attachmentsRef.current.length + getPendingUploadCount() >= MOBILE_MAX_ATTACHMENTS) {
      setError(t('session.common.maxAttachments', { max: MOBILE_MAX_ATTACHMENTS }));
      return;
    }
    mediaTapAcceptedRef.current = true;
    setError(null);
    enqueueUploads([{
      kind: 'image',
      uri: asset.uri,
      name: asset.filename,
      size: 0,
      sourceId: asset.id,
      resolve: async () => {
        const resolved = await resolveContextSheetMediaAssetForUpload(asset);
        const candidate = buildMobileImageAttachmentCandidate({ fileName: resolved.filename, uri: resolved.uri }, 0);
        return {
          uri: candidate.uri,
          name: candidate.name,
          mimeType: candidate.mimeType,
          width: resolved.width,
          height: resolved.height,
          // HEIC was already converted and resized while resolving.
          skipPreprocess: resolved.optimized === true,
        };
      },
    }], { token: getAccessTokenRef.current() });
    onPickedRef.current();
  }, [busyAssetIds, enqueueUploads, getPendingUploadCount, mediaAssetAttachments, t]);

  /** The computer cannot take attachments: a pasted image is dropped like before, its copy deleted. */
  const dropPastedImages = useCallback((uris: readonly string[]) => {
    for (const uri of uris) {
      if (isComposerPastedImageUri(uri)) void FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => undefined);
    }
  }, []);

  /** Tray thumbnails open full screen from their local files. */
  const galleryImages = useMemo<MobileMessageGalleryImage[]>(() => attachments.flatMap((attachment) => {
    const uri = attachment.category === 'image' ? previews[attachment.id] : undefined;
    if (!uri) return [];
    const payload = buildMediaPayload({ kind: 'image', previewable: true, title: attachment.name, url: uri }, attachment.name);
    return payload.kind === 'media' ? [{ key: attachment.id, payload, title: attachment.name, url: uri }] : [];
  }), [attachments, previews]);

  const count = attachments.length + pendingUploads.length + local.pastePlaceholderCount;
  return {
    attachments,
    attachmentsRef,
    previews,
    pendingUploads,
    pastePlaceholderCount: local.pastePlaceholderCount,
    /** Attached, uploading and paste placeholders together. */
    count,
    error,
    setError,
    addImages: local.addImages,
    addDocument: local.addDocument,
    addPastedImages: local.addPastedImages,
    beginPastePlaceholders: local.beginPastePlaceholders,
    failPastePlaceholders: local.failPastePlaceholders,
    dropPastedImages,
    removeAttachment,
    removePendingUpload: local.removePendingUpload,
    retryPendingUpload: local.retryPendingUpload,
    waitForPendingUploads: local.waitForPendingUploads,
    clearSent,
    holdForSend,
    armMediaTap,
    toggleMediaAsset,
    busyAssetIds,
    selectedAssetIds,
    galleryImages,
  };
}
