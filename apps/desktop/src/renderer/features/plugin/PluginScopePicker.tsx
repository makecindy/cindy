import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { Check, ChevronDown, Folder, FolderOpen, Globe } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
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

export function PluginScopePicker({
  scopeDir,
  activeSessionWorkingDir,
  recentWorkdirs,
  onPick,
}: {
  scopeDir: string | null;
  activeSessionWorkingDir: string | undefined;
  recentWorkdirs: RecentWorkdirEntry[];
  onPick: (dir: string | null) => void;
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
  const triggerLabel = scopeDir ? basename(scopeDir) : t('settings.ghosts.scopePicker.global');

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={t('settings.ghosts.scopePicker.ariaLabel')}
          title={scopeDir ?? undefined}
          className={cn(
            'flex h-9 max-w-[220px] shrink-0 items-center gap-1.5 rounded-full px-4',
            'bg-[var(--surface-elevated-soft)] text-13 font-medium text-[var(--text-primary)]',
            'hover:bg-[var(--surface-chip)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]',
            'transition-colors',
          )}
        >
          {scopeDir ? (
            <Folder size={14} className="shrink-0" />
          ) : (
            <Globe size={14} className="shrink-0" />
          )}
          <span className="truncate">{triggerLabel}</span>
          <ChevronDown size={13} className="shrink-0 opacity-60" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-max min-w-0 max-w-[calc(100vw-32px)]">
        <DropdownMenuItem
          onClick={() => onPick(null)}
          className="grid w-full cursor-pointer grid-cols-[14px_max-content] items-center gap-x-2.5 pr-4"
        >
          <Check
            size={14}
            className={cn('shrink-0', scopeDir === null ? 'opacity-100' : 'opacity-0')}
          />
          <div className="flex items-center gap-1.5">
            <Globe size={13} className="shrink-0 text-[var(--text-secondary)]" />
            <span className="whitespace-nowrap text-13 font-medium">
              {t('settings.ghosts.scopePicker.global')}
            </span>
          </div>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <div className="max-h-[min(320px,45vh)] overflow-y-auto">
          {candidates.map((dir) => {
            const isCurrent = dir === scopeDir;
            return (
              <DropdownMenuItem
                key={dir}
                onClick={() => onPick(dir)}
                // minmax(0,max-content):菜单仍按内容自适应宽,但路径超过菜单
                // max-w 上限时列可收缩、由 truncate 出省略号,不再水平溢出。
                className="grid w-full cursor-pointer grid-cols-[14px_minmax(0,max-content)] items-center gap-x-2.5 pr-4"
              >
                <Check
                  size={14}
                  className={cn('shrink-0', isCurrent ? 'opacity-100' : 'opacity-0')}
                />
                <div className="flex min-w-0 flex-col gap-0.5">
                  <span className="truncate text-13 font-medium">{basename(dir)}</span>
                  <span title={dir} className="truncate text-11 text-[var(--text-secondary)]">
                    {dir}
                  </span>
                </div>
              </DropdownMenuItem>
            );
          })}
        </div>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onClick={() => {
            void window.electronAPI.showOpenDirectoryDialog().then((result) => {
              if (!result.canceled && result.path) onPick(result.path);
            });
          }}
          className="grid w-full cursor-pointer grid-cols-[14px_max-content] items-center gap-x-2.5 pr-4"
        >
          <span aria-hidden className="w-[14px]" />
          <div className="flex items-center gap-1.5">
            <FolderOpen size={13} className="shrink-0 text-[var(--text-secondary)]" />
            <span className="whitespace-nowrap text-13 font-medium">
              {t('settings.ghosts.scopePicker.browse')}
            </span>
          </div>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
