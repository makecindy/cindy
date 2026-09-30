import { Folder, FolderPlus, MessageCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { FolderPickerOption } from '@/components/new-chat/FolderPickerPopover';
import { DropdownMenuItem, DropdownMenuSeparator } from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';

export interface SessionProjectMoveSubmenuProps {
  heading?: string;
  projectOptions: readonly FolderPickerOption[];
  currentWorkingDir?: string | null;
  isDialogue: boolean;
  onSelectProject: (workingDir: string) => void;
  onBrowseProject?: () => void;
  onMoveToDialogue?: () => void;
}

function normalizePath(value: string | null | undefined): string | null {
  if (!value) return null;
  return value.replace(/\\/g, '/').replace(/\/+$/, '') || value;
}

export function SessionProjectMoveSubmenu({
  heading,
  projectOptions,
  currentWorkingDir,
  isDialogue,
  onSelectProject,
  onBrowseProject,
  onMoveToDialogue,
}: SessionProjectMoveSubmenuProps) {
  const { t } = useTranslation();
  const normalizedCurrent = normalizePath(currentWorkingDir);

  return (
    <>
      <div className="px-3 py-1.5 text-xs font-medium text-[var(--cmd-palette-item-meta)]">
        {heading ?? t('ccAgent.sidebar.sessionMenu.moveToProjectHeading')}
      </div>
      <div className="pending-queue-scroll -mr-1 max-h-[224px] overflow-x-hidden overflow-y-auto pr-1">
        {projectOptions.length > 0 ? (
          projectOptions.map((project) => {
            const isCurrent = normalizePath(project.path) === normalizedCurrent;
            return (
              <DropdownMenuItem
                key={project.path}
                disabled={isCurrent}
                onSelect={() => onSelectProject(project.path)}
                className={cn(
                  'h-auto min-h-9 px-3 py-2 rounded-md text-sm text-[var(--msg-assistant-text)]',
                  'focus:bg-[var(--cmd-palette-item-hover)]',
                  'data-[disabled]:opacity-50 data-[disabled]:pointer-events-none',
                )}
              >
                <Folder size={16} className="mr-2 shrink-0 text-[var(--folder-item-icon)]" />
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate">{project.name}</span>
                  {project.description && (
                    <span className="truncate text-xs text-[var(--cmd-palette-item-meta)]">
                      {project.description}
                    </span>
                  )}
                </div>
              </DropdownMenuItem>
            );
          })
        ) : (
          <div className="px-3 py-2 text-sm text-[var(--cmd-palette-item-meta)]">
            {t('ccAgent.sidebar.sessionMenu.noProjects')}
          </div>
        )}
      </div>
      {(onBrowseProject || onMoveToDialogue) && (
        <DropdownMenuSeparator className="my-1 h-px bg-[var(--cmd-palette-border)]" />
      )}
      {onBrowseProject && (
        <DropdownMenuItem
          onSelect={onBrowseProject}
          className="h-8 px-3 rounded-md text-sm text-[var(--msg-assistant-text)] focus:bg-[var(--cmd-palette-item-hover)]"
        >
          <FolderPlus size={16} className="mr-2 shrink-0 text-[var(--folder-item-icon)]" />
          {t('ccAgent.sidebar.sessionMenu.browseProjectFolder')}
        </DropdownMenuItem>
      )}
      {onMoveToDialogue && (
        <DropdownMenuSeparator className="my-1 h-px bg-[var(--cmd-palette-border)]" />
      )}
      {onMoveToDialogue && (
        <DropdownMenuItem
          disabled={isDialogue}
          onSelect={onMoveToDialogue}
          className="h-8 px-3 rounded-md text-sm text-[var(--msg-assistant-text)] focus:bg-[var(--cmd-palette-item-hover)] data-[disabled]:opacity-50 data-[disabled]:pointer-events-none"
        >
          <MessageCircle size={16} className="mr-2 shrink-0 text-[var(--folder-item-icon)]" />
          {t('ccAgent.sidebar.sessionMenu.moveToDialogue')}
        </DropdownMenuItem>
      )}
    </>
  );
}
