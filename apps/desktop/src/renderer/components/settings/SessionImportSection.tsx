/**
 * 设置 → 任务导入。
 *
 * 列出这台电脑上其他 AI 编程工具里的任务（只读扫描），用户勾选后在后台导入；导入过程与结果
 * 留在本页，可以离开页面再回来。界面状态按「扫描中 → 列表 / 没找到 → 导入中 → 结果」走，
 * 导入任务的真实进度由主进程推送（session-import:progress）。
 *
 * 噪音（Cindy 自己运行过的、临时文件夹里的、Agent 内部会话、已导入的）默认不列，收在
 * 「已隐藏 N 个」里，前两类可以手动显示。来源图标与名称见 ImportSourceMark。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  ArrowRight,
  Check,
  ChevronDown,
  ChevronRight,
  CircleCheck,
  CircleX,
  Clock,
  EyeOff,
  FileUp,
  Folder,
  FolderOpen,
  ListFilter,
  MessageSquare,
  Minus,
  RefreshCw,
  RotateCw,
  Search,
  TriangleAlert,
  X,
} from 'lucide-react';

import { cn } from '@/lib/utils';
import { toast } from '@/lib/toast';
import { emitRefresh } from '@/lib/sessionsBus';
import { Button } from '@/components/ui/button';
import { Collapse } from '@/components/ui/collapse';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Spinner } from '@/components/ui/spinner';
import { Tip } from '@/components/ui/tooltip';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { IMPORT_SOURCE_NAMES, ImportSourceMark } from '@/components/icons/ImportSourceMark';
import { formatSidebarTime, formatSidebarTimeAbsolute } from '@/features/cc-agent/lib/formatSidebarTime';
import {
  IMPORT_CONFIRM_BYTES,
  IMPORT_CONFIRM_COUNT,
  IMPORT_SOURCE_IDS,
  type HiddenCategory,
  type ImportCandidate,
  type ImportItemView,
  type ImportJobView,
  type ImportScanResult,
  type ImportSourceId,
  type NativeHarness,
} from '../../../shared/sessionImport';
import { normalizeWorkingDirForGrouping } from '../../../shared/workingDir';
import { SessionShareImportWizard } from './SessionShareImportWizard';

const MB = 1024 * 1024;
/** 结果里「可以继续」超过这么多条时折叠成一行。 */
const READY_COLLAPSE_AT = 8;

const HARNESS_LABEL: Record<NativeHarness, string> = { cc: 'Claude Code', codex: 'Codex', pi: 'Pi' };

/** 离开页面再回来时直接显示上次扫描结果，后台再刷新。 */
let cachedScan: ImportScanResult | null = null;

interface Group {
  key: string;
  name: string;
  path: string | null;
  dialogue: boolean;
  missingDir: boolean;
  items: ImportCandidate[];
  latest: number;
}

type CheckState = 'off' | 'on' | 'mixed';

function platformKey(raw: string): string {
  const normalized = normalizeWorkingDirForGrouping(raw) ?? raw;
  return window.electronAPI.platform === 'linux' ? normalized : normalized.toLowerCase();
}

function isoOf(ms: number): string | undefined {
  return ms > 0 ? new Date(ms).toISOString() : undefined;
}

function useFormatSize(): (bytes: number) => string {
  const { i18n } = useTranslation();
  return useCallback(
    (bytes: number) => {
      const gb = bytes >= 1024 * MB;
      const nf = new Intl.NumberFormat(i18n.language, { maximumFractionDigits: gb ? 1 : 0 });
      return gb ? `${nf.format(bytes / 1024 / MB)} GB` : `${nf.format(Math.max(1, bytes / MB))} MB`;
    },
    [i18n.language],
  );
}

/** 大致时间：按约 12 MB/s 的读写速度加每条任务的固定开销估算，至少 1 分钟。 */
function estimateMinutes(count: number, bytes: number): number {
  return Math.max(1, Math.ceil((bytes / (12 * MB) + count * 0.6) / 60));
}

function buildGroups(candidates: ImportCandidate[]): Group[] {
  const map = new Map<string, Group>();
  for (const c of candidates) {
    let g = map.get(c.groupKey);
    if (!g) {
      g = { key: c.groupKey, name: c.groupName, path: c.groupPath, dialogue: c.dialogue, missingDir: false, items: [], latest: 0 };
      map.set(c.groupKey, g);
    }
    g.items.push(c);
    g.latest = Math.max(g.latest, c.updatedAt);
    if (c.missingDir) g.missingDir = true;
  }
  const groups = [...map.values()];
  for (const g of groups) g.items.sort((a, b) => b.updatedAt - a.updatedAt);
  // 对话放最后，其余按最近更新排。
  return groups.sort((a, b) => Number(a.dialogue) - Number(b.dialogue) || b.latest - a.latest);
}

function checkStateOf(items: ImportCandidate[], selected: Set<string>): CheckState {
  const n = items.reduce((acc, it) => acc + (selected.has(it.key) ? 1 : 0), 0);
  return n === 0 ? 'off' : n === items.length ? 'on' : 'mixed';
}

