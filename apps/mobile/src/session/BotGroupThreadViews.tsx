import { useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';
import { ChevronRight, CornerDownRight } from 'lucide-react-native';
import { Stack } from 'expo-router';
import { useTranslation } from 'react-i18next';
import type { BotGroupAttachment, BotGroupMessageView, BotGroupThreadShareView } from '@cindy/maker-shared/botGroupChat';
import { Text } from '@/components/AppText';
import { MainWindowActionButton } from '@/components/MobilePrimitives';
import { fontWeight, iconSize, iconStroke, lineHeight, spacing, typeScale, useTheme, useThemedStyles, type ThemeColors } from '@/theme';
import { ChatThreadSummary } from './ChatThreadSummary';
import { BotGroupAvatar } from './BotGroupAvatars';
import type { BotGroupIdentityLookup } from './BotGroupPlan';
import { BotGroupMessageAttachments } from './BotGroupMessageAttachments';
import { useTriggerMessageLongPress } from './botGroupMessageGestureContext';
import { BotGroupMarkdownText } from './BotGroupMessageText';
import type { BotGroupMentionContext } from './botGroupMentions';
import type { ResolveRemoteMediaFn } from './remoteMedia';

type BotGroupThreadSummary = Pick<BotGroupMessageView, 'replyCount' | 'threadPreview' | 'threadUnread'>;

export function BotGroupThreadEntry({ message, summary, topicExcerpt, identityFor, onPress }: {
  message: BotGroupMessageView; summary?: BotGroupThreadSummary; topicExcerpt?: string; identityFor: BotGroupIdentityLookup; onPress(): void;
}) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const triggerMessageLongPress = useTriggerMessageLongPress();
  const replyCount = summary?.replyCount ?? message.replyCount ?? (message.threadShare ? 1 : 0);
  const threadPreview = summary?.threadPreview ?? message.threadPreview ?? message.threadShare?.threadPreview;
  const threadUnread = summary?.threadUnread ?? message.threadUnread ?? message.threadShare?.threadUnread;
  const responders = threadPreview?.responders ?? threadPreview?.replies ?? [];
  const fromTopic = !!message.threadShare;
  return <ChatThreadSummary compact pill={fromTopic}
    leadingIcon={fromTopic ? <CornerDownRight size={iconSize.xs} strokeWidth={iconStroke.regular} color={colors.textTertiary} /> : undefined}
    leadingLabel={fromTopic ? t('groupChat.thread.repliedToTopic') : undefined}
    leadingTestID={fromTopic ? 'botGroup.thread.shareOrigin' : undefined}
    topicExcerpt={fromTopic ? topicExcerpt : undefined}
    replyCount={replyCount} unreadDot={!!threadUnread?.count}
    trailing={<ChevronRight size={iconSize.xs} strokeWidth={iconStroke.regular} color={colors.textTertiary} />}
    avatars={fromTopic ? [] : responders.slice(0, 3).map(reply => <BotGroupAvatar key={reply.id} deviceId="" online identity={identityFor(reply.authorBotId ?? '', reply.authorName)} size={iconSize.md} />)}
    onPress={onPress} onLongPress={fromTopic ? (triggerMessageLongPress ?? undefined) : undefined} testID={`botGroup.thread.${message.id}`}
    accessibilityHint={threadPreview?.replies.map(reply => `${reply.authorName}: ${reply.text}`).join(' · ')} />;
}

/**
 * Follow / unfollow a Thread. The button flips at once and saves behind it; taps while a save runs
 * are sent after it, so the last tap is what the server keeps. A failure returns to the saved state.
 */
