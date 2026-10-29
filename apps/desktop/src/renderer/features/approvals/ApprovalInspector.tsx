import { ArrowUpRight, Clock, Folder, Users } from 'lucide-react';
import { useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { PermissionPrompt } from '@/components/new-chat/PermissionPrompt';
import { Button } from '@/components/ui/button';
import { makerChatStore, type PendingPermission } from '@/lib/makerChatStore';

import { ApprovalTile, KIND_ICONS } from './ApprovalTile';
import { formatSeenAge, requestKind, SEEN_KEYS } from './approvalFormat';
import type { QueueEntry } from './queueModel';
import { DecisionGate } from './DecisionGate';
import { useNow } from './useNow';
import type { WorkerIdentity } from './useWorkerIdentity';

/**
 * The one place a decision can be made, and only for the request the user explicitly selected.
 * Everything here except the gated prompt is read-only context. Mount it with a key that changes on
 * every new selection so the gate re-arms and the path toggle resets.
 */
export function ApprovalInspector({ entry, permission, identity, onOpenSession, onEscape }: {
  entry: QueueEntry;
  permission: PendingPermission;
  identity: WorkerIdentity;
  onOpenSession: () => void;
  onEscape: () => void;
}) {
  const { t } = useTranslation();
  const now = useNow();
  const [pathOpen, setPathOpen] = useState(false);
  const kind = requestKind(permission.toolName, permission.input);
  const KindIcon = KIND_ICONS[kind];
  const seen = formatSeenAge(now - entry.firstSeenAt);

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Escape') return;
    // Esc leaves the inspector for the queue; it never denies and no global handler may see it.
    event.preventDefault();
    event.stopPropagation();
    onEscape();
  };

  return (
    <section
      aria-label={t('approvalsInbox.inspectorLabel', { name: identity.name })}
      data-testid="approval-inspector"
      onKeyDown={onKeyDown}
      className="flex h-full min-h-0 flex-col overflow-hidden rounded-xl border border-[var(--border-default)]"
    >
      <div className="min-h-0 flex-1 overflow-y-auto">
        <header className="flex items-start gap-3 p-5 pb-4">
          <ApprovalTile role={identity.role} size={44} inverse />
          <div className="min-w-0 flex-1">
            <h2 className="line-clamp-2 text-16 font-medium leading-snug text-[var(--text-primary)] [overflow-wrap:anywhere]" title={identity.name}>
              {identity.name}
            </h2>
            {identity.parentTitle && (
              <p className="mt-1 flex items-start gap-1.5 text-13 text-[var(--text-secondary)]" title={t('approvalsInbox.parentTask')}>
                <Users size={13} strokeWidth={1.75} className="mt-[3px] shrink-0" aria-hidden="true" />
                <span className="line-clamp-2 min-w-0">{identity.parentTitle}</span>
              </p>
            )}
          </div>
          <Button size="sm" variant="secondary" onClick={onOpenSession}>
            <ArrowUpRight size={14} aria-hidden="true" />
            {t('approvalsInbox.openSession')}
          </Button>
        </header>

        <div className="mx-5 flex flex-wrap items-start gap-x-5 gap-y-2 border-t border-[var(--border-default)] py-3.5">
          <span className="inline-flex h-6 shrink-0 items-center gap-1.5 rounded-full border border-[var(--border-default)] px-2.5 text-12 font-medium text-[var(--text-primary)]">
            <KindIcon size={13} strokeWidth={1.75} aria-hidden />
            {t(`approvalsInbox.kind.${kind}`)}
          </span>
          {identity.projectName && (
            <div className="min-w-[160px] flex-1 pt-[2px]">
              <div className="flex min-w-0 items-center gap-1.5">
                <Folder size={13} strokeWidth={1.75} className="shrink-0 text-[var(--text-secondary)]" aria-hidden="true" />
                <span className="min-w-0 truncate text-13 font-medium text-[var(--text-primary)]" title={identity.projectName}>
                  {identity.projectName}
                </span>
                {identity.projectPath && (
                  <Button
                    size="xxs" variant="secondary" tone="quiet" compact aria-expanded={pathOpen}
                    onClick={() => setPathOpen((open) => !open)} className="shrink-0 text-11"
                  >
                    {t(pathOpen ? 'approvalsInbox.hidePath' : 'approvalsInbox.showPath')}
                  </Button>
                )}
              </div>
              {pathOpen && identity.projectPath && (
                <p className="mt-1 break-all font-mono text-12 text-[var(--text-secondary)]">{identity.projectPath}</p>
              )}
            </div>
          )}
          <span
            className="approval-tnum flex h-6 shrink-0 items-center gap-1.5 text-13 text-[var(--text-secondary)]"
            title={t('approvalsInbox.seenHint')}
          >
            <Clock size={13} strokeWidth={1.75} aria-hidden="true" />
            {t(SEEN_KEYS[seen.unit], { count: seen.count })}
          </span>
        </div>

        <div className="px-5 pb-5">
          <DecisionGate>
            <PermissionPrompt
              key={permission.requestId}
              permission={permission}
              enableKeyboardShortcuts={false}
              compactActions
              onRespond={(result) => {
                // Re-check at click time: a retained callback must never decide a newer request,
                // and a request already being sent must not be sent twice.
                const current = makerChatStore.getLightSnapshot(entry.sessionId)?.pendingPermission;
                if (!current || current.requestId !== permission.requestId || current.submitting) return;
                makerChatStore.respondToPermission(entry.sessionId, result);
              }}
            />
          </DecisionGate>
        </div>
      </div>
      <p className="shrink-0 border-t border-[var(--border-default)] px-5 py-3 text-12 text-[var(--text-secondary)]">
        {t('approvalsInbox.decisionScope')}
      </p>
    </section>
  );
}
