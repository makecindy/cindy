import { useEffect, useState } from 'react';
import type { GhostTaskStatus } from '../../shared/ghostTaskStatus';
import { Button } from '@/components/ui/button';
import { Tip } from '@/components/ui/tooltip';
import {
  getDataOwnerGeneration,
  isDataOwnerGenerationCurrent,
} from '@/contexts/dataOwnerGeneration';
import { openPluginTaskTab } from '@/features/right-sidebar/lib/openPluginTaskTab';
import { useInstalledGhosts } from './useInstalledGhosts';
import { useWorkdirDisabledGhostIds } from './ghostWorkdirFilter';
import { ghostInstallApprovalToken } from '../../shared/ghost';
import { installedGhostStoragePart } from '../../shared/pluginIdentity';

/** Local task pages only: a remote task must never display the controller's plugins. */
export function PluginTaskStatus({
  sessionId,
  workingDir,
  routeKey = '',
  sidebarTargetSessionId,
}: {
  sessionId: string;
  workingDir?: string | null;
  routeKey?: string;
  /** 侧栏实际所属的任务;内嵌在他人侧栏里的会话与 sessionId 不同。 */
  sidebarTargetSessionId?: string | null;
}) {
  const ghosts = useInstalledGhosts();
  const disabled = useWorkdirDisabledGhostIds(workingDir, ghosts);
  const eligible = ghosts.filter(
    (g) =>
      g.enabled &&
      g.approval?.state === 'approved' &&
      g.taskStatusCapabilityApproved === true &&
      g.manifest.taskView?.statusBar === true &&
      disabled &&
      !disabled.has(installedGhostStoragePart(g)),
  );
  // 只按真正影响查询的字段重算:实例 + 批准版本(含 state)。其它插件的 OAuth 角标
  // 等投影更新会换掉整个 ghosts 数组,但不该重置轮询、也不该让已有状态在回复前消失。
  const eligibleKey = eligible
    .map((g) => `${installedGhostStoragePart(g)}=${ghostInstallApprovalToken(g.approval)}`)
    .join(',');
  // 内嵌在他人侧栏里的会话(Orca worker、侧聊)打开的是宿主任务的页签桶,状态入口
  // 点了看不到插件任务页,这里先不显示。
  const opensIntoOwnSidebar = !sidebarTargetSessionId || sidebarTargetSessionId === sessionId;
  const owner = getDataOwnerGeneration();
  const [snapshot, setSnapshot] = useState<{
    sessionId: string;
    workingDir: typeof workingDir;
    routeKey: string;
    owner: typeof owner;
    eligibleKey: string;
    statuses: GhostTaskStatus[];
  } | null>(null);

  useEffect(() => {
    if (!eligibleKey || !opensIntoOwnSidebar) return;
    let disposed = false;
    let busy = false;
    const refresh = async () => {
      if (disposed || busy || document.hidden || !isDataOwnerGenerationCurrent(owner)) return;
      busy = true;
      try {
        const statuses = await window.electronAPI.ghosts.taskStatus(sessionId);
        if (!disposed && isDataOwnerGenerationCurrent(owner))
          setSnapshot({ sessionId, workingDir, routeKey, owner, eligibleKey, statuses });
      } catch {
        if (!disposed) setSnapshot(null);
      } finally {
        busy = false;
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 30_000);
    const onVisibility = () => {
      if (!document.hidden) void refresh();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      disposed = true;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [sessionId, workingDir, routeKey, eligibleKey, owner, opensIntoOwnSidebar]);

  const statuses =
    snapshot?.sessionId === sessionId &&
    snapshot.eligibleKey === eligibleKey &&
    snapshot.workingDir === workingDir &&
    snapshot.routeKey === routeKey &&
    isDataOwnerGenerationCurrent(snapshot.owner)
      ? snapshot.statuses.filter((s) =>
          eligible.some((g) => installedGhostStoragePart(g) === s.instanceId),
        )
      : [];
  if (!statuses.length || !opensIntoOwnSidebar) return null;
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1">
      {statuses.map((status) => (
        <Tip key={status.instanceId} text={status.tooltip || status.name} side="top">
          <Button
            size="xxs"
            tone="quiet"
            compact
            className="max-w-full"
            onClick={() => {
              if (isDataOwnerGenerationCurrent(owner))
                void openPluginTaskTab(sessionId, status.instanceId, { userInitiated: true });
            }}
          >
            <span
              className="truncate"
              title={status.name + (status.label ? ': ' + status.label : '')}
            >
              {status.name}
              {status.label ? ': ' + status.label : ''}
            </span>
          </Button>
        </Tip>
      ))}
    </div>
  );
}
