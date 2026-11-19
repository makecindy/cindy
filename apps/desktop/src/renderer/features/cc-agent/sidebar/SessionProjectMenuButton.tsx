import { Tip } from '@/components/ui/tooltip';
import { setHeaderProjectMenu, useHeaderProjectMenu } from '@/state/headerProjectMenu';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import {
  projectAliasComparisonKey,
  projectDirectoryName,
} from '@cindy/maker-shared/project-alias-sync';
import type { Session } from '@/lib/ccAgent.types';
import { WINDOW_NO_DRAG_STYLE } from '@/components/layout/windowDrag';
import { useProjectInfo } from '../hooks/useProjectInfo';
import {
  getProjectIdentity,
  projectIdentityKeyForSession,
  type ProjectNode,
} from '../lib/projectGrouping';
import { ProjectSettingsDialog, projectHostKey } from './ProjectSettingsDialog';
import { ResolvedProjectIcon } from './ResolvedProjectIcon';

/** Keep the task's owning project identity, including worktree and remote sessions. */
export function SessionProjectMenuButton({
  session,
  disabled,
}: {
  session: Session;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const menu = useHeaderProjectMenu();
  useEffect(() => () => setHeaderProjectMenu(null), [session.id]);
  const project = useSessionProjectNode(session);
  if (!project) return null;
  return (
    <Tip text={t('ccAgent.sidebar.projectAction.menu', { name: project.displayName })}>
      <button
        type="button"
        aria-label={t('ccAgent.sidebar.projectAction.menu', { name: project.displayName })}
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={menu?.project.projectKey === project.projectKey}
        onClick={(event) =>
          setHeaderProjectMenu({
            anchor: event.currentTarget,
            project,
          })
        }
        style={WINDOW_NO_DRAG_STYLE}
        className="mr-1 inline-flex size-5 shrink-0 items-center justify-center rounded-full hover:bg-[var(--surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] disabled:opacity-50"
      >
        <ResolvedProjectIcon
          directory={project.workingDir}
          remoteHostId={session.remoteHostId}
          deviceId={session.deviceLinkDeviceId}
          size={20}
        />
      </button>
    </Tip>
  );
}

function useSessionProjectNode(session: Session): ProjectNode | null {
  const info = useProjectInfo(session.deviceLinkDeviceId ?? null);
  const identity = getProjectIdentity(session);
  const projectKey = projectIdentityKeyForSession(session);
  if (!identity || !projectKey) return null;
  const project: ProjectNode = {
    ...identity,
    projectKey,
    displayName: projectDirectoryName(identity.workingDir),
    segments: 1,
    sessions: [session],
    latestActivityAt: session.updatedAt,
  };
  const hostKey = projectHostKey(project);
  const comparison = info && projectAliasComparisonKey(hostKey, info.platform);
  project.displayName =
    info?.aliases.find(
      (row) => projectAliasComparisonKey(row.projectKey, info.platform) === comparison,
    )?.alias || project.displayName;
  return project;
}

export function SessionProjectSettingsDialog({
  session,
  onClose,
}: {
  session: Session;
  onClose(): void;
}) {
  const project = useSessionProjectNode(session);
  return project ? <ProjectSettingsDialog project={project} onClose={onClose} /> : null;
}
