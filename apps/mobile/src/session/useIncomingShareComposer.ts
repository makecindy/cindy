import { useEffect, useRef } from 'react';
import { useIsFocused } from 'expo-router';
import { useAuth } from '@/auth/AuthContext';
import { getMobileAuthOwner } from '@/auth/authOwnerGeneration';
import { MOBILE_MAX_ATTACHMENTS } from './attachments';
import { consumeIncomingShareBatch, deleteIncomingSharedFiles, incomingShareText, useIncomingShareBatch } from './incomingShare';
import { selectIncomingShareUploadCandidates } from './incomingShare';
import type { useMobileLocalAttachments } from './useMobileLocalAttachments';
import { useTranslation } from 'react-i18next';

/** Shares enter the real composer: its existing upload, retry and send pipeline owns delivery. */
export function useIncomingShareComposer(options: {
  destination: string | readonly string[];
  ready: boolean;
  appendText(text: string): void;
  attachmentCount: number;
  enqueueUploads: ReturnType<typeof useMobileLocalAttachments>['enqueueUploads'];
  getPendingUploadCount(): number;
  onError(message: string | null): void;
}) {
  const batch = useIncomingShareBatch();
  const focused = useIsFocused();
  const auth = useAuth();
  const { t } = useTranslation();
  const latest = useRef(options); latest.current = options;
  const pendingCount = options.getPendingUploadCount();
  useEffect(() => {
    const target = latest.current;
    const destinations = typeof target.destination === 'string' ? [target.destination] : target.destination;
    if (!focused || !target.ready || !batch || !batch.destination || !destinations.includes(batch.destination)
      || !auth.isAuthenticated || getMobileAuthOwner().accountId !== auth.user?.id) return;
    const selection = selectIncomingShareUploadCandidates(batch.payloads);
    if (selection.candidates.length + target.attachmentCount + target.getPendingUploadCount() > MOBILE_MAX_ATTACHMENTS) {
      // Retain the complete batch until the user frees space. Never silently drop files.
      target.onError(t('composer.upload.maxAttachments', { count: MOBILE_MAX_ATTACHMENTS }));
      return;
    }
    try {
      if (!consumeIncomingShareBatch(batch.id)) return;
    } catch {
      target.onError(t('composer.upload.shareReceiveFailed'));
      return;
    }
    const text = incomingShareText(batch.payloads);
    if (text) target.appendText(text);
    if (selection.candidates.length) target.enqueueUploads(selection.candidates.map((candidate, index) => ({
      ...candidate, incomingShareOrder: { batchId: batch.id, index }, cleanupLocalUris: deleteIncomingSharedFiles,
    })), { token: auth.getAccessToken() });
    if (selection.rejectedUris.length) void deleteIncomingSharedFiles(selection.rejectedUris).catch(() => undefined);
    target.onError(selection.rejectedUris.length ? t('composer.upload.noFileRead') : null);
  }, [auth, batch, focused, options.destination, options.ready, options.attachmentCount, pendingCount, t]);
}
