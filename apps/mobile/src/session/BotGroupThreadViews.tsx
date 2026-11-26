import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';
import { Check, Copy, CornerDownRight, Ellipsis, SmilePlus } from 'lucide-react-native';
import { Stack } from 'expo-router';
import { useTranslation } from 'react-i18next';
import type { BotGroupAttachment, BotGroupMessageView, BotGroupThreadShareView } from '@cindy/maker-shared/botGroupChat';
import { Text } from '@/components/AppText';
import { ChatReplyIcon } from '@/components/ChatReplyIcon';
import { MainWindowActionButton } from '@/components/MobilePrimitives';
import { fontWeight, iconSize, lineHeight, radius, spacing, typeScale, useTheme, useThemedStyles, type ThemeColors } from '@/theme';
import { ChatThreadSummary } from './ChatThreadSummary';
import { BotGroupAvatar } from './BotGroupAvatars';
import type { BotGroupIdentityLookup } from './BotGroupPlan';
import { BotGroupMenu } from './BotGroupMenu';
import { BotGroupMessageAttachments } from './BotGroupMessageAttachments';
import { BotGroupMarkdownText } from './BotGroupMessageText';
import type { BotGroupMentionContext } from './botGroupMentions';
import type { ResolveRemoteMediaFn } from './remoteMedia';
import { copyMessageText, type CopyMessageStatus } from './messageActions';
import { CHAT_REACTION_EMOJIS } from '@cindy/maker-shared/optimistic-reactions';
import { useOptimisticReactions } from '@/chat/optimisticReactions';

type BotGroupThreadSummary = Pick<BotGroupMessageView, 'replyCount' | 'threadPreview' | 'threadUnread'>;

