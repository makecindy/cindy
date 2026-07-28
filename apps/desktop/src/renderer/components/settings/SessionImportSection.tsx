import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, ChevronDown, ChevronRight, Download, FileUp, RefreshCw } from 'lucide-react';

import { basename, cn } from '@/lib/utils';
import { toast } from '@/lib/toast';
import { emitRefresh } from '@/lib/sessionsBus';
import { Spinner } from '@/components/ui/spinner';
import { formatSidebarTime, formatSidebarTimeAbsolute } from '@/features/cc-agent/lib/formatSidebarTime';
import { SessionShareImportWizard } from './SessionShareImportWizard';

type ImportSource = 'codex' | 'claude';
type SourceFilter = 'all' | ImportSource;
type PlacementFilter = 'all' | 'project' | 'dialogue';

interface ImportCandidate {
  key: string;
  source: ImportSource;
  id: string;
  title: string;
  cwd: string;
  updatedAt: string;
  archived: boolean;
  workspaceKind: 'project' | 'dialogue';
  sidebarBucket: 'project' | 'dialogue';
  projectDir: string | null;
}

interface ScanResult {
  sources: {
    codexHomes: string[];
    claudeRoots: string[];
  };
  candidates: ImportCandidate[];
  rejected: {
    codex: number;
    claude: number;
    existing: number;
  };
  currentProjectDirs: string[];
}

type ImportListItem =
  | { type: 'project'; key: string; items: ImportCandidate[]; updatedAtMs: number }
  | { type: 'dialogue'; key: string; item: ImportCandidate; updatedAtMs: number };

let cachedSessionImportScan: ScanResult | null = null;

