import { prStatusQuery, type PrStatusResult } from '@cindy/maker-shared';
import {
  buildDeliveryReceipt,
  type DeliveryReceipt,
  type DeliveryReceiptFileInput,
  type DeliveryReceiptInput,
  type DeliveryReceiptPullRequest,
} from '@cindy/maker-shared/delivery-receipt';
import * as Dialog from '@radix-ui/react-dialog';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { useDialogExit } from '@/hooks/useDialogExit';
import { useRemoteSessionActivity } from '@/features/device-link/remoteSessionActivityStore';
import { useSessionAttentionKind } from '@/lib/sessionAttentionStore';
import type { Session } from '@/lib/ccAgent.types';
import { buildDeliveryReceiptDeepLink } from '@/lib/deepLink';
import { toast } from '@/lib/toast';
import { makerChatStore } from '@/lib/makerChatStore';
import { get as getSession } from '@/lib/sessionService';
import { useAgentIslandActivity } from '@/state/agentIslandActivity';
import { projectSidebarSessionActivity } from './sidebarRightStatus';

interface ListedMessage {
  role?: string;
  content?: unknown;
  toolUseId?: string | null;
}

type ReceiptFacts = Omit<DeliveryReceiptInput, 'phase' | 'interactionKind' | 'workflowWaitingOn'>;

function outcomeLabel(outcome: string, t: (key: string) => string): string {
  if (outcome === 'failed') return t('deliveryReceipt.outcome.failed');
  if (outcome === 'tests failed') return t('deliveryReceipt.outcome.testsFailed');
  if (outcome === 'ok') return t('deliveryReceipt.outcome.ok');
  return outcome || t('deliveryReceipt.unknown');
}

async function readReceiptFacts(session: Session, stillCurrent: () => boolean): Promise<ReceiptFacts | null> {
  const [sets, messages, git, refs] = await Promise.all([
    window.electronAPI.maker.listTurnChangeSets(session.id),
    window.electronAPI.localDb.messages.list(session.id, { limit: 100 }),
    window.electronAPI.gitContext.getForSession({
      sessionId: session.id,
      workingDir: session.workingDir,
      worktreePath: session.worktreePath ?? null,
      remoteHostId: session.remoteHostId,
    }).catch(() => null),
    window.electronAPI.gitContext.listPrRefs(session.id).catch(() => null),
  ]);
  const changedFiles: DeliveryReceiptFileInput[] = [];
  let unlistedChangeCount = 0;
  let captureIncomplete = false;
  let fileHistoryTruncated = false;
  for (const set of [...sets].sort((a, b) => a.createdAt - b.createdAt)) {
    const hiddenFiles = Math.max(0, set.fileCount - set.files.length);
    unlistedChangeCount += hiddenFiles;
    if (hiddenFiles > 0) fileHistoryTruncated = true;
    if (set.state === 'partial' || set.incompleteReasons.length > 0 || hiddenFiles > 0) captureIncomplete = true;
    const applied = set.workspaceState !== 'undone';
    for (const file of set.files) {
      changedFiles.push({
        path: file.path,
        oldPath: file.oldPath,
        status: file.status,
        applied,
        cwd: set.cwd,
      });
    }
  }
  if (!refs) {
    return {
      title: session.title,
      workingDir: git?.workdir ?? session.workingDir,
      branch: git?.head?.kind === 'branch' ? git.head.branch : git?.head?.shortSha ?? null,
      changedFiles,
      unlistedChangeCount,
      messages: messageInputs(messages),
      pullRequests: [],
      pullRequestsUnavailable: true,
      captureIncomplete,
      fileHistoryTruncated,
    };
  }
  const activeRefs = refs.filter((ref) => ref.removedAt == null);
  let pullRequests: DeliveryReceiptPullRequest[] = [];
  if (activeRefs.length > 0) {
    if (!stillCurrent()) return null;
    const statuses: PrStatusResult[] | null = await window.electronAPI.gitContext
      .getPrStatuses(activeRefs.map(prStatusQuery))
      .catch(() => null);
    pullRequests = activeRefs.map((ref, index): DeliveryReceiptPullRequest => {
      const status = statuses?.[index];
      if (!status?.ok) return { url: ref.url, status: 'unknown', checks: null };
      return { url: status.htmlUrl || ref.url, status: 'ok', checks: status.checks ?? null };
    });
  }
  return {
    title: session.title,
    workingDir: git?.workdir ?? session.workingDir,
    branch: git?.head?.kind === 'branch' ? git.head.branch : git?.head?.shortSha ?? null,
    changedFiles,
    unlistedChangeCount,
    messages: messageInputs(messages),
    pullRequests,
    captureIncomplete,
    fileHistoryTruncated,
  };
}

