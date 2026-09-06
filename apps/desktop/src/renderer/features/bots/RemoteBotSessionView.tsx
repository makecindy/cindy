import { REMOTE_RESOURCE_GET_CHANNEL, type RemoteResourceGetRequest } from '@cindy/device-link';
import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { CCAgentSessionView } from '@/features/cc-agent/CCAgentSessionView';
import { remoteProjectsStore } from '@/features/device-link/remoteProjectsStore';
import type { Session } from '@/lib/ccAgent.types';
import { Spinner } from '@/components/ui/spinner';
import { BotAvatar } from './BotAvatar';
import { parseRemoteBots, type RemoteBot } from './remoteBotRoster';
import { useRemoteBots } from './useRemoteBots';

/** The session id comes from the host's collection, never from an arbitrary URL. */
export function RemoteBotSessionView() {
  const { deviceId, botId } = useParams();
  const { t } = useTranslation();
  const bots = useRemoteBots();
  const bot = bots.find((row) => row.id === botId && row.deviceId === deviceId);
  const [ready, setReady] = useState<RemoteBot | null>(null);
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  const sessionId = bot?.sessionId;
  useEffect(() => {
    let disposed = false;
    setFailed(false);
    if (!deviceId || !bot?.online) return;
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
      if (disposed) return;
      const [resolved] = parseRemoteBots(
        { collectionId: 'teammates', items: [resource] },
        deviceId,
        bot.deviceName,
      );
      if (resolved.id !== bot.id || !resolved.sessionId) throw new Error('Companion is not ready');
      const canonicalId = resolved.sessionId;
      const existingOrigin = remoteProjectsStore.getSessionDeviceId(canonicalId);
      if (existingOrigin && existingOrigin !== deviceId)
        throw new Error('Conflicting remote session owner');
      // Origin must precede every read/write in the shared conversation view.
      remoteProjectsStore.pinSessionOrigin(deviceId, canonicalId);
      const value = await window.electronAPI.deviceLink.invoke(deviceId, 'local-db:sessions:get', [
        canonicalId,
      ]);
      if (disposed) return;
      const session = value as Session | null;
      if (!session || session.id !== canonicalId || session.source !== 'bot')
        throw new Error('Invalid remote companion session');
      remoteProjectsStore.mergeDeviceSessions(deviceId, bot.deviceName, [session]);
      setReady(resolved);
    })().catch(() => {
      if (!disposed) setFailed(true);
    });
    return () => {
      disposed = true;
    };
  }, [deviceId, botId, sessionId, bot?.online, bot?.deviceName, retry]);

  if (bot && ready?.sessionId && ready.id === botId && ready.deviceId === deviceId) {
    return (
      <CCAgentSessionView
        key={`${deviceId}:${ready.sessionId}`}
        sessionIdProp={ready.sessionId}
        routeOwner
        botIdentity={ready}
        readOnly={!bot.online}
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
        <button
          type="button"
          className="rounded-lg border border-[var(--border-default)] px-3 py-2 text-13 text-[var(--text-primary)] hover:bg-[var(--surface-hover)]"
          onClick={() => setRetry((n) => n + 1)}
        >
          {t('bots.retry')}
        </button>
      ) : null}
    </main>
  );
}
