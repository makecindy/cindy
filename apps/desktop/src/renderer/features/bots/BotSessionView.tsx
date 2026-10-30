import { getDataOwnerGeneration, isDataOwnerGenerationCurrent } from '@/contexts/dataOwnerGeneration';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Navigate, useLocation, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { SessionEntryError, sessionEntryFailure } from '@/features/cc-agent/SessionEntryError';
import { Spinner } from '@/components/ui/spinner';
import { CCAgentSessionView } from '@/features/cc-agent/CCAgentSessionView';
import { useCompanionCloud } from './companionCloudStore';
import { withoutShadowedBots } from './companionCloudPresentation';
import { useCompanionArrivalNotice } from './useCompanionArrivalNotice';
import { CompanionShadowBanner } from './CompanionShadowBanner';
import type { ComposerBotMention } from '@/lib/fileTypes';
import { getBotLastReadAt, markBotRead } from './botReadState';
import { getBotProfiles, useBotProfiles } from './botStore';
import type { BotChatIdentity } from './BotSessionContentHeader';
import type { BotChatBinding } from './botChatPresentation';
import { BotDmThreadHost } from './BotDmThreadHost';
import { useBotPluginFocusedSession } from './useBotPluginFocusedSession';
import { canonicalBotSession } from './botSessionOwners';
import { standardSessionRoute } from '@/lib/orcaSessionIdentity';

type BotSessionGate =
  | { kind: 'loading' }
  | {
      kind: 'ready';
      mentions: ComposerBotMention[];
      identity: BotChatBinding;
      /** True only for the Bot's own canonical chat (not a mounted channel route). */
      isCanonical: boolean;
      /** Read position captured before opening advances it; null when entry had no unread replies. */
      unreadBoundaryAt: number | null;
      verified: boolean;
    }
  | { kind: 'unavailable' }
  | { kind: 'ordinary' }
  | { kind: 'error'; reason: ReturnType<typeof sessionEntryFailure> };

function readBotChatIdentity(bot: unknown, botId: string): BotChatIdentity {
  const candidate = (bot ?? {}) as { name?: unknown; avatar?: unknown; avatarColor?: unknown; templateId?: unknown };
  return {
    id: botId,
    templateId: typeof candidate.templateId === 'string' ? candidate.templateId : undefined,
    name: typeof candidate.name === 'string' ? candidate.name : '',
    avatar: typeof candidate.avatar === 'string' ? candidate.avatar : null,
    avatarColor: typeof candidate.avatarColor === 'string' ? candidate.avatarColor : null,
  };
}

function readBotMention(value: unknown, currentBotId: string): ComposerBotMention | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as {
    id?: unknown;
    name?: unknown;
    description?: unknown;
    enabled?: unknown;
    status?: unknown;
  };
  if (
    typeof candidate.id !== 'string' ||
    candidate.id === currentBotId ||
    typeof candidate.name !== 'string' ||
    candidate.enabled === false ||
    (candidate.status !== undefined && candidate.status !== 'active')
  ) {
    return null;
  }
  return {
    id: candidate.id,
    name: candidate.name,
    ...(typeof candidate.description === 'string' && candidate.description.trim()
      ? { description: candidate.description }
      : {}),
  };
}

/**
 * A Bot URL is a navigation projection, not authority to adopt an arbitrary
 * Cindy task. Check the durable Bot link before mounting the writable chat.
 */
export function BotSessionView() {
  const { botId, sessionId } = useParams();
  const owner = getDataOwnerGeneration();
  return <BotSessionGateView key={JSON.stringify([owner.dataOwnerId, owner.generation, botId, sessionId])} />;
}

