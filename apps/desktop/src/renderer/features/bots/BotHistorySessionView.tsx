import { useEffect, useState } from 'react';
import { Navigate, useLocation, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { CCAgentSessionView } from '@/features/cc-agent/CCAgentSessionView';
import type { BotChatIdentity } from './BotSessionContentHeader';
import { readIslandEntryRouteState, requestIslandEntryAlertDisposal } from './islandEntryAlert';
import { useBotIslandVisibleSession } from './useBotIslandVisibleSession';
import { useBotPluginFocusedSession } from './useBotPluginFocusedSession';
import { remoteProjectsStore } from '@/features/device-link/remoteProjectsStore';
import { getDataOwnerGeneration, isDataOwnerGenerationCurrent } from '@/contexts/dataOwnerGeneration';
import type { Session } from '@/lib/ccAgent.types';

function readBotChatIdentity(bot: unknown, botId: string): BotChatIdentity | null {
  if (!bot || typeof bot !== 'object') return null;
  const candidate = bot as { name?: unknown; avatar?: unknown; avatarColor?: unknown };
  return {
    id: botId,
    name: typeof candidate.name === 'string' ? candidate.name : '',
    avatar: typeof candidate.avatar === 'string' ? candidate.avatar : null,
    avatarColor: typeof candidate.avatarColor === 'string' ? candidate.avatarColor : null,
  };
}

/** History and hidden IM transcripts share the main-window read-only task view. */
export function BotHistorySessionView() {
  const { botId, sessionId, deviceId } = useParams();
  return <BotHistorySessionGateView key={JSON.stringify([deviceId, botId, sessionId])} />;
}

function BotHistorySessionGateView() {
  const { t } = useTranslation();
  const { botId, sessionId, deviceId } = useParams();
  const [allowed, setAllowed] = useState<boolean | null>(null);
  useBotPluginFocusedSession(allowed === true && !deviceId ? sessionId ?? null : null);
  useBotIslandVisibleSession(allowed === true ? sessionId ?? null : null);
  // 灵动岛点进来的那张卡,只在本门禁确认并显示了这段历史后才处置;被重定向走则保留。
  const islandEntryId = readIslandEntryRouteState(useLocation().state);
  useEffect(() => {
    if (allowed === true && sessionId && islandEntryId) requestIslandEntryAlertDisposal(sessionId, islandEntryId);
  }, [allowed, sessionId, islandEntryId]);
  /**
   * 归档的对话里,那个伙伴仍然是那个伙伴:气泡挂 TA 的头像,顶栏是 TA 的 lockup。
   * 这个视图本来就已经查过 `bots.history(botId)` 确认归属,顺手把身份取回来即可
   * ——只读路径,不影响任何写入。
   */
  const [identity, setIdentity] = useState<BotChatIdentity | null>(null);

  useEffect(() => {
    let cancelled = false;
    const owner = getDataOwnerGeneration();
    const current = () => !cancelled && isDataOwnerGenerationCurrent(owner);
    if (!botId || !sessionId) {
      setAllowed(false);
      return () => {
        cancelled = true;
      };
    }
    const profile = deviceId
      ? window.electronAPI.deviceLink.invoke(deviceId, 'local-db:bots:get', [botId])
      : window.electronAPI.localDb.bots.get(botId);
    const personalLink = (bot: unknown) => {
      const rows = (bot as { sessions?: Array<{ id: string; role?: string; status?: string }> } | null)?.sessions;
      return rows?.some(row => row.id === sessionId && row.status !== 'deleted'
        && (row.role === 'history' || row.role === 'canonical'
          || (!deviceId && row.role === 'channel'))) ?? false;
    };
    const history = deviceId
      ? profile.then(bot => personalLink(bot) ? [{ id: sessionId }] : [])
      : window.electronAPI.localDb.bots.history(botId).then(async rows =>
          rows.some(row => (row as { id?: string })?.id === sessionId)
            ? rows
            : personalLink(await profile) ? [{ id: sessionId }] : []);
    void history
      .then(async (rows) => {
        if (!current()) return;
        const found = rows.some(
          (row) =>
            !!row &&
            typeof row === 'object' &&
            'id' in row &&
            typeof (row as { id?: unknown }).id === 'string' &&
            (row as { id: string }).id === sessionId,
        );
        if (found && deviceId) {
          const origin = remoteProjectsStore.getSessionDeviceId(sessionId);
          if (origin && origin !== deviceId) throw new Error('Conflicting remote session owner');
          remoteProjectsStore.pinSessionOrigin(deviceId, sessionId);
          const isReadCurrent = remoteProjectsStore.captureSessionRead(deviceId, sessionId);
          const value = await window.electronAPI.deviceLink.invoke(deviceId, 'local-db:sessions:get', [sessionId]);
          if (!current()) return;
          const readIsCurrent = isReadCurrent();
          const mirror = remoteProjectsStore.getDeviceSessions(deviceId).find(row => row.id === sessionId);
          const session = readIsCurrent ? value as Session | null : mirror;
          if (!session || session.id !== sessionId
            || (session.status !== 'active' && session.status !== 'archived')
            || (!readIsCurrent && session.deviceLinkConnectionStatus !== 'connected')) {
            throw new Error('Invalid remote companion history');
          }
          // The shared chat reads remote metadata only from this mirror, including
          // the header. Preserve the status bucket and any newer push/activity.
          if (readIsCurrent) remoteProjectsStore.mergeDeviceSessions(
            deviceId, remoteProjectsStore.getDeviceName(deviceId) ?? deviceId,
            [isReadCurrent.mergeActivity(session)], session.status,
          );
        }
        setAllowed(found);
      })
      .catch(() => {
        if (current()) setAllowed(false);
      });
    // Profile 装饰可异步补齐；已验证的伙伴历史始终保持伙伴界面。
    void profile
      .then((bot) => {
        if (current()) setIdentity(readBotChatIdentity(bot, botId));
      })
      .catch(() => {
        if (current()) setIdentity(null);
      });
    return () => {
      cancelled = true;
    };
  }, [botId, sessionId, deviceId]);

  if (allowed === null) {
    return (
      <main className="flex h-full items-center justify-center bg-[var(--surface)]">
        <p className="text-13 text-[var(--text-secondary)]">{t('ccAgent.common.loading')}</p>
      </main>
    );
  }
  if (!allowed || !botId || !sessionId) {
    return <Navigate to={botId
      ? deviceId ? `/bots/remote/${encodeURIComponent(deviceId)}/${encodeURIComponent(botId)}`
        : `/bots/${encodeURIComponent(botId)}?settings=1`
      : '/bots'} replace />;
  }
  return (
    <CCAgentSessionView
      readOnly
      botIdentity={{ ...(identity ?? { id: botId, name: '' }), sessionId, ...(deviceId ? { deviceId } : {}) }}
    />
  );
}
