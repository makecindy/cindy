import { getDataOwnerGeneration, isDataOwnerGenerationCurrent } from '@/contexts/dataOwnerGeneration';
import { Button } from '@/components/ui/button';
import { REMOTE_RESOURCE_GET_CHANNEL, type RemoteResourceGetRequest } from '@cindy/device-link';
import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Navigate, useLocation, useParams } from 'react-router-dom';
import { standardSessionRoute } from '@/lib/orcaSessionIdentity';
import { useTranslation } from 'react-i18next';
import { CCAgentSessionView } from '@/features/cc-agent/CCAgentSessionView';
import { remoteProjectsStore } from '@/features/device-link/remoteProjectsStore';
import type { Session } from '@/lib/ccAgent.types';
import { Spinner } from '@/components/ui/spinner';
import { BotAvatar } from './BotAvatar';
import { parseRemoteBots, type RemoteBot } from './remoteBotRoster';
import { markRemoteBotRead, useRemoteBots } from './useRemoteBots';
import { useCompanionCloud } from './companionCloudStore';
import { cloudCompanionAt, homeControlOff } from './companionCloudPresentation';
import { useDeviceLinkDeviceList } from '@/features/device-link/useDeviceLinkDeviceList';
import { useDelayedFlag } from '@/features/cc-agent/workdir-browse/hooks/useDelayedFlag';
// Loaded only when a main computer is offline; keeps the live remote path light.
const CloudCompanionOfflineView = lazy(() => import('./CloudCompanionOfflineView')
  .then((module) => ({ default: module.CloudCompanionOfflineView })));

/** How long an open chat stays in place while its main computer cannot be reached. */
export const CLOUD_HOME_GRACE_MS = 15_000;

/** Verify companion identity with its host; pinned task links never adopt a replacement chat. */
export function RemoteBotSessionView() {
  const { deviceId, botId, sessionId: requestedSessionId } = useParams();
  const owner = getDataOwnerGeneration();
  return <RemoteBotSessionGate key={JSON.stringify([owner.dataOwnerId, owner.generation, deviceId, botId, requestedSessionId])} />;
}

