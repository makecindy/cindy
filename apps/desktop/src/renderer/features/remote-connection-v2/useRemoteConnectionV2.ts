/**
 * useRemoteConnectionV2 —— 「新版连接」开关(设置 → 远程连接)。
 * ---------------------------------------------------------------------------
 * 产品裁决(docs/product-rules/agent-net.md):V2 与 V1 并存,按设备切换,默认关闭,
 * 关闭时与现有 device-link 完全一致。真实宿主通过受信 IPC 保存偏好并重连传输；
 * localStorage 仅作为展示快照和无宿主 UI 预览，不再拥有传输设置的真相。
 *
 * 持久化规则(docs/dev-rules/configuration-and-overrides.md):只存 override ——
 * 打开写 'on',关闭就删 key;模块级内存值做同页即时生效,`storage` 事件跨窗口同步
 * (与 useStreamFadePreference 同一模式)。
 */

import { useCallback, useEffect, useState } from 'react';

import type { SelfHostedRelayState } from '../../../shared/selfHostedRelay';

/** 这台电脑的 Agent-Net 开关最近一次被同账号其他设备远程改动(原型)。 */
export type AgentNetRemoteChange = NonNullable<SelfHostedRelayState['agentNetChangedBy']>;

const STORAGE_KEY = 'remoteConnection.v2';

let memoryValue: boolean | null = null;
let onlyEncryptedValue = false;
let changedByValue: AgentNetRemoteChange | null = null;
export function getRemoteConnectionOnlyEncrypted(): boolean { return onlyEncryptedValue; }
const listeners = new Set<() => void>();
let storageSubscribed = false;
let offHost: (() => void) | null = null;
let hostEpoch = 0;

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
  const api = window.electronAPI?.selfHostedRelay;
  if (api) {
    const epoch = hostEpoch;
    void api.command({ type: 'state' }).then((result) => {
      if (epoch === hostEpoch) applyState(result.state);
    }).catch(() => undefined);
    return;
  }
  memoryValue = e.newValue === 'on';
  notify();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (!storageSubscribed) {
    window.addEventListener('storage', onStorage);
    storageSubscribed = true;
    const api = window.electronAPI?.selfHostedRelay;
    if (api) {
      const epoch = hostEpoch;
      void api.command({ type: 'state' }).then((result) => {
        if (epoch === hostEpoch && listeners.size) applyState(result.state);
      }).catch(() => undefined);
      offHost = api.onChanged((state) => { hostEpoch++; applyState(state); });
    }
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && storageSubscribed) {
      window.removeEventListener('storage', onStorage);
      storageSubscribed = false;
      offHost?.(); offHost = null; hostEpoch++;
    }
  };
}

function applyState(state: SelfHostedRelayState): void {
  changedByValue = state.agentNetChangedBy ?? null;
  applyView(state.agentNetEnabled === true, state.agentNetOnlyEncrypted === true);
}

function applyView(next: boolean, onlyEncrypted = onlyEncryptedValue): void {
  memoryValue = next;
  onlyEncryptedValue = onlyEncrypted;
  try {
    if (next) localStorage.setItem(STORAGE_KEY, 'on');
    else localStorage.removeItem(STORAGE_KEY); // 关 = 清除 override,不写默认值快照
  } catch {
    // localStorage 不可用:内存值已生效,只缺跨窗口同步。
  }
  notify();
}
export function setRemoteConnectionV2Enabled(next: boolean): Promise<void> {
  const api = window.electronAPI?.selfHostedRelay;
  if (!api) { applyView(next); return Promise.resolve(); } // Standalone UI previews have no transport.
  const epoch = ++hostEpoch;
  return api.command({ type: 'set-agent-net', enabled: next }).then((result) => {
    if (result.error) throw new Error(result.error);
    if (epoch === hostEpoch) applyState(result.state);
  });
}

export function setRemoteConnectionOnlyEncrypted(next: boolean): Promise<void> {
  const api = window.electronAPI?.selfHostedRelay;
  if (!api) { applyView(getRemoteConnectionV2Enabled(), next); return Promise.resolve(); }
  const epoch = ++hostEpoch;
  return api.command({ type: 'set-agent-net-encryption', enabled: next }).then((result) => {
    if (result.error) throw new Error(result.error);
    if (epoch === hostEpoch) applyState(result.state);
  });
}
export function useRemoteConnectionV2(): {
  enabled: boolean;
  setEnabled: (next: boolean) => void;
  onlyEncrypted: boolean;
  setOnlyEncrypted: (next: boolean) => void;
  changedBy: AgentNetRemoteChange | null;
} {
  const [enabled, setState] = useState<boolean>(getRemoteConnectionV2Enabled);
  const [onlyEncrypted, setOnlyEncryptedState] = useState(getRemoteConnectionOnlyEncrypted);
  const [changedBy, setChangedBy] = useState<AgentNetRemoteChange | null>(changedByValue);
  useEffect(() => subscribe(() => {
    setState(getRemoteConnectionV2Enabled());
    setOnlyEncryptedState(getRemoteConnectionOnlyEncrypted());
    setChangedBy(changedByValue);
  }), []);
  const setEnabled = useCallback((next: boolean) => {
    void setRemoteConnectionV2Enabled(next).catch((error) => {
      window.dispatchEvent(new CustomEvent('agent-net-preference-error', { detail: { code: error instanceof Error ? error.message : 'FAILED' } }));
    });
  }, []);
  const setOnlyEncrypted = useCallback((next: boolean) => {
    void setRemoteConnectionOnlyEncrypted(next).catch((error) => {
      window.dispatchEvent(new CustomEvent('agent-net-preference-error', { detail: { code: error instanceof Error ? error.message : 'FAILED' } }));
    });
  }, []);
  return { enabled, setEnabled, onlyEncrypted, setOnlyEncrypted, changedBy };
}

/** 测试专用:清空内存值与监听。 */
export function _resetRemoteConnectionV2ForTests(): void {
  memoryValue = null;
  onlyEncryptedValue = false;
  changedByValue = null;
  listeners.clear();
  offHost?.(); offHost = null; hostEpoch++;
  if (storageSubscribed) {
    window.removeEventListener('storage', onStorage);
    storageSubscribed = false;
  }
}
