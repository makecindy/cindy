import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { Check, ChevronRight, FolderOpen, Globe } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import {
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from '@/components/ui/dropdown-menu';
import { cn, basename } from '@/lib/utils';
import { recentWorkdirsStore, type RecentWorkdirEntry } from '@/lib/recentWorkdirsStore';

export function usePluginRecentWorkdirs(): RecentWorkdirEntry[] {
  const snapshot = useSyncExternalStore(recentWorkdirsStore.subscribe, recentWorkdirsStore.get);
  useEffect(() => {
    void recentWorkdirsStore.ensure().catch(() => {});
  }, []);
  return snapshot ?? [];
}

export function PluginProjectMenu({
  scopeDir,
  activeSessionWorkingDir,
  recentWorkdirs,
  onPick,
  projectOptions,
  computerName,
  disabled = false,
  unavailable = false,
  onBrowse,
}: {
  scopeDir: string | null;
  activeSessionWorkingDir: string | undefined;
  recentWorkdirs: RecentWorkdirEntry[];
  onPick: (dir: string | null) => void;
  /** When supplied, identities and display paths belong to the selected Host. */
  projectOptions?: Array<{ id: string; name: string; path?: string }>;
  onBrowse?: () => void;
  computerName?: string;
  disabled?: boolean;
  unavailable?: boolean;
}) {
  const { t } = useTranslation();
  const candidates = useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    const push = (path: string | undefined | null) => {
      if (!path || seen.has(path)) return;
      seen.add(path);
      out.push(path);
    };
    push(scopeDir);
    push(activeSessionWorkingDir);
    for (const entry of recentWorkdirs) push(entry.path);
    return out;
  }, [activeSessionWorkingDir, recentWorkdirs, scopeDir]);
  const triggerLabel = scopeDir
    ? (projectOptions?.find((project) => project.id === scopeDir)?.name ?? basename(scopeDir))
    : t('settings.ghosts.scopePicker.globalScope');
  const projectsLabel = t('settings.ghosts.scopePicker.projectsForComputer', {
    device: computerName ?? t('settings.ghosts.remote.thisComputer'),
  });
  const projects = projectOptions
    ? [...projectOptions.filter((project) => project.id === scopeDir),
      ...projectOptions.filter((project) => project.id !== scopeDir)]
    : candidates.map((dir) => ({ id: dir, name: basename(dir), path: dir }));

  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger
        aria-label={t('settings.ghosts.scopePicker.ariaLabel')}
        title={
          unavailable
            ? t('settings.ghosts.remote.projectsUnsupported')
            : projectOptions
              ? (projects.find((project) => project.id === scopeDir)?.path ?? triggerLabel)
              : (scopeDir ?? undefined)
        }
        disabled={disabled}
        className="gap-2"
      >
        <span className="shrink-0">{t('settings.ghosts.scopePicker.projectScope')}</span>
        <span className="min-w-0 flex-1 truncate text-12 font-normal text-[var(--cmd-palette-item-meta)]">
          {triggerLabel}
        </span>
        <ChevronRight size={14} className="shrink-0" aria-hidden="true" />
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="w-80 min-w-0 max-w-[calc(100vw-32px)]">
        <DropdownMenuLabel className="truncate" title={projectsLabel}>
          {projectsLabel}
        </DropdownMenuLabel>
        <DropdownMenuItem
          onSelect={() => onPick(null)}
          className="grid w-full cursor-pointer grid-cols-[14px_minmax(0,1fr)] items-center gap-x-2.5"
        >
          <Check
            size={14}
            className={cn('shrink-0', scopeDir === null ? 'opacity-100' : 'opacity-0')}
          />
          <div className="flex min-w-0 items-center gap-1.5">
            <Globe size={13} className="shrink-0 text-[var(--text-secondary)]" />
            <span className="truncate">{t('settings.ghosts.scopePicker.global')}</span>
          </div>
        </DropdownMenuItem>
        {projects.length > 0 || projectOptions !== undefined ? <DropdownMenuSeparator /> : null}
        {projects.length > 0 ? (
          <div className="max-h-[min(320px,45vh)] overflow-y-auto">
            {projects.map(({ id: dir, name, path }) => {
              const isCurrent = dir === scopeDir;
              return (
                <DropdownMenuItem
                  key={dir}
                  onSelect={() => onPick(dir)}
                  title={path ?? name}
                  className="grid w-full cursor-pointer grid-cols-[14px_minmax(0,1fr)] items-center gap-x-2.5 pr-4"
                >
                  <Check
                    size={14}
                    className={cn('shrink-0', isCurrent ? 'opacity-100' : 'opacity-0')}
                  />
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <span className="truncate">{name}</span>
                    {path ? (
                      <span
                        title={path}
                        className="truncate text-12 leading-[1.33] text-[var(--cmd-palette-item-meta)]"
                      >
                        {path}
                      </span>
                    ) : null}
                  </div>
                </DropdownMenuItem>
              );
            })}
          </div>
        ) : null}
        {projectOptions?.length === 0 ? (
          <p className="px-3 py-2 text-12 leading-4 text-[var(--text-secondary)]">
            {t('settings.ghosts.remote.noProjects')}
          </p>
        ) : null}
        {!projectOptions || onBrowse ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={() => {
                if (onBrowse) { onBrowse(); return; }
                void window.electronAPI.showOpenDirectoryDialog().then((result) => {
                  if (!result.canceled && result.path) onPick(result.path);
                });
              }}
              className="grid w-full cursor-pointer grid-cols-[14px_minmax(0,1fr)] items-center gap-x-2.5"
            >
              <span aria-hidden className="w-[14px]" />
              <div className="flex min-w-0 items-center gap-1.5">
                <FolderOpen size={13} className="shrink-0 text-[var(--text-secondary)]" />
                <span className="truncate">{t('settings.ghosts.scopePicker.browse')}</span>
              </div>
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}
