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
import { installedGhostStoragePart } from '../../shared/pluginIdentity';

/** Local task pages only: a remote task must never display the controller's plugins. */
export function PluginTaskStatus({
  sessionId,
  workingDir,
  routeKey = '',
}: {
  sessionId: string;
  workingDir?: string | null;
  routeKey?: string;
}) {
  const ghosts = useInstalledGhosts();
  const disabled = useWorkdirDisabledGhostIds(workingDir, ghosts);
  const eligible = ghosts.filter(
    (g) =>
      g.enabled &&
      g.approval?.state === 'approved' &&
      g.manifest.taskView?.statusBar === true &&
      disabled &&
      !disabled.has(installedGhostStoragePart(g)),
  );
  const eligibleKey = eligible.map(installedGhostStoragePart).join(',');
  const owner = getDataOwnerGeneration();
  const [snapshot, setSnapshot] = useState<{
    sessionId: string;
    workingDir: typeof workingDir;
    routeKey: string;
    owner: typeof owner;
    ghosts: typeof ghosts;
    statuses: GhostTaskStatus[];
  } | null>(null);

  useEffect(() => {
    if (!eligibleKey) return;
    let disposed = false;
    let busy = false;
    const refresh = async () => {
      if (disposed || busy || document.hidden || !isDataOwnerGenerationCurrent(owner)) return;
      busy = true;
      try {
        const statuses = await window.electronAPI.ghosts.taskStatus(sessionId);
        if (!disposed && isDataOwnerGenerationCurrent(owner))
          setSnapshot({ sessionId, workingDir, routeKey, owner, ghosts, statuses });
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
  }, [sessionId, workingDir, routeKey, eligibleKey, ghosts, owner]);

  const statuses =
    snapshot?.sessionId === sessionId &&
    snapshot.ghosts === ghosts &&
    snapshot.workingDir === workingDir &&
    snapshot.routeKey === routeKey &&
    isDataOwnerGenerationCurrent(snapshot.owner)
      ? snapshot.statuses.filter((s) =>
          eligible.some((g) => installedGhostStoragePart(g) === s.instanceId),
        )
      : [];
  if (!statuses.length) return null;
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
