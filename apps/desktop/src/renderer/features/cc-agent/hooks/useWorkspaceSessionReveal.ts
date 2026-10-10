import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from '@/lib/toast';
import type {
  ProjectWorkspace,
  ProjectWorkspaceMutation,
} from '../../../../shared/projectWorkspaceSettings';

interface WorkspaceSessionRevealOptions {
  sessionId: string | undefined;
  ready: boolean;
  enabled: boolean;
  projects: readonly { projectKey: string; sessions: readonly { id: string }[] }[];
  workspaces: readonly ProjectWorkspace[];
  collapsedProjects: ReadonlySet<string>;
  comparisonKey: (key: string) => string;
  onToggleProject: (key: string) => void;
  mutateWorkspace: (mutation: ProjectWorkspaceMutation) => Promise<void>;
}

export function useWorkspaceSessionReveal({
  sessionId,
  ready,
  enabled,
  projects,
  workspaces,
  collapsedProjects,
  comparisonKey,
  onToggleProject,
  mutateWorkspace,
}: WorkspaceSessionRevealOptions): void {
  const { t } = useTranslation();
  const revealedSession = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!ready || !sessionId) {
      revealedSession.current = undefined;
      return;
    }
    if (!enabled || revealedSession.current === sessionId) return;
    const project = projects.find((entry) =>
      entry.sessions.some((session) => session.id === sessionId),
    );
    if (!project) return;
    const projectKey = comparisonKey(project.projectKey);
    const workspace = workspaces.find((entry) => entry.projectKeys.includes(projectKey));
    revealedSession.current = sessionId;
    if (collapsedProjects.has(project.projectKey)) onToggleProject(project.projectKey);
    if (workspace?.collapsed) {
      void mutateWorkspace({ type: 'set-collapsed', id: workspace.id, collapsed: false }).catch(
        () => toast.error(t('ccAgent.sidebar.workspaces.saveError')),
      );
    }
  }, [
    sessionId,
    ready,
    enabled,
    projects,
    workspaces,
    collapsedProjects,
    comparisonKey,
    onToggleProject,
    mutateWorkspace,
    t,
  ]);
}
