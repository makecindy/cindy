import { Button } from '@/components/ui/button';
/** 「资源用量」：单层紧凑进程表，数据与终止授权均由 main 提供。 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import {
  AppWindow,
  ArrowDown,
  ArrowUp,
  Bot,
  Cog,
  Cpu,
  PanelsTopLeft,
  ServerOff,
  type LucideIcon,
} from 'lucide-react';

import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { Spinner } from '@/components/ui/spinner';
import { toast } from '@/components/ui/toast';
import type {
  ProcessMonitorSample,
  ProcessUsageEntry,
} from '../../../../../shared/processMonitor';
import type { TabKindHostContext } from '../../types';
import { HostDaemonsView } from './HostDaemonsView';
import type { ResourceUsageState } from './index';
import {
  acquireProcessMonitorSubscription,
  releaseProcessMonitorSubscription,
} from './subscription';
import './resource-usage.css';

type SortKey = 'name' | 'cpu' | 'memory' | 'pid';
type SortDirection = 'asc' | 'desc';
/** 进程表 / 本机常驻清单。常驻清单是全局数据，与当前会话无关。 */
type ViewKind = 'processes' | 'hostDaemons';

const KIND_ICON: Record<ProcessUsageEntry['kind'], LucideIcon> = {
  main: AppWindow,
  renderer: PanelsTopLeft,
  gpu: Cpu,
  utility: Cog,
  'agent-claude': Bot,
  'agent-codex': Bot,
  'agent-pi': Bot,
};

const AGENT_NAME: Record<string, string> = {
  'agent-claude': 'Claude Code',
  'agent-codex': 'Codex',
  'agent-pi': 'Pi',
};

const UTILITY_LABEL_KEY: Record<string, string> = {
  'audio.mojom.AudioService': 'audio',
  'network.mojom.NetworkService': 'network',
  'storage.mojom.StorageService': 'storage',
  'video_capture.mojom.VideoCaptureService': 'videoCapture',
};

function formatCpu(cpuPercent: number): string {
  return `${cpuPercent >= 10 ? Math.round(cpuPercent) : cpuPercent.toFixed(1)}%`;
}

function formatMemory(memoryKb: number): string {
  if (memoryKb >= 1024 * 1024) return `${(memoryKb / 1024 / 1024).toFixed(1)} GB`;
  return `${Math.round(memoryKb / 1024)} MB`;
}

function entryName(entry: ProcessUsageEntry, t: TFunction): string {
  if (entry.kind === 'agent-codex') {
    if (entry.agentRole === 'task-host') {
      return t('rightSidebar.resourceUsage.agentRoles.codexTask');
    }
    if (entry.agentRole === 'control-plane-service') {
      return t('rightSidebar.resourceUsage.agentRoles.codexService');
    }
  }
  if (entry.kind.startsWith('agent-')) return AGENT_NAME[entry.kind] ?? 'Agent';
  if (entry.kind === 'utility' && entry.label) {
    const serviceKey = UTILITY_LABEL_KEY[entry.label];
    if (serviceKey) return t(`rightSidebar.resourceUsage.services.${serviceKey}`);
  }
  return entry.label ?? t(`rightSidebar.resourceUsage.kinds.${entry.kind}`);
}

function entryDetails(entry: ProcessUsageEntry, t: TFunction): string | null {
  if (entry.kind.startsWith('agent-')) {
    // 单根进程是常态，不重复陈述“1 个进程”；只有实际出现子进程时才提示
    // 进程树规模。CPU / 内存始终是完整树汇总，与此展示取舍无关。
    const processCount = entry.processCount > 1
      ? t('rightSidebar.resourceUsage.processCount', { count: entry.processCount })
      : null;
    // 归属任务标题（main 采样时解析）与角色/树规模并列；多任务并行时用户
    // 靠它区分同名的 Pi / Claude Code 行。
    const parts = [
      entry.sessionLabel
        ? t('rightSidebar.resourceUsage.sessionDetail', { title: entry.sessionLabel })
        : null,
      entry.agentRole === 'task-host'
        ? t('rightSidebar.resourceUsage.agentRoleDetails.task')
        : null,
      entry.agentRole === 'control-plane-service'
        ? t('rightSidebar.resourceUsage.agentRoleDetails.service')
        : null,
      processCount,
    ].filter((part): part is string => part !== null);
    return parts.length > 0 ? parts.join(' · ') : null;
  }
  return entry.label ? t(`rightSidebar.resourceUsage.kinds.${entry.kind}`) : null;
}

