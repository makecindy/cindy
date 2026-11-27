import {
  PROJECT_ARCHIVE_CHANNEL,
  type ProjectArchiveMember,
  type ProjectArchiveOperation,
  type ProjectArchiveReceipt,
} from '../../../../shared/projectArchive';
import { projectDisplayLabelWithMachine } from '../lib/remoteProjectIdentity';
import { remoteProjectsStore } from '@/features/device-link/remoteProjectsStore';
import {
  getDataOwnerGeneration,
  isDataOwnerGenerationCurrent,
} from '@/contexts/dataOwnerGeneration';
import { isSessionRemovalRouteCurrent } from '../lib/sessionRemovalNavigation';
import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import type { NavigateFunction } from 'react-router-dom';
import type { ConfirmOptions, ConfirmWithCheckboxOptions } from '@/components/ui/confirm-dialog-provider';
import type { Session } from '@/lib/ccAgent.types';
import * as sessionService from '@/lib/sessionService';
import { makerChatStore } from '@/lib/makerChatStore';
import { countDirtyWorktreesForRemoval } from '@/lib/worktreeRemovalWarning';
import { archiveScheduleWarningMany } from '@/features/scheduler/lib/archiveScheduleWarning';
import { emitRefresh } from '@/lib/sessionsBus';
import { toast } from '@/lib/toast';
import { createLogger } from '@/lib/logger';
import type { ProjectNode } from '../lib/projectGrouping';
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
  | { kind: 'project'; project: ProjectNode; removal?: {
      confirm: (options: ConfirmWithCheckboxOptions) => Promise<{ ok: boolean; checked: boolean }>;
      finish: () => Promise<void>;
    } }
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
      const removal = scope.kind === 'project' ? scope.removal : undefined;
      if (removal && (scope.kind !== 'project' || scope.project.scope !== 'local')) return;
      const action =
        removal || scope.kind === 'automation' ? 'archive' : projectBulkArchiveActionForStatus(status);
      const memberIds =
        scope.kind === 'dialogue' ? new Set(scope.sessions.map((session) => session.id)) : null;
      const belongsToGroup = (session: Session): boolean =>
        scope.kind === 'automation'
          ? !session.deviceLinkDeviceId &&
            getAutomationSidebarGroupInfo(session, scope.scheduleSessionIndex)?.key ===
              scope.group.id
          : memberIds?.has(session.id) === true;
      const archiveCopy =
        scope.kind === 'project'
          ? 'archiveAll'
          : scope.kind === 'automation'
            ? 'automationArchiveAll'
            : 'dialogueArchiveAll';
      const restoreCopy = scope.kind === 'project' ? 'unarchiveAll' : 'dialogueRestoreAll';

      const owner = getDataOwnerGeneration();
      const deviceId = scope.kind === 'project' ? scope.project.deviceLinkDeviceId : null;
      const project = scope.kind === 'project' ? scope.project : null;
      const invokeProject = (operation: ProjectArchiveOperation) => {
        if (!project) throw new Error('Missing archive project');
        const request = {
          ...operation,
          directory: project.workingDir,
          action: removal ? 'archiveOnRemoval' as const : action,
          remoteHostId: project.remoteHostId,
        };
        return deviceId
          ? window.electronAPI.deviceLink.invoke(deviceId, PROJECT_ARCHIVE_CHANNEL, [request])
          : window.electronAPI.localDb.sessions.projectArchive(request);
      };
      let projectMembers: ProjectArchiveMember[] = [];
      if (project) {
        try {
          const preview = await invokeProject({ operation: 'preview' });
          if (!Array.isArray(preview)) throw new Error('Invalid project preview');
          projectMembers = preview;
        } catch (error) {
          log.warn('Project archive preview failed', error);
          if (isDataOwnerGenerationCurrent(owner))
            toast.error(
              t(
                deviceId
                  ? 'ccAgent.sidebar.projectAction.remotePreviewFailed'
                  : 'ccAgent.sidebar.projectAction.previewFailed',
              ),
            );
          return;
        }
      }
      const applyProject = async (id: string): Promise<ProjectArchiveReceipt> => {
        const receipt = await invokeProject({ operation: 'apply', sessionId: id });
        if (receipt === 'updated' && isDataOwnerGenerationCurrent(owner)) {
          const nextStatus = action === 'archive' ? 'archived' : 'active';
          if (deviceId) remoteProjectsStore.applyPatch(deviceId, id, { status: nextStatus });
          else {
            patchLocal(id, { status: nextStatus });
            if (nextStatus === 'archived') {
              makerChatStore.closeSessionQuery(id);
              makerChatStore.purgeSession(id);
            }
          }
        }
        return receipt as ProjectArchiveReceipt;
      };

      const selection = selectProjectBulkArchiveCandidates(
        project ? [] : sessions,
        action,
        runningSessionIds,
        belongsToGroup,
      );
      const projectEligible = projectMembers
        .filter((member) => !member.blocked)
        .map((member) => ({ ...member, deviceLinkDeviceId: deviceId }));
      let skippedRunning =
        selection.skippedRunning +
        projectMembers.filter((member) => member.blocked === 'running').length;
      const skippedPinned =
        selection.skippedPinned +
        projectMembers.filter((member) => member.blocked === 'pinned').length;
      if (!isDataOwnerGenerationCurrent(owner)) return;

      if (action === 'unarchive') {
        const candidates = project ? projectEligible : selection.candidates;
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
            if (!isDataOwnerGenerationCurrent(owner)) return;
            if ('hasWorktree' in session) {
              if ((await applyProject(session.id)) !== 'updated') failed.push(session.id);
              continue;
            }
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
        if (!deviceId) await refreshSessions();
        // 批量恢复跨 archived → active 桶，强制刷新其余缓存桶，确保 active / all
        // 视图切换后立即看到恢复结果。
        if (!deviceId) emitRefresh();

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

      let skippedAttached = projectMembers.filter((member) => member.blocked === 'attached').length;
      const checked = await Promise.all(
        selection.candidates.map(async (session) => {
          const reason = await archiveBlockReason(session.id);
          if (reason === 'attached') skippedAttached++;
          if (reason === 'running') skippedRunning++;
          return reason ? null : session;
        }),
      );
      const candidates = project
        ? projectEligible
        : checked.filter((session): session is Session => session !== null);

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
      if (!removal && candidates.length === 0) {
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
      if (!isDataOwnerGenerationCurrent(owner)) return;
      if (removal && project) {
        const title = t('ccAgent.sidebar.projectAction.removeFromSidebarConfirmTitle', {
          name: project.displayName,
        });
        const confirmText = t('ccAgent.sidebar.projectAction.removeFromSidebarConfirmAction');
        const keepFiles = t('ccAgent.sidebar.projectAction.removeKeepFiles');
        const activeTasks = t('ccAgent.sidebar.projectAction.removeFromSidebarConfirmDescription', {
          count: projectMembers.length,
        });
        const skippedTasks = skipNotes.length
          ? t('ccAgent.sidebar.projectAction.keepSkippedOnRemove', { skip: skipNotes.join(skipSep) })
          : '';
        if (!candidates.length) {
          const ok = await confirmDialog({
            title,
            description: [activeTasks, skippedTasks, keepFiles].filter(Boolean).join(' '),
            confirmText,
          });
          if (ok && isDataOwnerGenerationCurrent(owner)) await removal.finish();
          return;
        }
        const choice = await removal.confirm({
          title,
          confirmText,
          description: [activeTasks, keepFiles].join(' '),
          checkboxLabel: t('ccAgent.sidebar.projectAction.archiveOnRemove', {
            count: candidates.length,
          }),
          checkedOverrides: {
            description: [
            t('ccAgent.sidebar.projectAction.removedArchived', { count: candidates.length }),
            skippedTasks,
            keepFiles,
            scheduleWarning,
          ].filter(Boolean).join(' '),
            confirmText: t('ccAgent.sidebar.projectAction.removeAndArchive'),
          },
        });
        if (!choice.ok || !isDataOwnerGenerationCurrent(owner)) return;
        if (!choice.checked) {
          await removal.finish();
          return;
        }
      } else {
        const dirtyCount = await countDirtyWorktreesForRemoval(
          deviceId ? projectEligible.filter((member) => member.hasWorktree) : candidates,
        );
        const summary = skipNotes.length
          ? t(`ccAgent.sidebar.${archiveCopy}.descriptionWithSkip`, {
              count: candidates.length,
              skip: skipNotes.join(skipSep),
            })
          : t(`ccAgent.sidebar.${archiveCopy}.description`, { count: candidates.length });
        const dirtyWarning = dirtyCount > 0
          ? t('ccAgent.sidebar.bulkSelection.confirmArchive.dirtyWorktreeWarning', { count: dirtyCount })
          : '';
        const description = [summary, dirtyWarning, scheduleWarning].filter(Boolean).join(' ');
        if (!isDataOwnerGenerationCurrent(owner)) return;
        const ok = await confirmDialog({
          title:
            scope.kind === 'project'
              ? t('ccAgent.sidebar.archiveAll.projectTitle', {
                  name: projectDisplayLabelWithMachine(scope.project),
                })
              : t('ccAgent.sidebar.archiveAll.title'),
          description,
          confirmText: t('ccAgent.sidebar.archiveAll.confirm'),
          cancelText: t('ccAgent.sidebar.archiveAll.cancel'),
        });
        if (!ok) return;
      }

      // 失败的 id 收集起来，最后统一 toast；其余继续走完，不让一条失败拖累整批。
      const failed: string[] = [];
      const succeededIds = new Set<string>();
      let newlyRunning = 0;
      let newlyAttached = 0;
      let newlyPinned = 0;
      for (const s of candidates) {
        try {
          if (!isDataOwnerGenerationCurrent(owner)) return;
          if (project) {
            const receipt = await applyProject(s.id);
            if (receipt === 'updated') succeededIds.add(s.id);
            else if (receipt === 'attached') newlyAttached++;
            else if (receipt === 'pinned') newlyPinned++;
            else if (receipt === 'running') newlyRunning++;
            else failed.push(s.id);
            continue;
          }
          const statusWriteTarget = await sessionService.resolveStatusWriteTarget(s.id);
          // Confirmation, earlier writes and target resolution can outlive preflight.
          const reason = await archiveBlockReason(s.id);
          if (reason) {
            if (reason === 'attached') newlyAttached++;
            else newlyRunning++;
            continue;
          }
          const current = await sessionService.get(s.id);
          if (
            current.status !== 'active' ||
            current.deviceLinkDeviceId ||
            !belongsToGroup(current)
          ) {
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
          // 写入后同步各状态桶，再清理该任务的运行视图；未发送草稿保留到恢复。
          patchLocal(s.id, { status: 'archived', pinnedAt: null });
          makerChatStore.purgeSession(s.id);
        } catch (err) {
          log.error('[archive all]', err);
          failed.push(s.id);
        }
      }

      if (!deviceId) await refreshSessions();

      // 当前注视中的 session 被归档了 → 走 /cc-agent 让 CCAgentIndexRedirect
      // 做 Orca-aware 的「选下一条 / 空则跳 new」决策。
      if (
        viewedSessionId &&
        succeededIds.has(viewedSessionId) &&
        (!deviceId || isSessionRemovalRouteCurrent(viewedSessionId))
      ) {
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
      // Keep the project accessible on partial failure so the remaining tasks can be retried.
      if (removal && !failed.length && isDataOwnerGenerationCurrent(owner)) await removal.finish();
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
