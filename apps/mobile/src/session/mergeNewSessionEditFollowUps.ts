import { stripChatQuoteMarkerLines } from '@cindy/maker-shared/chat-quotes';
import { getMobileAuthOwner, isMobileAuthOwnerCurrent } from '@/auth/authOwnerGeneration';
import { i18n } from '@/i18n';
import { categorizeMobileAttachment, extractRemoteFileExt, mergeAttachmentsWithinLimit, mimeTypeForMobileAttachment } from './attachments';
import { isDurableCreationDraft, isDurableOutboxUnsent, type DurableOutboxRecord } from './durableOutbox';
import { discardOutboxUploads, getCurrentMobileOutboxRecords, mobileDurableOutbox } from './mobileDurableOutbox';
import type { RemoteSerializedAttachment } from './types';

/** Consolidate unsent messages before either warm navigation or cold editor recovery. */
export async function mergeNewSessionEditFollowUps(sessionId: string, deviceId: string, getToken: () => Promise<string | null> = async () => null): Promise<DurableOutboxRecord | undefined> {
  const owner = getMobileAuthOwner();
  // Drain committed send handoffs before reading the group, including a send
  // whose disk write was still queued when its chat unmounted.
  await mobileDurableOutbox.reconcileDrafts(sessionId);
  const guard = () => {
    if (!isMobileAuthOwnerCurrent(owner)) throw new Error('OUTBOX_OWNER_CHANGED');
  };
  guard();
  const group = getCurrentMobileOutboxRecords().filter(r => r.deviceId === deviceId && r.item.sessionId === sessionId);
  let first = group.find(r => r.creation);
  if (!first?.creation) return;
  let creation = first.creation;
  // Every editor entry, including retry after background recovery, must own a
  // writable draft before exposing content. Normalize the existing marker here;
  // presentation, claims and subsequent edits use the same store predicate.
  if (!isDurableCreationDraft(first)) {
    creation = { ...creation, editReady: true };
    if (!isDurableCreationDraft({ ...first, creation })) return;
    first = await mobileDurableOutbox.update(first, { creation });
    guard();
  }
  const followUps = group.filter(r => r !== first && !r.creation);
  if (!followUps.length) return first;
  if (followUps.some(r => !isDurableOutboxUnsent(r))) throw new Error('OUTBOX_CREATION_OWNERSHIP_UNRESOLVED');
  const copied = new Set(creation.mergedFollowUpClientIds ?? []);
  const pending = followUps.filter(r => !copied.has(r.item.clientId));
  const { durableOutboxUploadUri, outboxAttachmentNeedsLocalBytes, removeOutboxFiles, removeRetainedOutboxFiles, retainOutboxFile } = await import('./durableOutboxFiles');
  const copies: DurableOutboxRecord = { ...first, uploads: [] };
  let committed = false;
  try {
    const attachments = [...first.item.attachmentSlots];
    const slotMeta = [...first.item.slotMeta];
    const text = [creation.draft.firstMessage];
    let omitted = 0;
    for (const record of pending) {
      text.push(record.item.quotesEncoded ? stripChatQuoteMarkerLines(record.item.text) : record.item.text);
      for (let slot = 0; slot < record.item.attachmentSlots.length; slot++) {
        const upload = record.uploads.find(u => u.slot === slot);
        // Queued uploads already own durable bytes even before receiving a remote reference.
        const attachment: RemoteSerializedAttachment | null = record.item.attachmentSlots[slot] ?? (upload ? {
          id: `${record.item.clientId}-slot-${slot}`, path: durableOutboxUploadUri(record, upload),
          name: upload.name, ext: extractRemoteFileExt(upload.name), size: upload.size,
          category: categorizeMobileAttachment(upload.name),
          mimeType: upload.mimeType ?? mimeTypeForMobileAttachment(extractRemoteFileExt(upload.name), categorizeMobileAttachment(upload.name)),
          annotated: upload.annotated, annotationRegions: upload.annotationRegions,
        } : null);
        if (!attachment) { omitted++; continue; }
        if (attachments.some(a => a?.id === attachment.id)) continue;
        const { dropped } = mergeAttachmentsWithinLimit(attachments.filter((a): a is RemoteSerializedAttachment => a !== null), [attachment]);
        if (dropped.length) { omitted++; continue; }
        guard();
        if (upload) {
          const retained = await retainOutboxFile(first, attachments.length, {
            ...upload, uri: durableOutboxUploadUri(record, upload),
          });
          copies.uploads.push(retained);
          if (!record.item.attachmentSlots[slot]) {
            attachment.path = durableOutboxUploadUri(first, retained);
            if (attachment.category === 'image') attachment.url = attachment.path;
          }
        }
        else if (outboxAttachmentNeedsLocalBytes(attachment)) throw new Error(i18n.t('session.outbox.restoreFailed'));
        attachments.push(attachment);
        slotMeta.push({ kind: attachment.category === 'image' ? 'image' : 'file', previewUri: null });
      }
    }
    if (pending.length) {
      guard();
      const firstMessage = text.filter(Boolean).join('\n\n');
      first = await mobileDurableOutbox.update(first, {
        creation: { ...creation, draft: { ...creation.draft, firstMessage },
          mergedFollowUpClientIds: [...copied, ...pending.map(r => r.item.clientId)],
          notice: [creation.notice, omitted ? i18n.t('session.screen.attachmentsNotCarriedBack', { count: omitted }) : null]
            .filter(Boolean).join('\n') || undefined,
        },
        uploads: [...first.uploads, ...copies.uploads],
        item: { ...first.item, text: firstMessage, attachmentSlots: attachments, slotMeta },
      }, followUps);
    }
    committed = true;
    // The single parent write owns both content and receipt IDs before any
    // source is removed. A restart can finish removal without appending twice.
    for (const record of followUps) {
      guard();
      if (!getCurrentMobileOutboxRecords().includes(first)) throw new Error('OUTBOX_STALE_WRITE');
      await mobileDurableOutbox.remove(record);
      // Only references retained by the committed parent changed ownership.
      // Derive unused references from both records so interrupted cleanup can
      // finish on cold recovery without another ledger or a dropped-ID list.
      discardOutboxUploads(record, owner, getToken, record.item.attachmentSlots.filter(
        (attachment): attachment is RemoteSerializedAttachment => attachment !== null
          && !first!.item.attachmentSlots.some(kept => kept?.path === attachment.path),
      ));
      await removeOutboxFiles(record).catch(() => undefined);
    }
    return first;
  } finally {
    if (!committed) await removeRetainedOutboxFiles(copies).catch(() => undefined);
  }
}
