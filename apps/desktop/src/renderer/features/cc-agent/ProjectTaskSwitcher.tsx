import { Fragment, useMemo, useSyncExternalStore } from 'react';
import { ChevronsUpDown } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';

import { WINDOW_NO_DRAG_STYLE } from '@/components/layout/windowDrag';
import { ChromeIconButton } from '@/components/title-bar/ChromeIconButton';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { getDataOwnerGeneration, isDataOwnerGenerationCurrent } from '@/contexts/dataOwnerGeneration';
import { useObservedWorktreeForSession, useWorktrees } from '@/contexts/WorktreeContext';
import { useBotProfiles } from '@/features/bots/botStore';
import { getStickySessionDeviceId } from '@/features/device-link/stickySessionOrigin';
import { useCCSessions } from '@/hooks/useCCSessions';
import type { Session } from '@/lib/ccAgent.types';
import { isOrcaWorkerSession, resolveSessionRoute } from '@/lib/orcaSessionIdentity';
import type { WorktreeMeta } from '@/lib/worktree.types';
import { DESKTOP_TASK_LIST_SESSION_SOURCES, isOrdinaryTaskListSession } from '../../../shared/sessionSource';
import {
  compareSessionsByStatusThenSortTimeDesc,
  projectIdentityKeyForSession,
} from './lib/projectGrouping';
import { getProvisionalDraftTaskId, subscribeProvisionalDraftTaskId } from './lib/provisionalDraftTaskId';
import { getSessionDisplayTitle, isEmptyDraftSession } from './lib/sessionDisplayTitle';
import { isSessionInProject } from './lib/sidebarProjectVisibility';
import { observedWorktreeFromTelemetry, resolveManagedWorktree } from './sidebar/sessionWorktreeInfo';

interface ProjectTaskSwitcherProps {
  session: Session;
  runningSessionIds: ReadonlySet<string>;
}

function isEligibleTask(task: Session, provisionalId: string | null, privateTaskIds: ReadonlySet<string>) {
  return task.workspaceKind === 'project'
    && (task.status === 'active' || task.status === 'archived')
    && !task.remoteHostId && !task.deviceLinkDeviceId && !task.hiddenAt
    && task.id !== provisionalId && !privateTaskIds.has(task.id)
    && (task.source === 'bot'
      ? isOrdinaryTaskListSession(task)
      : DESKTOP_TASK_LIST_SESSION_SOURCES.includes(task.source ?? 'desktop'))
    && !isOrcaWorkerSession(task) && !isEmptyDraftSession(task);
}

function ProjectTaskRow({ task, worktree, running }: {
  task: Session;
  worktree: WorktreeMeta | undefined;
  running: boolean;
}) {
  const { t } = useTranslation();
  const observed = useObservedWorktreeForSession(task.id);
  const worktreeInfo = resolveManagedWorktree(worktree ?? null) ?? observedWorktreeFromTelemetry({
    source: 'telemetry', workdir: observed?.workdir ?? null,
    branch: observed?.branch ?? null, isInsideWorktree: observed !== null,
  });
  const title = getSessionDisplayTitle(task, t('ccAgent.common.unnamedSession'), t).trim()
    || t('ccAgent.sessionHeader.untitled');
  const status = task.status === 'archived' ? t('ccAgent.sidebar.taskStatus.archived')
    : running ? t('ccAgent.sidebar.status.running') : null;
  const worktreeMetadata = [...new Set([worktreeInfo?.name, worktreeInfo?.branch].filter(Boolean))];

  return (
    <DropdownMenuRadioItem value={task.id} textValue={title}>
      <span className="min-w-0 flex-1">
        <span className="block truncate" title={title}>{title}</span>
        {(status || worktreeMetadata.length > 0) && (
          <span className="flex min-w-0 items-baseline gap-1 text-[var(--cmd-palette-item-meta)]">
            {status && <span className="shrink-0">{status}</span>}
            {worktreeMetadata.length > 0 && (
              <span className="min-w-0 truncate" title={worktreeMetadata.join(' · ')}>
                {status && '· '}
                {worktreeMetadata.map((value, index) => (
                  <Fragment key={value}>{index > 0 && ' · '}<span>{value}</span></Fragment>
                ))}
              </span>
            )}
          </span>
        )}
      </span>
    </DropdownMenuRadioItem>
  );
}

