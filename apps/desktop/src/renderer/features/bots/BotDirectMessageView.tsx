import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowLeftRight, CircleAlert, LockKeyhole } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate, useParams } from 'react-router-dom';

import { makerApiForDevice } from '@/lib/makerTransport';
import { isDeviceLinkRemotePushCurrent } from '@/lib/remoteDataOwnerPushFence';
import { Spinner } from '@/components/ui/spinner';
import {
  getDataOwnerGeneration,
  isDataOwnerGenerationCurrent,
  isDataOwnerPushCurrent,
} from '@/contexts/dataOwnerGeneration';
import { useRegisterContentHeader } from '../feature-context';
import type { BotDirectMessageThreadView } from '../../../shared/botDirectMessage';
import { BotAvatar } from './BotAvatar';
import { useBotProfiles } from './botStore';
import { formatBotMessageGroupTime } from './botConversationTimeline';

type DirectMessageState =
  | { kind: 'loading' }
  | { kind: 'ready'; thread: BotDirectMessageThreadView }
  | { kind: 'unavailable' };

export function BotDirectMessageView() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const { botId, threadId } = useParams();
  const deviceId = new URLSearchParams(location.search).get('deviceId');
  const allProfiles = useBotProfiles();
  const profiles = deviceId ? [] : allProfiles;
  const [state, setState] = useState<DirectMessageState>({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;
    let requestVersion = 0;
    setState({ kind: 'loading' });
    const load = async () => {
      const version = ++requestVersion;
      const owner = getDataOwnerGeneration();
      if (!botId || !threadId) {
        if (!cancelled) setState({ kind: 'unavailable' });
        return;
      }
      try {
        const result = await (deviceId ? makerApiForDevice(deviceId) : window.electronAPI.maker).getBotDirectMessageThread(threadId, botId);
        if (cancelled || version !== requestVersion || !isDataOwnerGenerationCurrent(owner)) return;
        setState(result.ok ? { kind: 'ready', thread: result.thread } : { kind: 'unavailable' });
      } catch {
        if (!cancelled && version === requestVersion && isDataOwnerGenerationCurrent(owner)) {
          setState({ kind: 'unavailable' });
        }
      }
    };
    void load();
    const unsubscribe = deviceId
      ? window.electronAPI.deviceLink.onRemotePush((push, stamp) => {
          if (push.deviceId !== deviceId || push.channel !== 'maker:bot-direct-message:changed'
            || !isDeviceLinkRemotePushCurrent(push, stamp)) return;
          if ((push.payload as { threadId?: string })?.threadId === threadId) void load();
        })
      : window.electronAPI.maker.onBotDirectMessageChanged((payload, ownerStamp) => {
          if (!isDataOwnerPushCurrent(ownerStamp) || payload.threadId !== threadId) return;
          void load();
        });
    const offStatus = deviceId ? window.electronAPI.deviceLink.onStatusChanged((state) => {
      if (state.status === 'online') void load();
      else requestVersion += 1;
    }) : () => {};
    return () => {
      offStatus();
      cancelled = true;
      requestVersion += 1;
      unsubscribe();
    };
  }, [botId, deviceId, threadId]);

  const thread = state.kind === 'ready' ? state.thread : null;
  const profileFor = useCallback(
    (id: string, fallbackName: string) => {
      const profile = profiles.find((item) => item.id === id);
      return {
        name: profile?.name || fallbackName || id,
        avatar: profile?.avatar ?? null,
        avatarColor: profile?.avatarColor ?? null,
      };
    },
    [profiles],
  );
  const [leftBot, rightBot] = useMemo(() => {
    if (!thread || !botId) return [null, null] as const;
    const peerId = thread.botAId === botId ? thread.botBId : thread.botAId;
    const peerName = thread.botAId === peerId ? thread.botAName : thread.botBName;
    const viewerName = thread.botAId === botId ? thread.botAName : thread.botBName;
    return [profileFor(botId, viewerName), profileFor(peerId, peerName)] as const;
  }, [botId, profileFor, thread]);
  const header = useMemo(
    () =>
      leftBot && rightBot ? (
        <div className="flex min-w-0 items-center gap-2 px-2 text-13 font-medium text-[var(--text-primary)]">
          <BotAvatar bot={leftBot} size="xs" />
          <span className="truncate">{leftBot.name}</span>
          <ArrowLeftRight size={13} className="shrink-0 text-[var(--text-tertiary)]" aria-hidden />
          <BotAvatar bot={rightBot} size="xs" />
          <span className="truncate">{rightBot.name}</span>
        </div>
      ) : null,
    [leftBot, rightBot],
  );
  useRegisterContentHeader(header);

  const close = () => {
    const candidate = (location.state as { botDirectMessageReturnTo?: unknown } | null)
      ?.botDirectMessageReturnTo;
    const returnTo =
      typeof candidate === 'string' &&
      candidate.startsWith('/bots/') &&
      !candidate.includes('/direct/')
        ? candidate
        : deviceId && botId
          ? `/bots/remote/${encodeURIComponent(deviceId)}/${encodeURIComponent(botId)}`
          : botId
          ? `/bots/${encodeURIComponent(botId)}`
          : '/bots';
    navigate(returnTo, { replace: true });
  };

  if (state.kind === 'loading') {
    return (
      <main className="flex h-full items-center justify-center bg-[var(--surface)]">
        <Spinner size={20} className="text-[var(--text-tertiary)]" />
      </main>
    );
  }
  if (!thread || !botId) {
    return (
      <main className="flex h-full items-center justify-center bg-[var(--surface)] p-6">
        <section className="w-full max-w-md rounded-[12px] border border-[var(--border-default)] bg-[var(--surface-elevated)] p-5 text-center">
          <CircleAlert size={24} className="mx-auto text-[var(--text-danger)]" aria-hidden />
          <p className="mt-3 text-13 text-[var(--text-secondary)]">
            {t('bots.directMessage.unavailable')}
          </p>
          <button
            type="button"
            onClick={close}
            className="mt-4 h-9 rounded-full border border-[var(--border-default)] px-4 text-12 text-[var(--text-primary)] hover:bg-[var(--surface-hover)]"
          >
            {t('bots.directMessage.close')}
          </button>
        </section>
      </main>
    );
  }

  return (
    <main className="flex h-full min-w-0 flex-col overflow-hidden bg-[var(--surface)]">
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-6">
        <div className="mx-auto flex w-full max-w-[760px] flex-col gap-4">
          {thread.messages.map((message) => {
            const ownSide = message.senderBotId === botId;
            const sender = profileFor(message.senderBotId, message.senderBotName);
            return (
              <article
                key={message.id}
                className={`flex items-start gap-2.5 ${ownSide ? 'justify-end' : 'justify-start'}`}
              >
                {!ownSide ? <BotAvatar bot={sender} size="sm" /> : null}
                <div
                  className={`min-w-0 max-w-[74%] ${ownSide ? 'items-end' : 'items-start'} flex flex-col`}
                >
                  <div className="mb-1 px-1 text-11 text-[var(--text-tertiary)]">
                    {sender.name} · {formatBotMessageGroupTime(message.createdAt, i18n.language)}
                  </div>
                  <div
                    className={`whitespace-pre-wrap break-words rounded-[12px] border px-3.5 py-2.5 text-14 leading-[1.6] text-[var(--text-primary)] ${
                      ownSide
                        ? 'border-[var(--msg-user-border)] bg-[var(--msg-user-bg)]'
                        : 'border-[var(--border-default)] bg-[var(--surface-chip)]'
                    }`}
                  >
                    {message.content}
                  </div>
                </div>
                {ownSide ? <BotAvatar bot={sender} size="sm" /> : null}
              </article>
            );
          })}
          {thread.messages.length === 0 ? (
            <p className="py-12 text-center text-12 text-[var(--text-tertiary)]">
              {t('bots.directMessage.empty')}
            </p>
          ) : null}
          {thread.closeReason === 'message-limit' ? (
            <div className="flex items-center justify-center gap-2 py-2 text-11 text-[var(--text-tertiary)]">
              <div className="h-px flex-1 bg-[var(--border-default)]" />
              <span>{t('bots.directMessage.limitReached')}</span>
              <div className="h-px flex-1 bg-[var(--border-default)]" />
            </div>
          ) : null}
        </div>
      </div>
      <footer className="border-t border-[var(--border-default)] bg-[var(--surface)] px-5 py-3">
        <div className="mx-auto flex w-full max-w-[760px] items-center justify-center gap-3">
          <span className="inline-flex items-center gap-1.5 text-11 text-[var(--text-tertiary)]">
            <LockKeyhole size={12} aria-hidden />
            {t('bots.directMessage.readOnly')}
          </span>
          <button
            type="button"
            onClick={close}
            className="h-8 rounded-full border border-[var(--border-default)] px-3 text-11 text-[var(--text-primary)] hover:bg-[var(--surface-hover)]"
          >
            {t('bots.directMessage.close')}
          </button>
        </div>
      </footer>
    </main>
  );
}
