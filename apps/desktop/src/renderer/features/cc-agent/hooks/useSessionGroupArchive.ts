import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import type { NavigateFunction } from 'react-router-dom';
import type { ConfirmOptions } from '@/components/ui/confirm-dialog-provider';
import type { Session } from '@/lib/ccAgent.types';
import * as sessionService from '@/lib/sessionService';
import { makerChatStore } from '@/lib/makerChatStore';
import { discardDraft as discardComposerDraft } from '@/lib/composerDraftStore';
import { countDirtyWorktreesForRemoval } from '@/lib/worktreeRemovalWarning';
import { archiveScheduleWarningMany } from '@/features/scheduler/lib/archiveScheduleWarning';
import { emitRefresh } from '@/lib/sessionsBus';
import { toast } from '@/lib/toast';
import { createLogger } from '@/lib/logger';
import { projectIdentityKeyForSession, type ProjectNode } from '../lib/projectGrouping';
import { isDeviceLinkWriteBlocked } from '../lib/remoteSessionWriteGuard';
import {
  projectBulkArchiveActionForStatus,
  selectProjectBulkArchiveCandidates,
} from '../lib/projectBulkArchiveAction';
import type { FilterStatus } from './useSidebarFilter';
import {
  getAutomationSidebarGroupInfo,
  type AutomationSessionGroup,
  type AutomationScheduleSessionInfo,
} from '../lib/automationSidebarGrouping';

const log = createLogger('SessionGroupArchive');

/** Read takeover first, then the live running store after that asynchronous boundary. */
async function archiveBlockReason(sessionId: string): Promise<'attached' | 'running' | null> {
  try {
    if ((await window.electronAPI.binding.resolveSession(sessionId)).attached) return 'attached';
  } catch {
    // Match the existing single-session and selection archive preflight fallback.
  }
  return makerChatStore.getRunningSnapshot().get(sessionId)?.isRunning ? 'running' : null;
}

type SessionGroupArchiveScope =
  | { kind: 'project'; project: ProjectNode }
  | { kind: 'dialogue'; sessions: readonly Session[] }
  | {
      kind: 'automation';
      group: AutomationSessionGroup;
      scheduleSessionIndex: ReadonlyMap<string, AutomationScheduleSessionInfo>;
    };

interface SessionGroupArchiveOptions {
  sessions: readonly Session[];
  runningSessionIds: ReadonlySet<string>;
  status: FilterStatus;
  confirmDialog: (options: ConfirmOptions) => Promise<boolean>;
  refreshSessions: () => Promise<unknown>;
  patchLocal: (id: string, patch: Partial<Session>) => void;
  viewedSessionId?: string;
  navigate: NavigateFunction;
}

