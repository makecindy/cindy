import { useId, useRef, useState, type ReactNode } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { ChevronDown, ChevronRight, MoreHorizontal } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import { Tip } from '@/components/ui/tooltip';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { SortableList } from '@/components/sidebar/SortableList';
import { useReducedMotion } from '@/hooks/useReducedMotion';
import { toast } from '@/lib/toast';
import type {
  ProjectWorkspace,
  ProjectWorkspaceMutation,
} from '../../../../shared/projectWorkspaceSettings';
import type { ProjectNode } from '../lib/projectGrouping';
import { groupWorkspaceProjects, mergeWorkspaceOrder } from '../lib/workspaceProjectGrouping';
import { SectionCollapse } from './SectionCollapse';

const UNGROUPED_ID = '__ungrouped__';
const PROJECT_HANDLE = '[data-project-header]';
const PROJECT_FILTER = 'button, input, textarea, select, a, [data-no-drag]';

export function ProjectWorkspaceMenu({
  projectKey,
  workspaces,
  disabled,
  onMove,
  onCreate,
}: {
  projectKey: string;
  workspaces: readonly ProjectWorkspace[];
  disabled: boolean;
  onMove: (workspaceId: string | null) => void;
  onCreate: () => void;
}) {
  const { t } = useTranslation();
  const current = workspaces.find((workspace) => workspace.projectKeys.includes(projectKey));
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger disabled={disabled}>
        {t('ccAgent.sidebar.workspaces.moveTo')}
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="max-h-80 max-w-72 overflow-y-auto">
        {workspaces.map((workspace) => (
          <DropdownMenuItem
            key={workspace.id}
            disabled={workspace.id === current?.id}
            onSelect={() => onMove(workspace.id)}
            className="max-w-72"
          >
            <span className="truncate">{workspace.name}</span>
          </DropdownMenuItem>
        ))}
        {current && (
          <DropdownMenuItem onSelect={() => onMove(null)}>
            {t('ccAgent.sidebar.workspaces.removeFromWorkspace')}
          </DropdownMenuItem>
        )}
        {workspaces.length > 0 && <DropdownMenuSeparator />}
        <DropdownMenuItem onSelect={onCreate}>
          {t('ccAgent.sidebar.workspaces.createAndMove')}
        </DropdownMenuItem>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}

