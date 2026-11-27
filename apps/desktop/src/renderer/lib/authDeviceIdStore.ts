import { useSyncExternalStore } from 'react';

/**
 * 本机设备 id 的只读模块快照（由 AuthProvider 同步写入）。
 * 供调度绑定与归档预检读取本机设备 id，避免把 AuthContext / i18n 整棵依赖树拖入纯数据模块。
 */
let currentAuthDeviceId: string | null = null;
const listeners = new Set<() => void>();

export function setCurrentAuthDeviceId(deviceId: string | null): void {
  if (currentAuthDeviceId === deviceId) return;
  currentAuthDeviceId = deviceId;
  for (const listener of [...listeners]) listener();
}

export function getCurrentAuthDeviceId(): string | null {
  return currentAuthDeviceId;
}

export function subscribeCurrentAuthDeviceId(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useCurrentAuthDeviceId(): string | null {
  return useSyncExternalStore(
    subscribeCurrentAuthDeviceId,
    getCurrentAuthDeviceId,
    getCurrentAuthDeviceId,
  );
}
