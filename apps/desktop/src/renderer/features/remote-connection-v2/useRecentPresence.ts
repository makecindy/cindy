/**
 * useRecentPresence —— 远程连接页「最近」标签的数据:本页打开期间观察到的上线 / 下线。
 * 只记内存、只记本页生命周期,不持久化;同一设备连续相同状态只记一次。
 */

import { useEffect, useState } from 'react';

export interface PresenceEvent {
  deviceId: string;
  name: string;
  app?: string;
  online: boolean;
  at: number;
}

const MAX_EVENTS = 20;

/** 纯函数,可单测:把一条 presence 合并进列表(最新在前,连续重复不记)。 */
export function appendPresenceEvent(list: readonly PresenceEvent[], next: PresenceEvent): readonly PresenceEvent[] {
  const last = list.find((e) => e.deviceId === next.deviceId);
  if (last && last.online === next.online) return list;
  return [next, ...list].slice(0, MAX_EVENTS);
}

export function useRecentPresence(active: boolean): readonly PresenceEvent[] {
  const [events, setEvents] = useState<readonly PresenceEvent[]>([]);
  useEffect(() => {
    const api = window.electronAPI?.deviceLink;
    if (!active || !api?.onPresenceChanged) return undefined;
    const off = api.onPresenceChanged((snap) => {
      setEvents((prev) => appendPresenceEvent(prev, {
        deviceId: snap.deviceId,
        name: snap.deviceName,
        app: snap.app,
        online: snap.online,
        at: Date.now(),
      }));
    });
    return off;
  }, [active]);
  return events;
}
