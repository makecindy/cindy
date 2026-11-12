import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import { remoteSessionStore } from './remoteSessionStore';
import { startFocusedTopicSubscription } from '@/device-link/focusedTopicSubscription';
import { ActivityIndicator, View, useWindowDimensions } from 'react-native';
import { useTranslation } from 'react-i18next';
import { mobileToolRowWording } from '@/i18n/toolWording';
import { projectBotGroupProcess, readBotGroupProcessMessages, isBotGroupProcessMessageVisible, type BotGroupProcessRef, type BotGroupProcessMessage } from '@cindy/maker-shared/botGroupChat';
import { projectWorkActivities, summarizeTeammateWork, teammateWorkSummaryText } from '@cindy/maker-shared/work-activity-projection';
import { MainWindowActionButton } from '@/components/MobilePrimitives';
import { Text } from '@/components/AppText';
import { useDeviceLink } from '@/device-link/DeviceLinkContext';
import { useAuth } from '@/auth/AuthContext';
import { useTheme } from '@/theme';
import { spacing, typeScale, lineHeight } from '@/theme/tokens';
import { TeammateProcess, TeammateWorkSegment, useTeammateElapsedTitle } from './TeammateProcess';
import { BotGroupMarkdownText } from './BotGroupMessageText';
import { MessagePayloadModal, WorkToolActivityRow } from './MessageRenderer';
import { buildTextPayload, type MessagePayload } from './messagePayload';
import { ImageLightbox } from './ImageLightbox';
import { isLightboxMediaKind } from './messageGallery';
import { useBotGroupRemoteMedia } from './useBotGroupRemoteMedia';
import { normalizeRemoteMessages } from './messageNormalize';
import { buildMessageContentLayout } from './messageContentLayout';
import { fetchMobileToolInputDetail, formatFullToolInput, type MobileToolInputProjection } from './messageToolPayloadProjection';
import type { RemoteMessage } from './types';

type ProcessMessage = BotGroupProcessMessage & Partial<Pick<RemoteMessage, 'id' | 'mobileToolInputProjection'>>;

