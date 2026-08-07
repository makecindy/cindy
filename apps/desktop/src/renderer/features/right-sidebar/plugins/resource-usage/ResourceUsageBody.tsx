/** 「资源用量」：单层紧凑进程表，数据与终止授权均由 main 提供。 */

import { useEffect, useMemo, useState } from 'react';
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
import { Spinner } from '@/components/ui/spinner';
import { toast } from '@/components/ui/toast';
import type {
  ProcessMonitorSample,
  ProcessUsageEntry,
} from '../../../../../shared/processMonitor';
import type { TabKindHostContext } from '../../types';
import type { ResourceUsageState } from './index';
import {
  acquireProcessMonitorSubscription,
  releaseProcessMonitorSubscription,
} from './subscription';
import './resource-usage.css';

type SortKey = 'name' | 'cpu' | 'memory' | 'pid';
type SortDirection = 'asc' | 'desc';

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
    if (entry.agentRole === 'task-host') {
      const role = t('rightSidebar.resourceUsage.agentRoleDetails.task');
      return processCount ? `${role} · ${processCount}` : role;
    }
    if (entry.agentRole === 'control-plane-service') {
      const role = t('rightSidebar.resourceUsage.agentRoleDetails.service');
      return processCount ? `${role} · ${processCount}` : role;
    }
    return processCount;
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
            <div className="resource-usage-details">
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
}: {
  state: ResourceUsageState;
  active?: boolean;
  shellVisible?: boolean;
}) {
  const { t } = useTranslation();
  const visible = (active ?? true) && (shellVisible ?? true);
  const [sample, setSample] = useState<ProcessMonitorSample | null>(null);
  const [selectedPid, setSelectedPid] = useState<number | null>(null);
  const [pendingKill, setPendingKill] = useState<ProcessUsageEntry | null>(null);
  const [killing, setKilling] = useState(false);
  const [sort, setSort] = useState<{ key: SortKey; direction: SortDirection }>({
    key: 'cpu',
    direction: 'desc',
  });

  useEffect(() => {
    if (!visible) return;
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
  }, [visible]);

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
    <div className="resource-usage-root">
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
        <button
          type="button"
          className="resource-usage-terminate"
          disabled={!selected?.terminable}
          onClick={() => {
            if (selected?.terminable) setPendingKill(selected);
          }}
        >
          {t('rightSidebar.resourceUsage.terminate')}
        </button>
      </div>

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