/** Shared group bulk lifecycle. Scope membership never depends on visible fold limits. */
export function useSessionGroupArchive({
  sessions,
  runningSessionIds,
  status,
  confirmDialog,
  refreshSessions,
  patchLocal,
  viewedSessionId,
  navigate,
}: SessionGroupArchiveOptions) {
  const { t } = useTranslation();
  return useCallback(
    async (scope: SessionGroupArchiveScope) => {
      if (
        scope.kind === 'project'
          ? isDeviceLinkWriteBlocked(scope.project)
          : scope.kind === 'automation'
            ? scope.group.deviceLinkDeviceId ||
              scope.group.sessions.some((s) => s.deviceLinkDeviceId)
            : scope.sessions.some((session) => session.deviceLinkDeviceId)
      ) {
        toast.warning(
          t(
            scope.kind !== 'dialogue'
              ? 'ccAgent.remoteSession.actionsUnavailable'
              : 'ccAgent.sidebar.dialogueAction.remoteBulkUnavailable',
          ),
        );
        return;
      }
      const action =
        scope.kind === 'automation' ? 'archive' : projectBulkArchiveActionForStatus(status);
      const memberIds =
        scope.kind === 'dialogue' ? new Set(scope.sessions.map((session) => session.id)) : null;
      const belongsToGroup = (session: Session): boolean =>
        scope.kind === 'project'
          ? projectIdentityKeyForSession(session) === scope.project.projectKey
          : scope.kind === 'automation'
            ? !session.deviceLinkDeviceId &&
              getAutomationSidebarGroupInfo(session, scope.scheduleSessionIndex)?.key ===
                scope.group.id
            : memberIds!.has(session.id);
      const archiveCopy =
        scope.kind === 'project'
          ? 'archiveAll'
          : scope.kind === 'automation'
            ? 'automationArchiveAll'
            : 'dialogueArchiveAll';
      const restoreCopy = scope.kind === 'project' ? 'unarchiveAll' : 'dialogueRestoreAll';

      // Only local records are written; remote batches require runtime checks on their owning computer.
      // All group types share candidate selection, confirmation and lifecycle cleanup.
      const selection = selectProjectBulkArchiveCandidates(
        sessions,
        action,
        runningSessionIds,
        belongsToGroup,
      );
      let { candidates, skippedRunning } = selection;
      const { skippedPinned } = selection;

      if (action === 'unarchive') {
        if (candidates.length === 0) {
          toast.warning(t(`ccAgent.sidebar.${restoreCopy}.empty`));
          return;
        }

        const ok = await confirmDialog({
          title: t('ccAgent.sidebar.unarchiveAll.title'),
          description: t(`ccAgent.sidebar.${restoreCopy}.description`, {
            count: candidates.length,
          }),
          confirmText: t('ccAgent.sidebar.unarchiveAll.confirm'),
          cancelText: t('ccAgent.sidebar.unarchiveAll.cancel'),
        });
        if (!ok) return;

        const failed: string[] = [];
        for (const session of candidates) {
          try {
            // 确认框是异步边界：由持久层在单条 UPDATE 中同时校验 archived 状态和
            // 原任务归属，避免 get + update 在两次异步调用之间仍可被并发写穿。
            const restored = await sessionService.restoreIfArchived(session.id, session);
            if (!restored) {
              failed.push(session.id);
              continue;
            }
            patchLocal(restored.id, { status: 'active' });
          } catch (err) {
            log.error('[unarchive all]', err);
            failed.push(session.id);
          }
        }

        const succeededCount = candidates.length - failed.length;
        await refreshSessions();
        // 批量恢复跨 archived → active 桶，强制刷新其余缓存桶，确保 active / all
        // 视图切换后立即看到恢复结果。
        emitRefresh();

        if (failed.length === 0) {
          toast.success(t('ccAgent.sidebar.unarchiveAll.unarchived', { count: succeededCount }));
        } else {
          toast.error(
            t('ccAgent.sidebar.unarchiveAll.partialFailure', {
              ok: succeededCount,
              fail: failed.length,
            }),
          );
        }
        return;
      }

      let skippedAttached = 0;
      const checked = await Promise.all(
        candidates.map(async (session) => {
          const reason = await archiveBlockReason(session.id);
          if (reason === 'attached') skippedAttached++;
          if (reason === 'running') skippedRunning++;
          return reason ? null : session;
        }),
      );
      candidates = checked.filter((session): session is Session => session !== null);

      const skipNotesFor = (running: number, pinned: number, attached: number): string[] => {
        const notes: string[] = [];
        if (running > 0)
          notes.push(t('ccAgent.sidebar.archiveAll.skipRunning', { count: running }));
        if (pinned > 0) notes.push(t('ccAgent.sidebar.archiveAll.skipPinned', { count: pinned }));
        if (attached > 0)
          notes.push(t('ccAgent.sidebar.bulkSelection.skipAttached', { count: attached }));
        return notes;
      };
      const skipSep = t('ccAgent.sidebar.archiveAll.skipSeparator');
      const skipNotes = skipNotesFor(skippedRunning, skippedPinned, skippedAttached);
      if (candidates.length === 0) {
        if (skippedAttached > 0) {
          toast.warning(t('ccAgent.sidebar.archiveAll.skipped', { skip: skipNotes.join(skipSep) }));
        } else if (skippedPinned > 0 && skippedRunning > 0) {
          toast.warning(t(`ccAgent.sidebar.${archiveCopy}.allPinnedOrRunning`));
        } else if (skippedPinned > 0) {
          toast.warning(t(`ccAgent.sidebar.${archiveCopy}.allPinned`));
        } else if (skippedRunning > 0) {
          toast.warning(t(`ccAgent.sidebar.${archiveCopy}.allRunning`));
        } else {
          toast.warning(t(`ccAgent.sidebar.${archiveCopy}.empty`));
        }
        return;
      }

      const scheduleWarning = await archiveScheduleWarningMany(t, candidates);
      const dirtyCount = await countDirtyWorktreesForRemoval(candidates);

      const baseDescription =
        skipNotes.length > 0
          ? t(`ccAgent.sidebar.${archiveCopy}.descriptionWithSkip`, {
              count: candidates.length,
              skip: skipNotes.join(skipSep),
            })
          : t(`ccAgent.sidebar.${archiveCopy}.description`, { count: candidates.length });
      const description =
        baseDescription +
        (dirtyCount > 0
          ? ' ' +
            t('ccAgent.sidebar.bulkSelection.confirmArchive.dirtyWorktreeWarning', {
              count: dirtyCount,
            })
          : '') +
        (scheduleWarning ? ' ' + scheduleWarning : '');

      const ok = await confirmDialog({
        title: t('ccAgent.sidebar.archiveAll.title'),
        description,
        confirmText: t('ccAgent.sidebar.archiveAll.confirm'),
        cancelText: t('ccAgent.sidebar.archiveAll.cancel'),
      });
      if (!ok) return;

      // 失败的 id 收集起来，最后统一 toast；其余继续走完，不让一条失败拖累整批。
      const failed: string[] = [];
      const succeededIds = new Set<string>();
      let newlyRunning = 0;
      let newlyAttached = 0;
      let newlyPinned = 0;
      for (const s of candidates) {
        try {
          const statusWriteTarget = await sessionService.resolveStatusWriteTarget(s.id);
          // Confirmation, earlier writes and target resolution can outlive preflight.
          const reason = await archiveBlockReason(s.id);
          if (reason) {
            if (reason === 'attached') newlyAttached++;
            else newlyRunning++;
            continue;
          }
          const current = await sessionService.get(s.id);
          if (current.status !== 'active' || current.deviceLinkDeviceId || !belongsToGroup(current)) {
            continue;
          }
          if (current.pinnedAt) {
            newlyPinned++;
            continue;
          }
          // The final metadata read is also an asynchronous boundary. Check the
          // live runtime again, then close and write without further preparation.
          if (makerChatStore.getRunningSnapshot().get(s.id)?.isRunning) {
            newlyRunning++;
            continue;
          }
          makerChatStore.closeSessionQuery(s.id);
          await sessionService.setStatus(s.id, 'archived', statusWriteTarget);
          succeededIds.add(s.id);
          // 写入后同步各状态桶，再清理该任务的运行视图与草稿。
          patchLocal(s.id, { status: 'archived', pinnedAt: null });
          makerChatStore.purgeSession(s.id);
          discardComposerDraft(s.id);
        } catch (err) {
          log.error('[archive all]', err);
          failed.push(s.id);
        }
      }

      await refreshSessions();

      // 当前注视中的 session 被归档了 → 走 /cc-agent 让 CCAgentIndexRedirect
      // 做 Orca-aware 的「选下一条 / 空则跳 new」决策。
      if (viewedSessionId && succeededIds.has(viewedSessionId)) {
        navigate('/cc-agent');
      }

      if (failed.length === 0 && succeededIds.size > 0) {
        toast.success(t('ccAgent.sidebar.archiveAll.archived', { count: succeededIds.size }));
      } else if (failed.length > 0) {
        toast.error(
          t('ccAgent.sidebar.archiveAll.partialFailure', {
            ok: succeededIds.size,
            fail: failed.length,
          }),
        );
      }
      const lateSkipNotes = skipNotesFor(newlyRunning, newlyPinned, newlyAttached);
      if (lateSkipNotes.length > 0) {
        toast.warning(
          t('ccAgent.sidebar.archiveAll.skipped', { skip: lateSkipNotes.join(skipSep) }),
        );
      }
    },
    [
      sessions,
      runningSessionIds,
      confirmDialog,
      refreshSessions,
      viewedSessionId,
      navigate,
      patchLocal,
      status,
      t,
    ],
  );
}
