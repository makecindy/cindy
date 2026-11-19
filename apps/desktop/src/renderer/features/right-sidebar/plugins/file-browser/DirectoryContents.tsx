import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Folder, LayoutGrid, List } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { toast } from '@/lib/toast';
import { FileFilterInput } from '@/features/cc-agent/workdir-browse/FileFilterInput';
import { Tip } from '@/components/ui/tooltip';
import { Button } from '@/components/ui/button';
import { pickFileIcon } from '@/components/ui/file-type-icon';
import type { DirEntry } from '@/features/cc-agent/workdir-browse/hooks/useFileTree';
import { basename, formatBytes, toOsAbsolutePath } from '@/features/cc-agent/workdir-browse/lib/fileMeta';

function EntryIcon({ entry, localPath }: { entry: DirEntry; localPath?: string }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    setSrc(null);
    if (!localPath) return;
    let current = true;
    // Let fast scrolling settle before asking the OS to generate a thumbnail.
    const timer = window.setTimeout(() => {
      void window.electronAPI
        .getFileThumbnail({ path: localPath, size: 128 })
        .then((result) => {
          if (current) setSrc(result?.dataUrl ?? null);
        })
        .catch(() => {});
    }, 120);
    return () => {
      current = false;
      window.clearTimeout(timer);
    };
  }, [localPath, entry.size, entry.mtimeMs]);
  const Icon = entry.type === 'directory' ? Folder : pickFileIcon(entry.name);
  return src ? (
    <img src={src} alt="" className="h-full max-w-full object-contain" />
  ) : (
    <Icon aria-hidden size={localPath ? 28 : 18} />
  );
}

