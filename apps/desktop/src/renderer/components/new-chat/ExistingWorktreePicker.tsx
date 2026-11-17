import { useEffect, useRef, useState } from 'react';
import { ChevronDown, Check } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { workingDirEquals } from '../../../shared/workingDir';
import type { WorktreeMeta } from '@/lib/worktree.types';

/** The selected name stays inside the menu, preserving the composer's compact width. */
export function ExistingWorktreePicker({
  baseRepo,
  selected,
  disabled,
  onSelect,
}: {
  baseRepo: string;
  selected: WorktreeMeta | null;
  disabled?: boolean;
  onSelect: (value: WorktreeMeta | null) => void;
}) {
  const { t } = useTranslation();
  const [items, setItems] = useState<WorktreeMeta[]>([]);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const request = useRef(0);
  useEffect(
    () => () => {
      request.current += 1;
    },
    [],
  );
  const load = async () => {
    const current = ++request.current;
    setLoading(true);
    setFailed(false);
    try {
      const all = await window.electronAPI.worktreeListAll();
      if (current !== request.current) return;
      setItems(
        all
          .filter(
            (meta) =>
              workingDirEquals(meta.baseRepo, baseRepo) &&
              !meta.ephemeral &&
              !meta.quarantinePath &&
              !meta.pendingSessionTransfer,
          )
          .sort((a, b) => a.name.localeCompare(b.name)),
      );
    } catch {
      if (current === request.current) {
        setItems([]);
        setFailed(true);
      }
    } finally {
      if (current === request.current) setLoading(false);
    }
  };
  return (
    <DropdownMenu
      onOpenChange={(open) => {
        if (open) {
          setItems([]);
          void load();
        } else request.current += 1;
      }}
    >
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          aria-label={t('newChat.worktree.choose')}
          className="inline-flex h-full w-7 shrink-0 items-center justify-center text-muted-foreground transition-colors hover:bg-sidebar-item-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] disabled:opacity-50"
        >
          <ChevronDown size={12} aria-hidden />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64 max-w-[calc(100vw-32px)]">
        <DropdownMenuItem
          role="menuitemradio"
          aria-checked={!selected}
          onSelect={() => onSelect(null)}
        >
          <Check size={14} aria-hidden className={selected ? 'invisible' : ''} />
          {t('newChat.worktree.createNew')}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuLabel>{t('newChat.worktree.existing')}</DropdownMenuLabel>
        {loading && <DropdownMenuItem disabled>{t('newChat.worktree.detecting')}</DropdownMenuItem>}
        {failed && (
          <DropdownMenuItem
            onSelect={(event) => {
              event.preventDefault();
              void load();
            }}
          >
            {t('newChat.worktree.loadExistingFailed')}
          </DropdownMenuItem>
        )}
        {!loading && !failed && items.length === 0 && (
          <DropdownMenuItem disabled>{t('newChat.worktree.noExisting')}</DropdownMenuItem>
        )}
        {items.map((meta) => (
          <DropdownMenuItem
            key={meta.sessionId}
            role="menuitemradio"
            aria-checked={selected?.sessionId === meta.sessionId}
            onSelect={() => onSelect(meta)}
          >
            <Check
              size={14}
              aria-hidden
              className={selected?.path === meta.path ? '' : 'invisible'}
            />
            <span className="min-w-0">
              <span className="block truncate">{meta.name}</span>
              <span className="block truncate text-12 text-muted-foreground">{meta.branch}</span>
            </span>
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <p className="px-2 py-1.5 text-12 text-muted-foreground">
          {t('newChat.worktree.sharedHint')}
        </p>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
