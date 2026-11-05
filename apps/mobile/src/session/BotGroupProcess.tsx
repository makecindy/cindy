import { useCallback, useMemo, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import { remoteSessionStore } from './remoteSessionStore';
import { startFocusedTopicSubscription } from '@/device-link/focusedTopicSubscription';
import { ActivityIndicator, View, useWindowDimensions } from 'react-native';
import { useTranslation } from 'react-i18next';
import { mobileToolRowWording } from '@/i18n/toolWording';
import { projectBotGroupProcess, readBotGroupProcessMessages, isBotGroupProcessMessageVisible, type BotGroupProcessRef, type BotGroupProcessMessage } from '@cindy/maker-shared/botGroupChat';
import { projectWorkActivities, summarizeTeammateWork, teammateWorkSummaryText } from '@cindy/maker-shared/work-activity-projection';
import { MainWindowActionButton } from '@/components/MobilePrimitives';
import { useDeviceLink } from '@/device-link/DeviceLinkContext';
import { useAuth } from '@/auth/AuthContext';
import { useTheme } from '@/theme';
import { spacing } from '@/theme/tokens';
import { TeammateProcess, TeammateWorkSegment, useTeammateElapsedTitle } from './TeammateProcess';
import { BotGroupMarkdownText } from './BotGroupMessageText';
import { MessagePayloadModal, WorkToolActivityRow } from './MessageRenderer';
import type { MessagePayload } from './messagePayload';
import { ImageLightbox } from './ImageLightbox';
import { isLightboxMediaKind } from './messageGallery';
import { useBotGroupRemoteMedia } from './useBotGroupRemoteMedia';
import { normalizeRemoteMessages } from './messageNormalize';
import { buildMessageContentLayout } from './messageContentLayout';
import { fetchMobileToolInputDetail, type MobileToolInputProjection } from './messageToolPayloadProjection';
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
  const { invoke, subscribe, unsubscribe } = useDeviceLink();
  const [result, setResult] = useState<{ messages: BotGroupProcessMessage[]; failed: boolean }>();
  const [attempt, retry] = useState(0);
  const [loading, setLoading] = useState(true);
  const projection = useMemo(() => projectBotGroupProcess(result?.messages ?? [], false), [result]);
  const title = useTeammateElapsedTitle(false, undefined, process.durationMs ?? projection.durationMs);
  useFocusEffect(useCallback(() => {
    let cancelled = false;
    let reading = false;
    let refreshPending = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const lease = remoteSessionStore.acquireSessionMessageWork(process.sessionId, true);
    const offTopic = startFocusedTopicSubscription({ deviceId, owner: `group-history:${process.executionId}`,
      topic: `session:${process.sessionId}`, subscribe, unsubscribe });
    let closed = false;
    const stopUpdates = () => { if (closed) return; closed = true; clearTimeout(timer); off(); offTopic(); lease.release(); };
    const refresh = () => {
      if (cancelled || closed) return;
      if (reading) { refreshPending = true; return; }
      clearTimeout(timer);
      reading = true;
      refreshPending = false;
      const active = () => !cancelled;
      setLoading(true);
      void readBotGroupProcessMessages(process, clientId => invoke<BotGroupProcessMessage[]>(deviceId,
        'local-db:messages:around-client-id', [process.sessionId, clientId, { radius: 80 }], { background: true }), () => !active(), () => { if (active()) stopUpdates(); })
        .then(messages => { if (active()) { setResult({ messages, failed: false }); setLoading(false); } })
        .catch(() => { if (active()) { setResult(previous => ({ messages: previous?.messages ?? [], failed: true })); setLoading(false); } })
        .finally(() => {
          reading = false;
          if (refreshPending) refresh();
        });
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
      // Keep one read in flight; changes during it become one trailing read.
      if (reading) { refreshPending = true; return; }
      clearTimeout(timer);
      timer = setTimeout(refresh, 50);
    });
    refresh();
    return () => { cancelled = true; stopUpdates(); };
  }, [invoke, subscribe, unsubscribe, deviceId, process.sessionId, process.clientId, process.executionId, attempt]));
  // Resolve availability before advertising a disclosure, just like private chat.
  if (!result || (!result.failed && !projection.segments.length)) return null;
  return <TeammateProcess id={`group-process:${process.executionId}`} title={title}>
    {loading && <ActivityIndicator color={colors.textSecondary} />}
    {result.failed && !loading && <MainWindowActionButton action={{ label: t('message.renderer.retryPreview'), onPress: () => retry(v => v + 1) }} />}
    {result && <BotGroupProcessEntries messages={result.messages} id={`group-process:${process.executionId}`} deviceId={deviceId} sessionId={process.sessionId} />}
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
          return normalized ? <WorkToolActivityRow key={activity.key} actions={actions} contentLayout={contentLayout}
            activity={{ ...activity, message: { ...activity.message, normalized } }} /> : null;
        })}
      </TeammateWorkSegment>;
    })}
    {running && (!projection.segments.length || projection.segments.at(-1)?.kind === 'content') && <TeammateWorkSegment id={`${id}:pending`} title={t(projection.segments.length ? 'chat.teammateProcess.thinking' : 'chat.teammateProcess.processing')} running hasTools={false} />}
  </View>;
}