export function SessionImportSection() {
  const { t } = useTranslation();
  const [scan, setScan] = useState<ScanResult | null>(() => cachedSessionImportScan);
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>('all');
  const [placementFilter, setPlacementFilter] = useState<PlacementFilter>('all');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [scanning, setScanning] = useState(false);
  const [importing, setImporting] = useState(false);
  const [shareWizardOpen, setShareWizardOpen] = useState(false);
  const initialScanStartedRef = useRef(false);

  const runScan = useCallback(async (options?: { force?: boolean }) => {
    setScanning(true);
    try {
      const result = await window.electronAPI.localDb.sessionImport.scan(options);
      cachedSessionImportScan = result;
      setScan(result);
      setSelected(new Set());
      setExpanded(new Set());
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('settings.sessionImport.toast.scanFailed'));
    } finally {
      setScanning(false);
    }
  }, [t]);

  useEffect(() => {
    if (initialScanStartedRef.current) return;
    initialScanStartedRef.current = true;
    void runScan();
  }, [runScan]);

  const visibleCandidates = useMemo(() => {
    if (!scan) return [];
    return scan.candidates.filter((item) => {
      const sourceMatches = sourceFilter === 'all' || item.source === sourceFilter;
      const placementMatches = placementFilter === 'all' || item.sidebarBucket === placementFilter;
      return sourceMatches && placementMatches;
    });
  }, [placementFilter, scan, sourceFilter]);

  const listItems = useMemo(() => buildImportListItems(visibleCandidates), [visibleCandidates]);

  const selectedItems = useMemo(() => {
    if (!scan) return [];
    return scan.candidates
      .filter((item) => selected.has(item.key))
      .map((item) => ({ source: item.source, id: item.id }));
  }, [scan, selected]);

  const toggleItem = useCallback((key: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const toggleGroup = useCallback((key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const toggleGroupSelection = useCallback((items: ImportCandidate[]) => {
    setSelected((prev) => {
      const next = new Set(prev);
      const allSelected = items.every((item) => next.has(item.key));
      for (const item of items) {
        if (allSelected) next.delete(item.key);
        else next.add(item.key);
      }
      return next;
    });
  }, []);

  const visibleSelectedCount = useMemo(
    () => visibleCandidates.filter((item) => selected.has(item.key)).length,
    [selected, visibleCandidates],
  );
  const hiddenSelectedCount = selectedItems.length - visibleSelectedCount;

  const toggleAllVisible = useCallback(() => {
    setSelected((prev) => {
      const next = new Set(prev);
      const allSelected =
        visibleCandidates.length > 0 && visibleCandidates.every((item) => next.has(item.key));
      for (const item of visibleCandidates) {
        if (allSelected) next.delete(item.key);
        else next.add(item.key);
      }
      return next;
    });
  }, [visibleCandidates]);

  const importSelected = useCallback(async () => {
    if (selectedItems.length === 0) return;
    setImporting(true);
    try {
      const result = await window.electronAPI.localDb.sessionImport.importSelected(selectedItems);
      toast.success(
        t('settings.sessionImport.toast.imported', {
          inserted: result.inserted,
          updated: result.updated,
        }),
      );
      emitRefresh();
      await runScan({ force: true });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('settings.sessionImport.toast.importFailed'));
    } finally {
      setImporting(false);
    }
  }, [runScan, selectedItems, t]);

  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-col gap-4">
      <header className="flex shrink-0 flex-col items-stretch justify-between gap-3 xl:flex-row xl:items-end xl:gap-6">
        <div className="flex min-w-0 max-w-[620px] flex-col gap-1">
          <h2 className="text-16 font-medium leading-[1.2] text-[var(--settings-section-title)]">
            {t('settings.sessionImport.title')}
          </h2>
          <p className="text-13 leading-[1.5] text-[var(--settings-section-desc)]">
            {t('settings.sessionImport.description')}
          </p>
        </div>
        <div className="flex shrink-0 items-center justify-end gap-2 select-none">
          <button
            type="button"
            onClick={() => setShareWizardOpen(true)}
            className={cn(
              'inline-flex h-10 shrink-0 items-center gap-2 rounded-full px-4 text-13 font-medium active:scale-[0.98]',
              'border border-[var(--settings-btn-secondary-border)]',
              'bg-[var(--settings-btn-secondary-bg)] text-[var(--settings-btn-secondary-text)]',
              'transition-colors hover:bg-[var(--settings-menu-bg-hover)]',
            )}
          >
            <FileUp size={15} />
            {t('sessionShare.import.entryButton')}
          </button>
          <button
            type="button"
            onClick={() => runScan({ force: true })}
            disabled={scanning}
            className={cn(
              'inline-flex h-10 shrink-0 items-center gap-2 rounded-full px-5 text-13 font-medium active:scale-[0.98]',
              'border border-[var(--settings-btn-primary-border)]',
              'bg-[var(--settings-btn-primary-bg)] text-[var(--settings-btn-primary-text)]',
              'transition-colors hover:bg-[var(--settings-btn-primary-hover-bg)] disabled:cursor-not-allowed disabled:opacity-60',
            )}
          >
            <Spinner icon={RefreshCw} size={15} spinning={scanning} />
            {scanning ? t('settings.sessionImport.scanning') : t('settings.sessionImport.scan')}
          </button>
        </div>
      </header>

      {shareWizardOpen && (
        <SessionShareImportWizard open={shareWizardOpen} onOpenChange={setShareWizardOpen} />
      )}

      <div
        className={cn(
          'flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl',
          'border border-[var(--settings-theme-card-border)] bg-[var(--settings-theme-card-bg)]',
        )}
      >
        {!scan ? (
          <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
            <Download size={24} className="text-[var(--settings-section-title)] opacity-70" />
            <div className="flex max-w-[420px] flex-col gap-1">
              <p className="text-13 font-medium text-[var(--settings-section-sublabel)]">
                {t('settings.sessionImport.emptyTitle')}
              </p>
              <p className="text-12 leading-[1.5] text-[var(--settings-section-desc)]">
                {t('settings.sessionImport.emptyDescription')}
              </p>
            </div>
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="flex shrink-0 flex-col gap-3 border-b border-[var(--settings-input-border)] p-4">
              <ScanSummary scan={scan} />
              <FilterBar
                sourceValue={sourceFilter}
                placementValue={placementFilter}
                onSourceChange={setSourceFilter}
                onPlacementChange={setPlacementFilter}
              />
            </div>

            <div className="flex min-h-0 flex-1 flex-col">
              {listItems.length > 0 && (
                <label className="flex shrink-0 cursor-pointer items-center gap-2 border-b border-[var(--settings-input-border)] px-4 py-2.5 hover:bg-[var(--settings-menu-bg-hover)] select-none">
                  <input
                    type="checkbox"
                    checked={visibleCandidates.length > 0 && visibleSelectedCount === visibleCandidates.length}
                    ref={(node) => {
                      if (node) {
                        node.indeterminate =
                          visibleSelectedCount > 0 && visibleSelectedCount < visibleCandidates.length;
                      }
                    }}
                    onChange={toggleAllVisible}
                    className="h-4 w-4 accent-[var(--settings-menu-text-selected)]"
                  />
                  <span className="text-12 font-medium text-[var(--settings-section-sublabel)]">
                    {t('settings.sessionImport.selectAll', { count: visibleCandidates.length })}
                  </span>
                </label>
              )}
              <div className="flex min-h-0 flex-1 flex-col overflow-y-auto [scrollbar-gutter:stable]">
                {listItems.length === 0 ? (
                  <div className="flex min-h-[160px] flex-1 items-center justify-center px-4 py-10 text-center text-12 text-[var(--settings-section-desc)]">
                    {t('settings.sessionImport.noCandidates')}
                  </div>
                ) : (
                  listItems.map((listItem) => {
                    if (listItem.type === 'dialogue') {
                      const item = listItem.item;
                      return (
                        <div
                          key={listItem.key}
                          className="border-b border-[var(--settings-input-border)] last:border-b-0"
                        >
                          <SessionImportRow
                            item={item}
                            checked={selected.has(item.key)}
                            onToggle={() => toggleItem(item.key)}
                          />
                        </div>
                      );
                    }

                    const group = listItem;
                    const isOpen = expanded.has(group.key);
                    const selectedCount = group.items.filter((item) => selected.has(item.key)).length;
                    const latestUpdatedAt = group.items[0]?.updatedAt;
                    return (
                      <div key={group.key} className="border-b border-[var(--settings-input-border)] last:border-b-0">
                        <div className="grid min-h-14 grid-cols-[16px_20px_minmax(0,1fr)_auto] items-center gap-x-2 px-4 py-2">
                          <input
                            type="checkbox"
                            checked={selectedCount === group.items.length}
                            ref={(node) => {
                              if (node) node.indeterminate = selectedCount > 0 && selectedCount < group.items.length;
                            }}
                            onChange={() => toggleGroupSelection(group.items)}
                            className="h-4 w-4 accent-[var(--settings-menu-text-selected)]"
                            aria-label={t('settings.sessionImport.selectGroup')}
                          />
                          <button
                            type="button"
                            onClick={() => toggleGroup(group.key)}
                            className="flex h-6 w-5 items-center justify-center rounded-full text-[var(--settings-section-sublabel)] hover:bg-[var(--settings-menu-bg-hover)] active:scale-[0.98]"
                            aria-label={isOpen ? t('settings.sessionImport.collapse') : t('settings.sessionImport.expand')}
                          >
                            {isOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                          </button>
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-13 font-medium text-[var(--settings-section-sublabel)]">
                              {groupProjectName(group.items[0], t)}
                            </p>
                            <p
                              title={groupProjectPath(group.items[0], t)}
                              className="truncate text-11 text-[var(--settings-section-desc)]"
                            >
                              {group.items.length} {t('settings.sessionImport.sessions')} · {groupProjectPath(group.items[0], t)}
                            </p>
                          </div>
                          <div className="flex shrink-0 items-center gap-2">
                            {selectedCount > 0 && (
                              <span className="text-11 text-[var(--settings-section-desc)]">
                                {selectedCount}/{group.items.length}
                              </span>
                            )}
                            <time
                              dateTime={latestUpdatedAt}
                              title={formatSidebarTimeAbsolute(latestUpdatedAt)}
                              className="w-14 truncate text-right text-xs font-medium tabular-nums text-[var(--settings-section-desc)]"
                            >
                              {formatSidebarTime(latestUpdatedAt, t)}
                            </time>
                          </div>
                        </div>
                        {isOpen && (
                          <div className="flex flex-col border-t border-[var(--settings-input-border)]">
                            {group.items.map((item) => (
                              <SessionImportRow
                                key={item.key}
                                item={item}
                                checked={selected.has(item.key)}
                                onToggle={() => toggleItem(item.key)}
                                isProjectChild
                              />
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })
                )}
              </div>
            </div>

            <footer className="flex shrink-0 items-center justify-between gap-3 border-t border-[var(--settings-input-border)] px-4 py-3 select-none">
              <p className="text-12 text-[var(--settings-section-desc)]">
                {t('settings.sessionImport.selected', { count: selectedItems.length })}
                {hiddenSelectedCount > 0 && (
                  <span> {t('settings.sessionImport.selectedOutsideFilter', { count: hiddenSelectedCount })}</span>
                )}
              </p>
              <button
                type="button"
                onClick={importSelected}
                disabled={selectedItems.length === 0 || importing}
                className={cn(
                  'inline-flex h-10 items-center gap-2 rounded-full px-5 text-13 font-medium active:scale-[0.98]',
                  'border border-[var(--settings-btn-primary-border)]',
                  'bg-[var(--settings-btn-primary-bg)] text-[var(--settings-btn-primary-text)]',
                  'transition-colors hover:bg-[var(--settings-btn-primary-hover-bg)] disabled:cursor-not-allowed disabled:opacity-60',
                )}
              >
                <Check size={15} />
                {importing ? t('settings.sessionImport.importing') : t('settings.sessionImport.importSelected')}
              </button>
            </footer>
          </div>
        )}
      </div>
    </div>
  );
}

function buildImportListItems(candidates: ImportCandidate[]): ImportListItem[] {
  const projectGroups = new Map<string, ImportCandidate[]>();
  const listItems: ImportListItem[] = [];

  for (const item of candidates) {
    if (item.sidebarBucket !== 'project' || !item.projectDir) {
      listItems.push({
        type: 'dialogue',
        key: `dialogue:${item.key}`,
        item,
        updatedAtMs: Date.parse(item.updatedAt) || 0,
      });
      continue;
    }

    const key = groupKeyForProject(item);
    const group = projectGroups.get(key);
    if (group) group.push(item);
    else projectGroups.set(key, [item]);
  }

  for (const [key, items] of projectGroups.entries()) {
    items.sort((a, b) => (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0));
    listItems.push({
      type: 'project',
      key,
      items,
      updatedAtMs: Date.parse(items[0]?.updatedAt ?? '') || 0,
    });
  }

  return listItems.sort((a, b) => b.updatedAtMs - a.updatedAtMs);
}

function ScanSummary({ scan }: { scan: ScanResult }) {
  const { t } = useTranslation();
  const projectCount = scan.candidates.filter((item) => item.sidebarBucket === 'project').length;
  const dialogueCount = scan.candidates.length - projectCount;
  return (
    <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
      <SummaryCell
        label={t('settings.sessionImport.summary.total')}
        value={scan.candidates.length}
        hint={t('settings.sessionImport.summary.totalHint')}
      />
      <SummaryCell
        label={t('settings.sessionImport.summary.projects')}
        value={projectCount}
        hint={t('settings.sessionImport.summary.projectsHint')}
      />
      <SummaryCell
        label={t('settings.sessionImport.summary.dialogue')}
        value={dialogueCount}
        hint={t('settings.sessionImport.summary.dialogueHint')}
      />
      <SummaryCell
        label={t('settings.sessionImport.summary.filtered')}
        value={scan.rejected.codex + scan.rejected.claude + scan.rejected.existing}
        hint={t('settings.sessionImport.summary.filteredHint')}
      />
    </div>
  );
}

function SummaryCell({ label, value, hint }: { label: string; value: number; hint: string }) {
  return (
    <div className="min-w-0 rounded-xl border border-[var(--settings-input-border)] px-3 py-2">
      <div className="flex min-w-0 items-baseline gap-2">
        <p className="shrink-0 text-18 font-medium tabular-nums text-[var(--settings-section-title)]">
          {value}
        </p>
        <p className="truncate text-11 text-[var(--settings-section-desc)]">{label}</p>
      </div>
      <p className="mt-1 text-11 leading-[1.4] text-[var(--settings-section-desc)]">{hint}</p>
    </div>
  );
}

function FilterBar({
  sourceValue,
  placementValue,
  onSourceChange,
  onPlacementChange,
}: {
  sourceValue: SourceFilter;
  placementValue: PlacementFilter;
  onSourceChange: (value: SourceFilter) => void;
  onPlacementChange: (value: PlacementFilter) => void;
}) {
  const { t } = useTranslation();
  const sourceFilters: SourceFilter[] = ['all', 'codex', 'claude'];
  const placementFilters: PlacementFilter[] = ['all', 'project', 'dialogue'];
  return (
    <div className="grid gap-2 xl:grid-cols-2">
      <SegmentedFilter
        label={t('settings.sessionImport.filters.source')}
        values={sourceFilters}
        value={sourceValue}
        labelFor={(filter) => t(`settings.sessionImport.filters.${filter}`)}
        onChange={onSourceChange}
      />
      <SegmentedFilter
        label={t('settings.sessionImport.filters.placement')}
        values={placementFilters}
        value={placementValue}
        labelFor={(filter) => t(`settings.sessionImport.filters.${filter}`)}
        onChange={onPlacementChange}
      />
    </div>
  );
}

function SegmentedFilter<T extends string>({
  label,
  values,
  value,
  labelFor,
  onChange,
}: {
  label: string;
  values: readonly T[];
  value: T;
  labelFor: (value: T) => string;
  onChange: (value: T) => void;
}) {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2 select-none">
      <span className="w-[56px] text-11 font-medium text-[var(--settings-section-desc)]">
        {label}
      </span>
      {values.map((filter) => (
        <button
          key={filter}
          type="button"
          onClick={() => onChange(filter)}
          className={cn(
            'h-8 rounded-full border px-3 text-12 font-medium transition-colors active:scale-[0.98]',
            value === filter
              ? 'border-[var(--settings-menu-border-selected)] bg-[var(--settings-menu-bg-selected)] text-[var(--settings-menu-text-selected)]'
              : 'border-[var(--settings-input-border)] text-[var(--settings-section-sublabel)] hover:bg-[var(--settings-menu-bg-hover)]',
          )}
        >
          {labelFor(filter)}
        </button>
      ))}
    </div>
  );
}

function SessionImportRow({
  item,
  checked,
  onToggle,
  isProjectChild = false,
}: {
  item: ImportCandidate;
  checked: boolean;
  onToggle: () => void;
  isProjectChild?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <label
      className={cn(
        'flex min-w-0 cursor-pointer items-start gap-3 py-3 hover:bg-[var(--settings-menu-bg-hover)]',
        isProjectChild ? 'pl-[40px] pr-4' : 'px-4',
      )}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={onToggle}
        className="mt-1 h-4 w-4 shrink-0 accent-[var(--settings-menu-text-selected)]"
      />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2 overflow-hidden">
          <span className="shrink-0 whitespace-nowrap rounded-full border border-[var(--settings-input-border)] px-1.5 py-0.5 text-10 uppercase text-[var(--settings-section-desc)]">
            {item.source === 'codex' ? 'Codex' : 'Claude'}
          </span>
          {item.archived && (
            <span className="shrink-0 whitespace-nowrap rounded-full border border-[var(--settings-input-border)] px-1.5 py-0.5 text-10 text-[var(--settings-section-desc)]">
              {t('settings.sessionImport.archived')}
            </span>
          )}
          {item.workspaceKind === 'dialogue' && (
            <span className="shrink-0 whitespace-nowrap rounded-full border border-[var(--settings-input-border)] px-1.5 py-0.5 text-10 text-[var(--settings-section-desc)]">
              {t('settings.sessionImport.filters.dialogue')}
            </span>
          )}
          <p
            title={item.title || undefined}
            className="min-w-0 flex-1 truncate text-13 font-medium text-[var(--settings-section-sublabel)]"
          >
            {item.title || t('settings.sessionImport.untitled')}
          </p>
        </div>
        <p title={item.cwd || undefined} className="mt-1 truncate text-11 text-[var(--settings-section-desc)]">
          {item.cwd}
        </p>
      </div>
      <time
        dateTime={item.updatedAt}
        title={formatSidebarTimeAbsolute(item.updatedAt)}
        className="shrink-0 text-right text-xs font-medium tabular-nums text-[var(--settings-section-desc)]"
      >
        {formatSidebarTime(item.updatedAt, t)}
      </time>
    </label>
  );
}

function groupKeyForProject(item: ImportCandidate): string {
  return `project:${item.projectDir}`;
}

function groupProjectName(item: ImportCandidate | undefined, t: (key: string) => string): string {
  if (!item) return '';
  if (item.projectDir) return basename(item.projectDir) || item.projectDir;
  return item.cwd || t('settings.sessionImport.noWorkingDir');
}

function groupProjectPath(item: ImportCandidate | undefined, t: (key: string) => string): string {
  return item?.projectDir || item?.cwd || t('settings.sessionImport.noWorkingDir');
}
