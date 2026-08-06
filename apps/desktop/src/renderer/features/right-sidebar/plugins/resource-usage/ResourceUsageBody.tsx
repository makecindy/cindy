/**
 * ResourceUsageBody —— 「资源用量」tab 的内容区。
 *
 * 视图:两个分区 —— Agent 进程(本产品 spawn 的 claude/codex/pi 树,聚合值,
 * 可结束)与应用进程(Electron 自家 main/renderer/GPU/utility,只读)。
 * 各分区按 CPU 降序。
 *
 * 数据约束:
 *  - 可见(激活 tab 且壳子可见)才订阅;不可见即退订 —— main 侧无订阅者就
 *    完全不采样。同窗口多实例经 subscription.ts 引用计数聚合。
 *  - 数据由 main 周期推送(~2s),本地即时,无 loading 态;首帧到达前渲染
 *    空容器(订阅后 main 立即补推一帧,间隙不可感知)。
 *  - 结束进程:仅 terminable 条目;确认弹窗(destructive)→ IPC → 结果 toast。
 *    归属校验在 main,此处的按钮可见性只是 UX,不是权限边界。
 */

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AppWindow, Bot, Cog, Cpu, PanelsTopLeft, type LucideIcon } from 'lucide-react';

import { cn } from '@/lib/utils';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
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

const KIND_ICON: Record<ProcessUsageEntry['kind'], LucideIcon> = {
  main: AppWindow,
  renderer: PanelsTopLeft,
  gpu: Cpu,
  utility: Cog,
  'agent-claude': Bot,
  'agent-codex': Bot,
  'agent-pi': Bot,
};

/** agent 产品名不是 i18n 资源,固定英文展示(术语表:Agent 保留英文)。 */
const AGENT_NAME: Record<string, string> = {
  'agent-claude': 'Claude Code',
  'agent-codex': 'Codex',
  'agent-pi': 'Pi',
};

function formatCpu(cpuPercent: number): string {
  return `${cpuPercent >= 10 ? Math.round(cpuPercent) : cpuPercent.toFixed(1)}%`;
}

function formatMemory(memoryKb: number): string {
  if (memoryKb >= 1024 * 1024) return `${(memoryKb / 1024 / 1024).toFixed(1)} GB`;
  return `${Math.round(memoryKb / 1024)} MB`;
}

function byCpuDesc(a: ProcessUsageEntry, b: ProcessUsageEntry): number {
  return b.cpuPercent - a.cpuPercent || b.memoryKb - a.memoryKb;
}

function SectionHeader({ label }: { label: string }) {
  return (
    <div className="px-2 pb-1 pt-3 text-11 font-medium uppercase tracking-[0.5px] text-[var(--text-tertiary)]">
      {label}
    </div>
  );
}

function EntryRow({
  entry,
  onTerminate,
}: {
  entry: ProcessUsageEntry;
  onTerminate: (entry: ProcessUsageEntry) => void;
}) {
  const { t } = useTranslation();
  const Icon = KIND_ICON[entry.kind];
  const isAgent = entry.kind.startsWith('agent-');
  const name = isAgent
    ? AGENT_NAME[entry.kind]
    : (entry.label ?? t(`rightSidebar.resourceUsage.kinds.${entry.kind}`));
  const sub = isAgent
    ? t('rightSidebar.resourceUsage.processCount', { count: entry.processCount })
    : entry.label
      ? t(`rightSidebar.resourceUsage.kinds.${entry.kind}`)
      : null;
  return (
    <div className="group flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-[var(--surface-hover)]">
      <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[var(--surface-chip)] text-[var(--text-secondary)]">
        <Icon size={12} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-13 leading-5 text-[var(--text-primary)]">{name}</div>
        {sub && (
          <div className="truncate text-11 leading-4 text-[var(--text-tertiary)]">{sub}</div>
        )}
      </div>
      <span className="shrink-0 text-11 tabular-nums leading-4 text-[var(--text-tertiary)]">
        {formatCpu(entry.cpuPercent)} · {formatMemory(entry.memoryKb)}
      </span>
      {entry.terminable && (
        <button
          type="button"
          onClick={() => onTerminate(entry)}
          className={cn(
            'inline-flex shrink-0 items-center rounded-full border border-[var(--border-default)] px-2 py-0.5',
            'text-11 leading-4 text-[var(--text-secondary)] transition-colors',
            'opacity-0 focus-visible:opacity-100 group-hover:opacity-100',
            'hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]',
          )}
        >
          {t('rightSidebar.resourceUsage.terminate')}
        </button>
      )}
    </div>
  );
}

export function ResourceUsageBody({
  active,
  shellVisible,
}: {
  state: ResourceUsageState;
  ctx: TabKindHostContext;
  active?: boolean;
  shellVisible?: boolean;
}) {
  const { t } = useTranslation();
  const visible = (active ?? true) && (shellVisible ?? true);
  const [sample, setSample] = useState<ProcessMonitorSample | null>(null);
  const [pendingKill, setPendingKill] = useState<ProcessUsageEntry | null>(null);
  const [killing, setKilling] = useState(false);

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

  const agents = (sample?.entries ?? []).filter((e) => e.kind.startsWith('agent-')).sort(byCpuDesc);
  const app = (sample?.entries ?? []).filter((e) => !e.kind.startsWith('agent-')).sort(byCpuDesc);

  const confirmTarget = pendingKill ? (AGENT_NAME[pendingKill.kind] ?? '') : '';

  const handleConfirmTerminate = async () => {
    if (!pendingKill || killing) return;
    setKilling(true);
    try {
      await window.electronAPI.processMonitor.terminate(pendingKill.pid);
      toast.success(t('rightSidebar.resourceUsage.terminated', { name: confirmTarget }));
    } catch {
      // 典型失败:进程已自行退出(NOT_FOUND)。下一帧推送会自动纠正列表,
      // 文案只说事实与下一步,不区分错误细类。
      toast.error(t('rightSidebar.resourceUsage.terminateFailed'));
    } finally {
      setKilling(false);
      setPendingKill(null);
    }
  };

  return (
    <div className="h-full select-none overflow-y-auto px-2 py-1">
      {agents.length > 0 && (
        <>
          <SectionHeader label={t('rightSidebar.resourceUsage.sections.agents')} />
          {agents.map((entry) => (
            <EntryRow key={entry.pid} entry={entry} onTerminate={setPendingKill} />
          ))}
        </>
      )}
      {sample && agents.length === 0 && (
        <>
          <SectionHeader label={t('rightSidebar.resourceUsage.sections.agents')} />
          <div className="px-2 py-1.5 text-12 leading-5 text-[var(--text-tertiary)]">
            {t('rightSidebar.resourceUsage.agentsEmpty')}
          </div>
        </>
      )}
      {app.length > 0 && (
        <>
          <SectionHeader label={t('rightSidebar.resourceUsage.sections.app')} />
          {app.map((entry) => (
            <EntryRow key={entry.pid} entry={entry} onTerminate={setPendingKill} />
          ))}
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