/** 16px 复选框外观（交互由外层按钮承担）。 */
function CheckBox({ state, disabled = false }: { state: CheckState; disabled?: boolean }) {
  const filled = state !== 'off';
  return (
    <span
      aria-hidden
      className={cn(
        'flex h-4 w-4 shrink-0 items-center justify-center rounded-[4px] border transition-colors duration-[var(--motion-instant)]',
        filled
          ? 'border-[var(--accent-cta-bg-pure)] bg-[var(--accent-cta-bg-pure)] text-[var(--accent-pure-cta-fg)]'
          : 'border-[var(--border-default)] bg-[var(--settings-theme-card-bg)]',
        disabled && 'opacity-40',
      )}
    >
      {state === 'on' && <Check size={12} strokeWidth={2.5} />}
      {state === 'mixed' && <Minus size={12} strokeWidth={2.5} />}
    </span>
  );
}

/** 用户点过「完成」的那次导入结果；重新打开页面时不再显示它。 */
const DISMISSED_JOB_KEY = 'cindy.sessionImport.dismissedJob';

function dismissedJobId(): string | null {
  try {
    return window.localStorage.getItem(DISMISSED_JOB_KEY);
  } catch {
    return null;
  }
}

export function SessionImportSection() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const formatSize = useFormatSize();
  const [searchParams, setSearchParams] = useSearchParams();
  const projectParam = searchParams.get('project');

  const [scan, setScan] = useState<ImportScanResult | null>(() => cachedScan);
  const [scanning, setScanning] = useState(false);
  const [scanFailed, setScanFailed] = useState(false);
  const [job, setJob] = useState<ImportJobView | null>(null);
  const [source, setSource] = useState<ImportSourceId | 'all'>('all');
  const [query, setQuery] = useState('');
  const [shownHidden, setShownHidden] = useState<Set<HiddenCategory>>(() => new Set());
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [open, setOpen] = useState<Set<string> | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [starting, setStarting] = useState(false);
  const [shareWizardOpen, setShareWizardOpen] = useState(false);
  const jobIdRef = useRef<string | null>(null);

  const runScan = useCallback(async (force: boolean) => {
    setScanning(true);
    setScanFailed(false);
    try {
      const result = await window.electronAPI.localDb.sessionImport.scan({ force });
      cachedScan = result;
      setScan(result);
      // 已经不在列表里的勾选（刚导入的、被隐藏的）一并去掉。
      setSelected((prev) => {
        const keys = new Set(result.candidates.map((c) => c.key));
        return new Set([...prev].filter((k) => keys.has(k)));
      });
    } catch {
      setScanFailed(true);
    } finally {
      setScanning(false);
    }
  }, []);

  // 打开页面只扫描一次（StrictMode 双挂载也不重复扫）。
  const initialScanStartedRef = useRef(false);
  useEffect(() => {
    if (initialScanStartedRef.current) return;
    initialScanStartedRef.current = true;
    void runScan(false);
  }, [runScan]);

  // 接上正在进行的导入，或还没点「完成」的上次结果（离开页面期间导入完成也能看到重试与选择文件夹）。
  useEffect(() => {
    let alive = true;
    void window.electronAPI.localDb.sessionImport.status().then((view) => {
      if (alive && view && (view.status === 'running' || view.requestId !== dismissedJobId())) {
        jobIdRef.current = view.requestId;
        setJob(view);
      }
    }).catch(() => undefined);
    const off = window.electronAPI.localDb.sessionImport.onProgress((view) => {
      if (jobIdRef.current && view.requestId !== jobIdRef.current) return;
      if (!jobIdRef.current && view.status !== 'running') return;
      jobIdRef.current = view.requestId;
      setJob(view);
    });
    return () => {
      alive = false;
      off();
    };
  }, []);

  // 导入结束：侧栏刷新出新任务。
  const finishedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!job || job.status === 'running' || finishedRef.current === job.requestId) return;
    finishedRef.current = job.requestId;
    emitRefresh();
  }, [job]);

  const projectKey = useMemo(() => (projectParam ? platformKey(projectParam) : null), [projectParam]);
  const projectName = useMemo(() => {
    if (!projectParam) return '';
    const parts = projectParam.replace(/[\\/]+$/, '').split(/[\\/]/);
    return parts[parts.length - 1] || projectParam;
  }, [projectParam]);

  const shown = useCallback(
    (c: ImportCandidate) => !c.hidden || shownHidden.has(c.hidden),
    [shownHidden],
  );

  const listable = useMemo(() => (scan?.candidates ?? []).filter(shown), [scan, shown]);

  const sourceCounts = useMemo(() => {
    const counts = new Map<ImportSourceId, number>();
    for (const c of listable) counts.set(c.source, (counts.get(c.source) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }, [listable]);

  const visible = useMemo(() => {
    const kw = query.trim().toLowerCase();
    return listable.filter((c) => {
      if (source !== 'all' && c.source !== source) return false;
      if (projectKey && (c.dialogue || c.groupKey !== projectKey)) return false;
      if (!kw) return true;
      return c.title.toLowerCase().includes(kw) || c.groupName.toLowerCase().includes(kw)
        || (c.groupPath ?? '').toLowerCase().includes(kw);
    });
  }, [listable, projectKey, query, source]);

  const groups = useMemo(() => buildGroups(visible), [visible]);
  const openGroups = useMemo(() => open ?? new Set(groups.slice(0, 1).map((g) => g.key)), [groups, open]);

  const selectable = useMemo(() => visible.filter((c) => !c.unsupportedVersion), [visible]);
  const byKey = useMemo(() => new Map((scan?.candidates ?? []).map((c) => [c.key, c])), [scan]);
  const selectedList = useMemo(() => [...selected].map((k) => byKey.get(k)).filter((c): c is ImportCandidate => !!c), [byKey, selected]);
  const selectedBytes = useMemo(() => selectedList.reduce((acc, c) => acc + c.sizeBytes, 0), [selectedList]);

  const hiddenTotal = useMemo(() => {
    if (!scan) return 0;
    const h = scan.hiddenCounts;
    return (shownHidden.has('cindy') ? 0 : h.cindy) + (shownHidden.has('temp') ? 0 : h.temp) + h.internal + h.imported;
  }, [scan, shownHidden]);

  const toggleKeys = useCallback((keys: string[], on: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const k of keys) {
        if (on) next.add(k);
        else next.delete(k);
      }
      return next;
    });
  }, []);

  const toggleGroupOpen = useCallback((key: string) => {
    setOpen((prev) => {
      const next = new Set(prev ?? openGroups);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, [openGroups]);

  const startImport = useCallback(async (keys: string[]) => {
    if (keys.length === 0) return;
    setStarting(true);
    try {
      const view = await window.electronAPI.localDb.sessionImport.start(keys);
      jobIdRef.current = view.requestId;
      finishedRef.current = null;
      setJob(view);
      setSelected(new Set());
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('settings.sessionImport.scanFailed'));
    } finally {
      setStarting(false);
      setConfirmOpen(false);
    }
  }, [t]);

  const requestImport = useCallback(() => {
    if (selectedList.length === 0) return;
    if (selectedList.length > IMPORT_CONFIRM_COUNT || selectedBytes > IMPORT_CONFIRM_BYTES) {
      setConfirmOpen(true);
      return;
    }
    void startImport(selectedList.map((c) => c.key));
  }, [selectedBytes, selectedList, startImport]);

  const closeJob = useCallback(() => {
    if (jobIdRef.current) {
      try {
        window.localStorage.setItem(DISMISSED_JOB_KEY, jobIdRef.current);
      } catch { /* storage unavailable: the result simply shows again next time */ }
    }
    jobIdRef.current = null;
    setJob(null);
    void runScan(true);
  }, [runScan]);

  const clearProjectFilter = useCallback(() => {
    const next = new URLSearchParams(searchParams);
    next.delete('project');
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);

  let body: React.ReactNode;
  if (job) {
    body = (
      <ImportJobPanel
        job={job}
        onStop={() => void window.electronAPI.localDb.sessionImport.cancel(job.requestId)}
        onDone={closeJob}
        onRetry={(key) => void startImport([key])}
        onOpen={(sessionId) => navigate(`/cc-agent/${sessionId}`)}
      />
    );
  } else if (!scan) {
    body = scanFailed ? <ScanFailed onRetry={() => void runScan(true)} /> : <ScanningSkeleton />;
  } else if (scan.candidates.length === 0 && !projectKey) {
    // 只有真的没有记录时才显示空状态；记录都被默认隐藏时留在列表里，右上角可以打开隐藏项。
    body = <EmptyState onRescan={() => void runScan(true)} scanning={scanning} />;
  } else {
    const allState = checkStateOf(selectable, selected);
    body = (
      <>
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-[var(--settings-input-border)] px-4 py-3">
          <SourceFilter value={source} counts={sourceCounts} total={listable.length} onChange={setSource} />
          <label className="flex h-8 w-[240px] min-w-0 items-center gap-2 rounded-full border border-[var(--settings-input-border)] bg-[var(--settings-theme-card-bg)] px-3 text-[var(--text-tertiary)] focus-within:border-[var(--focus-ring)]">
            <Search size={14} aria-hidden />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('settings.sessionImport.search')}
              aria-label={t('settings.sessionImport.search')}
              className="min-w-0 flex-1 bg-transparent text-13 text-[var(--text-primary)] outline-none placeholder:text-[var(--settings-input-placeholder)]"
            />
          </label>
          {projectKey && (
            <span className="inline-flex h-8 max-w-[220px] items-center gap-1.5 rounded-full border border-[var(--settings-input-border)] pl-3 pr-1 text-13 text-[var(--text-primary)]">
              <Folder size={14} className="shrink-0 text-[var(--text-secondary)]" aria-hidden />
              <span className="truncate">{t('settings.sessionImport.projectFilter', { name: projectName })}</span>
              <Tip text={t('settings.sessionImport.clearProjectFilter')}>
                <button
                  type="button"
                  onClick={clearProjectFilter}
                  aria-label={t('settings.sessionImport.clearProjectFilter')}
                  className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[var(--text-tertiary)] hover:bg-[var(--settings-menu-bg-hover)] hover:text-[var(--text-secondary)]"
                >
                  <X size={14} aria-hidden />
                </button>
              </Tip>
            </span>
          )}
          <div className="ml-auto flex items-center gap-2">
            {scanning && <Spinner size={14} className="text-[var(--text-tertiary)]" />}
            <HiddenMenu
              scan={scan}
              total={hiddenTotal}
              shown={shownHidden}
              onToggle={(cat) => setShownHidden((prev) => {
                const next = new Set(prev);
                if (next.has(cat)) next.delete(cat);
                else next.add(cat);
                return next;
              })}
            />
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]">
          {groups.length === 0 ? (
            <div className="flex min-h-[160px] items-center justify-center px-6 py-10 text-13 text-[var(--text-secondary)]">
              {listable.length === 0 && scan.candidates.length > 0
                ? t('settings.sessionImport.allHidden')
                : t('settings.sessionImport.noMatch')}
            </div>
          ) : (
            <>
              <button
                type="button"
                role="checkbox"
                aria-checked={allState === 'on' ? true : allState === 'mixed' ? 'mixed' : false}
                onClick={() => toggleKeys(selectable.map((c) => c.key), allState !== 'on')}
                className="flex h-9 w-full items-center gap-2.5 border-b border-[var(--settings-input-border)] px-4 text-12 font-medium text-[var(--text-secondary)] select-none"
              >
                <CheckBox state={allState} />
                {t('settings.sessionImport.selectAll')}
              </button>
              {groups.map((g, i) => (
                <ImportGroup
                  key={g.key}
                  group={g}
                  first={i === 0}
                  open={openGroups.has(g.key) || !!query.trim()}
                  selected={selected}
                  onToggleOpen={() => toggleGroupOpen(g.key)}
                  onToggleKeys={toggleKeys}
                />
              ))}
            </>
          )}
        </div>

        <footer className="flex h-14 shrink-0 items-center justify-between gap-3 border-t border-[var(--settings-input-border)] px-4 select-none">
          <span className="min-w-0 truncate text-13 tabular-nums text-[var(--text-secondary)]">
            {selectedList.length > 0
              ? t('settings.sessionImport.selectedSummary', { count: selectedList.length, size: formatSize(selectedBytes) })
              : t('settings.sessionImport.pickHint')}
          </span>
          <Button
            variant="cta"
            size="lg"
            type="button"
            loading={starting}
            disabled={selectedList.length === 0 || starting}
            onClick={requestImport}
          >
            {selectedList.length > 0
              ? t('settings.sessionImport.importCount', { count: selectedList.length })
              : t('settings.sessionImport.import')}
          </Button>
        </footer>
      </>
    );
  }

  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-col gap-4">
      <header className="flex shrink-0 items-end justify-between gap-6">
        <div className="flex min-w-0 max-w-[560px] flex-col gap-1">
          <h2 className="text-16 font-medium leading-[1.2] text-[var(--settings-section-title)]">
            {t('settings.sessionImport.title')}
          </h2>
          <p className="text-13 leading-[1.5] text-[var(--settings-section-desc)]">
            {t('settings.sessionImport.description')}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2 select-none">
          <Button variant="secondary" size="lg" type="button" onClick={() => setShareWizardOpen(true)}>
            <FileUp size={15} />
            {t('sessionShare.import.entryButton')}
          </Button>
          <Tip text={t('settings.sessionImport.rescan')}>
            <Button
              variant="secondary"
              size="lg"
              type="button"
              compact
              aria-label={t('settings.sessionImport.rescan')}
              disabled={scanning || !!job}
              onClick={() => void runScan(true)}
              className="w-9 px-0"
            >
              <RefreshCw size={15} className={cn(scanning && 'animate-spin')} />
            </Button>
          </Tip>
        </div>
      </header>

      {shareWizardOpen && <SessionShareImportWizard open={shareWizardOpen} onOpenChange={setShareWizardOpen} />}

      <section className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-[var(--settings-theme-card-border)] bg-[var(--settings-theme-card-bg)]">
        {body}
      </section>

      <ConfirmDialog
        presentation="standard"
        cancelFirst
        open={confirmOpen}
        onOpenChange={(next) => !starting && setConfirmOpen(next)}
        title={t('settings.sessionImport.confirm.title', { count: selectedList.length })}
        description={t('settings.sessionImport.confirm.body', {
          minutes: estimateMinutes(selectedList.length, selectedBytes),
          size: formatSize(selectedBytes),
        })}
        cancelText={t('settings.sessionImport.confirm.cancel')}
        confirmText={t('settings.sessionImport.importCount', { count: selectedList.length })}
        autoFocusConfirm
        loading={starting}
        onConfirm={() => void startImport(selectedList.map((c) => c.key))}
      />
    </div>
  );
}

