import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Plus } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Tip } from '@/components/ui/tooltip';
import { toast } from '@/lib/toast';
import type { ProjectWorkspace } from '../../../../shared/projectWorkspaceSettings';
import { useProjectWorkspaces } from '../hooks/useProjectWorkspaces';
import { projectKeyComparisonKey } from '../lib/projectGrouping';
import { ProjectWorkspaceMenu, WorkspaceNameDialog } from './WorkspaceProjectList';

type WorkspaceActions = ReturnType<typeof useProjectWorkspaces> & {
  create: (projectKey?: string) => void;
  rename: (workspace: ProjectWorkspace) => void;
  remove: (workspace: ProjectWorkspace) => void;
};

const WorkspaceContext = createContext<WorkspaceActions | null>(null);

export function useWorkspaceSidebar() {
  return useContext(WorkspaceContext);
}

export function WorkspaceSidebarProvider({
  children,
  onCreated,
}: {
  children: ReactNode;
  onCreated: () => void;
}) {
  const { t } = useTranslation();
  const { workspaces, loading, error, pending, ready, mutate, reload } = useProjectWorkspaces();
  const [dialog, setDialog] = useState<{
    workspace?: ProjectWorkspace;
    projectKey?: string;
  } | null>(null);
  const [deleting, setDeleting] = useState<ProjectWorkspace | null>(null);
  const [savingDelete, setSavingDelete] = useState(false);
  const deleteRequestRef = useRef<symbol | null>(null);
  const onCreatedRef = useRef(onCreated);
  onCreatedRef.current = onCreated;
  useEffect(() => {
    if (!ready) {
      setDialog(null);
      setDeleting(null);
      deleteRequestRef.current = null;
      setSavingDelete(false);
    }
  }, [ready]);
  const create = useCallback((projectKey?: string) => setDialog({ projectKey }), []);
  const rename = useCallback((workspace: ProjectWorkspace) => setDialog({ workspace }), []);
  const remove = useCallback((workspace: ProjectWorkspace) => setDeleting(workspace), []);
  const value = useMemo(
    () => ({
      workspaces,
      loading,
      error,
      pending,
      ready,
      mutate,
      reload,
      create,
      rename,
      remove,
    }),
    [workspaces, loading, error, pending, ready, mutate, reload, create, rename, remove],
  );
  return (
    <WorkspaceContext.Provider value={value}>
      {children}
      {dialog && ready && (
        <WorkspaceNameDialog
          workspace={dialog.workspace}
          workspaces={workspaces}
          onClose={() => setDialog(null)}
          onSave={async (name) => {
            await mutate(
              dialog.workspace
                ? { type: 'rename', id: dialog.workspace.id, name }
                : { type: 'create', id: crypto.randomUUID(), name, projectKey: dialog.projectKey },
            );
            if (!dialog.workspace) onCreatedRef.current();
          }}
        />
      )}
      <ConfirmDialog
        presentation="standard"
        open={deleting !== null && ready}
        onOpenChange={(open) => {
          if (!open && !pending && deleteRequestRef.current === null) setDeleting(null);
        }}
        title={t('ccAgent.sidebar.workspaces.deleteTitle')}
        description={t('ccAgent.sidebar.workspaces.deleteDescription', {
          name: deleting?.name ?? '',
        })}
        confirmText={t('ccAgent.sidebar.workspaces.delete')}
        loading={pending || savingDelete}
        onConfirm={() => {
          if (!deleting || pending || deleteRequestRef.current !== null) return;
          const request = Symbol();
          deleteRequestRef.current = request;
          setSavingDelete(true);
          void mutate({ type: 'delete', id: deleting.id })
            .then(() => {
              if (deleteRequestRef.current === request) setDeleting(null);
            })
            .catch(() => {
              if (deleteRequestRef.current === request)
                toast.error(t('ccAgent.sidebar.workspaces.saveError'));
            })
            .finally(() => {
              if (deleteRequestRef.current === request) {
                deleteRequestRef.current = null;
                setSavingDelete(false);
              }
            });
        }}
      />
    </WorkspaceContext.Provider>
  );
}

export function WorkspaceCreateButton() {
  const { t } = useTranslation();
  const actions = useWorkspaceSidebar();
  if (!actions) return null;
  const label = t(
    actions.error ? 'ccAgent.sidebar.workspaces.loadError' : 'ccAgent.sidebar.workspaces.create',
  );
  return (
    <Tip text={label} side="bottom">
      <button
        type="button"
        aria-label={t('ccAgent.sidebar.workspaces.create')}
        disabled={!actions.ready || actions.pending}
        onClick={() => actions.create()}
        className="flex size-7 items-center justify-center rounded-full text-sidebar-action-icon transition-colors hover:bg-sidebar-item-hover disabled:opacity-40"
      >
        <Plus size={14} aria-hidden />
      </button>
    </Tip>
  );
}

export function ProjectWorkspaceActions({ projectKey }: { projectKey: string }) {
  const { t } = useTranslation();
  const actions = useWorkspaceSidebar();
  if (!actions) return null;
  const key = projectKeyComparisonKey(projectKey, window.electronAPI.platform) ?? projectKey;
  return (
    <ProjectWorkspaceMenu
      projectKey={key}
      workspaces={actions.workspaces}
      disabled={!actions.ready || actions.pending}
      onCreate={() => actions.create(key)}
      onMove={(workspaceId) => {
        void actions
          .mutate({ type: 'move-project', projectKey: key, workspaceId })
          .catch(() => toast.error(t('ccAgent.sidebar.workspaces.saveError')));
      }}
    />
  );
}