function messageInputs(messages: unknown) {
  const listed = Array.isArray(messages) ? (messages as ListedMessage[]) : [];
  return [...listed].reverse().map((message) => ({
    role: message.role ?? '',
    content: message.content,
    toolUseId: message.toolUseId,
  }));
}

function ReceiptFiles({
  items,
  omitted,
  remote,
}: {
  items: Array<{ path: string; name?: string; openable?: boolean }>;
  omitted: number;
  remote: boolean;
}) {
  const { t } = useTranslation();
  return (
    <ul className="mt-1 flex flex-col">
      {items.map((file) => (
        <li key={file.path}>
          {remote || file.openable === false ? (
            <span className="block min-h-8 truncate px-1 text-left text-sm text-[var(--text-primary)]">
              {file.name || file.path}
            </span>
          ) : (
            <button
              type="button"
              className="min-h-8 w-full truncate rounded-lg px-1 text-left text-sm text-[var(--text-primary)] hover:bg-titlebar-button-hover"
              onClick={() => {
                void window.electronAPI.openPath(file.path);
              }}
            >
              {file.name || file.path}
            </button>
          )}
        </li>
      ))}
      {omitted > 0 && (
        <li className="px-1 text-sm text-[var(--text-secondary)]">
          {t('deliveryReceipt.more', { count: omitted })}
        </li>
      )}
    </ul>
  );
}

