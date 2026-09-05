import { useMemo, useState } from 'react';
import { ArrowLeftRight, ChevronRight } from 'lucide-react';
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
    <div className="flex w-full select-none items-center gap-3 py-2" role="separator">
      <div className="h-px flex-1 bg-[var(--msg-tool-card-border)]" />
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
          'flex min-w-0 max-w-full items-center gap-1.5 rounded-full border',
          'border-[var(--msg-tool-card-border)] bg-[var(--surface)] px-2.5 py-1',
          'text-11 text-[var(--text-secondary)] transition-colors',
          'hover:bg-[var(--msg-tool-card-bg)] hover:text-[var(--text-primary)]',
        )}
        title={t('bots.directMessage.open')}
      >
        <BotAvatar bot={peer} size="xs" />
        <ArrowLeftRight size={12} className="shrink-0 text-[var(--text-tertiary)]" aria-hidden />
        <span className="truncate">{label}</span>
        <ChevronRight size={12} className="shrink-0 text-[var(--text-tertiary)]" aria-hidden />
      </button>
      <div className="h-px flex-1 bg-[var(--msg-tool-card-border)]" />
    </div>
  );
}
