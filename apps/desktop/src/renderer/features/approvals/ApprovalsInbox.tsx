/**
 * Central view over the existing session approval flow. No permissions or decisions are stored
 * here: requests and their delivery state belong to makerChatStore, and every decision goes through
 * the real PermissionPrompt -> makerChatStore.respondToPermission(sessionId, result). The inbox only
 * adds a stable queue, explicit selection and a short arming lock in front of the decision controls.
 */
import { ChevronLeft, Inbox, ListChecks } from 'lucide-react';
import { memo, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';

import { InvisibleWindowDragStrip } from '@/components/layout/windowDrag';
import { Button } from '@/components/ui/button';
import { getDataOwnerGeneration, isDataOwnerGenerationCurrent } from '@/contexts/dataOwnerGeneration';
import { useRegisterCCAgentSidebar } from '@/features/cc-agent/useRegisterCCAgentSidebar';
import { resolveSessionRoute } from '@/lib/orcaSessionIdentity';
import { cn } from '@/lib/utils';
import { useAgentIslandActivityMap } from '@/state/agentIslandActivity';

import { ApprovalInspector } from './ApprovalInspector';
import { ApprovalQueue, type FocusRequest } from './ApprovalQueue';
import { usePermissionFor } from './ApprovalRow';
import type { QueueEntry } from './queueModel';
import './approvals.css';
import { useApprovalQueue } from './useApprovalQueue';
import { useApprovalReconcile } from './useApprovalReconcile';
import { useApprovalSelection } from './useApprovalSelection';
import { useApprovalSessionIds } from './useApprovalSessionIds';
import { useContainerWidth } from './useContainerWidth';
import { useDataOwnerEpoch } from './useDataOwnerEpoch';
import { invalidateWorkerIdentity, useWorkerIdentity } from './useWorkerIdentity';

/** Container width (measured on the outer section) from which queue and inspector sit side by side. */
const TWO_PANE_MIN_WIDTH = 800;

export function ApprovalsInbox() {
  useRegisterCCAgentSidebar();
  // A new data owner remounts the body, which drops the selection, placeholders and late lookups.
  const epoch = useDataOwnerEpoch();
  return <ApprovalsInboxBody key={epoch} />;
}

const ApprovalsInboxBody = memo(function ApprovalsInboxBody() {
  const { t } = useTranslation();
  const titleId = useId();
  const sectionRef = useRef<HTMLElement>(null);
  const backRef = useRef<HTMLButtonElement>(null);
  const width = useContainerWidth(sectionRef);
  const twoPane = width === 0 || width >= TWO_PANE_MIN_WIDTH;

  const storeIds = useApprovalSessionIds();
  const activities = useAgentIslandActivityMap();
  const hostIds = useMemo(
    () => [...activities]
      .filter(([, activity]) => activity.phase === 'needs-interaction' && activity.interactionKind === 'permission')
      .map(([id]) => id),
    [activities],
  );
  const [held, setHeld] = useState(false);
  const entries = useApprovalQueue(held);
  const { selectedKey, selectionId, select, clear } = useApprovalSelection(entries);
  const { checking, failed, refresh } = useApprovalReconcile({ storeIds, hostIds });
  const [identityVersion, setIdentityVersion] = useState(0);
  const [focusRequest, setFocusRequest] = useState<FocusRequest | null>(null);

  const selectedEntry = entries.find((entry) => entry.key === selectedKey) ?? null;
  const pendingCount = entries.filter((entry) => entry.phase === 'pending').length;
  const showDetail = !twoPane && selectedEntry !== null;
  const gutter = twoPane ? 'px-6' : 'px-4';

  const focusQueueRow = (key: string | null) => {
    if (key) setFocusRequest((current) => ({ key, id: (current?.id ?? 0) + 1 }));
  };
  const back = () => { focusQueueRow(selectedKey); clear(); };
  const escapeInspector = () => (twoPane ? focusQueueRow(selectedKey) : back());
  const onRefresh = () => {
    invalidateWorkerIdentity();
    setIdentityVersion((value) => value + 1);
    refresh();
  };

  useEffect(() => {
    if (showDetail) backRef.current?.focus();
  }, [showDetail]);

  const queue = (
    <ApprovalQueue
      entries={entries}
      selectedKey={selectedKey}
      identityVersion={identityVersion}
      focusRequest={focusRequest}
      onSelect={select}
      onHoldChange={setHeld}
    />
  );
  const inspector = selectedEntry
    ? (
      <SelectedInspector
        key={selectionId}
        entry={selectedEntry}
        identityVersion={identityVersion}
        onEscape={escapeInspector}
      />
    )
    : <IdleInspector />;

  return (
    <section
      ref={sectionRef}
      aria-labelledby={titleId}
      className="relative flex h-full min-h-0 w-full flex-col bg-content-area"
    >
      <InvisibleWindowDragStrip />
      {showDetail ? (
        <div className={cn('flex shrink-0 items-center gap-3 pb-3 pt-8', gutter)}>
          <Button ref={backRef} size="sm" variant="secondary" onClick={back}>
            <ChevronLeft size={14} aria-hidden="true" />
            {t('approvalsInbox.back')}
          </Button>
          <h1 id={titleId} className="sr-only">{t('approvalsInbox.title')}</h1>
          <span className="approval-tnum text-12 text-[var(--text-secondary)]">
            {t('approvalsInbox.waitingCount', { count: pendingCount })}
          </span>
        </div>
      ) : (
        <header className={cn('flex shrink-0 items-end gap-3 pb-4 pt-8', gutter)}>
          <div className="min-w-0">
            <h1 id={titleId} className="text-20 font-medium leading-tight text-[var(--text-primary)]">
              {t('approvalsInbox.title')}
            </h1>
            <p className="approval-tnum mt-1 text-13 text-[var(--text-secondary)]">
              {t('approvalsInbox.waitingCount', { count: pendingCount })}
            </p>
          </div>
          <div className="flex-1" />
          <Button size="sm" variant="secondary" disabled={checking} onClick={onRefresh}>
            {t('approvalsInbox.refresh')}
          </Button>
        </header>
      )}

      {failed && (
        <p role="alert" className={cn('shrink-0 pb-3 text-13 text-[var(--text-secondary)]', gutter)}>
          {t('approvalsInbox.loadFailed')}
        </p>
      )}

      <div className={cn('min-h-0 flex-1 pb-6', gutter)}>
        {entries.length === 0 ? (
          <EmptyState checking={checking} failed={failed} />
        ) : twoPane ? (
          <div className="grid h-full max-h-[640px] min-h-0 grid-cols-[minmax(300px,360px)_minmax(0,1fr)] gap-6">
            {queue}
            {inspector}
          </div>
        ) : (
          <div className="h-full max-h-[640px] min-h-0">{showDetail ? inspector : queue}</div>
        )}
      </div>
    </section>
  );
});

function SelectedInspector({ entry, identityVersion, onEscape }: {
  entry: QueueEntry; identityVersion: number; onEscape: () => void;
}) {
  const navigate = useNavigate();
  const identity = useWorkerIdentity(entry.sessionId, identityVersion);
  const permission = usePermissionFor(entry);
  if (!permission) return <IdleInspector />;
  const openSession = async () => {
    const owner = getDataOwnerGeneration();
    const route = await resolveSessionRoute(entry.sessionId, identity.session).catch(() => null);
    if (route && isDataOwnerGenerationCurrent(owner)) navigate(route);
  };
  return (
    <ApprovalInspector
      entry={entry}
      permission={permission}
      identity={identity}
      onOpenSession={() => { void openSession(); }}
      onEscape={onEscape}
    />
  );
}

function IdleInspector() {
  const { t } = useTranslation();
  return (
    <section
      aria-label={t('approvalsInbox.idleTitle')}
      className="grid h-full min-h-0 place-items-center rounded-xl border border-[var(--border-default)] p-8"
    >
      <div className="flex max-w-[360px] flex-col items-center text-center">
        <span className="mb-4 grid h-12 w-12 place-items-center rounded-lg border border-[var(--border-default)] text-[var(--text-secondary)]">
          <ListChecks size={22} strokeWidth={1.5} aria-hidden="true" />
        </span>
        <h2 className="text-15 font-medium text-[var(--text-primary)]">{t('approvalsInbox.idleTitle')}</h2>
        <p className="mt-2 text-13 leading-relaxed text-[var(--text-secondary)]">{t('approvalsInbox.idleBody')}</p>
      </div>
    </section>
  );
}

function EmptyState({ checking, failed }: { checking: boolean; failed: boolean }) {
  const { t } = useTranslation();
  if (checking || failed) {
    return (
      <p role="status" className="py-8 text-13 text-[var(--text-secondary)]">
        {t(checking ? 'approvalsInbox.loading' : 'approvalsInbox.unavailable')}
      </p>
    );
  }
  return (
    <div role="status" className="grid h-full max-h-[420px] place-items-center rounded-xl border border-[var(--border-default)] p-8">
      <div className="flex max-w-[340px] flex-col items-center text-center">
        <span className="mb-4 grid h-12 w-12 place-items-center rounded-lg border border-[var(--border-default)] text-[var(--text-secondary)]">
          <Inbox size={22} strokeWidth={1.5} aria-hidden="true" />
        </span>
        <h2 className="text-15 font-medium text-[var(--text-primary)]">{t('approvalsInbox.emptyTitle')}</h2>
        <p className="mt-2 text-13 leading-relaxed text-[var(--text-secondary)]">{t('approvalsInbox.empty')}</p>
      </div>
    </div>
  );
}
