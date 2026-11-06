/**
 * useRemoteConnectionV2 —— 「新版连接」开关(设置 → 远程连接)。
 * ---------------------------------------------------------------------------
 * 产品裁决(docs/product-rules/agent-net.md):V2 与 V1 并存,按设备切换,默认关闭,
 * 关闭时与现有 device-link 完全一致。现阶段 V2 传输还没接入产品,这个开关只换
 * 远程连接页的样子;传输接入后由同一个值一起启用(届时迁到主进程 settings-store)。
 *
 * 持久化规则(docs/dev-rules/configuration-and-overrides.md):只存 override ——
 * 打开写 'on',关闭就删 key;模块级内存值做同页即时生效,`storage` 事件跨窗口同步
 * (与 useStreamFadePreference 同一模式)。
 */

import { useCallback, useEffect, useState } from 'react';

const STORAGE_KEY = 'remoteConnection.v2';

let memoryValue: boolean | null = null;
const listeners = new Set<() => void>();
let storageSubscribed = false;

/** 同步读;非 hook 路径用。坏数据 / 不可用一律当默认值 false。 */
export function getRemoteConnectionV2Enabled(): boolean {
  if (memoryValue !== null) return memoryValue;
  try {
    return (memoryValue = localStorage.getItem(STORAGE_KEY) === 'on');
  } catch {
    return false;
  }
}

function notify(): void {
  listeners.forEach((fn) => fn());
}

function onStorage(e: StorageEvent): void {
  if (e.key !== STORAGE_KEY) return;
  memoryValue = e.newValue === 'on';
  notify();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (!storageSubscribed) {
    window.addEventListener('storage', onStorage);
    storageSubscribed = true;
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && storageSubscribed) {
      window.removeEventListener('storage', onStorage);
      storageSubscribed = false;
    }
  };
}

export function setRemoteConnectionV2Enabled(next: boolean): void {
  memoryValue = next;
  try {
    if (next) localStorage.setItem(STORAGE_KEY, 'on');
    else localStorage.removeItem(STORAGE_KEY); // 关 = 清除 override,不写默认值快照
  } catch {
    // localStorage 不可用:内存值已生效,只缺跨窗口同步。
  }
  notify();
}

export function useRemoteConnectionV2(): { enabled: boolean; setEnabled: (next: boolean) => void } {
  const [enabled, setState] = useState<boolean>(getRemoteConnectionV2Enabled);
  useEffect(() => subscribe(() => setState(getRemoteConnectionV2Enabled())), []);
  const setEnabled = useCallback((next: boolean) => setRemoteConnectionV2Enabled(next), []);
  return { enabled, setEnabled };
}

/** 测试专用:清空内存值与监听。 */
export function _resetRemoteConnectionV2ForTests(): void {
  memoryValue = null;
  listeners.clear();
  if (storageSubscribed) {
    window.removeEventListener('storage', onStorage);
    storageSubscribed = false;
  }
}
