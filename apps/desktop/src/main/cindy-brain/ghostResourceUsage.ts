import { app, session, webContents, type Session } from 'electron';
import type { GhostResourceUsageResult } from '../../shared/ghost.js';
import type { ActiveAppSession } from '../appSessionState.js';
import { readLocalMachineStatus } from '../machines/localStatus.js';
import { throwIpcError } from '../utils/ipcValidate.js';
import { ownerScopedGhostPartitionForInstalledGhost } from './ghostWebviewPartition.js';

type Target = Parameters<typeof ownerScopedGhostPartitionForInstalledGhost>[0] & {
  enabled: boolean;
};
interface Ports {
  findGhost(id: string): Target | null;
  readOwner(): ActiveAppSession;
  ghostIdForLogicWebContents(id: number): string | null;
}
interface PageProcess {
  session: Session;
  pid: number;
  type: string;
  logicId: string | null;
}

const CACHE_MS = 1_000;
const measured = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;

/** Shared sampling is bounded to one snapshot; plugin totals are never cached across callers. */
export function createGhostResourceUsageReader(ports: Ports) {
  async function sample() {
    const machine = await readLocalMachineStatus().catch(() => null);
    let metrics: ReturnType<typeof app.getAppMetrics> | null = null;
    try {
      metrics = app.getAppMetrics();
    } catch {
      /* Missing process metrics remain null. */
    }
    const pages: PageProcess[] = [];
    let pagesComplete = true;
    try {
      for (const page of webContents.getAllWebContents()) {
        if (page.isDestroyed()) continue;
        try {
          pages.push({
            session: page.session,
            pid: page.getOSProcessId(),
            type: page.getType(),
            logicId: ports.ghostIdForLogicWebContents(page.id),
          });
        } catch {
          pagesComplete = false;
        }
      }
    } catch {
      pagesComplete = false;
    }
    return {
      capturedAt: new Date().toISOString(),
      sampledAt: Date.now(),
      machine,
      metrics,
      pages,
      pagesComplete,
    };
  }
  type Snapshot = Awaited<ReturnType<typeof sample>>;
  let cached: Snapshot | null = null;
  let pending: Promise<Snapshot> | null = null;
  function snapshot(): Promise<Snapshot> {
    if (cached && Date.now() - cached.sampledAt < CACHE_MS) return Promise.resolve(cached);
    if (!pending) {
      pending = sample()
        .then((result) => {
          cached = result;
          return result;
        })
        .finally(() => {
          pending = null;
        });
    }
    return pending;
  }

  return async (
    id: string,
    kind: unknown,
    isCurrent: () => boolean,
  ): Promise<GhostResourceUsageResult> => {
    if (kind !== 'resource-usage') throwIpcError('INVALID_PARAMS', '未知的宿主请求类型');
    const owner = ports.readOwner();
    const ghost = ports.findGhost(id);
    const partition = ghost?.enabled
      ? ownerScopedGhostPartitionForInstalledGhost(ghost, owner)
      : null;
    if (!partition || !isCurrent()) throwIpcError('PERMISSION_DENIED', '插件资源请求已失效');
    const pluginSession = session.fromPartition(partition);
    const data = await snapshot();
    const currentOwner = ports.readOwner();
    const currentGhost = ports.findGhost(id);
    if (
      !isCurrent() ||
      currentOwner.mode !== owner.mode ||
      currentOwner.dataOwnerId !== owner.dataOwnerId ||
      currentOwner.generation !== owner.generation ||
      !currentGhost?.enabled ||
      ownerScopedGhostPartitionForInstalledGhost(currentGhost, currentOwner) !== partition
    ) {
      throwIpcError('PERMISSION_DENIED', '插件资源请求已失效');
    }

    const ownPages = data.pages.filter(
      (page) =>
        page.session === pluginSession &&
        (page.logicId === id || (page.logicId === null && page.type === 'webview')),
    );
    const pids = new Set(ownPages.map((page) => page.pid));
    const ownPageSet = new Set(ownPages);
    const attributable =
      data.pagesComplete &&
      ownPages.some((page) => page.logicId === id) &&
      [...pids].every((pid) => Number.isSafeInteger(pid) && pid > 0) &&
      // A shared renderer cannot be apportioned exactly; never return another instance's usage.
      !data.pages.some((page) => pids.has(page.pid) && !ownPageSet.has(page));
    const pluginMetrics = [...pids].map((pid) =>
      data.metrics?.find((metric) => metric.pid === pid),
    );
    const total = (values: (number | null)[]): number | null =>
      values.length > 0 && values.every((value) => value !== null)
        ? measured(values.reduce<number>((sum, value) => sum + value!, 0))
        : null;
    const memoryBytes = (metric: NonNullable<typeof data.metrics>[number] | undefined) => {
      const kb = measured(metric?.memory?.workingSetSize);
      return kb === null ? null : measured(kb * 1024);
    };
    return {
      ok: true,
      capturedAt: data.capturedAt,
      machine: {
        memoryTotalBytes: measured(data.machine?.memory?.totalBytes),
        memoryAvailableBytes: measured(data.machine?.memory?.availableBytes),
        cpuBusyPercent: measured(data.machine?.cpu?.busyPercent),
        cpuLogicalCores: measured(data.machine?.cpu?.logicalCores),
        cpuLoadAverage1m: measured(data.machine?.cpu?.loadAverage1m),
      },
      plugin: {
        memoryBytes: attributable ? total(pluginMetrics.map(memoryBytes)) : null,
        cpuPercent: attributable
          ? total(pluginMetrics.map((metric) => measured(metric?.cpu?.percentCPUUsage)))
          : null,
      },
      gpu: {
        memoryBytes: total(
          (data.metrics ?? []).filter((metric) => metric.type === 'GPU').map(memoryBytes),
        ),
      },
    };
  };
}