export function WorkspaceNameDialog({
  workspace,
  workspaces,
  onClose,
  onSave,
}: {
  workspace?: ProjectWorkspace;
  workspaces: readonly ProjectWorkspace[];
  onClose: () => void;
  onSave: (name: string) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState(workspace?.name ?? '');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const submit = async () => {
    if (savingRef.current) return;
    const trimmed = name.trim();
    if (!trimmed || trimmed.length > 80) {
      setError(t('ccAgent.sidebar.workspaces.invalidName'));
      inputRef.current?.focus();
      return;
    }
    if (
      workspaces.some(
        (entry) => entry.id !== workspace?.id && entry.name.toLowerCase() === trimmed.toLowerCase(),
      )
    ) {
      setError(t('ccAgent.sidebar.workspaces.duplicateName'));
      inputRef.current?.focus();
      return;
    }
    savingRef.current = true;
    setSaving(true);
    setError(null);
    try {
      await onSave(trimmed);
      onClose();
    } catch {
      toast.error(t('ccAgent.sidebar.workspaces.saveError'));
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open && !savingRef.current) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="modal-scrim fixed inset-0 z-[10000]" />
        <Dialog.Content
          className="modal-panel fixed left-1/2 top-1/2 z-[10000] w-[calc(100vw-32px)] max-w-[400px] -translate-x-1/2 -translate-y-1/2 p-4"
          aria-describedby={undefined}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            inputRef.current?.focus();
            inputRef.current?.select();
          }}
          onEscapeKeyDown={(event) => {
            if (savingRef.current) event.preventDefault();
          }}
          onPointerDownOutside={(event) => event.preventDefault()}
        >
          <Dialog.Title className="mb-4 text-18 font-semibold text-[var(--confirm-title)]">
            {t(
              workspace
                ? 'ccAgent.sidebar.workspaces.renameTitle'
                : 'ccAgent.sidebar.workspaces.createTitle',
            )}
          </Dialog.Title>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <FormField
              label={t('ccAgent.sidebar.workspaces.nameLabel')}
              error={error}
              reserveFeedback
              required
            >
              {(control) => (
                <Input
                  {...control}
                  inputRef={inputRef}
                  value={name}
                  maxLength={80}
                  size="md"
                  disabled={saving}
                  placeholder={t('ccAgent.sidebar.workspaces.namePlaceholder')}
                  onChange={(value) => {
                    setName(value);
                    setError(null);
                  }}
                />
              )}
            </FormField>
            <div className="mt-4 flex justify-end gap-2">
              <Button type="submit" size="lg" loading={saving}>
                {t(
                  workspace
                    ? 'ccAgent.sidebar.workspaces.rename'
                    : 'ccAgent.sidebar.workspaces.create',
                )}
              </Button>
              <Button
                type="button"
                variant="secondary"
                size="lg"
                disabled={saving}
                onClick={onClose}
              >
                {t('commonUi.confirmDialog.cancel')}
              </Button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function WorkspaceProjectList({
  projects,
  workspaces,
  comparisonKey,
  disabled,
  renderProject,
  renderStatus,
  onMutation,
  onProjectReorder,
  onRename,
  onDelete,
}: {
  projects: readonly ProjectNode[];
  workspaces: readonly ProjectWorkspace[];
  comparisonKey: (key: string) => string;
  disabled: boolean;
  renderProject: (project: ProjectNode) => ReactNode;
  renderStatus: (projects: readonly ProjectNode[]) => ReactNode;
  onMutation: (mutation: ProjectWorkspaceMutation) => Promise<void>;
  onProjectReorder: (keys: string[]) => void | Promise<void>;
  onRename: (workspace: ProjectWorkspace) => void;
  onDelete: (workspace: ProjectWorkspace) => void;
}) {
  const { t } = useTranslation();
  const reducedMotion = useReducedMotion();
  const transferGroup = useId();
  const { groups, ungrouped } = groupWorkspaceProjects(projects, workspaces, comparisonKey);
  const mutate = (mutation: ProjectWorkspaceMutation) => {
    void onMutation(mutation).catch(() => toast.error(t('ccAgent.sidebar.workspaces.saveError')));
  };
  const reorderWorkspaces = (ids: string[]) =>
    mutate({
      type: 'reorder',
      workspaceIds: mergeWorkspaceOrder(workspaces, ids),
    });
  const shiftWorkspace = (id: string, offset: number) => {
    const ids = workspaces.map((workspace) => workspace.id);
    const index = ids.indexOf(id);
    const target = index + offset;
    if (index < 0 || target < 0 || target >= ids.length) return;
    [ids[index], ids[target]] = [ids[target]!, ids[index]!];
    reorderWorkspaces(ids);
  };
  const projectList = (items: readonly ProjectNode[], workspaceId: string) => (
    <SortableList
      items={items}
      getId={(project) => project.projectKey}
      onReorder={(keys) => {
        void Promise.resolve(onProjectReorder(keys)).catch(() =>
          toast.error(t('ccAgent.sidebar.workspaces.saveError')),
        );
      }}
      disabled={disabled}
      reducedMotion={reducedMotion}
      handle={PROJECT_HANDLE}
      filter={PROJECT_FILTER}
      crossListGroup={transferGroup}
      listId={workspaceId}
      onTransfer={({ itemId, toListId, targetOrderIds }) => {
        void onMutation({
          type: 'move-project',
          projectKey: comparisonKey(itemId),
          workspaceId: toListId === UNGROUPED_ID ? null : toListId,
        })
          .then(async () => {
            try {
              await onProjectReorder(targetOrderIds);
            } catch {
              toast.error(t('ccAgent.sidebar.workspaces.orderError'));
            }
          })
          .catch(() => toast.error(t('ccAgent.sidebar.workspaces.saveError')));
      }}
      className="flex min-h-8 flex-col gap-1"
      renderItem={renderProject}
    />
  );
  return (
    <div className="flex min-w-0 flex-col gap-2" data-project-workspaces>
      <SortableList
        items={groups}
        getId={(group) => group.workspace.id}
        disabled={disabled}
        reducedMotion={reducedMotion}
        handle="[data-workspace-drag-handle]"
        filter={PROJECT_FILTER}
        onReorder={reorderWorkspaces}
        className="flex flex-col gap-2"
        renderItem={({ workspace, projects: workspaceProjects }) => (
          <section className="min-w-0" aria-label={workspace.name}>
            <div className="group/workspace flex min-h-8 items-center gap-1 pr-2">
              <div
                role="button"
                tabIndex={disabled ? -1 : 0}
                data-workspace-drag-handle
                aria-expanded={!workspace.collapsed}
                aria-disabled={disabled}
                onClick={() => {
                  if (!disabled)
                    mutate({
                      type: 'set-collapsed',
                      id: workspace.id,
                      collapsed: !workspace.collapsed,
                    });
                }}
                onKeyDown={(event) => {
                  if ((event.key === 'Enter' || event.key === ' ') && !disabled) {
                    event.preventDefault();
                    mutate({
                      type: 'set-collapsed',
                      id: workspace.id,
                      collapsed: !workspace.collapsed,
                    });
                  }
                }}
                className="flex min-h-8 min-w-0 flex-1 cursor-pointer items-center gap-1.5 rounded-full px-3 text-sm font-medium text-[var(--sidebar-list-muted)] transition-colors hover:bg-sidebar-item-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--focus-ring)]"
              >
                {workspace.collapsed ? (
                  <ChevronRight size={12} aria-hidden />
                ) : (
                  <ChevronDown size={12} aria-hidden />
                )}
                <span className="min-w-0 flex-1 truncate" title={workspace.name}>
                  {workspace.name}
                </span>
                {workspace.collapsed && renderStatus(workspaceProjects)}
              </div>
              <DropdownMenu>
                <Tip text={t('ccAgent.sidebar.workspaces.actions')}>
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      disabled={disabled}
                      aria-label={t('ccAgent.sidebar.workspaces.actions') + ': ' + workspace.name}
                      className="flex size-7 shrink-0 items-center justify-center rounded-full text-sidebar-action-icon opacity-0 transition-opacity hover:bg-sidebar-item-hover focus-visible:opacity-100 group-hover/workspace:opacity-100 data-[state=open]:opacity-100"
                    >
                      <MoreHorizontal size={16} aria-hidden />
                    </button>
                  </DropdownMenuTrigger>
                </Tip>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onSelect={() => onRename(workspace)}>
                    {t('ccAgent.sidebar.workspaces.rename')}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    disabled={workspaces[0]?.id === workspace.id}
                    onSelect={() => shiftWorkspace(workspace.id, -1)}
                  >
                    {t('ccAgent.sidebar.workspaces.moveUp')}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    disabled={workspaces.at(-1)?.id === workspace.id}
                    onSelect={() => shiftWorkspace(workspace.id, 1)}
                  >
                    {t('ccAgent.sidebar.workspaces.moveDown')}
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onSelect={() => onDelete(workspace)}>
                    {t('ccAgent.sidebar.workspaces.delete')}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
            <SectionCollapse collapsed={workspace.collapsed}>
              <div className="relative pl-2">
                {projectList(workspaceProjects, workspace.id)}
                {workspace.projectKeys.length === 0 && (
                  <p className="pointer-events-none absolute left-2 top-2 px-3 text-xs text-[var(--sidebar-list-muted)]">
                    {t('ccAgent.sidebar.workspaces.empty')}
                  </p>
                )}
              </div>
            </SectionCollapse>
          </section>
        )}
      />
      <section aria-label={t('ccAgent.sidebar.workspaces.ungrouped')}>
        <div className="px-3 py-1 text-xs font-medium text-[var(--sidebar-list-muted)]">
          {t('ccAgent.sidebar.workspaces.ungrouped')}
        </div>
        {projectList(ungrouped, UNGROUPED_ID)}
      </section>
    </div>
  );
}
