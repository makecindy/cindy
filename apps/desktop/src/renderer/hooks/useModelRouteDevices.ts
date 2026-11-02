/**
 * 任务、Worker 与模型设置共用的执行位置候选：其他电脑与分享(远程供应商)。
 *
 * 与任务输入框同一套候选：本机 Lead 列在线的同账号电脑(当前位置掉线也保留)与收到的分享；远程
 * 控制的被控电脑上的 Lead 按被控电脑的名单列同账号电脑与可用分享。分享按账号授予，
 * 不要求 Lead 已经在该分享上运行；暂停或已删除的分享只保留当前位置。
 * 新主机提供自己的来源名单和只读目录通道，包含控制端自身与仅主机收到的分享。
 * 旧主机保持原直接读取兼容路径；devices 为 undefined = 不提供位置选择。
 */
import { useMemo } from 'react';
import { useControlledModelLocations } from './useControlledModelLocations';
import type { ControlledModelFavoriteSource } from '../../shared/controlledModelCatalog';

import { useAuth } from '@/contexts/AuthContext';
import { useSelectableDevices } from '@/hooks/useControllableDevices';
import {
  controlledTaskAgentLocationReadable,
  controlledTaskReadableShareIds,
  selectControlledTaskAgentDevices,
} from '@/lib/controlledTaskAgentLocation';
import { useProviderShareAgentDevices } from '@/features/provider-share/useProviderShareAgentDevices';

export interface ModelRouteDevices {
  catalogHostDeviceId?: string;
  /** 面板默认选中、并按它读模型目录的 Lead 位置；null = 任务所在电脑。 */
  leadAgentDeviceId: string | null;
  devices: readonly { deviceId: string; name: string; favoriteSource?: ControlledModelFavoriteSource }[] | undefined;
}

export function useModelRouteDevices(input: {
  /** Lead 任务所在的被控电脑：string = 被控电脑，null = 本机，undefined = 尚未解析。 */
  controlledDeviceId: string | null | undefined;
  /** Lead 的 Agent 所在电脑(或分享)；null / undefined = 任务所在电脑。 */
  leadAgentDeviceId: string | null | undefined;
  pendingAgentDeviceId?: string | null;
  sshRemote?: boolean;
}): ModelRouteDevices {
  const { controlledDeviceId, sshRemote } = input;
  const lead = input.leadAgentDeviceId ?? null;
  const pending = input.pendingAgentDeviceId ?? null;
  const { deviceId: selfDeviceId } = useAuth();
  const { devices: selectableDevices } = useSelectableDevices();
  const { devices: shareDevices, isReceived } = useProviderShareAgentDevices([lead, pending], controlledDeviceId);
  const hostLocations = useControlledModelLocations(sshRemote ? undefined : controlledDeviceId, selfDeviceId);
  return useMemo(() => {
    if (controlledDeviceId === undefined || sshRemote) return { leadAgentDeviceId: lead, devices: undefined };
    if (controlledDeviceId) {
      if (hostLocations !== undefined) {
        const devices = hostLocations.map(({ agentDeviceId, name, favoriteSource }) => ({
          deviceId: agentDeviceId, name, ...(favoriteSource ? { favoriteSource } : {}),
        }));
        for (const id of [lead, pending]) {
          if (id && !devices.some(device => device.deviceId === id)) {
            devices.push({ deviceId: id, name: shareDevices.find(device => device.deviceId === id)?.name ?? id });
          }
        }
        return { leadAgentDeviceId: lead, devices, catalogHostDeviceId: controlledDeviceId };
      }
      const readableShareIds = controlledTaskReadableShareIds({
        agentDeviceId: lead,
        pendingAgentDeviceId: null,
        isReceived,
      });
      const readable = controlledTaskAgentLocationReadable({
        agentDeviceId: lead,
        pendingAgentDeviceId: null,
        selfDeviceId: selfDeviceId ?? null,
        ...(readableShareIds ? { readableShareIds } : {}),
      });
      if (!readable) return { leadAgentDeviceId: null, devices: undefined };
      return {
        leadAgentDeviceId: lead,
        devices: selectControlledTaskAgentDevices({
          devices: selectableDevices,
          controlledDeviceId,
          keepDeviceIds: [lead],
          shareDevices,
        }),
      };
    }
    return {
      leadAgentDeviceId: lead,
      devices: [
        ...selectableDevices
          .filter((device) => device.online || device.deviceId === lead)
          .map(({ deviceId, name }) => ({ deviceId, name })),
        ...shareDevices,
      ],
    };
  }, [controlledDeviceId, hostLocations, isReceived, lead, pending, selectableDevices, selfDeviceId, shareDevices, sshRemote]);
}
