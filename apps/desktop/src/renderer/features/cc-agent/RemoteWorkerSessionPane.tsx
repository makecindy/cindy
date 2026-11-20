/**
 * 协同面板里在另一台电脑(运行设备)上运行的 Worker。
 *
 * 本机只有一条不跑 Agent 的代理任务；这里登记运行设备上真实任务的归属、读一次任务行，
 * 然后用普通的远程任务视图展示与收发。直接在这里发的消息按插话处理，不回报给 Lead。
 * 设备连不上时只提示，不判失败；恢复后自动重新读取。
 * 在本机查看另一台电脑上的 Lead 时，运行设备可能就是本机：那条任务是本机任务，直接按本机打开。
 */
import { Folder, Monitor, WifiOff } from 'lucide-react';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { useOptionalAuthDeviceId } from '@/contexts/AuthContext';
import {
  getDataOwnerGeneration,
  isDataOwnerGenerationCurrent,
} from '@/contexts/dataOwnerGeneration';
import { remoteProjectsStore } from '@/features/device-link/remoteProjectsStore';
import type { Session } from '@/lib/ccAgent.types';
import { makerChatStore } from '@/lib/makerChatStore';

import { CCAgentSessionView, type WorkerViewCommit } from './CCAgentSessionView';
import type { WorkerExecutionDevice } from './hooks/workerProjectionStore';
import { workerDeviceName } from './RolePillDropdown';

export interface RemoteWorkerSessionPaneProps {
  leadSessionId: string;
  device: WorkerExecutionDevice;
  viewVisible: boolean;
  chatRealtime: boolean;
  readOnly?: boolean;
  onHistoryCommit?: (stage: WorkerViewCommit) => void;
}

type LoadState = 'loading' | 'ready' | 'failed';

type SessionRead = {
  promise: Promise<Session>;
  isCurrent: ReturnType<typeof remoteProjectsStore.captureSessionRead>;
};

const pendingSessionReads = new Map<string, SessionRead>();

function readWorkerSession(key: string, deviceId: string, sessionId: string): SessionRead {
  const pending = pendingSessionReads.get(key);
  if (pending?.isCurrent()) return pending;
  const isCurrent = remoteProjectsStore.captureSessionRead(deviceId, sessionId);
  const deviceEpoch = remoteProjectsStore.getDeviceLifecycleEpoch(deviceId);
  const promise = window.electronAPI.deviceLink.invoke(deviceId, 'local-db:sessions:get', [sessionId])
    .then((value) => {
      const session = value as Session | null;
      if (session?.id !== sessionId) throw new Error('Remote worker task not found');
      if (remoteProjectsStore.getSessionDeviceId(sessionId) !== deviceId ||
          remoteProjectsStore.getDeviceLifecycleEpoch(deviceId) !== deviceEpoch) {
        throw new Error('Remote worker route changed during the read');
      }
      if (!isCurrent()) {
        const newer = remoteProjectsStore.getDeviceSessions(deviceId).find((row) => row.id === sessionId);
        if (!newer) throw new Error('Remote worker task changed during the read');
        return newer;
      }
      return session;
    });
  const read = { promise, isCurrent };
  pendingSessionReads.set(key, read);
  const release = () => {
    if (pendingSessionReads.get(key) === read) pendingSessionReads.delete(key);
  };
  void promise.then(release, release);
  return read;
}

