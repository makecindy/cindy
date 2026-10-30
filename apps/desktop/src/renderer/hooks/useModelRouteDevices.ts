/**
 * 任务、Worker 与模型设置共用的执行位置候选：其他电脑与分享(远程供应商)。
 *
 * 与任务输入框同一套候选：本机 Lead 列在线的同账号电脑(当前位置掉线也保留)与收到的分享；远程
 * 控制的被控电脑上的 Lead 列被控电脑之外的同账号电脑与两端都可用的分享。分享按账号授予，
 * 不要求 Lead 已经在该分享上运行；暂停或已删除的分享只保留当前位置。
 * 远程控制时 Lead 的 Agent 在控制端读不到目录的地方(控制端自己、只有被控电脑收到的分享)：与任务输入框
 * 一样维持被控电脑的目录、不列远程供应商，Worker 跟 Lead(返回的 leadAgentDeviceId 为 null)。
 * devices 为 undefined = 不提供(Lead 归属未解析、SSH Lead、上面这种读不到的情况)。
 */
import { useMemo } from 'react';

import { useAuth } from '@/contexts/AuthContext';
import { useSelectableDevices } from '@/hooks/useControllableDevices';
import {
  controlledTaskAgentLocationReadable,
  controlledTaskReadableShareIds,
  selectControlledTaskAgentDevices,
} from '@/lib/controlledTaskAgentLocation';
import { useProviderShareAgentDevices } from '@/features/provider-share/useProviderShareAgentDevices';

export interface ModelRouteDevices {
  /** 面板默认选中、并按它读模型目录的 Lead 位置；null = 任务所在电脑。 */
  leadAgentDeviceId: string | null;
  devices: readonly { deviceId: string; name: string }[] | undefined;
}

export function useModelRouteDevices(input: {
  /** Lead 任务所在的被控电脑：string = 被控电脑，null = 本机，undefined = 尚未解析。 */
  controlledDeviceId: string | null | undefined;
  /** Lead 的 Agent 所在电脑(或分享)；null / undefined = 任务所在电脑。 */
  leadAgentDeviceId: string | null | undefined;
  sshRemote?: boolean;
}): ModelRouteDevices {
  const { controlledDeviceId, sshRemote } = input;
  const lead = input.leadAgentDeviceId ?? null;
  const { deviceId: selfDeviceId } = useAuth();
  const { devices: selectableDevices } = useSelectableDevices();
  const { devices: shareDevices, isReceived } = useProviderShareAgentDevices([lead], controlledDeviceId);
  return useMemo(() => {
    if (controlledDeviceId === undefined || sshRemote) return { leadAgentDeviceId: lead, devices: undefined };
    if (controlledDeviceId) {
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
  }, [controlledDeviceId, isReceived, lead, selectableDevices, selfDeviceId, shareDevices, sshRemote]);
}
