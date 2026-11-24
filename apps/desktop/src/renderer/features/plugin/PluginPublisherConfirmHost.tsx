/**
 * Organization plugin publish confirmation screen, shared by conversation and UI publishing.
 *
 * Shows organization, plugin id, version and size, and — when Main allows it — the visibility
 * audience: all members, or specific departments / members / emails (#1541). Main decides
 * whether the audience is editable; this screen only returns the user's choice.
 */
import * as Dialog from '@radix-ui/react-dialog';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { isDataOwnerPushStampCurrent } from '@/contexts/dataOwnerGeneration';
import type {
  PluginPublisherConfirmPayload,
  PublisherAudienceContext,
} from '../../../shared/pluginPublisher';
import {
  ALL_MEMBERS_DRAFT,
  audienceOf,
  draftOf,
  EMPTY_SPECIFIED_DRAFT,
  type AudienceDraft,
} from './audience/audienceDraft';
import { AudienceEditor } from './audience/AudienceEditor';

const copy = 'settings.ghosts.publish';
const audienceCopy = 'settings.ghosts.audience';

const BLOCKED_REASON_COPY: Record<Extract<PublisherAudienceContext, { kind: 'blocked' }>['reason'], string> = {
  locked: `${audienceCopy}.blockedLocked`,
  legacyRoles: `${audienceCopy}.blockedLegacyRoles`,
};

function isAudienceContext(value: unknown): value is PublisherAudienceContext {
  if (!value || typeof value !== 'object') return false;
  const kind = (value as { kind?: unknown }).kind;
  return kind === 'locked' || kind === 'editable' || kind === 'blocked' || kind === 'denied';
}

function isConfirmRequest(value: unknown): value is PluginPublisherConfirmPayload {
  if (!value || typeof value !== 'object') return false;
  const raw = value as Record<string, unknown>;
  if (typeof raw.requestId !== 'string') return false;
  if (!raw.ownerStamp || typeof raw.ownerStamp !== 'object') return false;
  if (!raw.facts || typeof raw.facts !== 'object') return false;
  const facts = raw.facts as Record<string, unknown>;
  return (
    typeof facts.orgSlug === 'string' &&
    typeof facts.ghostId === 'string' &&
    typeof facts.name === 'string' &&
    typeof facts.version === 'string' &&
    typeof facts.sizeBytes === 'number' &&
    (raw.audience === undefined || isAudienceContext(raw.audience))
  );
}

