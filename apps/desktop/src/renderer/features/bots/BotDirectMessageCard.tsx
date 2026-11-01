import { useMemo, useState } from 'react';
import { ArrowLeftRight, ChevronRight, CircleAlert, Clock } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate } from 'react-router-dom';

import { remoteProjectsStore } from '@/features/device-link/remoteProjectsStore';
import { cn } from '@/lib/utils';
import { readBotDirectMessageMeta, type BotDirectMessageMeta } from '../../../shared/botDirectMessage';
import { BotAvatar } from './BotAvatar';
import { useBotProfiles } from './botStore';

export function BotDirectMessageCard({ data, sessionId }: { data?: Record<string, unknown>; sessionId?: string }) {
  const meta = readBotDirectMessageMeta(data);
  if (!meta) return null;
  return <BotDirectMessageCardBody meta={meta} sessionId={sessionId} />;
}

function BotDirectMessageCardBody({ meta, sessionId }: { meta: BotDirectMessageMeta; sessionId?: string }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const allProfiles = useBotProfiles();
  const [deviceId] = useState(() => sessionId ? remoteProjectsStore.getSessionDeviceId(sessionId) : null);
  const profiles = deviceId ? [] : allProfiles;

  const peer = useMemo(() => {
    const profile = profiles.find((item) => item.id === meta.peerBotId);
    return {
      name: profile?.name || meta.peerBotName || meta.peerBotId,
      avatar: profile?.avatar ?? null,
      avatarColor: profile?.avatarColor ?? null,
    };
  }, [meta.peerBotId, meta.peerBotName, profiles]);
  const label = t(
    meta.direction === 'sent'
      ? 'bots.directMessage.sentTo'
      : 'bots.directMessage.receivedFrom',
    { name: peer.name },
  );

  return (
    <div className="flex w-full min-w-0 select-none items-center py-1" data-bot-direct-message={meta.direction}>
      <button
        type="button"
        onClick={() =>
          navigate(
            `/bots/${encodeURIComponent(meta.viewerBotId)}/direct/${encodeURIComponent(meta.threadId)}${deviceId ? `?deviceId=${encodeURIComponent(deviceId)}` : ''}`,
            {
              state: {
                botDirectMessageReturnTo: `${location.pathname}${location.search}`,
              },
            },
          )
        }
        className={cn(
          'flex min-h-7 min-w-0 max-w-full items-center gap-1.5 rounded-full border',
          'border-[var(--msg-tool-card-border)] bg-[var(--surface)] px-2.5 py-1',
          'text-11 text-[var(--text-secondary)] transition-colors',
          'hover:bg-[var(--msg-tool-card-bg)] hover:text-[var(--text-primary)]',
          'focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--focus-ring)]',
        )}
        title={t('bots.directMessage.open')}
      >
        <BotAvatar bot={peer} size="xs" />
        <ArrowLeftRight size={12} className="shrink-0 text-[var(--text-tertiary)]" aria-hidden />
        <span className="truncate" title={label}>{label}</span>
        {meta.deliveryStatus === 'failed' ? (
          <span role="status" className="inline-flex shrink-0 items-center gap-1 text-[var(--text-danger)]">
            <CircleAlert size={12} aria-hidden />
            {t('bots.directMessage.notDelivered')}
          </span>
        ) : null}
        {meta.deliveryStatus === 'queued' ? (
          <span role="status" className="inline-flex shrink-0 items-center gap-1 text-[var(--text-tertiary)]">
            <Clock size={12} aria-hidden />
            {t('bots.directMessage.queued')}
          </span>
        ) : null}
        <ChevronRight size={12} className="shrink-0 text-[var(--text-tertiary)]" aria-hidden />
      </button>
    </div>
  );
}