export function BotGroupThreadEntry({ message, summary, identityFor, onPress }: {
  message: BotGroupMessageView; summary?: BotGroupThreadSummary; identityFor: BotGroupIdentityLookup; onPress(): void;
}) {
  const replyCount = summary?.replyCount ?? message.replyCount ?? (message.threadShare ? 1 : 0);
  const threadPreview = summary?.threadPreview ?? message.threadPreview ?? message.threadShare?.threadPreview;
  const threadUnread = summary?.threadUnread ?? message.threadUnread ?? message.threadShare?.threadUnread;
  const responders = threadPreview?.responders ?? threadPreview?.replies ?? [];
  return <ChatThreadSummary compact replyCount={replyCount} lastReplyAt={threadUnread?.count ? undefined : threadPreview?.replies.at(-1)?.createdAt}
    avatars={responders.slice(0, 3).map(reply => <BotGroupAvatar key={reply.id} deviceId="" online identity={identityFor(reply.authorBotId ?? '', reply.authorName)} size={iconSize.lg} />)}
    onPress={onPress} testID={`botGroup.thread.${message.id}`}
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
        // The saved value has been applied to the page by now; it shows again.
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

export function BotGroupThreadShare({ share, mentionContext, resolveMedia, resolveServerMedia, onRetry, messageKey, messageId, onOpenDiagram, interactive = true, active = true }: {
  messageKey?: string; messageId?: string;
  share: BotGroupThreadShareView; resolveMedia: ResolveRemoteMediaFn;
  onOpenDiagram?: (source: string) => void; interactive?: boolean; active?: boolean;
  mentionContext?: BotGroupMentionContext;
  resolveServerMedia?: (id: string, signal?: AbortSignal) => Promise<BotGroupAttachment>; onRetry?(): void;
}) {
  const { t } = useTranslation(); const styles = useThemedStyles(makeStyles); const { colors } = useTheme();
  return <View style={styles.share} testID="botGroup.thread.share">
    {share.status === 'available' ? <Text style={styles.note}>{t(share.sharedByAuthor ? 'groupChat.thread.sharedOwn' : 'groupChat.thread.sharedOther', { name: share.authorName })}</Text> : null}
    {share.status === 'loading' ? <View style={styles.entry}><ActivityIndicator color={colors.textSecondary} /><Text style={styles.note}>{t('groupChat.thread.sourceLoading')}</Text>{onRetry ? <MainWindowActionButton density="compact" action={{ label: t('groupChat.settings.retry'), onPress: onRetry }} /> : null}</View>
      : share.status === 'unavailable' ? <Text style={styles.note}>{t('groupChat.thread.sourceUnavailable')}</Text>
      : <>
        <Text style={styles.count}>{share.authorName}{share.edited ? ` · ${t('groupChat.thread.edited')}` : ''}</Text>
        {share.attachments.length ? <BotGroupMessageAttachments messageId={share.messageId} attachments={share.attachments} align="left" onResolveRemoteMedia={resolveMedia} resolveServerMedia={resolveServerMedia} /> : null}
        <BotGroupMarkdownText readOnly messageKey={messageKey} messageId={messageId} richContent active={active} interactive={interactive} onOpenDiagram={onOpenDiagram} content={share.content} authorKind={share.authorKind} mentionContext={mentionContext} />
      </>}
  </View>;
}

/** The phone picker's quick choices: the first two rows of the shared reaction list. */
const REACTION_CHOICES = CHAT_REACTION_EMOJIS.slice(0, 12);

/**
 * The reactions on a message as chips under it; a tap adds or removes your own. Your pending change
 * shows at once (see `useOptimisticReactions`); a chip you reacted with gets the selected look.
 */
export function BotGroupMessageReactions({ groupId, message, align = 'left', disabled, onReact }: {
  groupId: string; message: BotGroupMessageView; align?: 'left' | 'right'; disabled: boolean;
  onReact(messageId: string, emoji: string, present: boolean): void;
}) {
  const { t } = useTranslation(); const styles = useThemedStyles(makeStyles);
  const shown = useOptimisticReactions(groupId, message);
  if (!shown.reactions?.length) return null;
  return <View style={[styles.reactions, align === 'right' && styles.reactionsRight]} testID={`botGroup.reactions.${message.id}`}>
    {shown.reactions.map(reaction => <Pressable key={reaction.emoji} accessibilityRole="button" disabled={disabled} hitSlop={{ top: spacing.sm, bottom: spacing.sm }}
      accessibilityLabel={t('groupChat.reaction.count', { emoji: reaction.emoji, count: reaction.count })}
      accessibilityState={{ selected: reaction.me, disabled }} onPress={() => onReact(message.id, reaction.emoji, !reaction.me)}
      style={({ pressed }) => [styles.reactionChip, reaction.me && styles.reactionChipMine, pressed && styles.reactionChipPressed]}
      testID={`botGroup.reaction.${message.id}.${reaction.emoji}`}>
      <Text style={styles.reactionEmoji}>{reaction.emoji}</Text>
      <Text style={reaction.me ? styles.reactionCountMine : styles.reactionCount}>{reaction.count}</Text>
    </Pressable>)}
  </View>;
}

export function BotGroupMessageActions({ message, align = 'left', onQuote, onThread, onShare, onReveal, shared, online, readOnly, onShareImage, reactionGroupId, onReact }: {
  align?: 'left' | 'right';
  /** Server group whose messages take reactions; with `onReact` the toolbar offers the reaction picker. */
  reactionGroupId?: string; onReact?(messageId: string, emoji: string, present: boolean): void;
  onShareImage?: () => void;
  message: BotGroupMessageView; onQuote?: () => void; onThread?: () => void; onShare?: () => void; onReveal?: () => void;
  shared?: { messageId: string | null; bySelf: boolean }; online: boolean; readOnly: boolean;
}) {
  const { t, i18n } = useTranslation(); const styles = useThemedStyles(makeStyles); const { colors } = useTheme();
  const reacted = useOptimisticReactions(reactionGroupId, message).reactions;
  const reactable = !!reactionGroupId && !!onReact && !readOnly;
  const copyDisabled = message.threadShare ? message.threadShare.status !== 'available' : !message.content;
  const copyText = message.threadShare?.status === 'available' ? message.threadShare.content : message.content;
  const [copyState, setCopyState] = useState<CopyMessageStatus | 'idle' | 'copying'>('idle');
  const copyOperation = useRef(0);
  useEffect(() => {
    setCopyState('idle');
    return () => { copyOperation.current += 1; };
  }, [message.id, copyText]);
  useEffect(() => {
    if (copyState === 'idle' || copyState === 'copying') return;
    const timer = setTimeout(() => setCopyState('idle'), 1500);
    return () => clearTimeout(timer);
  }, [copyState]);
  const copy = () => {
    if (copyDisabled || copyState === 'copying') return;
    const operation = ++copyOperation.current;
    setCopyState('copying');
    void copyMessageText(copyText).then(status => {
      if (copyOperation.current === operation) setCopyState(status);
    });
  };
  const copying = copyState === 'copying';
  const copyLabel = copyState === 'copied' ? 'message.renderer.copyStateCopied'
    : copyState === 'failed' ? 'message.renderer.copyStateFailed'
      : copying ? 'message.renderer.copyStateCopying' : 'groupChat.thread.copy';
  const actionId = `botGroup.thread.context.${message.id}.action`;
  const buttonStyle = [styles.actionButton, align === 'right' ? styles.actionRight : styles.actionLeft];
  const options = [
    ...(onThread ? [{ id: 'thread', title: t(message.replyCount === 0 ? 'groupChat.thread.create' : 'groupChat.thread.open') }] : []),
    ...(onShare && !readOnly ? [{ id: 'share', title: t(shared?.bySelf ? 'groupChat.thread.showInGroup' : 'groupChat.thread.shareToGroup'), disabled: shared?.bySelf ? !shared.messageId : !online }] : []),
    ...(onShareImage ? [{ id: 'image', title: t('session.shareImage.title') }] : []),
  ];
  const select = (id: string) => {
    if (id === 'image') onShareImage?.();
    else if (id === 'thread') onThread?.();
    else if (id === 'share') { if (shared?.bySelf) onReveal?.(); else onShare?.(); }
  };
  const sections = [{ id: 'time', options: [{ id: 'timestamp', title: new Date(message.createdAt).toLocaleString(i18n.language), disabled: true }] },
    { id: 'message', options }];
  return <View style={styles.messageActions} testID={`botGroup.messageActions.${message.id}`}>
    <Pressable accessibilityRole="button" accessibilityLabel={t(copyLabel)} accessibilityLiveRegion="polite" disabled={copyDisabled || copying}
      accessibilityState={{ disabled: copyDisabled || copying }} onPress={copy}
      style={({ pressed }) => [buttonStyle, { borderRadius: radius.pill, backgroundColor: pressed ? colors.surfaceChip : 'transparent' }]} testID={`${actionId}.copy`}>
      {copyState === 'copied' ? <Check size={iconSize.sm} color={colors.textSecondary} />
        : <Copy size={iconSize.sm} color={copyDisabled ? colors.textTertiary : colors.textSecondary} />}
    </Pressable>
    {onQuote ? <Pressable accessibilityRole="button" accessibilityLabel={t('message.renderer.reply')} disabled={readOnly}
      accessibilityState={{ disabled: readOnly }} onPress={onQuote} style={buttonStyle} testID={`${actionId}.quote`}>
      <ChatReplyIcon size={iconSize.sm} color={readOnly ? colors.textTertiary : colors.textSecondary} />
    </Pressable> : null}
    {reactable ? <BotGroupMenu title={t('groupChat.reaction.add')} accessibilityLabel={t('groupChat.reaction.add')} disabled={!online}
      sections={[{ id: 'reactions', options: REACTION_CHOICES.map(emoji => ({ id: emoji, title: emoji, selected: reacted?.some(r => r.emoji === emoji && r.me) ?? false })) }]}
      onSelect={emoji => onReact!(message.id, emoji, !reacted?.some(r => r.emoji === emoji && r.me))} testID={`botGroup.reactionPicker.${message.id}`}>
      {open => <Pressable accessibilityRole="button" accessibilityLabel={t('groupChat.reaction.add')} disabled={!online}
        accessibilityState={{ disabled: !online }} onPress={open} style={buttonStyle} testID={`${actionId}.react`}>
        <SmilePlus size={iconSize.sm} color={online ? colors.textSecondary : colors.textTertiary} />
      </Pressable>}
    </BotGroupMenu> : null}
    <BotGroupMenu title={t('groupChat.thread.actions')} sections={sections}
      onSelect={select} testID={`botGroup.thread.context.${message.id}`}>
      {open => <Pressable accessibilityRole="button" accessibilityLabel={t('message.renderer.moreActions')}
        onPress={open} style={buttonStyle} testID={`botGroup.thread.more.${message.id}`}>
        <Ellipsis size={iconSize.sm} color={colors.textSecondary} />
      </Pressable>}
    </BotGroupMenu>
  </View>;
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
  messageActions: { flexDirection: 'row', alignItems: 'center' },
  reactions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs, marginTop: spacing.xs },
  reactionsRight: { justifyContent: 'flex-end' },
  reactionChip: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, minHeight: 32, paddingHorizontal: spacing.sm,
    borderRadius: radius.pill, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border },
  reactionChipMine: { backgroundColor: colors.surfaceChip, borderColor: colors.borderStrong },
  reactionChipPressed: { backgroundColor: colors.surfaceChip },
  reactionEmoji: { fontSize: typeScale.bodySmall, lineHeight: lineHeight.bodySmall, fontWeight: fontWeight.regular, color: colors.textPrimary },
  reactionCount: { fontSize: typeScale.caption, lineHeight: lineHeight.caption, fontWeight: fontWeight.regular, color: colors.textTertiary },
  reactionCountMine: { fontSize: typeScale.caption, lineHeight: lineHeight.caption, fontWeight: fontWeight.regular, color: colors.textSecondary },
  actionButton: { width: 44, height: 44, justifyContent: 'flex-start', paddingTop: spacing.sm },
  actionLeft: { alignItems: 'flex-start' },
  actionRight: { alignItems: 'flex-end' },
  entry: { minHeight: 44, flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: spacing.sm },
  count: { fontSize: typeScale.bodySmall, lineHeight: lineHeight.bodySmall, fontWeight: fontWeight.medium, color: colors.textPrimary },
  note: { fontSize: typeScale.footnote, lineHeight: lineHeight.caption, fontWeight: fontWeight.regular, color: colors.textSecondary },
  postedEntry: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  postedNote: { flexShrink: 1, fontSize: typeScale.caption, lineHeight: lineHeight.caption, fontWeight: fontWeight.regular, color: colors.textTertiary },
  share: { borderLeftWidth: 2, borderLeftColor: colors.border, paddingLeft: spacing.md, gap: spacing.sm },
});