export function BotGroupProcess({ process, owned, deviceId }: { process: BotGroupProcessRef; owned: boolean; deviceId: string }) {
  const { accountGeneration } = useAuth();
  const executionDeviceId = process.deviceId || deviceId;
  if (!owned || !executionDeviceId) return null;
  return <BotGroupProcessHistory key={`${accountGeneration}:${executionDeviceId}:${process.sessionId}:${process.clientId}:${process.executionId}`} process={process} deviceId={executionDeviceId} />;
}
function BotGroupProcessHistory({ process, deviceId }: { process: BotGroupProcessRef; deviceId: string }) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const { invoke, subscribe, unsubscribe, getSubscriptionIdentity } = useDeviceLink();
  const subscriptionIdentity = getSubscriptionIdentity?.(deviceId, [`session:${process.sessionId}`]) ?? null;
  const refreshAfterRecovery = useRef<(() => void) | null>(null);
  const observedSubscription = useRef(subscriptionIdentity);
  const [result, setResult] = useState<{ messages: BotGroupProcessMessage[]; failed: boolean }>();
  const [attempt, retry] = useState(0);
  const [subscriptionFailed, setSubscriptionFailed] = useState(false);
  const [loading, setLoading] = useState(true);
  const projection = useMemo(() => projectBotGroupProcess(result?.messages ?? [], false), [result]);
  const title = useTeammateElapsedTitle(false, undefined, process.durationMs ?? projection.durationMs);
  useFocusEffect(useCallback(() => {
    let cancelled = false;
    let closed = false;
    setSubscriptionFailed(false);
    let reading = false;
    let refreshPending = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const lease = remoteSessionStore.acquireSessionMessageWork(process.sessionId, true);
    const offTopic = startFocusedTopicSubscription({ deviceId, owner: `group-history:${process.executionId}`,
      topic: `session:${process.sessionId}`, unsubscribe,
      subscribe: async (...args) => {
        try {
          await subscribe(...args);
          if (!cancelled && !closed) setSubscriptionFailed(false);
        } catch (error) {
          if (!cancelled && !closed) setSubscriptionFailed(true);
          throw error;
        }
      } });
    const stopUpdates = () => { if (closed) return; closed = true; clearTimeout(timer); off(); offTopic(); lease.release(); if (!cancelled) setSubscriptionFailed(false); };
    const refresh = () => {
      if (cancelled || closed) return;
      if (reading) { refreshPending = true; return; }
      clearTimeout(timer);
      reading = true;
      refreshPending = false;
      const active = () => !cancelled;
      setLoading(true);
      void readBotGroupProcessMessages(process, clientId => invoke<BotGroupProcessMessage[]>(deviceId,
        'local-db:messages:around-client-id', [process.sessionId, clientId, { radius: 80 }], {
          background: true,
          preSend: () => { if (!active()) throw new Error('Group history read cancelled'); },
        }), () => !active(), () => { if (active()) stopUpdates(); })
        .then(messages => { if (active()) { setResult({ messages, failed: false }); setLoading(false); } })
        .catch(() => { if (active()) { setResult(previous => ({ messages: previous?.messages ?? [], failed: true })); setLoading(false); } })
        .finally(() => {
          reading = false;
          if (refreshPending) refresh();
        });
    };
    const changed = () => {
      if (cancelled || closed) return;
      // Keep one read in flight; pushes and re-ACKs share one trailing refresh.
      if (reading) { refreshPending = true; return; }
      clearTimeout(timer);
      timer = setTimeout(refresh, 50);
    };
    let messages = remoteSessionStore.getMessages(process.sessionId);
    let invalidation = remoteSessionStore.getHistoryInvalidationToken(process.sessionId);
    const off = remoteSessionStore.subscribe(() => {
      const next = remoteSessionStore.getMessages(process.sessionId);
      const nextInvalidation = remoteSessionStore.getHistoryInvalidationToken(process.sessionId);
      const invalidated = nextInvalidation !== undefined && nextInvalidation !== invalidation;
      const origin = remoteSessionStore.getSessionDeviceId(process.sessionId);
      // Hidden group lanes may not be in the task list. The mirror only invalidates;
      // every record is still re-read from this process's explicit execution device.
      if (cancelled || closed || (next === messages && !invalidated) || (origin && origin !== deviceId)) return;
      messages = next;
      invalidation = nextInvalidation;
      changed();
    });
    refreshAfterRecovery.current = changed;
    refresh();
    return () => { cancelled = true; refreshAfterRecovery.current = null; stopUpdates(); };
  }, [invoke, subscribe, unsubscribe, deviceId, process.sessionId, process.clientId, process.executionId, attempt]));
  // A restarted host has no push backlog. Its confirmed subscription changes
  // even when the hidden lane's global history snapshot cannot enter the mirror.
  // Keep this separate from focus ownership so a re-ACK never churns the topic.
  useEffect(() => {
    if (observedSubscription.current === subscriptionIdentity) return;
    observedSubscription.current = subscriptionIdentity;
    if (subscriptionIdentity !== null) {
      setSubscriptionFailed(false);
      refreshAfterRecovery.current?.();
    }
  }, [subscriptionIdentity]);
  const failed = result?.failed || subscriptionFailed;
  // Resolve availability before advertising a disclosure, just like private chat.
  if (!result) return null;
  return <TeammateProcess id={`group-process:${process.executionId}`} title={title}>
    {loading && <ActivityIndicator color={colors.textSecondary} />}
    {failed && !loading && <>
      <Text style={{ color: colors.textSecondary, fontSize: typeScale.footnote, lineHeight: lineHeight.caption }}>{t('chat.teammateProcess.unavailable')}</Text>
      <MainWindowActionButton action={{ label: t('chat.teammateProcess.retry'), onPress: () => retry(v => v + 1) }} />
    </>}
    {projection.segments.length
      ? <BotGroupProcessEntries messages={result.messages} id={`group-process:${process.executionId}`} deviceId={deviceId} sessionId={process.sessionId} />
      : !failed && !loading && <Text style={{ color: colors.textSecondary, fontSize: typeScale.footnote, lineHeight: lineHeight.caption }}>{t('chat.teammateProcess.empty')}</Text>}
  </TeammateProcess>;
}