function formatBytes(sizeBytes: number): string {
  if (sizeBytes < 1024) return `${sizeBytes} B`;
  if (sizeBytes < 1024 * 1024) return `${(sizeBytes / 1024).toFixed(1)} KB`;
  return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`;
}

function initialDraft(audience: PublisherAudienceContext): AudienceDraft {
  if (audience.kind !== 'editable') return { ...ALL_MEMBERS_DRAFT };
  const { initial, members } = audience;
  if (initial.type === 'matchAny' && !('departmentIds' in initial) && !('membershipIds' in initial) &&
    !('emails' in initial) && !('roles' in initial)) {
    return { ...EMPTY_SPECIFIED_DRAFT };
  }
  return draftOf(initial, members);
}

/** One confirmation at a time; later requests wait in arrival order. */
export function PluginPublisherConfirmHost() {
  const [queue, setQueue] = useState<PluginPublisherConfirmPayload[]>([]);

  useEffect(() => {
    return window.electronAPI.pluginPublisher.onConfirm((raw) => {
      if (!isConfirmRequest(raw)) return;
      if (!isDataOwnerPushStampCurrent(raw.ownerStamp)) {
        void window.electronAPI.pluginPublisher.resolveConfirm(raw.requestId, false).catch(() => undefined);
        return;
      }
      setQueue((current) => [...current, { ...raw, audience: raw.audience ?? { kind: 'locked' } }]);
    });
  }, []);

  const finish = useCallback((requestId: string) => {
    setQueue((current) => current.filter((item) => item.requestId !== requestId));
  }, []);

  const head = queue[0];
  return head ? <PublisherConfirmDialog key={head.requestId} request={head} onFinished={finish} /> : null;
}

function PublisherConfirmDialog({
  request,
  onFinished,
}: {
  request: PluginPublisherConfirmPayload;
  onFinished: (requestId: string) => void;
}) {
  const { t } = useTranslation();
  const { facts, audience } = request;
  const [draft, setDraft] = useState<AudienceDraft>(() => initialDraft(audience));
  const settled = useRef(false);

  const answer = useCallback((confirmed: boolean) => {
    if (settled.current) return;
    settled.current = true;
    const chosen = confirmed && audience.kind === 'editable' ? audienceOf(draft) : null;
    void window.electronAPI.pluginPublisher
      .resolveConfirm(request.requestId, confirmed, chosen ?? undefined)
      .catch(() => undefined) // Window teardown cancels the pending confirm in Main.
      .finally(() => onFinished(request.requestId));
  }, [audience.kind, draft, onFinished, request.requestId]);

  // A different account or data owner must never confirm this publish.
  useEffect(() => {
    if (!isDataOwnerPushStampCurrent(request.ownerStamp)) answer(false);
    return window.electronAPI.onAuthStateChange((state) => {
      if (
        state.dataOwnerId !== request.ownerStamp.dataOwnerId ||
        state.ownerGeneration !== request.ownerStamp.ownerGeneration
      ) {
        answer(false);
      }
    });
  }, [answer, request.ownerStamp]);

  // A specific audience that cannot be applied, or an upload the server rejects for anyone, blocks.
  const canConfirm = audience.kind !== 'blocked' && audience.kind !== 'denied' &&
    (audience.kind !== 'editable' || audienceOf(draft) !== null);

  return (
    <Dialog.Root open onOpenChange={(open) => { if (!open) answer(false); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="modal-scrim fixed inset-0 z-modal" />
        <Dialog.Content
          onInteractOutside={(event) => event.preventDefault()}
          className="modal-panel fixed left-1/2 top-1/2 z-modal-raised flex max-h-[85vh] w-[calc(100vw-32px)] max-w-[480px] -translate-x-1/2 -translate-y-1/2 flex-col p-4">
          <Dialog.Title className="text-18 font-medium text-[var(--text-primary)]">
            {t(`${copy}.confirmTitle`, { name: facts.name })}
          </Dialog.Title>
          <Dialog.Description className="mt-2 text-13 leading-[1.54] text-[var(--text-secondary)]">
            {t(`${copy}.confirmDescription`)}
          </Dialog.Description>
          <div className="my-4 min-h-0 space-y-4 overflow-y-auto">
            <dl className="space-y-2 text-13 text-[var(--text-secondary)]">
              {([
                [t(`${copy}.org`), facts.orgName ?? facts.orgSlug],
                [t(`${copy}.pluginId`), facts.ghostId],
                [t(`${copy}.version`), facts.version],
                [t(`${copy}.size`), formatBytes(facts.sizeBytes)],
              ] as const).map(([label, value]) => (
                <div key={label} className="flex justify-between gap-4">
                  <dt>{label}</dt>
                  <dd className="min-w-0 break-all text-right text-[var(--text-primary)]">{value}</dd>
                </div>
              ))}
              {audience.kind === 'locked' ? (
                <div className="flex justify-between gap-4">
                  <dt>{t(`${audienceCopy}.title`)}</dt>
                  <dd className="text-right text-[var(--text-primary)]">{t(`${audienceCopy}.keepCurrent`)}</dd>
                </div>
              ) : null}
            </dl>
            {audience.kind === 'locked' && audience.reason === 'legacyRoles' ? (
              <p className="text-13 leading-[1.54] text-[var(--text-secondary)]">{t(`${audienceCopy}.legacyRolesNote`)}</p>
            ) : null}
            {audience.kind === 'denied' ? (
              <section role="alert" aria-label={t(`${copy}.denied.title`)} className="space-y-1 border-t border-[var(--border-default)] pt-3">
                <h3 className="text-13 font-medium text-[var(--text-primary)]">{t(`${copy}.denied.title`)}</h3>
                <p className="text-13 leading-[1.54] text-[var(--text-secondary)]">{t(`${copy}.denied.${audience.reason}`)}</p>
              </section>
            ) : null}
            {audience.kind === 'blocked' ? (
              <section role="alert" aria-label={t(`${audienceCopy}.title`)} className="space-y-1 border-t border-[var(--border-default)] pt-3">
                <h3 className="text-13 font-medium text-[var(--text-primary)]">{t(`${audienceCopy}.blocked`)}</h3>
                <p className="text-13 leading-[1.54] text-[var(--text-secondary)]">
                  {t(BLOCKED_REASON_COPY[audience.reason] ?? `${audienceCopy}.blockedLocked`)}
                </p>
              </section>
            ) : null}
            {audience.kind === 'editable' ? (
              <section aria-label={t(`${audienceCopy}.title`)} className="border-t border-[var(--border-default)] pt-3">
                <AudienceEditor
                  draft={draft}
                  onChange={setDraft}
                  unresolved={audience.unresolved}
                  api={window.electronAPI.pluginAuthor}
                />
              </section>
            ) : null}
          </div>
          <div className="flex shrink-0 justify-end gap-2">
            <Button variant="secondary" onClick={() => answer(false)}>{t(`${copy}.cancel`)}</Button>
            <Button variant="cta" disabled={!canConfirm} autoFocus onClick={() => answer(true)}>
              {t(`${copy}.confirm`)}
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