export function DeliveryReceiptDialog({
  sessionId,
  onClose,
}: {
  sessionId: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const dialog = useDialogExit();
  const attentionKind = useSessionAttentionKind(sessionId);
  const islandActivity = useAgentIslandActivity(sessionId);
  const runningMap = useSyncExternalStore(
    makerChatStore.subscribeAll,
    makerChatStore.getRunningSnapshot,
    makerChatStore.getRunningSnapshot,
  );
  const [session, setSession] = useState<Session | null>(null);
  const [facts, setFacts] = useState<ReceiptFacts | null>(null);
  const [failed, setFailed] = useState(false);
  const remoteActivity = useRemoteSessionActivity(sessionId, session?.deviceLinkDeviceId);

  useEffect(() => {
    let disposed = false;
    setSession(null);
    setFacts(null);
    setFailed(false);
    void getSession(sessionId)
      .then(async (next) => {
        if (disposed) return;
        setSession(next);
        // 另一台电脑或 SSH 工作区的记录不在本机。不拿本机空结果冒充这次结果。
        if (next.deviceLinkDeviceId || next.remoteHostId) {
          setFailed(true);
          return;
        }
        const nextFacts = await readReceiptFacts(next, () => !disposed);
        if (!disposed && nextFacts) setFacts(nextFacts);
      })
      .catch(() => {
        if (!disposed) setFailed(true);
      });
    return () => {
      disposed = true;
    };
  }, [sessionId]);

  const live = session?.deviceLinkDeviceId ? remoteActivity : islandActivity;
  const activity = session
    ? projectSidebarSessionActivity({
        interruption: session,
        sessionId: session.id,
        title: session.title,
        recordStatus: session.status,
        liveActivity: live,
        attentionKind,
        isUrgentFromContext: false,
        isRunning: session.deviceLinkDeviceId ? remoteActivity?.phase === 'running' : runningMap.has(sessionId),
        hasAttentionNotification: attentionKind !== undefined,
      })
    : null;
  const receipt: DeliveryReceipt | null = facts
    ? buildDeliveryReceipt({
        ...facts,
        phase: activity?.phase,
        interactionKind: activity?.interactionKind,
        workflowWaitingOn: activity?.workflow?.waitingOn,
      })
    : null;

  const copyLink = async () => {
    const link = buildDeliveryReceiptDeepLink(sessionId, {
      deviceId: session?.deviceLinkDeviceId,
    });
    try {
      await navigator.clipboard.writeText(link);
      toast.success(t('deliveryReceipt.copied'));
    } catch {
      toast.warning(t('deliveryReceipt.copyFailed'));
    }
  };

  const value = (text: string | null | undefined) => text?.trim() || t('deliveryReceipt.unknown');

  return (
    <Dialog.Root open={dialog.open} onOpenChange={(open) => { if (!open) dialog.close(onClose); }}>
      <Dialog.Portal>
        <Dialog.Overlay
          className="modal-scrim fixed inset-0 z-modal"
          onClick={(event) => event.stopPropagation()}
        />
        <Dialog.Content
          className="modal-panel fixed left-1/2 top-1/2 z-modal-raised flex max-h-[85vh] w-[min(520px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-y-auto p-4 text-[var(--text-primary)]"
          onClick={(event) => event.stopPropagation()}
          onOpenAutoFocus={dialog.onOpenAutoFocus}
          onCloseAutoFocus={dialog.onCloseAutoFocus}
          onPointerDownOutside={(event) => event.preventDefault()}
        >
          <Dialog.Title className="text-lg font-medium">{t('deliveryReceipt.title')}</Dialog.Title>
          <Dialog.Description className="mt-1 text-sm text-[var(--text-secondary)]">
            {receipt?.title || t('deliveryReceipt.loading')}
          </Dialog.Description>
          {failed && (
            <p role="alert" className="mt-3 text-sm text-[var(--text-danger)]">{t('deliveryReceipt.loadFailed')}</p>
          )}
          {!receipt && !failed && (
            <div className="mt-4 flex items-center gap-2 text-sm text-[var(--text-secondary)]">
              <Spinner size={14} />
              {t('deliveryReceipt.loading')}
            </div>
          )}
          {receipt && (
            <div className="mt-4 flex flex-col gap-3 text-sm">
              <p>
                <span className="text-[var(--text-secondary)]">{t('deliveryReceipt.status')} </span>
                {t(`deliveryReceipt.phaseValue.${receipt.phase}`, { defaultValue: t('deliveryReceipt.unknown') })}
              </p>
              <p className="break-all">
                <span className="text-[var(--text-secondary)]">{t('deliveryReceipt.workingDir')} </span>
                {value(receipt.workingDir)}
              </p>
              <p>
                <span className="text-[var(--text-secondary)]">{t('deliveryReceipt.branch')} </span>
                {value(receipt.branch)}
              </p>
              {receipt.conversationOnly && <p>{t('deliveryReceipt.conversationOnly')}</p>}
              {receipt.changes.shown && (
                <section>
                  <h2 className="font-medium">{t('deliveryReceipt.changes')}</h2>
                  <ReceiptFiles items={receipt.changes.items} omitted={receipt.changes.omitted} remote={Boolean(session?.remoteHostId)} />
                </section>
              )}
              {receipt.verification.shown && (
                <section>
                  <h2 className="font-medium">{t('deliveryReceipt.verification')}</h2>
                  <ul className="mt-1 flex flex-col gap-1">
                    {receipt.verification.items.map((command) => (
                      <li key={`${command.command}:${command.outcome}`} className="break-all">
                        <span className="font-mono">{command.command}</span>
                        <span className={command.failed ? ' text-[var(--text-danger)]' : ' text-[var(--text-secondary)]'}>
                          {' '}{outcomeLabel(command.outcome, t)}
                        </span>
                      </li>
                    ))}
                    {receipt.verification.omitted > 0 && (
                      <li className="text-[var(--text-secondary)]">{t('deliveryReceipt.more', { count: receipt.verification.omitted })}</li>
                    )}
                  </ul>
                </section>
              )}
              {receipt.outputs.shown && (
                <section>
                  <h2 className="font-medium">{t('deliveryReceipt.outputs')}</h2>
                  <ReceiptFiles items={receipt.outputs.items} omitted={receipt.outputs.omitted} remote={Boolean(session?.remoteHostId)} />
                </section>
              )}
              <p className="break-all">
                <span className="text-[var(--text-secondary)]">{t('deliveryReceipt.pullRequest')} </span>
                {receipt.prUrl ?? (receipt.ci === 'unknown' ? t('deliveryReceipt.unknown') : t('deliveryReceipt.ciNone'))}
              </p>
              <p>
                <span className="text-[var(--text-secondary)]">{t('deliveryReceipt.ci')} </span>
                {t(`deliveryReceipt.ciValue.${receipt.ci}`)}
              </p>
              <p>
                <span className="text-[var(--text-secondary)]">{t('deliveryReceipt.next')} </span>
                {t(`deliveryReceipt.nextValue.${receipt.nextStep}`)}
              </p>
            </div>
          )}
          <div className="mt-5 flex justify-end gap-2">
            <Button variant="secondary" size="md" compact palette="confirmation" type="button" onClick={() => void copyLink()}>
              {t('deliveryReceipt.copyLink')}
            </Button>
            <Dialog.Close asChild>
              <Button variant="cta" size="md" compact palette="confirmation" type="button">
                {t('deliveryReceipt.close')}
              </Button>
            </Dialog.Close>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
