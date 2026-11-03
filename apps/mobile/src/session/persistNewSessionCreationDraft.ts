import { i18n } from '@/i18n';
import { getMobileAuthOwner, isMobileAuthOwnerCurrent } from '@/auth/authOwnerGeneration';
import type { DurableOutboxRecord } from './durableOutbox';
import type { MobileLocalAttachmentUploadCandidate } from './mobileLocalAttachmentUpload';
import { durableOutboxUploadUri, outboxAttachmentNeedsLocalBytes, removeRetainedOutboxFiles, retainOutboxFile } from './durableOutboxFiles';
import { getCurrentMobileOutboxRecords, mobileDurableOutbox } from './mobileDurableOutbox';

export type NewSessionDraftEdit = { firstMessage?: string; removeAttachmentId?: string };

/** User edits replace recovered content; an empty recovery is discarded permanently. */
export async function persistNewSessionDraftEdit(record: DurableOutboxRecord, edit: NewSessionDraftEdit): Promise<DurableOutboxRecord | null> {
  const owner = getMobileAuthOwner();
  const guard = () => {
    if (owner.accountKey !== record.accountId || !isMobileAuthOwnerCurrent(owner)) throw new Error('OUTBOX_OWNER_CHANGED');
  };
  guard();
  let removed: DurableOutboxRecord | undefined;
  const saved = await mobileDurableOutbox.editCreationDraft(record, current => {
    guard();
    const slots = current.item.attachmentSlots.map((attachment, slot) => ({ attachment, slot }))
      .filter(({ attachment }) => attachment && attachment.id !== edit.removeAttachmentId);
    const firstMessage = edit.firstMessage ?? current.creation!.draft.firstMessage;
    const uploads = current.uploads.filter(upload => slots.some(({ slot }) => slot === upload.slot));
    removed = { ...current, uploads: current.uploads.filter(upload => !uploads.includes(upload)) };
    if (!firstMessage.trim() && !slots.length) return null;
    return {
      ...current,
      creation: { ...current.creation!, draft: { ...current.creation!.draft, firstMessage } },
      uploads: uploads.map(upload => ({ ...upload, slot: slots.findIndex(({ slot }) => slot === upload.slot) })),
      item: { ...current.item, text: firstMessage,
        attachmentSlots: slots.map(({ attachment }) => attachment),
        slotMeta: slots.map(({ slot }) => current.item.slotMeta[slot]),
        slotByLocalId: {}, waitingIds: [], failedIds: [],
        agentReferences: [], pastedTextRanges: [], slashCommandRanges: [], quotesEncoded: false,
      },
    };
  });
  // Delete only bytes no longer referenced by the committed revision. Startup
  // reconciliation already handles a failed local cleanup; do not undo the edit.
  if (removed?.uploads.length) await removeRetainedOutboxFiles(removed).catch(() => undefined);
  return saved;
}

/** Save attachment bytes before the form reserves a worktree or hands off creation. */
export async function persistNewSessionCreationDraft({ record, recovering, getUploadedSource, isCurrent }: {
  record: DurableOutboxRecord;
  recovering: DurableOutboxRecord | null | undefined;
  getUploadedSource: (id: string) => MobileLocalAttachmentUploadCandidate | undefined;
  isCurrent: () => boolean;
}): Promise<DurableOutboxRecord | null> {
  // Recovery may carry local-only slots or expired remote references. Delivery
  // must materialize the retained bytes again after the new task is created.
  let saved: DurableOutboxRecord = { ...record, refreshUploads: !!recovering, uploads: [] };
  let committed = false;
  try {
    for (let slot = 0; slot < saved.item.attachmentSlots.length; slot++) {
      const attachment = saved.item.attachmentSlots[slot];
      if (!attachment) continue;
      const source = getUploadedSource(attachment.id);
      const oldSlot = recovering?.item.attachmentSlots.findIndex(a => a?.id === attachment.id);
      const oldUpload = recovering?.uploads.find(u => u.slot === oldSlot);
      if (source) saved.uploads.push(await retainOutboxFile(saved, slot, source));
      else if (recovering && oldUpload) saved.uploads.push(await retainOutboxFile(saved, slot, {
        ...oldUpload, uri: durableOutboxUploadUri(recovering, oldUpload),
      }));
      else if (outboxAttachmentNeedsLocalBytes(attachment)) {
        throw new Error(i18n.t('session.screen.attachmentsNotCarriedBack', { count: 1 }));
      }
    }
    if (!isCurrent()) return null;
    if (recovering) {
      const latest = getCurrentMobileOutboxRecords().find(r => r.item.clientId === saved.item.clientId
        && r.item.sessionId === recovering.item.sessionId);
      if (latest !== recovering || latest.prepared) throw new Error('OUTBOX_STALE_WRITE');
      saved = await mobileDurableOutbox.update(latest, saved);
    } else await mobileDurableOutbox.add(saved);
    committed = true;
    return saved;
  } finally {
    if (!committed) await removeRetainedOutboxFiles(saved).catch(() => undefined);
  }
}