// Radix mounts this subtree only while the menu is present. The all-status bucket
// and Worktree metadata are shared snapshots, so the header adds no reads per row.
function ProjectTaskItems({ session, runningSessionIds, projectKey, provisionalId, privateTaskIds }: ProjectTaskSwitcherProps & {
  projectKey: string;
  provisionalId: string | null;
  privateTaskIds: ReadonlySet<string>;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { sessions, isLoading, error } = useCCSessions({ includeArchived: 'all' });
  const worktrees = useWorktrees();
  const localPlatform = window.electronAPI.platform;
  const tasks = useMemo(() => {
    const projectTasks = sessions.filter((task) =>
      isEligibleTask(task, provisionalId, privateTaskIds) && isSessionInProject(task, projectKey, localPlatform));
    const current = projectTasks.find((task) => task.id === session.id) ?? session;
    const alternatives = projectTasks.filter((task) =>
      task.id !== session.id && getStickySessionDeviceId(task.id) === undefined);
    return [current, ...alternatives.sort(compareSessionsByStatusThenSortTimeDesc)];
  }, [localPlatform, privateTaskIds, projectKey, provisionalId, session, sessions]);

  const selectTask = async (id: string) => {
    if (id === session.id) return;
    const task = tasks.find((item) => item.id === id);
    // A bare task route follows the sticky device origin, which can change while open.
    if (!task || getStickySessionDeviceId(id) !== undefined) return;
    const owner = getDataOwnerGeneration();
    const route = await resolveSessionRoute(task.id, task);
    if (isDataOwnerGenerationCurrent(owner) && getStickySessionDeviceId(id) === undefined) navigate(route);
  };

  return (
    <div className="max-h-[min(24rem,calc(var(--radix-dropdown-menu-content-available-height)-0.75rem))] overflow-x-hidden overflow-y-auto">
      {isLoading && <DropdownMenuLabel role="status">{t('ccAgent.common.loading')}</DropdownMenuLabel>}
      {error && <DropdownMenuLabel role="status">{t('ccAgent.common.unknownError')}</DropdownMenuLabel>}
      <DropdownMenuRadioGroup value={session.id} onValueChange={(id) => void selectTask(id)}>
        {tasks.map((task) => (
          <ProjectTaskRow key={task.id} task={task} worktree={worktrees[task.id]} running={runningSessionIds.has(task.id)} />
        ))}
      </DropdownMenuRadioGroup>
    </div>
  );
}

export function ProjectTaskSwitcher({ session, runningSessionIds }: ProjectTaskSwitcherProps) {
  const { t } = useTranslation();
  const provisionalId = useSyncExternalStore(subscribeProvisionalDraftTaskId, getProvisionalDraftTaskId);
  const profiles = useBotProfiles();
  const privateTaskIds = useMemo(() => new Set(profiles.flatMap((profile) => profile.sessions
    .filter(({ role }) => role !== 'channel' && role !== 'routine' && role !== 'delegation')
    .map((task) => task.id))), [profiles]);
  const projectKey = projectIdentityKeyForSession(session);
  if (projectKey === null || !isEligibleTask(session, provisionalId, privateTaskIds)) return null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <ChromeIconButton
          aria-label={t('ccAgent.sessionHeader.switchProjectTask')}
          data-testid="project-task-switcher-trigger"
          className="shrink-0 enabled:hover:[--button-face-bg:hsl(var(--titlebar-button-hover))] enabled:active:[--button-face-bg:hsl(var(--titlebar-button-hover))]"
          style={WINDOW_NO_DRAG_STYLE}
          tooltipSide="bottom"
        >
          <ChevronsUpDown size={14} aria-hidden />
        </ChromeIconButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        collisionPadding={12}
        data-testid="project-task-switcher-menu"
        className="w-80 min-w-0 max-w-[var(--radix-dropdown-menu-content-available-width)]"
      >
        <ProjectTaskItems {...{ session, runningSessionIds, projectKey, provisionalId, privateTaskIds }} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
