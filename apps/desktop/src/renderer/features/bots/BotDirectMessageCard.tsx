import { useEffect, useId, useRef, useState } from 'react';
import { ArrowLeftRight, ChevronDown, ChevronUp, SquareArrowOutUpRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate } from 'react-router-dom';

import { MarkdownRenderer } from '@/components/chat/MarkdownRenderer';
import { Spinner } from '@/components/ui/spinner';
import { getDataOwnerGeneration, isDataOwnerGenerationCurrent } from '@/contexts/dataOwnerGeneration';
import { remoteProjectsStore } from '@/features/device-link/remoteProjectsStore';
import { makerApiForDevice } from '@/lib/makerTransport';
import { cn } from '@/lib/utils';
import {
  readBotDirectMessageMeta,
  type BotDirectMessageMeta,
  type BotDirectMessageThreadView,
} from '../../../shared/botDirectMessage';
import { BotAvatar } from './BotAvatar';
import { useBotProfiles } from './botStore';
import { formatBotMessageGroupTime } from './botConversationTimeline';

export function BotDirectMessageCard({ data, sessionId }: { data?: Record<string, unknown>; sessionId?: string }) {
  const meta = readBotDirectMessageMeta(data);
  if (!meta) return null;
  return <BotDirectMessageCardBody meta={meta} sessionId={sessionId} />;
}

type ThreadState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ready'; thread: BotDirectMessageThreadView }
  | { kind: 'unavailable' };

const chipClass = cn(
  'inline-flex h-6 max-w-full shrink-0 items-center gap-1 rounded-full bg-[var(--surface-chip)] px-2.5 text-11',
  'text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)]',
  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--focus-ring)]',
);

/**
 * A teammate message trace in the reply column: who, an excerpt, and the
 * exchange inline on demand. It never adds unread state or a left-list entry.
 */
function BotDirectMessageCardBody({ meta, sessionId }: { meta: BotDirectMessageMeta; sessionId?: string }) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const allProfiles = useBotProfiles();
  const [deviceId] = useState(() => sessionId ? remoteProjectsStore.getSessionDeviceId(sessionId) : null);
  const profiles = deviceId ? [] : allProfiles;
  const [open, setOpen] = useState(false);
  const [thread, setThread] = useState<ThreadState>({ kind: 'idle' });
  const threadId = useId();
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const profileFor = (id: string, fallbackName: string) => {
    const profile = profiles.find((item) => item.id === id);
    return {
      name: profile?.name || fallbackName || id,
      avatar: profile?.avatar ?? null,
      avatarColor: profile?.avatarColor ?? null,
    };
  };
  const peer = profileFor(meta.peerBotId, meta.peerBotName);
  const label = t(
    meta.direction === 'sent' ? 'bots.directMessage.sentHeader' : 'bots.directMessage.receivedHeader',
    { name: peer.name },
  );

  const load = async () => {
    const owner = getDataOwnerGeneration();
    setThread({ kind: 'loading' });
    try {
      const result = await (deviceId ? makerApiForDevice(deviceId) : window.electronAPI.maker)
        .getBotDirectMessageThread(meta.threadId, meta.viewerBotId);
      if (!alive.current || !isDataOwnerGenerationCurrent(owner)) return;
      setThread(result.ok ? { kind: 'ready', thread: result.thread } : { kind: 'unavailable' });
    } catch {
      if (alive.current && isDataOwnerGenerationCurrent(owner)) setThread({ kind: 'unavailable' });
    }
  };
  const toggle = () => {
    const next = !open;
    setOpen(next);
    // Each expansion reads the latest exchange; collapsing keeps the last copy.
    if (next && thread.kind !== 'loading') void load();
  };
  const openFull = () =>
    navigate(
      `/bots/${encodeURIComponent(meta.viewerBotId)}/direct/${encodeURIComponent(meta.threadId)}${deviceId ? `?deviceId=${encodeURIComponent(deviceId)}` : ''}`,
      { state: { botDirectMessageReturnTo: `${location.pathname}${location.search}` } },
    );
  const loaded = thread.kind === 'ready' ? thread.thread : null;
  const toggleLabel = loaded
    ? `${t('bots.directMessage.exchangeCountShort', { count: loaded.messages.length })} · ${t(
        open ? 'bots.directMessage.collapse' : 'bots.directMessage.expand',
      )}`
    : t(open ? 'bots.directMessage.collapse' : 'bots.directMessage.expandThread');

  return (
    <div
      data-bot-direct-message={meta.direction}
      className="my-2 w-full min-w-0 max-w-[560px] rounded-xl border border-[var(--msg-tool-card-border)] bg-[var(--msg-tool-card-bg)] px-3 py-2.5"
    >
      <div className="flex min-w-0 items-center gap-2">
        <BotAvatar bot={peer} size="xs" />
        <span className="min-w-0 flex-1 truncate text-13 font-medium text-[var(--text-primary)]">{label}</span>
      </div>
      {meta.preview.trim() ? (
        <p className="mt-1.5 line-clamp-2 whitespace-pre-wrap break-words rounded-lg border-l-2 border-[var(--msg-blockquote-border)] bg-[var(--surface-chip)] px-2.5 py-1.5 text-13 leading-[1.6] text-[var(--text-primary)]">
          {meta.preview.trim()}
        </p>
      ) : null}
      <div className="mt-2 flex min-w-0 flex-wrap items-center gap-1.5">
        <button type="button" className={chipClass} aria-expanded={open} aria-controls={threadId} onClick={toggle}>
          <ArrowLeftRight size={12} aria-hidden="true" />
          {toggleLabel}
          {open ? <ChevronUp size={12} aria-hidden="true" /> : <ChevronDown size={12} aria-hidden="true" />}
        </button>
        <span className="ml-auto flex shrink-0 items-center gap-1">
          <button type="button" className={chipClass} onClick={openFull} title={t('bots.directMessage.open')}>
            <SquareArrowOutUpRight size={12} aria-hidden="true" />
            {t('bots.directMessage.fullThread')}
          </button>
        </span>
      </div>
      {open ? (
        <div id={threadId} className="mt-2 border-t border-[var(--border-default)] pt-2">
          {thread.kind === 'loading' && !loaded ? (
            <div className="flex justify-center py-2">
              <Spinner size={14} className="text-[var(--text-tertiary)]" />
            </div>
          ) : null}
          {thread.kind === 'unavailable' ? (
            <p className="py-1 text-12 text-[var(--text-tertiary)]">{t('bots.directMessage.unavailable')}</p>
          ) : null}
          {loaded ? (
            <div className="flex flex-col gap-2.5">
              {loaded.messages.map((message) => {
                const sender = profileFor(message.senderBotId, message.senderBotName);
                return (
                  <article key={message.id} className="flex min-w-0 items-start gap-2">
                    <BotAvatar bot={sender} size="xs" />
                    <div className="min-w-0 flex-1">
                      <div className="text-11 text-[var(--text-tertiary)]">
                        {sender.name} · {formatBotMessageGroupTime(message.createdAt, i18n.language)}
                      </div>
                      <div className="min-w-0 break-words text-13 text-[var(--text-primary)]">
                        <MarkdownRenderer workingDir="" content={message.content} allowPrivilegedLinks={false} />
                      </div>
                    </div>
                  </article>
                );
              })}
              {loaded.messages.length === 0 ? (
                <p className="text-12 text-[var(--text-tertiary)]">{t('bots.directMessage.empty')}</p>
              ) : null}
              {loaded.status === 'closed' ? (
                <p className="text-center text-11 text-[var(--text-tertiary)]">
                  {t('bots.directMessage.threadClosed')}
                </p>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