export function BotGroupThreadFollow({ nativeHeader = false, following: saved, online, onChange, onError }: {
  nativeHeader?: boolean; following?: boolean; online: boolean; onChange(value: boolean): Promise<boolean>; onError(error: unknown): void;
}) {
  const { t } = useTranslation();
  const [chosen, setChosen] = useState<boolean | null>(null);
  const saving = useRef(false);
  const wanted = useRef<boolean | null>(null);
  const following = saved === undefined ? undefined : chosen ?? saved;
  const label = t(following ? 'groupChat.thread.following' : 'groupChat.thread.follow');
  const disabled = following === undefined || !online;
  const toggle = () => {
    if (disabled) return;
    const next = !following;
    setChosen(next); wanted.current = next;
    if (saving.current) return;
    saving.current = true;
    void (async () => {
      let sent: boolean | null = null;
      try {
        while (wanted.current !== null && wanted.current !== sent) { sent = wanted.current; await onChange(sent); }
      } catch (error) { onError(error); }
      finally {
        saving.current = false; wanted.current = null; setChosen(null);
      }
    })();
  };
  // Toolbar.View can collapse a custom button into UIKit's overflow.
  if (nativeHeader) return <Stack.Toolbar placement="right">
    {following === undefined ? null : <Stack.Toolbar.Button icon={following ? 'bell.fill' : 'bell'}
      accessibilityLabel={label} selected={following} disabled={disabled} onPress={toggle}>{label}</Stack.Toolbar.Button>}
  </Stack.Toolbar>;
  if (following === undefined) return null;
  return <MainWindowActionButton density="compact" action={{ label, active: following,
    disabled, testID: 'botGroup.thread.follow', onPress: toggle }} />;
}

export function BotGroupThreadShare({ groupId, share, mentionContext, resolveMedia, resolveServerMedia, onRetry, messageKey, messageId, onOpenDiagram, interactive = true, active = true, selectable = false }: {
  groupId?: string;
  messageKey?: string; messageId?: string;
  share: BotGroupThreadShareView; resolveMedia: ResolveRemoteMediaFn;
  onOpenDiagram?: (source: string) => void; interactive?: boolean; active?: boolean; selectable?: boolean;
  mentionContext?: BotGroupMentionContext;
  resolveServerMedia?: (id: string, signal?: AbortSignal) => Promise<BotGroupAttachment>; onRetry?(): void;
}) {
  const { t } = useTranslation(); const styles = useThemedStyles(makeStyles); const { colors } = useTheme();
  return (
    <View style={styles.share} testID="botGroup.thread.share">
      {share.status === 'loading' ? <View style={styles.entry}><ActivityIndicator color={colors.textSecondary} /><Text style={styles.note}>{t('groupChat.thread.sourceLoading')}</Text>{onRetry ? <MainWindowActionButton density="compact" action={{ label: t('groupChat.settings.retry'), onPress: onRetry }} /> : null}</View>
        : share.status === 'unavailable' ? <Text style={styles.note}>{t('groupChat.thread.sourceUnavailable')}</Text>
        : <>
          <Text numberOfLines={1} style={styles.shareAuthor}>
            {share.authorName}{share.edited ? ` · ${t('groupChat.thread.edited')}` : ''}
          </Text>
          {share.attachments.length ? <BotGroupMessageAttachments messageId={share.messageId} roomId={groupId} attachments={share.attachments} align="left" onResolveRemoteMedia={resolveMedia} resolveServerMedia={resolveServerMedia} /> : null}
          <BotGroupMarkdownText readOnly selectable={selectable} messageKey={messageKey} messageId={messageId} richContent active={active} interactive={interactive} onOpenDiagram={onOpenDiagram} content={share.content} authorKind={share.authorKind} mentionContext={mentionContext} />
        </>}
    </View>
  );
}

export function BotGroupThreadPosted({ messageId, shared, onPress }: {
  messageId: string; shared: { messageId: string | null; bySelf: boolean }; onPress(): void;
}) {
  const { t } = useTranslation(); const styles = useThemedStyles(makeStyles); const { colors } = useTheme();
  return <Pressable onPress={onPress} disabled={!shared.messageId} accessibilityRole="button" style={styles.postedEntry} testID={`botGroup.thread.shared.${messageId}`}>
    <CornerDownRight size={iconSize.xs} color={colors.textTertiary} /><Text style={styles.postedNote}>{t(shared.bySelf ? 'groupChat.thread.postedSelf' : 'groupChat.thread.postedOther')}</Text>
  </Pressable>;
}
const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  entry: { minHeight: 44, flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: spacing.sm },
  shareAuthor: { fontSize: typeScale.caption, lineHeight: lineHeight.caption, fontWeight: fontWeight.medium, color: colors.textSecondary },
  note: { fontSize: typeScale.footnote, lineHeight: lineHeight.caption, fontWeight: fontWeight.regular, color: colors.textSecondary },
  postedEntry: { minHeight: 36, flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  postedNote: { flexShrink: 1, fontSize: typeScale.caption, lineHeight: lineHeight.caption, fontWeight: fontWeight.regular, color: colors.textTertiary },
  share: { gap: spacing.xs },
});