function BotSessionGateView() {
  const readOwner = useRef(getDataOwnerGeneration());
  const { t } = useTranslation();
  const location = useLocation();
  const { botId, sessionId } = useParams();
  const [reloadVersion, setReloadVersion] = useState(0);
  const [gate, setGate] = useState<BotSessionGate>(() => {
    const profiles = getBotProfiles();
    const profile = profiles.find(bot => bot.id === botId && bot.status === 'active');
    const projection = profile ? canonicalBotSession(profile) : undefined;
    if (!profile || !projection || projection.id !== sessionId || projection.status !== 'active' || !sessionId) return { kind: 'loading' };
    // The already-read local roster selects a display; fresh validation still
    // controls writes and read receipts. Mount the existing message cache now.
    return { kind: 'ready', verified: false, identity: { ...readBotChatIdentity(profile, profile.id), sessionId },
      isCanonical: projection.role === 'canonical', unreadBoundaryAt: projection.role === 'canonical' && ((profile as { unreadCount?: number }).unreadCount ?? 0) > 0 ? getBotLastReadAt(profile.id) : null,
      mentions: profiles.map(bot => readBotMention(bot, profile.id)).filter((bot): bot is ComposerBotMention => bot !== null) };
  });
  // The companion now runs on its main computer: this copy's main task is read only.
  const cloud = useCompanionCloud();
  const shadowed = cloud.demotedBotIds.includes(botId ?? '');
  // The send / delegate choices leave out copies that run on another computer or were retired
  // there, like the roster (cloud-companions.md §6); read live, the gate's list is a one-off.
  const readyMentions = gate.kind === 'ready' ? gate.mentions : null;
  const mentions = useMemo(() => (readyMentions ? withoutShadowedBots(readyMentions, cloud) : []), [readyMentions, cloud]);
  const ownedSessionId = gate.kind === 'ready' ? sessionId ?? null : null;
  useBotPluginFocusedSession(ownedSessionId);
  // The gate proves ownership once; name and avatar edited in settings must
  // still reach the open chat's header and composer.
  const liveProfile = useBotProfiles().find((profile) => profile.id === botId);
  const liveName = liveProfile?.name;
  const liveAvatar = liveProfile?.avatar;
  const liveAvatarColor = liveProfile?.avatarColor;
  const liveInvitationStage = liveProfile?.invitation?.stage;
  useCompanionArrivalNotice(gate.kind === 'ready' ? botId : undefined, liveName);
  const gateIdentity = gate.kind === 'ready' ? gate.identity : null;
  const identity = useMemo(
    () =>
      gateIdentity && liveName !== undefined
        ? {
            ...gateIdentity,
            name: liveName,
            avatar: liveAvatar ?? gateIdentity.avatar,
            avatarColor: liveAvatarColor ?? gateIdentity.avatarColor,
          }
        : gateIdentity,
    [gateIdentity, liveName, liveAvatar, liveAvatarColor],
  );
  // A read-only demoted copy offers no add-to-group entry, like its settings.
  const canonicalChat = gate.kind === 'ready' && gate.verified && gate.isCanonical && !shadowed;
  const chatIdentity = useMemo(
    () => (gateIdentity ? { ...(identity ?? gateIdentity), canonicalChat } : null),
    [gateIdentity, identity, canonicalChat],
  );

  useEffect(() => {
    let cancelled = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const owner = getDataOwnerGeneration();
    if (!botId || !sessionId) {
      setGate({ kind: 'unavailable' });
      return () => {
        cancelled = true;
      };
    }
    setGate(previous => previous.kind === 'ready' ? { ...previous, verified: false } : { kind: 'loading' });
    const lastReadAt = getBotLastReadAt(botId);
    void Promise.all([
      window.electronAPI.localDb.bots.get(botId).catch((error: unknown) => {
        if (sessionEntryFailure(error) === 'missing') return null;
        throw error;
      }),
      window.electronAPI.localDb.bots.list(
        lastReadAt === null ? undefined : { lastReadAtByBotId: { [botId]: lastReadAt } },
      ),
    ])
      .then(([bot, bots]) => {
        if (cancelled || !isDataOwnerGenerationCurrent(owner)) return;
        if (!bot || typeof bot !== 'object') {
          setGate({ kind: 'ordinary' });
          return;
        }
        const sessions = (bot as { sessions?: unknown }).sessions;
        const profileStatus = (bot as { status?: unknown }).status;
        const activeProjection = Array.isArray(sessions)
          ? canonicalBotSession({ sessions: sessions.filter((row) => row && typeof row === 'object') })
          : undefined;
        if (profileStatus !== 'active' || activeProjection?.id !== sessionId || activeProjection?.status !== 'active') {
          // The URL is an old presentation, not evidence that the task disappeared.
          // Ordinary task access still passes through the host's authorization checks.
          setGate({ kind: 'ordinary' });
          return;
        }
        const listedBot = Array.isArray(bots)
          ? bots.find(
              (candidate) =>
                candidate &&
                typeof candidate === 'object' &&
                (candidate as { id?: unknown }).id === botId,
            )
          : undefined;
        const unreadCount =
          listedBot &&
          typeof listedBot === 'object' &&
          typeof (listedBot as { unreadCount?: unknown }).unreadCount === 'number'
            ? (listedBot as { unreadCount: number }).unreadCount
            : 0;
        readOwner.current = owner;
        setGate({
          kind: 'ready',
          verified: true,
          // 欢迎语只属于主任务:渠道路由任务是「别处的对话被接进来」,
          // 在那里冒出一句自我介绍是插话,不是打招呼。
          isCanonical: activeProjection?.role === 'canonical',
          unreadBoundaryAt:
            activeProjection?.role === 'canonical' && unreadCount > 0 ? lastReadAt : null,
          identity: { ...readBotChatIdentity(bot, botId), sessionId },
          mentions: Array.isArray(bots)
            ? bots
                .map((candidate) => readBotMention(candidate, botId))
                .filter((candidate): candidate is ComposerBotMention => candidate !== null)
            : [],
        });
      })
      .catch((error: unknown) => {
        if (cancelled || !isDataOwnerGenerationCurrent(owner)) return;
        const reason = sessionEntryFailure(error);
        const denied = reason !== 'failed' || /NOT_FOUND|FORBIDDEN|PERMISSION_DENIED/.test(String(error));
        setGate(previous => denied ? { kind: 'error', reason: reason === 'failed' ? 'denied' : reason }
          : previous.kind === 'ready' ? { ...previous, verified: false } : { kind: 'error', reason });
        if (!denied) retry = setTimeout(() => { if (isDataOwnerGenerationCurrent(owner)) setReloadVersion(value => value + 1); }, 5_000);
      });
    return () => {
      cancelled = true;
      clearTimeout(retry);
    };
  }, [botId, reloadVersion, sessionId]);

  const onReadThrough = useCallback((at: number) => {
    if (isDataOwnerGenerationCurrent(readOwner.current) && gate.kind === 'ready' && gate.verified && gate.isCanonical && botId && gate.identity.sessionId === sessionId) markBotRead(botId, at);
  }, [botId, gate, sessionId]);

  if (gate.kind === 'ordinary' && sessionId) {
    return <Navigate to={`${standardSessionRoute(sessionId)}${location.search ?? ''}`} state={location.state} replace />;
  }
  if (gate.kind === 'loading') {
    return (
      <main className="flex h-full items-center justify-center bg-[var(--surface)]">
        <Spinner
          size={20}
          className="text-[var(--text-tertiary)]"
          role="status"
          aria-label={t('ccAgent.common.loading')}
        />
      </main>
    );
  }
  if (gate.kind !== 'ready' || !sessionId) {
    return <SessionEntryError reason={gate.kind === 'error' ? gate.reason : 'missing'}
      onRetry={() => setReloadVersion((value) => value + 1)} />;
  }
  const readOnly = !gate.verified || (shadowed && gate.isCanonical);
  return (
    <main className="relative flex h-full min-w-0 overflow-hidden bg-[var(--surface)]">
      {/* 私聊话题只属于本机的伙伴主对话；只读副本没有话题。 */}
      <BotDmThreadHost enabled={gate.isCanonical && !readOnly} bot={identity ?? gate.identity}
        rootSessionId={sessionId} mentions={mentions}>
        {shadowed && gate.isCanonical && botId ? <CompanionShadowBanner botId={botId} name={(identity ?? gate.identity).name} /> : null}
        <div className="min-h-0 flex-1">
          <CCAgentSessionView
            botMentions={mentions}
            botIdentity={chatIdentity ?? gate.identity}
            botInvitationStage={gate.isCanonical ? liveInvitationStage : undefined}
            botUnreadBoundaryAt={gate.unreadBoundaryAt}
            onBotReadThrough={gate.verified && gate.isCanonical ? onReadThrough : undefined}
            {...(readOnly ? { readOnly: true } : {})}
          />
        </div>
      </BotDmThreadHost>
    </main>
  );
}
