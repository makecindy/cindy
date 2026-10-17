/**
 * 协同面板里在另一台电脑(运行设备)上运行的 Worker。
 *
 * 本机只有一条不跑 Agent 的代理任务；这里登记运行设备上真实任务的归属、读一次任务行，
 * 然后用普通的远程任务视图展示与收发。直接在这里发的消息按插话处理，不回报给 Lead。
 * 设备连不上时只提示，不判失败；恢复后自动重新读取。
 */
import { Folder, Monitor, WifiOff } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import {
  getDataOwnerGeneration,
  isDataOwnerGenerationCurrent,
} from '@/contexts/dataOwnerGeneration';
import { remoteProjectsStore } from '@/features/device-link/remoteProjectsStore';
import type { Session } from '@/lib/ccAgent.types';

import { CCAgentSessionView } from './CCAgentSessionView';
import type { WorkerExecutionDevice } from './hooks/workerProjectionStore';
import { workerDeviceName } from './RolePillDropdown';

export interface RemoteWorkerSessionPaneProps {
  leadSessionId: string;
  device: WorkerExecutionDevice;
  viewVisible: boolean;
  chatRealtime: boolean;
}

type LoadState = 'loading' | 'ready' | 'failed';

export function RemoteWorkerSessionPane({
  leadSessionId,
  device,
  viewVisible,
  chatRealtime,
}: RemoteWorkerSessionPaneProps) {
  const { t } = useTranslation();
  const [state, setState] = useState<LoadState>('loading');
  const [loadedKey, setLoadedKey] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const { deviceId, remoteSessionId, reachable } = device;
  const sessionKey = `${deviceId}:${remoteSessionId}`;
  const name = workerDeviceName(t, device);

  useEffect(() => {
    let disposed = false;
    const owner = getDataOwnerGeneration();
    setState('loading');
    void (async () => {
      const existingOrigin = remoteProjectsStore.getSessionDeviceId(remoteSessionId);
      if (existingOrigin && existingOrigin !== deviceId)
        throw new Error('Conflicting session owner');
      // 归属必须先于任何读写登记，任务视图才会把请求发到运行设备。
      remoteProjectsStore.pinSessionOrigin(deviceId, remoteSessionId);
      const cached = remoteProjectsStore
        .getDeviceSessions(deviceId)
        .some((row) => row.id === remoteSessionId);
      if (cached) setLoadedKey(sessionKey);
      if (reachable === false) {
        setState('failed');
        return;
      }
      const isReadCurrent = remoteProjectsStore.captureSessionRead(deviceId, remoteSessionId);
      const value = (await window.electronAPI.deviceLink.invoke(deviceId, 'local-db:sessions:get', [
        remoteSessionId,
      ])) as Session | null;
      if (disposed || !isDataOwnerGenerationCurrent(owner)) return;
      if (!value || value.id !== remoteSessionId) throw new Error('Remote worker task not found');
      if (isReadCurrent()) {
        const mirror = remoteProjectsStore
          .getDeviceSessions(deviceId)
          .find((row) => row.id === remoteSessionId);
        remoteProjectsStore.mergeDeviceSessions(
          deviceId,
          mirror?.deviceLinkDeviceName ?? remoteProjectsStore.getDeviceName(deviceId) ?? name,
          [isReadCurrent.mergeActivity(value)],
        );
      }
      setState('ready');
      setLoadedKey(sessionKey);
    })().catch(() => {
      if (!disposed && isDataOwnerGenerationCurrent(owner)) setState('failed');
    });
    return () => {
      disposed = true;
    };
    // name 只用于镜像分片缺名时的兜底，不触发重读。
  }, [deviceId, remoteSessionId, reachable, retry, sessionKey]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div
        data-testid="remote-worker-device-bar"
        className="flex min-w-0 shrink-0 items-center gap-3 border-b border-border/40 px-3 py-1.5 text-11 leading-snug text-[var(--text-secondary)]"
      >
        <span className="inline-flex min-w-0 shrink-0 items-center gap-1">
          <Monitor size={12} aria-hidden />
          <span className="truncate">{t('orca.rolePill.executionDevice', { device: name })}</span>
        </span>
        {device.workingDir ? (
          <span className="inline-flex min-w-0 items-center gap-1">
            <Folder size={12} aria-hidden className="shrink-0" />
            <code className="truncate font-mono">{device.workingDir}</code>
          </span>
        ) : null}
        {reachable === false ? (
          <span className="ml-auto inline-flex shrink-0 items-center gap-1 text-[var(--warning-fg)]">
            <WifiOff size={12} aria-hidden />
            {t('orca.rolePill.deviceUnreachable')}
          </span>
        ) : null}
        {state === 'failed' && reachable !== false ? (
          <Button
            variant="secondary"
            tone="quiet"
            size="sm"
            className="ml-auto"
            onClick={() => setRetry((value) => value + 1)}
          >
            {t('commonUi.retry')}
          </Button>
        ) : null}
      </div>
      <div className="min-h-0 flex-1">
        {loadedKey === sessionKey ? (
          <CCAgentSessionView
            key={`${deviceId}:${remoteSessionId}`}
            sessionIdProp={remoteSessionId}
            compact
            compactToolbar
            viewVisible={viewVisible}
            chatRealtime={chatRealtime}
            readOnly={reachable === false || state !== 'ready'}
            navigationMode="sidebar-embedded"
            sidebarTargetSessionId={leadSessionId}
          />
        ) : (
          <div className="flex h-full w-full flex-col items-center justify-center gap-3 px-6 text-center text-13 text-[var(--text-secondary)]">
            {state === 'loading' ? <Spinner size={16} /> : null}
            <p>
              {state === 'loading'
                ? t('orca.split.remoteWorkerLoading', { device: name })
                : t('orca.split.remoteWorkerUnreachable', { device: name })}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