function compareEntries(
  a: ProcessUsageEntry,
  b: ProcessUsageEntry,
  key: SortKey,
  direction: SortDirection,
  t: TFunction,
): number {
  let value = 0;
  if (key === 'name') value = entryName(a, t).localeCompare(entryName(b, t));
  if (key === 'cpu') value = a.cpuPercent - b.cpuPercent;
  if (key === 'memory') value = a.memoryKb - b.memoryKb;
  if (key === 'pid') value = a.pid - b.pid;
  if (value === 0) value = a.pid - b.pid;
  return direction === 'asc' ? value : -value;
}

function SortHeader({
  column,
  label,
  activeKey,
  direction,
  className,
  onSort,
}: {
  column: SortKey;
  label: string;
  activeKey: SortKey;
  direction: SortDirection;
  className?: string;
  onSort: (key: SortKey) => void;
}) {
  const { t } = useTranslation();
  const active = column === activeKey;
  const Icon = direction === 'asc' ? ArrowUp : ArrowDown;
  return (
    <div
      role="columnheader"
      aria-sort={active ? (direction === 'asc' ? 'ascending' : 'descending') : 'none'}
      className={className}
    >
      <button
        type="button"
        className="resource-usage-sort-button"
        aria-label={t('rightSidebar.resourceUsage.sortBy', { column: label })}
        onClick={() => onSort(column)}
      >
        <span>{label}</span>
        {active ? <Icon aria-hidden size={10} strokeWidth={1.75} /> : null}
      </button>
    </div>
  );
}

function SectionHeader({ label }: { label: string }) {
  return <div className="resource-usage-section">{label}</div>;
}

function EntryRow({
  entry,
  selected,
  onSelect,
}: {
  entry: ProcessUsageEntry;
  selected: boolean;
  onSelect: (entry: ProcessUsageEntry) => void;
}) {
  const { t } = useTranslation();
  const Icon = KIND_ICON[entry.kind];
  const name = entryName(entry, t);
  const details = entryDetails(entry, t);
  const select = () => onSelect(entry);
  return (
    <div
      role="row"
      tabIndex={0}
      aria-selected={selected}
      className="resource-usage-row resource-usage-grid"
      data-selected={selected ? 'true' : 'false'}
      data-kind={entry.kind}
      data-agent-role={entry.agentRole}
      onClick={select}
      onKeyDown={(event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        select();
      }}
    >
      <div role="cell" className="resource-usage-name-cell">
        <Icon className="resource-usage-icon" aria-hidden size={14} strokeWidth={1.6} />
        <div className="resource-usage-name-copy">
          <div className="resource-usage-name" title={name}>{name}</div>
          {details ? (
            <div className="resource-usage-details" title={details}>
              <span>{details}</span>
              <span className="resource-usage-pid-inline"> · PID {entry.pid}</span>
            </div>
          ) : (
            <div className="resource-usage-details resource-usage-pid-only">
              PID {entry.pid}
            </div>
          )}
        </div>
      </div>
      <div role="cell" className="resource-usage-number">{formatCpu(entry.cpuPercent)}</div>
      <div role="cell" className="resource-usage-number">{formatMemory(entry.memoryKb)}</div>
      <div role="cell" className="resource-usage-number resource-usage-pid">{entry.pid}</div>
    </div>
  );
}