export function RemoteWorkerSessionPane({
  leadSessionId,
  device,
  viewVisible,
  chatRealtime,
  readOnly = false,
  onHistoryCommit,
}: RemoteWorkerSessionPaneProps) {
  const { t } = useTranslation();
  const [state, setState] = useState<LoadState>('loading');
  const [loadedKey, setLoadedKey] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const verifiedSessionKey = useRef<string | null>(null);
  const onCommit = useRef(onHistoryCommit);
  useEffect(() => { onCommit.current = onHistoryCommit; }, [onHistoryCommit]);
  const localDeviceId = useOptionalAuthDeviceId();
  const { deviceId, remoteSessionId, reachable } = device;
  const sessionOrigin = useSyncExternalStore(
    remoteProjectsStore.subscribe,
    () => remoteProjectsStore.getSessionDeviceId(remoteSessionId),
  );
  // 本机任务不能登记成「本机这台设备上的远程任务」：侧栏会多出一条同 id 的远程行，
  // 归档等写入也会按这条归属绕隧道写回本机。
  const runsHere = localDeviceId !== null && deviceId === localDeviceId;
  // 本机设备 id 未就绪时还不知道任务在不在本机，先不提示连不上。
  const showUnreachable = localDeviceId !== null && !runsHere && reachable === false;
  const owner = getDataOwnerGeneration();
  const sessionKey = JSON.stringify([owner.dataOwnerId, owner.generation, deviceId, remoteSessionId]);
  const name = workerDeviceName(t, device);

  useEffect(() => {
    // 本机设备 id 未就绪时无法判断任务在不在本机，先不登记归属。
    if (reachable === false) verifiedSessionKey.current = null;
    if (localDeviceId === null || runsHere || !viewVisible || verifiedSessionKey.current === sessionKey) return;
    let disposed = false;
    let releaseHistory: (() => void) | undefined;
    const isMounted = () => !disposed && isDataOwnerGenerationCurrent(owner);
    const reportFailure = onCommit.current;
    setState('loading');
    void Promise.resolve().then(async () => {
      if (!isMounted()) return;
      const existingOrigin = remoteProjectsStore.getSessionDeviceId(remoteSessionId);
      if (existingOrigin && existingOrigin !== deviceId)
        throw new Error('Conflicting session owner');
      // 归属必须先于任何读写登记，任务视图才会把请求发到运行设备。
      remoteProjectsStore.pinSessionOrigin(deviceId, remoteSessionId);
      const ownsRoute = () => remoteProjectsStore.getSessionDeviceId(remoteSessionId) === deviceId;
      if (!ownsRoute()) throw new Error('Conflicting session owner');
      const cached = remoteProjectsStore
        .getDeviceSessions(deviceId)
        .some((row) => row.id === remoteSessionId);
      if (cached) setLoadedKey(sessionKey);
      if (reachable === false) {
        setState('failed');
        if (!cached) reportFailure?.('history-failed');
        return;
      }
      const { promise, isCurrent } = readWorkerSession(sessionKey, deviceId, remoteSessionId);
      // The chat view joins the same history load when its metadata arrives.
      releaseHistory = makerChatStore.enterView(remoteSessionId);
      makerChatStore.ensureInitialMessages(remoteSessionId, promise);
      const value = await promise;
      if (!isMounted()) return;
      if (!ownsRoute()) throw new Error('Conflicting session owner');
      if (isCurrent()) {
        const mirror = remoteProjectsStore
          .getDeviceSessions(deviceId)
          .find((row) => row.id === remoteSessionId);
        remoteProjectsStore.mergeDeviceSessions(
          deviceId,
          mirror?.deviceLinkDeviceName ?? remoteProjectsStore.getDeviceName(deviceId) ?? name,
          [isCurrent.mergeActivity(value)],
        );
      }
      setState('ready');
      setLoadedKey(sessionKey);
      verifiedSessionKey.current = sessionKey;
    }).catch(() => {
      if (!isMounted()) return;
      releaseHistory?.();
      releaseHistory = undefined;
      setState('failed');
      reportFailure?.('history-failed');
    });
    return () => {
      disposed = true;
      releaseHistory?.();
    };
    // name 只用于镜像分片缺名时的兜底，不触发重读。
  }, [deviceId, remoteSessionId, reachable, retry, sessionKey, localDeviceId, runsHere, owner, viewVisible]);

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
        {showUnreachable ? (
          <span className="ml-auto inline-flex shrink-0 items-center gap-1 text-[var(--warning-fg)]">
            <WifiOff size={12} aria-hidden />
            {t('orca.rolePill.deviceUnreachable')}
          </span>
        ) : null}
        {!runsHere && state === 'failed' && reachable !== false ? (
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
        {(runsHere && !sessionOrigin) || (loadedKey === sessionKey && sessionOrigin === deviceId) ? (
          <CCAgentSessionView
            key={sessionKey}
            sessionIdProp={remoteSessionId}
            onHistoryCommit={onHistoryCommit}
            compact
            compactToolbar
            viewVisible={viewVisible}
            chatRealtime={chatRealtime}
            readOnly={readOnly || (!runsHere && (reachable === false || state !== 'ready'))}
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