function RemoteBotSessionGate() {
  const { deviceId, botId, sessionId: requestedSessionId } = useParams();
  const location = useLocation();
  const [originalTask, setOriginalTask] = useState(false);
  const { t } = useTranslation();
  const bots = useRemoteBots();
  const bot = bots.find((row) => row.id === botId && row.deviceId === deviceId);
  const cloud = useCompanionCloud();
  const deviceList = useDeviceLinkDeviceList();
  const cloudActor = cloudCompanionAt(cloud, deviceId, botId);
  const [ready, setReady] = useState<(RemoteBot & { sessionId: string; canonicalChat: true }) | null>(() => {
    if (!bot?.sessionId || !deviceId || (requestedSessionId && requestedSessionId !== bot.sessionId)
      || remoteProjectsStore.getSessionDeviceId(bot.sessionId) !== deviceId) return null;
    const session = remoteProjectsStore.getDeviceSessions(deviceId).find(row => row.id === bot.sessionId);
    return session?.source === 'bot' && session.status === 'active' ? { ...bot, sessionId: bot.sessionId, canonicalChat: true } : null;
  });
  const [validatedSessionId, setValidatedSessionId] = useState<string | null | undefined>(null);
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  const sessionId = bot?.sessionId;
  const readOwner = useRef(getDataOwnerGeneration());
  useEffect(() => {
    let disposed = false;
    const owner = getDataOwnerGeneration();
    setFailed(false);
    setOriginalTask(false);
    if (!deviceId || !bot?.online) return;
    setValidatedSessionId(null);
    const request: RemoteResourceGetRequest = {
      client: { protocolVersion: 1, primitives: ['status', 'session-link'] },
      ref: { collectionId: 'teammates', kind: 'bot', id: bot.id },
    };
    void (async () => {
      const resource = await window.electronAPI.deviceLink.invoke(
        deviceId,
        REMOTE_RESOURCE_GET_CHANNEL,
        [request],
      );
      if (disposed || !isDataOwnerGenerationCurrent(owner)) return;
      if (!resource) { setReady(null); throw new Error('Companion is not ready'); }
      const [resolved] = parseRemoteBots(
        { collectionId: 'teammates', items: [resource] },
        deviceId,
        bot.deviceName,
      );
      if (!resolved || resolved.id !== bot.id || !resolved.sessionId) { setReady(null); throw new Error('Companion is not ready'); }
      const canonicalId = resolved.sessionId;
      if (requestedSessionId && canonicalId !== requestedSessionId) {
        setOriginalTask(true);
        return;
      }
      const existingOrigin = remoteProjectsStore.getSessionDeviceId(canonicalId);
      if (existingOrigin && existingOrigin !== deviceId)
        throw new Error('Conflicting remote session owner');
      // Origin must precede every read/write in the shared conversation view.
      remoteProjectsStore.pinSessionOrigin(deviceId, canonicalId);
      const isSessionReadCurrent = remoteProjectsStore.captureSessionRead(deviceId, canonicalId);
      const value = await window.electronAPI.deviceLink.invoke(deviceId, 'local-db:sessions:get', [
        canonicalId,
      ]);
      if (disposed || !isDataOwnerGenerationCurrent(owner)) return;
      // A settings change or reconnect may finish while this GET is in flight.
      // Use the newer mirror when available; never publish the late response.
      const readIsCurrent = isSessionReadCurrent();
      const currentMirror = remoteProjectsStore.getDeviceSessions(deviceId).find((row) => row.id === canonicalId);
      const session = readIsCurrent ? value as Session | null : currentMirror;
      if (!session || session.id !== canonicalId || session.source !== 'bot' ||
        session.status !== 'active' ||
        (!readIsCurrent && session.deviceLinkConnectionStatus !== 'connected'))
        { setReady(null); throw new Error('Invalid remote companion session'); }
      if (readIsCurrent) remoteProjectsStore.mergeDeviceSessions(deviceId, currentMirror?.deviceLinkDeviceName ?? bot.deviceName, [
        isSessionReadCurrent.mergeActivity(session),
      ]);
      readOwner.current = owner;
      setReady({ ...resolved, sessionId: canonicalId, canonicalChat: true });
      setValidatedSessionId(sessionId);
    })().catch((error: unknown) => {
      if (!disposed && isDataOwnerGenerationCurrent(owner)) {
        const code = (error as { code?: string })?.code;
        const denied = ['NOT_FOUND', 'FORBIDDEN', 'PERMISSION_DENIED', 'ACCESS_REVOKED', 'DEVICE_REVOKED', 'AUTH_REQUIRED'];
        if (denied.includes(code ?? '') || denied.some(value => String(error).includes(`[${value}]`))) setReady(null);
        setFailed(true);
      }
    });
    return () => {
      disposed = true;
    };
  }, [deviceId, botId, sessionId, bot?.online, bot?.deviceName, retry, requestedSessionId]);

  useEffect(() => {
    if (!failed || !bot?.online || !ready) return;
    const timer = setTimeout(() => setRetry(value => value + 1), 5_000);
    return () => clearTimeout(timer);
  }, [failed, bot?.online, ready]);
  const identity = useMemo(() => ready ? { ...ready, canonicalChat: !failed && validatedSessionId === bot?.sessionId } : null,
    [ready, failed, validatedSessionId, bot?.sessionId]);

  const acknowledge = useCallback((at: number) => {
    if ((!requestedSessionId || ready?.sessionId === requestedSessionId) && !originalTask && isDataOwnerGenerationCurrent(readOwner.current) && bot?.online && !failed && ready?.id === bot.id && ready.deviceId === bot.deviceId
      && validatedSessionId === bot.sessionId) {
      markRemoteBotRead(bot.deviceId, bot.id, Math.min(at, bot.lastReplyAt ?? 0));
    }
  }, [bot, failed, ready, validatedSessionId, requestedSessionId, originalTask]);

  const liveChat = !originalTask && (!requestedSessionId || requestedSessionId === ready?.sessionId)
    && !!bot && !!ready?.sessionId && ready.id === botId && ready.deviceId === deviceId;
  const homeAway = !!cloudActor && !!deviceId && !!botId && cloudActor.homeDeviceId !== cloud.selfDeviceId
    && (!bot || (!bot.online && bot.connectionKnown !== false));
  // Like IM, a brief drop keeps the open chat in place (cloud-companions.md §3.1).
  const homeAwayLong = useDelayedFlag(homeAway && liveChat, CLOUD_HOME_GRACE_MS);
  if (requestedSessionId && deviceId && (originalTask || failed || !bot?.online || bot.sessionId !== requestedSessionId)) {
    const query = new URLSearchParams(location.search);
    query.set('device', deviceId);
    return <Navigate to={`${standardSessionRoute(requestedSessionId)}?${query}`} state={location.state} replace />;
  }
  // Its main computer is offline (or never reachable here): read the cloud conversation
  // and offer to continue on this computer instead of a stale read-only mirror.
  if (cloudActor && deviceId && botId && homeAway && (!liveChat || homeAwayLong)) {
    return (
      <Suspense fallback={<main className="flex h-full items-center justify-center bg-[var(--surface)]"><Spinner size={18} /></main>}>
      <CloudCompanionOfflineView
        key={`${deviceId}:${botId}`}
        botId={botId}
        deviceId={deviceId}
        name={bot?.name || cloudActor.name}
        avatar={bot?.avatar || cloudActor.avatar}
        avatarColor={bot?.avatarColor}
        deviceName={bot?.deviceName || cloudActor.homeDevice?.name || ''}
        controlOff={!bot && homeControlOff(cloudActor, deviceList)}
      />
      </Suspense>
    );
  }
  if (liveChat && bot && ready) {
    return (
      <CCAgentSessionView
        key={`${deviceId}:${ready.sessionId}`}
        sessionIdProp={ready.sessionId}
        routeOwner
        botIdentity={identity!}
        onBotReadThrough={acknowledge}
        readOnly={!bot.online || validatedSessionId !== bot.sessionId || failed}
      />
    );
  }
  return (
    <main className="flex h-full flex-col items-center justify-center gap-3 bg-[var(--surface)] px-6 text-center">
      {bot ? <BotAvatar bot={bot} size="lg" /> : null}
      <p className="text-14 text-[var(--text-secondary)]">
        {failed
          ? t('bots.sessionLoadFailedDescription')
          : bot && !bot.online
            ? t('bots.remote.offlineDescription', { name: bot.name, device: bot.deviceName })
            : !sessionId
              ? t('bots.remote.preparing')
              : t('ccAgent.common.loading')}
      </p>
      {sessionId && bot?.online && !failed ? <Spinner size={18} /> : null}
      {failed ? (
        <Button
          variant="secondary"
          size="md"
          compact
          type="button"
          onClick={() => setRetry((n) => n + 1)}
        >
          {t('bots.retry')}
        </Button>
      ) : null}
    </main>
  );
}
