import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Alert, AppState, StyleSheet, View } from 'react-native';
import { useIsFocused, useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import type { BotDmThreadSummary } from '@cindy/maker-shared';
import { useAuth } from '@/auth/AuthContext';
import { useDeviceLink } from '@/device-link/DeviceLinkContext';
import { Text } from '@/components/AppText';
import { fontWeight, lineHeight, spacing, typeScale, useThemedStyles, type ThemeColors } from '@/theme';
import { useRemoteCompanionQuery } from './useRemoteCompanionQuery';
import { ChatThreadSummary } from './ChatThreadSummary';
import { BotGroupMarkdownText } from './BotGroupMessageText';
import { normalizeRemoteMessages, type NormalizedRemoteMessage } from './messageNormalize';
import { remoteSessionStore } from './remoteSessionStore';
import type { RemoteMessage, RemoteSession } from './types';

export interface CompanionThreads {
  threads: ReadonlyMap<string, BotDmThreadSummary>;
  avatar: ReactNode;
  busy: boolean;
  open(message: NormalizedRemoteMessage): void;
}

/** Topics belong to the host's canonical Bot chat; the full task route owns their runtime. */
export function useCompanionThreads({ deviceId, deviceName, botId, sessionId, enabled, avatar, controlsReady = true }: {
  deviceId: string; deviceName: string; botId: string; sessionId: string; enabled: boolean; avatar: ReactNode; controlsReady?: boolean;
}): CompanionThreads | undefined {
  const { accountGeneration } = useAuth();
  const { invoke, connectionEpoch } = useDeviceLink();
  const focused = useIsFocused();
  const router = useRouter();
  const { t } = useTranslation();
  const profile = useRemoteCompanionQuery<{ dmThreadsSupported?: boolean; canonicalSessionId?: string }>(
    deviceId, 'local-db:bots:get', [botId], { enabled: enabled && !!botId });
  const supported = enabled && profile.value?.dmThreadsSupported === true && profile.value.canonicalSessionId === sessionId;
  const query = useRemoteCompanionQuery<BotDmThreadSummary[]>(deviceId, 'local-db:bots:dm-thread:list', [{ botId, rootSessionId: sessionId }],
    { enabled: supported, refreshIntervalMs: 10_000 });
  const scope = JSON.stringify([accountGeneration, connectionEpoch, deviceId, botId, sessionId, enabled, controlsReady, query.online, focused]);
  const current = useRef(scope); current.current = scope;
  const pending = useRef<string | null>(null);
  const attempt = useRef(0);
  const [busyScope, setBusyScope] = useState<string | null>(null);
  useEffect(() => { pending.current = null; setBusyScope(null); return () => { attempt.current += 1; }; }, [scope]);
  const open = useCallback((message: NormalizedRemoteMessage) => {
    if (!supported || !controlsReady || !focused || !query.online || pending.current === scope) return;
    pending.current = scope; setBusyScope(scope);
    const request = ++attempt.current;
    const rootClientId = message.source.clientId || message.source.id;
    const valid = () => current.current === scope && attempt.current === request && AppState.currentState === 'active';
    void (async () => {
      try {
        const result = await invoke<{ ok: boolean; sessionId?: string }>(deviceId, 'local-db:bots:dm-thread:ensure', [{
          botId, rootSessionId: sessionId, rootClientId, title: message.body.replace(/\s+/g, ' ').trim().slice(0, 60),
        }]);
        if (!valid()) return;
        if (!result.ok || !result.sessionId) throw new Error('Topic unavailable');
        const task = await invoke<RemoteSession>(deviceId, 'local-db:sessions:get', [result.sessionId]);
        if (!valid()) return;
        if (!task || task.id !== result.sessionId || task.source !== 'bot') throw new Error('Topic unavailable');
        remoteSessionStore.upsertDeviceSession(deviceId, deviceName, task);
        router.push({ pathname: '/sessions/[sessionId]', params: { sessionId: task.id, deviceId, deviceName,
          resourceCollectionId: 'teammates', resourceKind: 'bot', resourceId: botId,
          resourceThreadRootSessionId: sessionId, resourceThreadRootClientId: rootClientId } });
      } catch {
        if (valid()) Alert.alert(t('groupChat.thread.title'), t('groupChat.thread.openFailed'));
      } finally {
        if (pending.current === scope) pending.current = null;
        if (valid()) setBusyScope(null);
      }
    })();
  }, [botId, controlsReady, deviceId, deviceName, focused, invoke, query.online, router, scope, sessionId, supported, t]);
  const threads = useMemo(() => new Map((query.value ?? []).map(thread => [thread.rootClientId, thread])), [query.value]);
  return useMemo(() => supported ? { threads, avatar, busy: busyScope === scope || !query.online || !controlsReady, open } : undefined,
    [supported, threads, avatar, busyScope, scope, query.online, controlsReady, open]);
}

export function CompanionThreadSummary({ message, topics }: { message: NormalizedRemoteMessage; topics: CompanionThreads }) {
  const thread = topics.threads.get(message.source.clientId || message.source.id);
  return thread ? <ChatThreadSummary avatars={topics.avatar ? [topics.avatar] : []} replyCount={thread.replyCount}
    lastReplyAt={thread.lastReplyAt} onPress={() => topics.open(message)} testID={`companion.thread.${thread.rootClientId}`} /> : null;
}

/** The root stays in the same scroll area as replies; raw wire notes never become UI text. */
export function CompanionThreadRoot({ deviceId, rootSessionId, rootClientId, companionName, enabled }: {
  deviceId: string; rootSessionId: string; rootClientId: string; companionName: string; enabled: boolean;
}) {
  const { t } = useTranslation();
  const styles = useThemedStyles(makeStyles);
  const query = useRemoteCompanionQuery<RemoteMessage[]>(deviceId, 'local-db:messages:around-client-id',
    [rootSessionId, rootClientId, { radius: 0 }], { enabled });
  const root = useMemo(() => normalizeRemoteMessages(query.value ?? [], { sessionSource: 'bot' })
    .find(row => row.source.clientId === rootClientId && (row.kind === 'user' || row.kind === 'assistant')), [query.value, rootClientId]);
  return <View style={styles.root} testID="companion.thread.root">
    {root ? <>
      <Text style={styles.author}>{root.kind === 'user' ? t('message.renderer.you') : companionName}</Text>
      <BotGroupMarkdownText content={root.body} authorKind={root.kind === 'user' ? 'user' : 'bot'} />
      {root.attachments?.map((attachment, index) => <Text key={index} style={styles.author}>{attachment.name}</Text>)}
    </> : <Text style={styles.author}>{t(query.value || query.error ? 'groupChat.thread.sourceUnavailable' : 'groupChat.thread.sourceLoading')}</Text>}
    <Text style={styles.divider}>{t('groupChat.thread.replies')}</Text>
  </View>;
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  root: { gap: spacing.xs, paddingBottom: spacing.md },
  author: { fontSize: typeScale.footnote, lineHeight: lineHeight.caption, fontWeight: fontWeight.regular, color: colors.textSecondary },
  divider: { fontSize: typeScale.footnote, lineHeight: lineHeight.caption, fontWeight: fontWeight.regular, color: colors.textTertiary, borderTopWidth: 1, borderColor: colors.border, marginTop: spacing.md, paddingTop: spacing.md },
});