export function BotGroupProcessEntries({ messages, id, deviceId, sessionId, running = false }: { messages: readonly ProcessMessage[]; id: string; deviceId: string; sessionId: string; running?: boolean }) {
  const { t } = useTranslation();
  const projection = useMemo(() => projectBotGroupProcess(messages, running), [messages, running]);
  const { width } = useWindowDimensions();
  const contentLayout = useMemo(() => buildMessageContentLayout({ screenWidth: width }), [width]);
  const [payload, setPayload] = useState<MessagePayload | null>(null);
  const closePayload = useCallback(() => setPayload(null), []);
  const { invoke } = useDeviceLink();
  const loadToolInput = useCallback((ref: MobileToolInputProjection) => fetchMobileToolInputDetail(ref,
    (messageId, options) => invoke<RemoteMessage[]>(deviceId, 'local-db:messages:around', [sessionId, messageId, options])), [invoke, deviceId, sessionId]);
  const resolveMedia = useBotGroupRemoteMedia(deviceId);
  const lightboxImages = useMemo(() => payload?.kind === 'media' && isLightboxMediaKind(payload.media.kind)
    ? [{ key: payload.media.url, title: payload.title, url: payload.media.url, payload }] : null, [payload]);
  const actions = useMemo(() => ({ isSessionStreaming: running, onOpenPayload: setPayload, onLoadToolInput: loadToolInput,
    onResolveRemoteMedia: resolveMedia }), [running, loadToolInput, resolveMedia]);
  const tools = useMemo(() => new Map(normalizeRemoteMessages(messages
    // Keep non-tool record boundaries: removing commentary can falsely pair a
    // pending tool with an unrelated result through adjacency fallback.
    .filter(isBotGroupProcessMessageVisible)
    .map(message => ({ ...message, id: message.id ?? message.clientId, sessionId,
      role: message.role as RemoteMessage['role'],
      toolUseId: message.toolUseId ?? null, agentMeta: message.agentMeta ?? null,
      createdAt: message.createdAt ?? new Date(0).toISOString(),
    })), { preserveSourceOrder: true, includeInteractionTools: true }).map(tool => [tool.source.clientId, tool])), [messages, sessionId]);
  return <View style={{ gap: spacing.md }}>
    {payload && (lightboxImages && payload.kind === 'media'
      ? <ImageLightbox images={lightboxImages} initialUrl={payload.media.url} onClose={closePayload} onResolveRemoteMedia={resolveMedia} />
      : <MessagePayloadModal payload={payload} onClose={closePayload} onResolveRemoteMedia={resolveMedia} />)}
    {projection.segments.map((segment, index) => {
      if (segment.kind === 'content') return <BotGroupMarkdownText key={segment.key} content={segment.item.text ?? ''} authorKind="bot" />;
      const active = running && index === projection.segments.length - 1;
      const activities = projectWorkActivities(segment.items, active, true).activities;
      const summary = summarizeTeammateWork(activities);
      summary.thinking ||= segment.items.some(item => item.kind === 'thinking');
      return <TeammateWorkSegment key={segment.key} id={`${id}:${segment.key}`} title={teammateWorkSummaryText(summary, active, t, mobileToolRowWording)}
        running={active && (summary.running || !summary.toolCount)} hasTools={summary.toolCount > 0}
        last={index === projection.segments.length - 1}>
        {activities.map(activity => {
          if (activity.kind !== 'tool') return null;
          const normalized = tools.get(activity.message.clientId);
          // Dispatch cards retain their summary but omit result details during
          // normalization. Group process rows still need the paired result.
          const tool = normalized?.orcaCard?.variant === 'dispatch'
            ? { ...normalized, secondaryBody: normalized.secondaryBody ?? activity.toolResult }
            : normalized;
          return tool ? <WorkToolActivityRow key={activity.key} actions={actions} contentLayout={contentLayout}
            onOpenInput={!tool.toolInputProjection && activity.message.toolInput != null
              ? () => setPayload(buildTextPayload(t('message.renderer.toolInputTitle', { label: activity.message.toolName ?? tool.label }),
                formatFullToolInput(activity.message.toolInput)))
              : undefined}
            activity={{ ...activity, message: { ...activity.message, normalized: tool } }} /> : null;
        })}
      </TeammateWorkSegment>;
    })}
  </View>;
}