export function DirectoryContents({
  directory,
  entries,
  loading,
  localWorkdir,
  previousEntry,
  grid,
  setGrid,
  filter,
  setFilter,
  onOpen,
}: {
  directory: string;
  entries?: readonly DirEntry[];
  loading: boolean;
  localWorkdir?: string;
  previousEntry: string | null;
  grid: boolean;
  setGrid: (value: boolean) => void;
  filter: string;
  setFilter: (value: string) => void;
  onOpen: (entry: DirEntry) => void;
}) {
  const { t } = useTranslation();
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const resize = () => setWidth(el.clientWidth);
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const ordered = useMemo(
    () =>
      [...(entries ?? [])].sort(
        (a, b) =>
          Number(b.type === 'directory') - Number(a.type === 'directory') ||
          b.mtimeMs - a.mtimeMs ||
          a.name.localeCompare(b.name),
      ),
    [entries],
  );
  const sorted = useMemo(() => {
    const query = filter.trim().toLocaleLowerCase();
    return query
      ? ordered.filter((entry) => entry.name.toLocaleLowerCase().includes(query))
      : ordered;
  }, [ordered, filter]);
  const columns = grid ? Math.max(1, Math.floor(width / 148)) : 1;
  const height = grid ? 144 : 52;
  const virtual = useVirtualizer({
    count: Math.ceil(sorted.length / columns),
    getScrollElement: () => ref.current,
    estimateSize: () => height,
    overscan: 2,
  });
  useLayoutEffect(() => {
    virtual.measure();
  }, [columns, height, virtual]);
  const restored = useRef(false);
  useLayoutEffect(() => {
    if (restored.current || !previousEntry || !width || !sorted.length) return;
    const index = sorted.findIndex((entry) => entry.relPath === previousEntry);
    if (index >= 0) virtual.scrollToIndex(Math.floor(index / columns), { align: 'center' });
    restored.current = true;
  }, [columns, previousEntry, sorted, virtual, width]);
  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col p-3">
      <header className="flex items-center gap-2 pb-2">
        <Folder size={16} className="shrink-0" />
        <h2 title={directory} className="min-w-0 flex-1 truncate text-sm font-semibold">
          {basename(directory) || directory}
        </h2>
        <Button
          variant={!grid ? 'primary' : 'secondary'}
          size="sm"
          className="w-7 px-0"
          aria-pressed={!grid}
          aria-label={t('ccAgent.workdirBrowse.listView')}
          onClick={() => setGrid(false)}
        >
          <List size={16} />
        </Button>
        <Button
          variant={grid ? 'primary' : 'secondary'}
          size="sm"
          className="w-7 px-0"
          aria-pressed={grid}
          aria-label={t('ccAgent.workdirBrowse.gridView')}
          onClick={() => setGrid(true)}
        >
          <LayoutGrid size={16} />
        </Button>
      </header>
      <div className="mb-2">
        <FileFilterInput placeholder={t('ccAgent.workdirBrowse.filterDirectory')} value={filter} onChange={setFilter} />
      </div>
      <div ref={ref} className="min-h-0 flex-1 overflow-auto">
        {!sorted.length && (
          <p className="p-3 text-sm text-muted-foreground">
            {t(
              loading
                ? 'ccAgent.workdirBrowse.treeLoading'
                : filter
                  ? 'rightSidebar.fileBrowser.filterNoMatch'
                  : 'ccAgent.workdirBrowse.treeEmpty',
            )}
          </p>
        )}
        <div className="relative" style={{ height: virtual.getTotalSize() }}>
          {virtual.getVirtualItems().map((row) => (
            <div
              key={row.index}
              className="absolute inset-x-0 top-0 grid gap-1"
              style={{
                height,
                transform: `translateY(${row.start}px)`,
                gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
              }}
            >
              {sorted.slice(row.index * columns, (row.index + 1) * columns).map((entry, offset) => (
                <Tip key={entry.relPath} text={entry.name}>
                <button
                  type="button"
                  data-file-index={row.index * columns + offset}
                  aria-current={entry.relPath === previousEntry || undefined}
                  onClick={() => onOpen(entry)}
                  onKeyDown={(event) => {
                    const index = row.index * columns + offset;
                    const step: Record<string, number> = {
                      ArrowUp: -columns,
                      ArrowDown: columns,
                      ArrowLeft: -1,
                      ArrowRight: 1,
                    };
                    if (event.key in step && !event.altKey && !event.metaKey && !event.ctrlKey) {
                      event.preventDefault();
                      const next = Math.max(
                        0,
                        Math.min(sorted.length - 1, index + step[event.key]),
                      );
                      virtual.scrollToIndex(Math.floor(next / columns), { align: 'auto' });
                      requestAnimationFrame(() =>
                        ref.current
                          ?.querySelector<HTMLButtonElement>(`[data-file-index="${next}"]`)
                          ?.focus({ preventScroll: true }),
                      );
                      return;
                    }
                    const { platform } = window.electronAPI;
                    const quickLook = platform === 'darwin' && event.key === ' ';
                    const previewPane =
                      platform === 'win32' && event.altKey && event.code === 'KeyP';
                    if (!localWorkdir || entry.type !== 'file' || (!quickLook && !previewPane))
                      return;
                    event.preventDefault();
                    if (event.repeat) return;
                    const target = toOsAbsolutePath(localWorkdir, entry.relPath);
                    void window.electronAPI.openSystemPreview(target).then(
                      (ok) => {
                        if (!ok) toast.error(t('ccAgent.common.openFailed'));
                      },
                      () => toast.error(t('ccAgent.common.openFailed')),
                    );
                  }}
                  className={`flex min-w-0 items-center gap-2 rounded-lg px-2 aria-[current=true]:bg-accent hover:bg-accent focus-visible:bg-accent ${grid ? 'flex-col justify-start py-1 text-left' : 'text-left'}`}
                >
                  <span
                    className={
                      grid
                        ? 'flex h-20 w-full shrink-0 items-center justify-center rounded-lg border border-[var(--border-default)] bg-[var(--surface-chip)] p-1'
                        : 'flex shrink-0'
                    }
                  >
                    <EntryIcon
                      entry={entry}
                      localPath={
                        grid && localWorkdir && entry.type === 'file'
                          ? toOsAbsolutePath(localWorkdir, entry.relPath)
                          : undefined
                      }
                    />
                  </span>
                  <span className={grid ? 'w-full min-w-0' : 'min-w-0 flex-1'}>
                    <span className="line-clamp-2 break-all text-sm">{entry.name}</span>
                  </span>
                  {!grid && entry.type === 'file' && (
                    <small className="shrink-0 text-muted-foreground">
                      {formatBytes(entry.size)}
                    </small>
                  )}
                </button>
                </Tip>
              ))}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
