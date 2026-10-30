import { handleListDevices, defaultDeps as deviceDirectoryDeps } from '../device-link/ipc.js';
import { getReceivedShares, providerShareAgentDeviceId } from '../device-link/providerShareGuest.js';
import { isExecutionDeviceCandidate } from './orcaRemoteWorkers.js';

export type WorkerAgentLocation = { agentDeviceId: string; name: string };
export type WorkerAgentLocationsReadResult =
  | { status: 'complete'; locations: WorkerAgentLocation[] }
  | { status: 'degraded'; locations: WorkerAgentLocation[] };

/**
 * Lead 的 list_available_models 与插件 GET /agent-models 共用的 Worker Agent 位置：
 * 同账号在线、开了远程控制的电脑，以及收到的、未暂停的分享。只列位置不读目录；
 * 那台没开放供应商时按位置再列模型会是空的。分享不写分享者的电脑名
 * （provider-sharing.md §6），写「供应商 · 分享者」。不含本机。
 */
export async function readWorkerAgentLocations(): Promise<WorkerAgentLocationsReadResult> {
  let devices: Awaited<ReturnType<typeof handleListDevices>>['devices'] = [];
  let complete = true;
  try {
    ({ devices } = await handleListDevices(deviceDirectoryDeps()));
  } catch {
    complete = false;
  }
  const shares = getReceivedShares().filter((share) => share.status === 'active');
  const locations = [
    ...devices
      .filter(isExecutionDeviceCandidate)
      .map((device) => ({ agentDeviceId: device.deviceId, name: device.name || device.deviceId })),
    ...shares.flatMap((share) => {
      try {
        return [{
          agentDeviceId: providerShareAgentDeviceId(share.shareId),
          name: `${share.providerLabel} · ${share.owner.displayName}`,
        }];
      } catch {
        return [];
      }
    }),
  ];
  return complete ? { status: 'complete', locations } : { status: 'degraded', locations };
}

/** Keeps the existing best-effort array contract for non-plugin callers. */
export async function listWorkerAgentLocations(): Promise<WorkerAgentLocation[]> {
  return (await readWorkerAgentLocations()).locations;
}
