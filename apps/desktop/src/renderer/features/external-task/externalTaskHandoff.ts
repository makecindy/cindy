import type { ExternalTaskPayload, ExternalTaskRequest } from '../../../shared/externalTask';
import { isExternalTaskRequest } from '../../../shared/externalTask';
import {
  getDataOwnerGeneration,
  isDataOwnerGenerationCurrent,
  type DataOwnerGeneration,
} from '@/contexts/dataOwnerGeneration';
import {
  draftHasContent,
  getDraft,
  saveDraft,
  plainTextToTiptapDoc,
} from '@/lib/composerDraftStore';
import { takeComposerSubmitRequest } from '@/lib/composerActionsBus';
import { resetDraftWorkspaceTargets } from '@/state/newMakerDraft';
import { NEW_MAKER_DRAFT_KEY } from '@/features/cc-agent/newMakerDraftKeys';

interface Entry {
  payload: ExternalTaskPayload;
  owner: DataOwnerGeneration;
}

let pending: Entry[] = [];
const accepted = new Map<string, { owner: DataOwnerGeneration; expires: number }>();
const listeners = new Set<() => void>();
const emit = () => {
  for (const listener of listeners) listener();
};
export const subscribeExternalTasks = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
export const getExternalTask = () =>
  pending.find((entry) => isDataOwnerGenerationCurrent(entry.owner)) ?? null;

/** Account-scoped, bounded presentation of the existing deep-link pending queue. */
export function requestExternalTask(payload: ExternalTaskPayload): void {
  pending = pending.filter((entry) => isDataOwnerGenerationCurrent(entry.owner));
  for (const [id, entry] of accepted) {
    if (!isDataOwnerGenerationCurrent(entry.owner) || entry.expires <= Date.now())
      accepted.delete(id);
  }
  if (payload.type === 'external-task') {
    if (!isExternalTaskRequest(payload.request) || payload.request.expires <= Date.now()) {
      payload = { type: 'external-task-error' };
    } else {
      const request = payload.request;
      if (accepted.has(request.id)) return;
      const previous = pending.find(
        (entry) =>
          entry.payload.type === 'external-task' && entry.payload.request.id === request.id,
      );
      if (previous) {
        if (
          previous.payload.type === 'external-task' &&
          previous.payload.request.question === payload.request.question &&
          previous.payload.request.context === payload.request.context &&
          previous.payload.request.source === payload.request.source
        )
          return;
        payload = { type: 'external-task-error' };
      }
      if (pending.length >= 8) payload = { type: 'external-task-error' };
    }
  }
  if (
    payload.type === 'external-task-error' &&
    pending.some((entry) => entry.payload.type === 'external-task-error')
  )
    return;
  pending = [...pending, { payload, owner: getDataOwnerGeneration() }];
  emit();
}

export function dismissExternalTask(entry: Entry): void {
  pending = pending.filter((value) => value !== entry);
  emit();
}

export function clearExternalTasks(): void {
  pending = [];
  emit();
}

/** No model call, file reference or command. The normal composer owns the eventual send. */
export function acceptExternalTaskDraft(
  entry: Entry,
  question: string,
  contextLabel: string,
  sourceLabel?: string,
): boolean {
  if (entry.payload.type !== 'external-task' || !isDataOwnerGenerationCurrent(entry.owner))
    return false;
  const request: ExternalTaskRequest = { ...entry.payload.request, question };
  if (
    !isExternalTaskRequest(request) ||
    request.expires <= Date.now() ||
    accepted.has(request.id) ||
    draftHasContent(getDraft(NEW_MAKER_DRAFT_KEY))
  )
    return false;
  const text = plainTextToTiptapDoc(question);
  const referenceText = [
    request.source ? (sourceLabel ?? request.source) : '',
    request.context ?? '',
  ]
    .filter(Boolean)
    .join('\n\n');
  // Same atom and serialization used by long pasted text, including persisted fold ranges.
  text.content ??= [];
  if (referenceText)
    text.content.push({
      type: 'paragraph',
      content: [
        {
          type: 'pastedTextChip',
          attrs: {
            display: contextLabel,
            text: referenceText,
            externalReference: true,
          },
        },
      ],
    });
  resetDraftWorkspaceTargets();
  takeComposerSubmitRequest(NEW_MAKER_DRAFT_KEY);
  saveDraft(NEW_MAKER_DRAFT_KEY, { text, attachments: [], focusAtEnd: true });
  if (accepted.size >= 64) accepted.delete(accepted.keys().next().value!);
  accepted.set(request.id, { owner: entry.owner, expires: request.expires });
  dismissExternalTask(entry);
  return true;
}