function LocalResourceUsageBody({
  active,
  shellVisible,
  onFirstSample,
}: {
  state: ResourceUsageState;
  active?: boolean;
  shellVisible?: boolean;
  onFirstSample?: () => void;
}) {
  const { t } = useTranslation();
  const visible = (active ?? true) && (shellVisible ?? true);
  const firstSampleReportedRef = useRef(false);
  const [sample, setSample] = useState<ProcessMonitorSample | null>(null);
  const [selectedPid, setSelectedPid] = useState<number | null>(null);
  const [pendingKill, setPendingKill] = useState<ProcessUsageEntry | null>(null);
  const [killing, setKilling] = useState(false);
  const [sort, setSort] = useState<{ key: SortKey; direction: SortDirection }>({
    key: 'cpu',
    direction: 'desc',
  });
  const [view, setView] = useState<ViewKind>('processes');
  // 旧右侧栏页签窗口的 preload 没有常驻清单桥（面板正式入口是独立资源监视器窗口）。
  const hostDaemonsAvailable = typeof window.electronAPI.hostDaemons?.list === 'function';
  // 切到常驻清单就放开进程采样订阅：看不到的列表不需要继续 2s 一次采样。
  const processVisible = visible && view === 'processes';

  // 「本机常驻」不需要进程快照，界面一挂上就能展示：用它当作首屏，否则窗口要等
  // 一份永远不来的进程采样，打开时白白空等主进程的兜底超时。
  useEffect(() => {
    if (view !== 'hostDaemons' || !visible) return;
    onFirstSample?.();
  }, [view, visible, onFirstSample]);

  useEffect(() => {
    if (!processVisible) return;
    let disposed = false;
    const offSample = window.electronAPI.processMonitor.onSample((next) => {
      if (!disposed) setSample(next);
    });
    acquireProcessMonitorSubscription();
    return () => {
      disposed = true;
      offSample();
      releaseProcessMonitorSubscription();
    };
  }, [processVisible]);

  useEffect(() => {
    if (visible) return;
    setSelectedPid(null);
    setPendingKill(null);
  }, [visible]);

  useEffect(() => {
    if (sample === null || firstSampleReportedRef.current) return;
    firstSampleReportedRef.current = true;
    onFirstSample?.();
  }, [onFirstSample, sample]);

  useEffect(() => {
    if (selectedPid == null || !sample) return;
    if (!sample.entries.some((entry) => entry.pid === selectedPid)) setSelectedPid(null);
  }, [sample, selectedPid]);

  const sortedEntries = useMemo(() => {
    const entries = sample?.entries ?? [];
    const sorter = (a: ProcessUsageEntry, b: ProcessUsageEntry) =>
      compareEntries(a, b, sort.key, sort.direction, t);
    return {
      agents: entries.filter((entry) => entry.kind.startsWith('agent-')).sort(sorter),
      app: entries.filter((entry) => !entry.kind.startsWith('agent-')).sort(sorter),
    };
  }, [sample, sort, t]);

  const selected = sample?.entries.find((entry) => entry.pid === selectedPid) ?? null;
  const confirmTarget = pendingKill ? entryName(pendingKill, t) : '';

  const handleSort = (key: SortKey) => {
    setSort((current) => ({
      key,
      direction:
        current.key === key
          ? current.direction === 'asc' ? 'desc' : 'asc'
          : key === 'name' ? 'asc' : 'desc',
    }));
  };

  const handleConfirmTerminate = async () => {
    if (!pendingKill?.processInstanceId || killing) return;
    setKilling(true);
    try {
      await window.electronAPI.processMonitor.terminate({
        pid: pendingKill.pid,
        processInstanceId: pendingKill.processInstanceId,
      });
      toast.success(t('rightSidebar.resourceUsage.terminated', { name: confirmTarget }));
    } catch {
      toast.error(t('rightSidebar.resourceUsage.terminateFailed'));
    } finally {
      setKilling(false);
      setPendingKill(null);
    }
  };

  const actionHint = !selected
    ? t('rightSidebar.resourceUsage.selectHint')
    : selected.terminable
      ? `${entryName(selected, t)} · PID ${selected.pid}`
      : t('rightSidebar.resourceUsage.readOnlyHint');

  return (
    <div className="resource-usage-root" data-view={view}>
      <div className="resource-usage-switch">
        <SegmentedControl<ViewKind>
          aria-label={t('rightSidebar.resourceUsage.tabs.label')}
          role="tablist"
          height={26}
          optionHeight={22}
          value={view}
          options={[
            { value: 'processes', label: t('rightSidebar.resourceUsage.tabs.processes') },
            ...(hostDaemonsAvailable
              ? [{ value: 'hostDaemons' as const, label: t('rightSidebar.resourceUsage.tabs.hostDaemons') }]
              : []),
          ]}
          onValueChange={setView}
        />
      </div>
      {view === 'hostDaemons' ? (
        <HostDaemonsView />
      ) : (
        <>
      <div
        className="resource-usage-table"
        role="table"
        aria-label={t('rightSidebar.resourceUsage.tableLabel')}
      >
        <div role="row" className="resource-usage-header resource-usage-grid">
        <SortHeader
          column="name"
          label={t('rightSidebar.resourceUsage.columns.process')}
          activeKey={sort.key}
          direction={sort.direction}
          onSort={handleSort}
        />
        <SortHeader
          column="cpu"
          label={t('rightSidebar.resourceUsage.columns.cpu')}
          activeKey={sort.key}
          direction={sort.direction}
          className="resource-usage-header-number"
          onSort={handleSort}
        />
        <SortHeader
          column="memory"
          label={t('rightSidebar.resourceUsage.columns.memory')}
          activeKey={sort.key}
          direction={sort.direction}
          className="resource-usage-header-number"
          onSort={handleSort}
        />
        <SortHeader
          column="pid"
          label={t('rightSidebar.resourceUsage.columns.pid')}
          activeKey={sort.key}
          direction={sort.direction}
          className="resource-usage-header-number resource-usage-pid"
          onSort={handleSort}
        />
        </div>

        <div role="rowgroup" className="resource-usage-body">
        {sample === null ? (
          <div className="resource-usage-loading">
            <Spinner size={13} />
            <span>{t('rightSidebar.resourceUsage.loading')}</span>
          </div>
        ) : (
          <>
            <SectionHeader label={t('rightSidebar.resourceUsage.sections.agents')} />
            {sortedEntries.agents.length > 0 ? sortedEntries.agents.map((entry) => (
              <EntryRow
                key={entry.pid}
                entry={entry}
                selected={selectedPid === entry.pid}
                onSelect={(next) => setSelectedPid(next.pid)}
              />
            )) : (
              <div className="resource-usage-empty">
                {t('rightSidebar.resourceUsage.agentsEmpty')}
              </div>
            )}
            {sortedEntries.app.length > 0 ? (
              <>
                <SectionHeader label={t('rightSidebar.resourceUsage.sections.app')} />
                {sortedEntries.app.map((entry) => (
                  <EntryRow
                    key={entry.pid}
                    entry={entry}
                    selected={selectedPid === entry.pid}
                    onSelect={(next) => setSelectedPid(next.pid)}
                  />
                ))}
              </>
            ) : null}
          </>
        )}
        </div>
      </div>

      <div className="resource-usage-footer">
        <div className="resource-usage-action-hint" title={actionHint}>{actionHint}</div>
        <Button
          variant="secondary"
          size="md"
          compact
          type="button"
          disabled={!selected?.terminable}
          onClick={() => {
            if (selected?.terminable) setPendingKill(selected);
          }}
        >
          {t('rightSidebar.resourceUsage.terminate')}
        </Button>
      </div>
        </>
      )}

      <ConfirmDialog
        open={pendingKill !== null}
        onOpenChange={(open) => {
          if (!open && !killing) setPendingKill(null);
        }}
        title={t('rightSidebar.resourceUsage.terminateConfirmTitle', { name: confirmTarget })}
        description={t('rightSidebar.resourceUsage.terminateConfirmDescription')}
        confirmText={t('rightSidebar.resourceUsage.terminate')}
        confirmVariant="destructive"
        loading={killing}
        onConfirm={() => void handleConfirmTerminate()}
      />
    </div>
  );
}

export function ResourceUsageBody({
  ctx,
  ...props
}: {
  state: ResourceUsageState;
  ctx: TabKindHostContext;
  active?: boolean;
  shellVisible?: boolean;
  onFirstSample?: () => void;
}) {
  const { t } = useTranslation();

  // processMonitor only samples this Desktop instance. device-link tasks run on
  // another device, while undefined means ownership is still resolving; both
  // must fail closed instead of briefly exposing this device's processes.
  const isLocalSession = ctx.remoteHostId === null && ctx.deviceLinkDeviceId === null;
  if (!isLocalSession) {
    return (
      <div className="resource-usage-unavailable">
        <ServerOff aria-hidden size={18} strokeWidth={1.6} />
        <div className="resource-usage-unavailable-copy">
          <div className="resource-usage-unavailable-title">
            {t('rightSidebar.resourceUsage.remoteUnavailableTitle')}
          </div>
          <div className="resource-usage-unavailable-description">
            {t('rightSidebar.resourceUsage.remoteUnavailableDescription')}
          </div>
        </div>
      </div>
    );
  }

  return <LocalResourceUsageBody {...props} />;
}
