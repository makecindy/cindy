/**
 * useRemoteSessionConnection —— 打开的 device-link 远程会话的连接健康(控制端可见状态)。
 * ---------------------------------------------------------------------------
 * 让"连接有问题"不再静默:用本机到 relay 的链路状态(linkStatus)× 被控端在线态(presence)
 * 派生出会话级连接状态,供 banner 提示用户(重连中 / 被控设备离线),而不是界面不动 + 丢消息。
 *
 *  - linkStatus(deviceLink.getState + onStatusChanged):本机 WS 到 relay 的连接。非 online =
 *    本机断链重连中 —— 此时所有远程会话都收不到 push / 发不出 invoke,是最常见的"连接问题"。
 *  - hostOnline:复用 remoteProjectsStore 的在线设备索引 —— 被控端在线 + 允许被控时才算在线;
 *    presence-offline / relay connecting 会保留快照但从在线索引移除。
 *
 * 本机会话(deviceId 为空)→ 'local',不显示 banner。
 */

import { useEffect, useState, useSyncExternalStore } from 'react';

import { remoteProjectsStore } from '@/features/device-link/remoteProjectsStore';
import { unresponsiveDevicesStore } from '@/features/device-link/unresponsiveDevicesStore';

type LinkStatus = 'stopped' | 'connecting' | 'online';

export type RemoteConnectionStatus =
  | 'local'
  | 'connected'
  | 'reconnecting'
  | 'host-offline'
  | 'degraded';

/**
 * 纯派生:本机链路非 online → reconnecting(本机断链,优先级最高);本机在线但被控端不在线
 * → host-offline;两端都「在线」但被控端被熔断判定无响应(连续 invoke 超时,弱网 / 对端
 * 卡死)→ degraded;否则 connected。便于单测。
 */
export function deriveRemoteConnectionStatus(
  linkStatus: LinkStatus,
  hostOnline: boolean,
  hostUnresponsive = false,
): Exclude<RemoteConnectionStatus, 'local'> {
  if (linkStatus !== 'online') return 'reconnecting';
  if (!hostOnline) return 'host-offline';
  if (hostUnresponsive) return 'degraded';
  return 'connected';
}

/**
 * 本机到 relay 的连接问题(鉴权失效/被顶号/超限/版本不符;null = 无异常)。
 * 与三态 linkStatus 互补:非 online 的「一直重连」若有明确原因,banner / 设置页
 * 用它把原因说清楚,而不是笼统的「重连中」。enabled=false 时不订阅(本机会话免开销)。
 */
export function useDeviceLinkConnectionIssue(
  enabled: boolean,
): DeviceLinkConnectionIssuePayload | null {
  const [issue, setIssue] = useState<DeviceLinkConnectionIssuePayload | null>(null);

  useEffect(() => {
    if (!enabled) {
      setIssue(null);
      return;
    }
    let cancelled = false;
    // push 一旦到达即权威:迟到的 getState 快照不得覆盖更新的 push 值(同 linkStatus)。
    let pushSeen = false;

    void window.electronAPI.deviceLink
      .getState()
      .then((s) => {
        if (!cancelled && !pushSeen) setIssue(s.connectionIssue);
      })
      .catch(() => {
        /* 取不到状态 → 按无 issue,避免误报 */
      });
    const offIssue = window.electronAPI.deviceLink.onConnectionIssue((p) => {
      if (cancelled) return;
      pushSeen = true;
      setIssue(p.issue);
    });

    return () => {
      cancelled = true;
      offIssue();
    };
  }, [enabled]);

  return enabled ? issue : null;
}

export function useRemoteSessionConnection(deviceId: string | undefined): RemoteConnectionStatus {
  const [linkStatus, setLinkStatus] = useState<LinkStatus>('online');

  useEffect(() => {
    if (!deviceId) return;
    let cancelled = false;
    // push 一旦到达即权威:迟到的 getState 快照不得覆盖更新的 onStatusChanged 值。
    let pushSeen = false;

    void window.electronAPI.deviceLink
      .getState()
      .then((s) => {
        if (!cancelled && !pushSeen) setLinkStatus(s.linkStatus);
      })
      .catch(() => {
        /* 取不到状态 → 保守按 online,避免误报 banner */
      });
    const offStatus = window.electronAPI.deviceLink.onStatusChanged((p) => {
      if (cancelled) return;
      pushSeen = true;
      setLinkStatus(p.status);
    });

    return () => {
      cancelled = true;
      offStatus();
    };
  }, [deviceId]);

  // hostOnline:直接从 remoteProjectsStore 派生(断线缓存仍显示,但 getDeviceIds 只返回在线设备)。
  // 用 useSyncExternalStore 让首帧就是真值 —— 旧实现 hostOnline 初值 false,打开一个在线远程
  // 会话会先渲染一帧 host-offline 再被 effect 纠正(banner 闪一下)。
  const hostOnline = useSyncExternalStore(
    remoteProjectsStore.subscribe,
    () => (deviceId ? remoteProjectsStore.getDeviceIds().includes(deviceId) : false),
  );

  // 「无响应」熔断镜像(main 权威,useDeviceLinkRemoteProjects 接线):presence 在线但
  // 连续 invoke 超时 → degraded,让弱网不再表现为「界面不动 + 每次操作干等超时」。
  const hostUnresponsive = useSyncExternalStore(
    unresponsiveDevicesStore.subscribe,
    () => (deviceId ? unresponsiveDevicesStore.getSnapshot().has(deviceId) : false),
  );

  if (!deviceId) return 'local';
  return deriveRemoteConnectionStatus(linkStatus, hostOnline, hostUnresponsive);
}