function SourceFilter({
  value,
  counts,
  total,
  onChange,
}: {
  value: ImportSourceId | 'all';
  counts: Array<[ImportSourceId, number]>;
  total: number;
  onChange: (value: ImportSourceId | 'all') => void;
}) {
  const { t } = useTranslation();
  const label = value === 'all' ? t('settings.sessionImport.allSources') : IMPORT_SOURCE_NAMES[value];
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="inline-flex h-8 shrink-0 items-center gap-2 rounded-full border border-[var(--settings-input-border)] bg-[var(--settings-theme-card-bg)] pl-3 pr-2.5 text-13 font-medium text-[var(--text-primary)] select-none hover:bg-[var(--settings-menu-bg-hover)]"
        >
          {value === 'all' ? <ListFilter size={14} aria-hidden /> : <ImportSourceMark source={value} size={14} />}
          <span>{label}</span>
          <ChevronDown size={14} className="text-[var(--text-tertiary)]" aria-hidden />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-[232px]">
        <DropdownMenuItem onSelect={() => onChange('all')} className="gap-2.5">
          <span className="flex w-4 justify-center">{value === 'all' && <Check size={16} />}</span>
          {t('settings.sessionImport.allSources')}
          <DropdownMenuShortcut className="tracking-normal tabular-nums">{total}</DropdownMenuShortcut>
        </DropdownMenuItem>
        {counts.length > 0 && <DropdownMenuSeparator />}
        {counts.map(([id, n]) => (
          <DropdownMenuItem key={id} onSelect={() => onChange(id)} className="gap-2.5">
            <span className="flex w-4 justify-center">{value === id && <Check size={16} />}</span>
            <ImportSourceMark source={id} size={16} />
            {IMPORT_SOURCE_NAMES[id]}
            <DropdownMenuShortcut className="tracking-normal tabular-nums">{n}</DropdownMenuShortcut>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function HiddenMenu({
  scan,
  total,
  shown,
  onToggle,
}: {
  scan: ImportScanResult;
  total: number;
  shown: Set<HiddenCategory>;
  onToggle: (cat: HiddenCategory) => void;
}) {
  const { t } = useTranslation();
  const h = scan.hiddenCounts;
  if (total === 0 && shown.size === 0 && scan.sourceErrors.length === 0) return null;
  const toggleRow = (cat: HiddenCategory, label: string, count: number) => (
    <DropdownMenuItem
      onSelect={(e) => {
        e.preventDefault();
        onToggle(cat);
      }}
      disabled={count === 0}
      className="gap-2.5"
    >
      <CheckBox state={shown.has(cat) ? 'on' : 'off'} />
      {label}
      <DropdownMenuShortcut className="tracking-normal tabular-nums">{count}</DropdownMenuShortcut>
    </DropdownMenuItem>
  );
  const infoRow = (label: string, count: number) => (
    <div className="flex h-8 items-center gap-2.5 px-2 text-14 leading-[1.43] text-[var(--cmd-palette-item-meta)]">
      <span className="w-4" />
      {label}
      <span className="ml-auto pl-4 text-12 tabular-nums">{count}</span>
    </div>
  );
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="inline-flex h-7 items-center gap-1.5 rounded-full px-2 text-12 text-[var(--text-tertiary)] select-none hover:bg-[var(--settings-menu-bg-hover)] hover:text-[var(--text-secondary)]"
        >
          <EyeOff size={14} aria-hidden />
          <span className="tabular-nums">{t('settings.sessionImport.hiddenCount', { count: total })}</span>
          <ChevronDown size={12} aria-hidden />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[340px]">
        <DropdownMenuLabel>{t('settings.sessionImport.hidden.head')}</DropdownMenuLabel>
        {toggleRow('cindy', t('settings.sessionImport.hidden.cindy'), h.cindy)}
        {toggleRow('temp', t('settings.sessionImport.hidden.temp'), h.temp)}
        <DropdownMenuSeparator />
        {infoRow(t('settings.sessionImport.hidden.internal'), h.internal)}
        {infoRow(t('settings.sessionImport.hidden.imported'), h.imported)}
        {scan.sourceErrors.length > 0 && <DropdownMenuSeparator />}
        {scan.sourceErrors.map((e) => (
          <div key={e.id} className="flex h-8 items-center gap-2.5 px-2 text-14 leading-[1.43] text-[var(--cmd-palette-item-meta)]">
            <TriangleAlert size={16} className="text-[var(--warning-fg)]" aria-hidden />
            {t('settings.sessionImport.hidden.sourceError', { name: IMPORT_SOURCE_NAMES[e.id] })}
          </div>
        ))}
        <div className="px-2 pb-1.5 pt-1 text-12 leading-[1.33] text-[var(--cmd-palette-item-meta)]">
          {t('settings.sessionImport.hidden.hint')}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ImportGroup({
  group,
  first,
  open,
  selected,
  onToggleOpen,
  onToggleKeys,
}: {
  group: Group;
  first: boolean;
  open: boolean;
  selected: Set<string>;
  onToggleOpen: () => void;
  onToggleKeys: (keys: string[], on: boolean) => void;
}) {
  const { t } = useTranslation();
  const selectable = group.items.filter((c) => !c.unsupportedVersion);
  const state = checkStateOf(selectable, selected);
  const name = group.dialogue ? t('settings.sessionImport.dialogue') : group.name;
  return (
    <div className={cn(!first && 'border-t border-[var(--settings-input-border)]')}>
      <div className="grid h-11 grid-cols-[16px_minmax(0,1fr)] items-center gap-x-2.5 pl-4 transition-colors duration-[var(--motion-fast)] hover:bg-[var(--settings-menu-bg-hover)]">
        <Tip text={t('settings.sessionImport.selectGroup')}>
          <button
            type="button"
            role="checkbox"
            aria-checked={state === 'on' ? true : state === 'mixed' ? 'mixed' : false}
            aria-label={t('settings.sessionImport.selectGroup')}
            disabled={selectable.length === 0}
            onClick={() => onToggleKeys(selectable.map((c) => c.key), state !== 'on')}
            className="-m-2 flex rounded-lg p-2"
          >
            <CheckBox state={state} disabled={selectable.length === 0} />
          </button>
        </Tip>
        <button
          type="button"
          aria-expanded={open}
          aria-label={open ? t('settings.sessionImport.collapse') : t('settings.sessionImport.expand')}
          onClick={onToggleOpen}
          className="grid h-full min-w-0 grid-cols-[16px_16px_auto_minmax(0,1fr)_auto_84px] items-center gap-x-2.5 pr-4 text-left select-none"
        >
          <ChevronRight
            size={14}
            aria-hidden
            className={cn('text-[var(--text-tertiary)] transition-transform duration-[var(--motion-fast)] ease-[var(--motion-ease-move)]', open && 'rotate-90')}
          />
          {group.dialogue
            ? <MessageSquare size={16} className="text-[var(--text-secondary)]" aria-hidden />
            : <Folder size={16} className="text-[var(--text-secondary)]" aria-hidden />}
          <span className="whitespace-nowrap text-13 font-medium leading-[1.38] text-[var(--text-primary)]">{name}</span>
          <span className="min-w-0 truncate text-12 leading-[1.33] text-[var(--text-tertiary)]" title={group.path ?? undefined}>
            {group.missingDir && (
              <span className="text-[var(--warning-fg)]">{t('settings.sessionImport.missingDir')}{group.path ? ' · ' : ''}</span>
            )}
            {group.path}
          </span>
          <span className="whitespace-nowrap text-right text-12 tabular-nums text-[var(--text-tertiary)]">
            {t('settings.sessionImport.groupTasks', { count: group.items.length })}
          </span>
          <time
            dateTime={isoOf(group.latest)}
            title={formatSidebarTimeAbsolute(isoOf(group.latest))}
            className="whitespace-nowrap text-right text-12 tabular-nums text-[var(--text-tertiary)]"
          >
            {formatSidebarTime(isoOf(group.latest), t)}
          </time>
        </button>
      </div>
      <Collapse open={open}>
        {group.items.map((c) => (
          <ImportRow
            key={c.key}
            item={c}
            checked={selected.has(c.key)}
            onToggle={() => onToggleKeys([c.key], !selected.has(c.key))}
          />
        ))}
      </Collapse>
    </div>
  );
}

function ImportRow({ item, checked, onToggle }: { item: ImportCandidate; checked: boolean; onToggle: () => void }) {
  const { t } = useTranslation();
  const disabled = !!item.unsupportedVersion;
  const title = item.title || t('settings.sessionImport.untitled');
  const tag = disabled ? t('settings.sessionImport.unsupported') : item.archived ? t('settings.sessionImport.archived') : '';
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      disabled={disabled}
      onClick={onToggle}
      className="grid h-9 w-full grid-cols-[16px_16px_16px_minmax(0,1fr)_auto_84px] items-center gap-x-2.5 px-4 text-left transition-colors duration-[var(--motion-fast)] select-none enabled:hover:bg-[var(--settings-menu-bg-hover)] disabled:cursor-default"
    >
      <CheckBox state={checked ? 'on' : 'off'} disabled={disabled} />
      <span />
      <Tip text={IMPORT_SOURCE_NAMES[item.source]}>
        <span className={cn('flex text-[var(--text-primary)]', disabled && 'opacity-40')}>
          <ImportSourceMark source={item.source} size={16} />
        </span>
      </Tip>
      <span
        title={title}
        className={cn('truncate text-13 leading-[1.38] text-[var(--text-primary)]', disabled && 'text-[var(--text-tertiary)]')}
      >
        {title}
      </span>
      <span className="whitespace-nowrap text-12 text-[var(--text-tertiary)]">{tag}</span>
      <time
        dateTime={isoOf(item.updatedAt)}
        title={formatSidebarTimeAbsolute(isoOf(item.updatedAt))}
        className="whitespace-nowrap text-right text-12 tabular-nums text-[var(--text-tertiary)]"
      >
        {formatSidebarTime(isoOf(item.updatedAt), t)}
      </time>
    </button>
  );
}

function ScanningSkeleton() {
  const { t } = useTranslation();
  const widths = [62, 48, 70, 40, 56, 66, 44, 52];
  return (
    <>
      <div className="flex shrink-0 items-center gap-2 border-b border-[var(--settings-input-border)] px-4 py-3">
        <span className="ml-auto inline-flex items-center gap-2 text-12 text-[var(--text-tertiary)]">
          <Spinner size={14} />
          {t('settings.sessionImport.scanning')}
        </span>
      </div>
      <div className="flex flex-col" aria-hidden>
        {widths.map((w, i) => (
          <div key={i} className="flex h-9 items-center gap-2.5 px-4">
            <i className="block h-4 w-4 rounded-[4px] bg-[var(--surface-chip)]" />
            <i className="block h-2.5 rounded-full bg-[var(--surface-chip)]" style={{ width: w * 4 }} />
            <i className="ml-auto block h-2.5 w-14 rounded-full bg-[var(--surface-chip)]" />
          </div>
        ))}
      </div>
    </>
  );
}

function ScanFailed({ onRetry }: { onRetry: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 px-6 py-10 text-center">
      <p className="text-13 leading-[1.5] text-[var(--text-secondary)]">{t('settings.sessionImport.scanFailed')}</p>
      <Button variant="secondary" size="md" type="button" onClick={onRetry}>
        <RefreshCw size={14} />
        {t('settings.sessionImport.rescan')}
      </Button>
    </div>
  );
}

function EmptyState({ onRescan, scanning }: { onRescan: () => void; scanning: boolean }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 px-6 py-10 text-center">
      <p className="text-14 font-medium leading-[1.43] text-[var(--text-primary)]">{t('settings.sessionImport.emptyTitle')}</p>
      <p className="max-w-[440px] text-13 leading-[1.5] text-[var(--text-secondary)]">{t('settings.sessionImport.emptyDescription')}</p>
      <div className="mt-1 grid grid-cols-[repeat(3,max-content)] justify-center gap-x-8 gap-y-2.5">
        {IMPORT_SOURCE_IDS.map((id) => (
          <div key={id} className="flex items-center gap-2 whitespace-nowrap text-13 leading-[1.38] text-[var(--text-secondary)]">
            <ImportSourceMark source={id} size={16} />
            {IMPORT_SOURCE_NAMES[id]}
          </div>
        ))}
      </div>
      <Button variant="secondary" size="md" type="button" loading={scanning} onClick={onRescan} className="mt-2">
        <RefreshCw size={14} />
        {t('settings.sessionImport.rescan')}
      </Button>
    </div>
  );
}

function ImportJobPanel({
  job,
  onStop,
  onDone,
  onRetry,
  onOpen,
}: {
  job: ImportJobView;
  onStop: () => void;
  onDone: () => void;
  onRetry: (key: string) => void;
  onOpen: (sessionId: string) => void;
}) {
  const { t } = useTranslation();
  const [readyOpen, setReadyOpen] = useState(false);
  const [relocated, setRelocated] = useState<Set<string>>(() => new Set());
  const running = job.status === 'running';
  const items = useMemo(
    () => job.items.map((it) => (relocated.has(it.key) && it.status === 'action' ? { ...it, status: 'ready' as const, issue: null } : it)),
    [job.items, relocated],
  );
  const total = items.length;
  const finished = items.filter((it) => it.status !== 'queued' && it.status !== 'running').length;
  const count = (s: ImportItemView['status']) => items.filter((it) => it.status === s).length;

  const relocate = useCallback(async (item: ImportItemView) => {
    if (!item.sessionId) return;
    const picked = await window.electronAPI.showOpenDirectoryDialog();
    if (picked.canceled || !picked.path) return;
    try {
      await window.electronAPI.localDb.sessionImport.relocate(item.sessionId, picked.path);
      setRelocated((prev) => new Set(prev).add(item.key));
      emitRefresh();
    } catch {
      toast.error(t('settings.sessionImport.result.relocateFailed'));
    }
  }, [t]);

  const row = (it: ImportItemView) => (
    <JobRow
      key={it.key}
      item={it}
      running={running}
      onRetry={() => onRetry(it.key)}
      onRelocate={() => void relocate(it)}
      onOpen={() => it.sessionId && onOpen(it.sessionId)}
    />
  );

  let rows: React.ReactNode;
  if (running) {
    rows = items.map(row);
  } else {
    const order: Record<string, number> = { action: 0, failed: 1, cancelled: 2, ready: 3 };
    const sorted = [...items].sort((a, b) => (order[a.status] ?? 4) - (order[b.status] ?? 4));
    const ready = sorted.filter((it) => it.status === 'ready');
    const rest = sorted.filter((it) => it.status !== 'ready');
    rows = (
      <>
        {rest.map(row)}
        {ready.length > READY_COLLAPSE_AT ? (
          <>
            <button
              type="button"
              aria-expanded={readyOpen}
              onClick={() => setReadyOpen((v) => !v)}
              className={cn(
                'flex h-11 w-full items-center gap-2 px-4 text-13 font-medium text-[var(--text-secondary)] select-none hover:bg-[var(--settings-menu-bg-hover)]',
                rest.length > 0 && 'border-t border-[var(--settings-input-border)]',
              )}
            >
              <ChevronRight
                size={14}
                aria-hidden
                className={cn('text-[var(--text-tertiary)] transition-transform duration-[var(--motion-fast)] ease-[var(--motion-ease-move)]', readyOpen && 'rotate-90')}
              />
              <CircleCheck size={14} className="text-[var(--status-success)]" aria-hidden />
              {t('settings.sessionImport.result.readyGroup', { count: ready.length })}
            </button>
            <Collapse open={readyOpen}>{ready.map(row)}</Collapse>
          </>
        ) : (
          ready.map(row)
        )}
      </>
    );
  }

  const ready = count('ready');
  const action = count('action');
  const failed = count('failed');
  const imported = ready + action;

  return (
    <>
      <div className="flex shrink-0 flex-col gap-2.5 border-b border-[var(--settings-input-border)] p-4">
        {running ? (
          <>
            <div className="flex items-baseline justify-between gap-4">
              <span className="text-14 font-medium leading-[1.43] text-[var(--text-primary)]">
                {t('settings.sessionImport.progress.title', { count: total })}
              </span>
              <span className="text-12 tabular-nums text-[var(--text-tertiary)]">{finished} / {total}</span>
            </div>
            <div
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={total}
              aria-valuenow={finished}
              className="h-1 overflow-hidden rounded-full bg-[var(--surface-chip)]"
            >
              <i
                className="block h-full origin-left rounded-full bg-[var(--text-secondary)] transition-transform duration-[var(--motion-enter)] ease-[var(--motion-ease-move)]"
                style={{ transform: `scaleX(${total ? finished / total : 0})` }}
              />
            </div>
          </>
        ) : (
          <>
            <span className="text-14 font-medium leading-[1.43] text-[var(--text-primary)]">
              {job.status === 'cancelled' && imported === 0
                ? t('settings.sessionImport.result.stoppedTitle')
                : t('settings.sessionImport.result.title', { count: imported })}
            </span>
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-13 leading-[1.46] text-[var(--text-secondary)]">
              {ready > 0 && (
                <span className="inline-flex items-center gap-1.5">
                  <CircleCheck size={14} className="text-[var(--status-success)]" aria-hidden />
                  {t('settings.sessionImport.result.ready', { count: ready })}
                </span>
              )}
              {action > 0 && (
                <span className="inline-flex items-center gap-1.5">
                  <TriangleAlert size={14} className="text-[var(--warning-fg)]" aria-hidden />
                  {t('settings.sessionImport.result.action', { count: action })}
                </span>
              )}
              {failed > 0 && (
                <span className="inline-flex items-center gap-1.5">
                  <CircleX size={14} className="text-[var(--error-fg)]" aria-hidden />
                  {t('settings.sessionImport.result.failed', { count: failed })}
                </span>
              )}
            </div>
          </>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]">{rows}</div>
      <footer className="flex h-14 shrink-0 items-center justify-between gap-3 border-t border-[var(--settings-input-border)] px-4 select-none">
        <span className="min-w-0 truncate text-13 text-[var(--text-secondary)]">
          {running ? t('settings.sessionImport.progress.background') : ''}
        </span>
        {running ? (
          <Button variant="secondary" size="lg" type="button" onClick={onStop}>
            {t('settings.sessionImport.progress.stop')}
          </Button>
        ) : (
          <Button variant="cta" size="lg" type="button" onClick={onDone}>
            {t('settings.sessionImport.result.done')}
          </Button>
        )}
      </footer>
    </>
  );
}

function JobRow({
  item,
  running,
  onRetry,
  onRelocate,
  onOpen,
}: {
  item: ImportItemView;
  running: boolean;
  onRetry: () => void;
  onRelocate: () => void;
  onOpen: () => void;
}) {
  const { t } = useTranslation();
  const openable = !running && item.status === 'ready' && !!item.sessionId;
  let icon: React.ReactNode;
  let line: string;
  if (item.status === 'queued') {
    icon = <Clock size={14} className="text-[var(--text-tertiary)]" aria-hidden />;
    line = t('settings.sessionImport.progress.queued');
  } else if (item.status === 'running') {
    icon = <Spinner size={14} className="text-[var(--text-tertiary)]" />;
    line = item.step === 'copy'
      ? t('settings.sessionImport.progress.copy')
      : item.step === 'verify'
        ? t('settings.sessionImport.progress.verify')
        : t('settings.sessionImport.progress.messages', { count: item.messagesWritten });
  } else if (item.status === 'action') {
    icon = <TriangleAlert size={14} className="text-[var(--warning-fg)]" aria-hidden />;
    line = t('settings.sessionImport.result.missingDir');
  } else if (item.status === 'failed') {
    icon = <CircleX size={14} className="text-[var(--error-fg)]" aria-hidden />;
    line = t(`settings.sessionImport.failure.${item.issue ?? 'read-failed'}`);
  } else if (item.status === 'cancelled') {
    icon = <Minus size={14} className="text-[var(--text-tertiary)]" aria-hidden />;
    line = t('settings.sessionImport.result.cancelled');
  } else {
    icon = <CircleCheck size={14} className="text-[var(--status-success)]" aria-hidden />;
    const harness = HARNESS_LABEL[item.harness ?? 'cc'];
    line = item.mode === 'native'
      ? t('settings.sessionImport.result.readyNative', { harness })
      : t('settings.sessionImport.result.readyHandoff', { harness });
  }

  const content = (
    <>
      <span className="mt-px flex text-[var(--text-primary)]"><ImportSourceMark source={item.source} size={16} /></span>
      <div className="min-w-0">
        <div className="truncate text-13 font-medium leading-[1.38] text-[var(--text-primary)]">
          {item.title || t('settings.sessionImport.untitled')}
        </div>
        <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-12 leading-[1.33] text-[var(--text-secondary)]">
          {icon}
          <span className="truncate tabular-nums">{line}</span>
        </div>
      </div>
    </>
  );

  const rowClass = 'grid min-h-14 w-full grid-cols-[16px_minmax(0,1fr)_auto] items-center gap-x-3 border-b border-[var(--settings-input-border)] px-4 py-2.5 text-left last:border-b-0';
  if (openable) {
    return (
      <button type="button" onClick={onOpen} className={cn(rowClass, 'group transition-colors duration-[var(--motion-fast)] hover:bg-[var(--settings-menu-bg-hover)]')}>
        {content}
        <span className="inline-flex items-center gap-1 text-12 text-[var(--text-tertiary)] opacity-0 transition-opacity duration-[var(--motion-fast)] group-hover:opacity-100 group-focus-visible:opacity-100">
          {t('settings.sessionImport.result.open')}
          <ArrowRight size={14} aria-hidden />
        </span>
      </button>
    );
  }
  return (
    <div className={rowClass}>
      {content}
      {!running && item.status === 'action' && item.sessionId && (
        <Button variant="secondary" size="sm" type="button" onClick={onRelocate}>
          <FolderOpen size={14} />
          {t('settings.sessionImport.result.chooseFolder')}
        </Button>
      )}
      {!running && item.status === 'failed' && item.issue !== 'unsupported-version' && item.issue !== 'empty' && (
        <Button variant="secondary" size="sm" type="button" onClick={onRetry}>
          <RotateCw size={14} />
          {t('settings.sessionImport.result.retry')}
        </Button>
      )}
    </div>
  );
}
