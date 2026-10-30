import { useCallback, useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { ChevronDown, ChevronUp } from 'lucide-react-native';
import { useFocusEffect } from 'expo-router';
import { useTranslation } from 'react-i18next';
import type { BotGroupRemoteChatData } from '@cindy/maker-shared/botGroupChat';
import { useAuth } from '@/auth/AuthContext';
import { useDeviceLink } from '@/device-link/DeviceLinkContext';
import { getRemoteResource } from '@/device-link/remoteResources';
import { startFocusedTopicSubscription } from '@/device-link/focusedTopicSubscription';
import { BOT_GROUP_CLIENT_PRIMITIVES, botGroupChatDataFromResource, botGroupResourceRef } from './botGroupRemote';
import { BotGroupSpeakerRow } from './BotGroupSpeakerRow';
import type { BotGroupIdentity } from './BotGroupAvatars';
import { Text } from '@/components/AppText';
import { iconStroke, useTheme, useThemedStyles, type ThemeColors } from '@/theme';
import { fontWeight, iconSize, lineHeight, radius, spacing, typeScale } from '@/theme/tokens';

/** Live work is separate from messages. Only an owned companion's computer can
 * resolve its execution to a task; another member's private task is never queried. */
export function BotGroupWorkArea({ group, deviceId, online, identityFor, onError }: {
  group: BotGroupRemoteChatData; deviceId: string; online: boolean;
  identityFor(botId: string, name: string): BotGroupIdentity;
  onError(message: string | null): void;
}) {
  const { accountGeneration } = useAuth();
  const { t, i18n } = useTranslation();
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const disclosureScope = JSON.stringify([accountGeneration, group.id, deviceId]);
  const [expandedScope, setExpandedScope] = useState<string | null>(null);
  const expanded = expandedScope === disclosureScope;
  useEffect(() => {
    setExpandedScope(null);
  }, [disclosureScope, group.round.status]);
  const { invoke, openLink, connectionEpoch, presenceVersion, getPresenceAvailability, subscribe, unsubscribe, onRemoteResourceChanged } = useDeviceLink();
  const candidates = group.round.speakers.flatMap(speaker => {
    const member = group.members.find(member => member.botId === speaker.botId);
    return !speaker.sessionId && speaker.executionId && member?.isOwned && member.homeDeviceId
      ? [{ executionId: speaker.executionId, deviceId: member.homeDeviceId }] : [];
  });
  const scope = JSON.stringify([accountGeneration, group.id, deviceId, candidates]);
  const [resolved, setResolved] = useState<{ scope: string; targets: Map<string, { deviceId: string; sessionId: string; botId: string }> }>();
  useFocusEffect(useCallback(() => {
    if (!online || !candidates.length) return;
    let cancelled = false;
    let reading = false;
    let again = false;
    const hosts = [...new Set(candidates.map(candidate => candidate.deviceId))];
    const read = async () => {
      if (cancelled) return;
      if (reading) { again = true; return; }
      reading = true;
      const targets = new Map<string, { deviceId: string; sessionId: string; botId: string }>();
      await Promise.all(hosts.map(async host => {
        if (getPresenceAvailability(host) === false) return;
        try {
          await openLink(host);
          const resource = await getRemoteResource(invoke, { deviceId: host, deviceName: '' }, botGroupResourceRef(group.id), i18n.language, BOT_GROUP_CLIENT_PRIMITIVES);
          const remote = botGroupChatDataFromResource(resource);
          if (remote?.id !== group.id) return;
          for (const candidate of candidates.filter(candidate => candidate.deviceId === host)) {
            const speaker = remote.round.speakers.find(speaker => speaker.executionId === candidate.executionId);
            if (speaker?.sessionId) targets.set(candidate.executionId, { deviceId: host, sessionId: speaker.sessionId, botId: speaker.botId });
          }
        } catch { /* Generic server status remains available while the computer cannot be reached. */ }
      }));
      if (!cancelled) setResolved({ scope, targets });
      reading = false;
      if (again) { again = false; void read(); }
    };
    const off = onRemoteResourceChanged((host, payload) => {
      if (hosts.includes(host) && payload.collectionId === 'bot-groups'
        && (!payload.resourceRefs?.length || payload.resourceRefs.some(ref => ref.id === group.id))) void read();
    });
    const topics = hosts.map(host => startFocusedTopicSubscription({ deviceId: host, owner: `group-work:${group.id}`, topic: 'sessions', subscribe, unsubscribe }));
    void read();
    return () => { cancelled = true; off(); topics.forEach(offTopic => offTopic()); };
  }, [scope, online, connectionEpoch, presenceVersion, invoke, openLink, subscribe, unsubscribe, onRemoteResourceChanged, getPresenceAvailability, i18n.language]));
  if (group.round.status !== 'running' || !group.round.speakers.length) return null;
  // Count teammates, not executions; a teammate with active work and a queued
  // follow-up belongs to the active count only.
  const activityByBot = new Map<string, boolean>();
  for (const speaker of group.round.speakers) {
    if (!group.members.some(member => member.botId === speaker.botId)) continue;
    activityByBot.set(speaker.botId, activityByBot.get(speaker.botId) === true || speaker.executionStatus !== 'queued');
  }
  if (!activityByBot.size) return null;
  const active = [...activityByBot.values()].filter(Boolean).length;
  const queued = activityByBot.size - active;
  const summary = [queued ? t('groupChat.work.queued', { count: queued }) : '', active ? t('groupChat.work.active', { count: active }) : ''].filter(Boolean).join(' · ');
  const disclosure = t(expanded ? 'groupChat.work.collapse' : 'groupChat.work.expand');
  const Chevron = expanded ? ChevronUp : ChevronDown;
  return <View testID="botGroup.work" style={styles.container}>
    <Pressable testID="botGroup.work.toggle" accessibilityRole="button" accessibilityState={{ expanded }}
      accessibilityLabel={`${summary}, ${disclosure}`} onPress={() => setExpandedScope(expanded ? null : disclosureScope)}
      style={({ pressed }) => [styles.summary, pressed && styles.pressed]}>
      <Text numberOfLines={1} style={styles.summaryText}>{summary}</Text>
      <Chevron size={iconSize.sm} strokeWidth={iconStroke.regular} color={colors.textSecondary} />
    </Pressable>
    {/* Keep rows mounted while collapsed: their existing subscriptions discover
        prompts raised after the last group snapshot, and reveal those inline. */}
    <ScrollView testID="botGroup.work.details" style={styles.details} contentContainerStyle={styles.rows} keyboardShouldPersistTaps="handled">
      {group.round.speakers.map(speaker => {
        const member = group.members.find(member => member.botId === speaker.botId);
        if (!member) return null;
        const target = speaker.executionId && resolved?.scope === scope ? resolved.targets.get(speaker.executionId) : undefined;
        const host = target?.deviceId ?? deviceId;
        return <BotGroupSpeakerRow key={speaker.executionId ?? `${speaker.botId}:${speaker.activity}`}
          deviceId={host} online={online && !!host && getPresenceAvailability(host) !== false}
          identity={{ ...identityFor(member.botId, member.name), ...(target ? { botId: target.botId } : {}) }} sessionId={speaker.sessionId ?? target?.sessionId ?? null}
          collapsed={!expanded} revealWaiting={member.isOwned !== false}
          activity={speaker.activity} executionStatus={speaker.executionStatus} stopping={speaker.stopping} onError={onError} />;
      })}
    </ScrollView>
  </View>;
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  container: { flexShrink: 0 },
  summary: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: spacing.sm,
    marginHorizontal: spacing.md, paddingHorizontal: spacing.sm, borderRadius: radius.pill },
  pressed: { backgroundColor: colors.surfaceChip },
  summaryText: { flex: 1, minWidth: 0, color: colors.textSecondary, fontSize: typeScale.footnote,
    lineHeight: lineHeight.caption, fontWeight: fontWeight.regular },
  details: { maxHeight: 220, flexGrow: 0 },
  rows: { paddingHorizontal: spacing.md },
});
