import { useEffect, useRef, useState, type ReactElement } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';
import { ArrowUpRight, Ellipsis, X } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import * as Clipboard from 'expo-clipboard';
import type { ChatReactor, BotGroupMemberView, BotGroupAttachment, BotGroupMessageView, BotGroupThreadShareView } from '@cindy/maker-shared/botGroupChat';
import type { chatThreadMetadata } from '@/chat/chatServerClient';
import { Text } from '@/components/AppText';
import { MainWindowActionButton } from '@/components/MobilePrimitives';
import { fontWeight, iconSize, lineHeight, radius, spacing, typeScale, useTheme, useThemedStyles, type ThemeColors } from '@/theme';
import { useMessageListItemVisible } from './messageListVisibility';
import { BotGroupAvatar } from './BotGroupAvatars';
import type { BotGroupIdentityLookup } from './BotGroupPlan';
import { BotGroupMenu } from './BotGroupMenu';
import { CompanionSheet } from './CompanionSheet';
import { BotGroupMessageAttachments } from './BotGroupMessageAttachments';
import { BotGroupMarkdownText } from './BotGroupMessageText';
import type { ResolveRemoteMediaFn } from './remoteMedia';

type ThreadMeta = ReturnType<typeof chatThreadMetadata>;
export function BotGroupThreadEntry({ message, identityFor, onPress }: {
  message: BotGroupMessageView; identityFor: BotGroupIdentityLookup; onPress(): void;
}) {
  const { t } = useTranslation(); const styles = useThemedStyles(makeStyles);
  if (!message.replyCount) return null;
  const responders = message.threadPreview?.responders ?? message.threadPreview?.replies ?? [];
  const newest = message.threadPreview?.replies.at(-1);
  const minutes = newest ? Math.max(0, Math.floor((Date.now() - newest.createdAt) / 60000)) : 0;
  return <Pressable accessibilityRole="button" onPress={onPress} style={styles.entry} testID={`botGroup.thread.${message.id}`}
    accessibilityHint={message.threadPreview?.replies.map(reply => `${reply.authorName}: ${reply.text}`).join(' · ')}>
    {responders.length ? <View style={styles.responders}>{responders.slice(0, 3).map((reply, index) => <View key={reply.id} style={index ? styles.overlap : undefined}>
      <BotGroupAvatar deviceId="" online identity={identityFor(reply.authorBotId ?? '', reply.authorName)} size={iconSize.lg} />
    </View>)}</View> : null}
    <Text style={styles.count}>{t('groupChat.thread.replyCount', { count: message.replyCount })}</Text>
    {message.threadUnread?.count ? <View style={styles.entry}><View style={styles.unreadDot} /><Text style={styles.unread}>{t('groupChat.thread.newReplies', { count: message.threadUnread.count })}{message.threadUnread.mentioned ? ` · ${t('groupChat.thread.mentioned')}` : ''}</Text></View>
      : newest ? <Text style={styles.metadata}>{t(minutes < 60 ? 'groupChat.thread.lastMinutes' : 'groupChat.thread.lastHours', { count: minutes < 60 ? minutes : Math.floor(minutes / 60) })}</Text> : null}
  </Pressable>;
}

export function BotGroupThreadFollow({ following, online, onChange, onError }: {
  following?: boolean; online: boolean; onChange(value: boolean): Promise<boolean>; onError(error: unknown): void;
}) {
  const { t } = useTranslation(); const [busy, setBusy] = useState(false);
  if (following === undefined) return null;
  return <MainWindowActionButton density="compact" action={{ label: t(following ? 'groupChat.thread.following' : 'groupChat.thread.follow'),
    disabled: !online || busy, busy, testID: 'botGroup.thread.follow', onPress: () => {
      if (busy) return; setBusy(true); void onChange(!following).catch(onError).finally(() => setBusy(false));
    } }} />;
}

export function BotGroupTopicList({ meta, onOpen, owner }: { meta?: ThreadMeta; owner: string; onOpen(rootId: string): void }) {
  const { t } = useTranslation(); const styles = useThemedStyles(makeStyles); const { colors } = useTheme();
  const [visible, setVisible] = useState(false);
  const chosen = useRef<string | null>(null);
  const [dismissed, setDismissed] = useState({ owner, sequence: '0' });
  const threads = meta?.threads ?? [];
  const attention = threads.filter(thread => thread.unread > 0 && (thread.following || thread.mentioned));
  const newest = attention.reduce((max, thread) => BigInt(thread.latest) > BigInt(max) ? thread.latest : max, '0');
  const hint = attention.length > 0 && BigInt(newest) > BigInt(dismissed.owner === owner ? dismissed.sequence : '0');
  return <>
    {hint ? <View style={styles.hint}><View style={styles.unreadDot} />
      <MainWindowActionButton density="compact" action={{ label: t('groupChat.thread.topicUpdates', { count: attention.length }), testID: 'botGroup.thread.hint',
        onPress: () => attention.length === 1 ? onOpen(attention[0]!.rootId) : setVisible(true) }} />
      <Pressable accessibilityLabel={t('groupChat.thread.dismiss')} style={styles.hit} onPress={() => setDismissed({ owner, sequence: newest })}>
        <X size={iconSize.md} color={colors.textSecondary} />
      </Pressable>
    </View> : null}
    {threads.length ? <MainWindowActionButton density="compact" action={{ label: t('groupChat.thread.groupTopics'), testID: 'botGroup.thread.list', onPress: () => setVisible(true) }} /> : null}
    <CompanionSheet visible={visible} title={t('groupChat.thread.groupTopics')} onClose={() => { chosen.current = null; setVisible(false); }} onClosed={() => { const root = chosen.current; chosen.current = null; if (root) onOpen(root); }}>
      {([true, false] as const).map(isNew => <View key={String(isNew)}>
        <Text style={styles.section}>{t(isNew ? 'groupChat.thread.hasNew' : 'groupChat.thread.otherTopics')}</Text>
        {threads.filter(thread => attention.includes(thread) === isNew).map(thread => <Pressable key={thread.rootId} accessibilityRole="button"
          style={styles.topicRow} onPress={() => { chosen.current = thread.rootId; setVisible(false); }} testID={`botGroup.thread.list.${thread.rootId}`}>
          {thread.unread ? <View style={styles.unreadDot} /> : null}<Text numberOfLines={2} style={styles.topicText}>{thread.text || t(thread.status === 'loading' ? 'groupChat.thread.sourceLoading' : 'groupChat.thread.rootUnavailable')}</Text>
          <Text style={styles.metadata}>{thread.authorName}{thread.replyCount !== undefined ? ` · ${t('groupChat.thread.replyCount', { count: thread.replyCount })}` : ''}
            {thread.unread ? ` · ${t('groupChat.thread.newReplies', { count: thread.unread })}` : ''}{thread.mentioned ? ` · ${t('groupChat.thread.mentioned')}` : ''}</Text>
        </Pressable>)}
      </View>)}
    </CompanionSheet>
  </>;
}

export function BotGroupThreadShare({ share, resolveMedia, resolveServerMedia, onOpen, onRetry }: {
  share: BotGroupThreadShareView; resolveMedia: ResolveRemoteMediaFn;
  resolveServerMedia?: (id: string, signal?: AbortSignal) => Promise<BotGroupAttachment>; onOpen?(): void; onRetry?(): void;
}) {
  const { t } = useTranslation(); const styles = useThemedStyles(makeStyles); const { colors } = useTheme();
  return <View style={styles.share} testID="botGroup.thread.share">
    {share.status === 'available' ? <Text style={styles.note}>{t(share.sharedByAuthor ? 'groupChat.thread.sharedOwn' : 'groupChat.thread.sharedOther', { name: share.authorName })}</Text> : null}
    {share.status === 'loading' ? <View style={styles.entry}><ActivityIndicator color={colors.textSecondary} /><Text style={styles.note}>{t('groupChat.thread.sourceLoading')}</Text>{onRetry ? <MainWindowActionButton density="compact" action={{ label: t('groupChat.thread.retry'), onPress: onRetry }} /> : null}</View>
      : share.status === 'unavailable' ? <Text style={styles.note}>{t('groupChat.thread.sourceUnavailable')}</Text>
      : <>
        <Text style={styles.count}>{share.authorName}{share.edited ? ` · ${t('groupChat.thread.edited')}` : ''}</Text>
        {share.attachments.length ? <BotGroupMessageAttachments messageId={share.messageId} attachments={share.attachments} align="left" onResolveRemoteMedia={resolveMedia} resolveServerMedia={resolveServerMedia} /> : null}
        <BotGroupMarkdownText content={share.content} authorKind={share.authorKind} />
        {onOpen ? <MainWindowActionButton density="compact" action={{ label: t('groupChat.thread.open'), onPress: onOpen }} /> : null}
      </>}
  </View>;
}

export function BotGroupTopicActions({ message, onQuote, onThread, onShare, onReveal, shared, onReact, online, readOnly, reactors, reactionRevision, members, identityFor, children, onShareImage }: {
  children?: ReactElement; onShareImage?: () => void;
  reactors?: (messageId: string, emoji: string) => Promise<ChatReactor[]>; reactionRevision?: string;
  members: BotGroupMemberView[]; identityFor: BotGroupIdentityLookup;
  message: BotGroupMessageView; onQuote?: () => void; onThread?: () => void; onShare?: () => void; onReveal?: () => void;
  shared?: { messageId: string | null; bySelf: boolean }; online: boolean; readOnly: boolean;
  onReact?: (emoji: string, present: boolean) => void;
}) {
  const { t } = useTranslation(); const styles = useThemedStyles(makeStyles); const { colors } = useTheme();
  const emojis = ['👍', '❤️', '😂', '🎉', '👀', '🙏', '✅', '🤔', '🔥', '👏', '🚀', '💯'];
  const options = [
    ...(onQuote ? [{ id: 'quote', title: t('groupChat.thread.quoteReply'), disabled: readOnly }] : []),
    ...(onThread ? [{ id: 'thread', title: t(message.replyCount === 0 ? 'groupChat.thread.create' : 'groupChat.thread.open') }] : []),
    ...(onShare && !readOnly ? [{ id: 'share', title: t(shared?.bySelf ? 'groupChat.thread.showInGroup' : 'groupChat.thread.shareToGroup'), disabled: shared?.bySelf ? !shared.messageId : !online }] : []),
    ...(onShareImage ? [{ id: 'image', title: t('session.shareImage.title') }] : []),
    { id: 'copy', title: t('groupChat.thread.copy'), disabled: !message.content && message.threadShare?.status !== 'available' },
  ];
  const sections = [{ id: 'message', options },
        ...(onReact && !readOnly ? [{ id: 'reactions', title: t('groupChat.thread.reactions'), options: emojis.map(emoji => ({ id: `react:${emoji}`, title: emoji, disabled: !online })) }] : [])];
  const select = (id: string) => {
          if (id === 'image') onShareImage?.(); else if (id === 'quote') onQuote?.(); else if (id === 'thread') onThread?.();
          else if (id === 'share') { if (shared?.bySelf) onReveal?.(); else onShare?.(); }
          else if (id === 'copy') void Clipboard.setStringAsync(message.threadShare?.status === 'available' ? message.threadShare.content : message.content);
          else if (id.startsWith('react:')) { const emoji = id.slice(6); onReact?.(emoji, !message.reactions?.some(reaction => reaction.emoji === emoji && reaction.me)); }
        };
  const timedSections = [{ id: 'time', options: [{ id: 'timestamp', title: new Date(message.createdAt).toLocaleString(), disabled: true }] }, ...sections];
  if (children) return <BotGroupMenu title={t('groupChat.thread.actions')} sections={timedSections} onSelect={select} longPress testID={`botGroup.thread.context.${message.id}`}>
    {open => <Pressable onLongPress={open} delayLongPress={350}>{children}</Pressable>}
  </BotGroupMenu>;
  return <View>
    {shared ? <Pressable onPress={onReveal} disabled={!shared.messageId} accessibilityRole="button" style={styles.entry} testID={`botGroup.thread.shared.${message.id}`}>
      <ArrowUpRight size={iconSize.md} color={colors.textSecondary} /><Text style={styles.note}>{t(shared.bySelf ? 'groupChat.thread.postedSelf' : 'groupChat.thread.postedOther')}</Text>
    </Pressable> : null}
    <View style={styles.actions}>
      {message.reactions?.map(reaction => <BotGroupReaction key={reaction.emoji} messageId={message.id} reaction={reaction}
        revision={reactionRevision} read={reactors} members={members} identityFor={identityFor} disabled={!online || readOnly || !onReact}
        onPress={() => onReact?.(reaction.emoji, !reaction.me)} />)}
      <BotGroupMenu testID={`botGroup.thread.menu.${message.id}`} title={t('groupChat.thread.actions')} sections={timedSections} onSelect={select}>
        {open => <Pressable style={styles.hit} accessibilityRole="button" accessibilityLabel={t('groupChat.thread.actions')} onPress={open} testID={`botGroup.thread.actions.${message.id}`}>
          <Ellipsis size={iconSize.md} color={colors.textSecondary} />
        </Pressable>}
      </BotGroupMenu>
    </View>
  </View>;
}
function BotGroupReaction({ messageId, reaction, revision, read, members, identityFor, disabled, onPress }: {
  messageId: string; reaction: NonNullable<BotGroupMessageView['reactions']>[number]; revision?: string;
  read?: (messageId: string, emoji: string) => Promise<ChatReactor[]>; members: BotGroupMemberView[];
  identityFor: BotGroupIdentityLookup; disabled: boolean; onPress(): void;
}) {
  const styles = useThemedStyles(makeStyles); const { t } = useTranslation();
  const visible = useMessageListItemVisible(messageId);
  const signature = `${messageId}:${reaction.emoji}:${reaction.count}:${reaction.me}:${revision}`;
  const [loaded, setLoaded] = useState<{ signature: string; actors: ChatReactor[] | null } | null>(null);
  useEffect(() => {
    if (!visible || !read || reaction.count > 3 || loaded?.signature === signature) return;
    let cancelled = false;
    void read(messageId, reaction.emoji).then(actors => {
      if (!cancelled) setLoaded({ signature, actors: actors.length === reaction.count ? actors : null });
    }, () => { if (!cancelled) setLoaded({ signature, actors: null }); });
    return () => { cancelled = true; };
  }, [visible, read, signature, loaded?.signature, messageId, reaction.emoji, reaction.count]);
  const actors = loaded?.signature === signature ? loaded.actors : null;
  return <Pressable accessibilityRole="button" accessibilityState={{ selected: reaction.me }} disabled={disabled}
    accessibilityLabel={t('groupChat.thread.reactionCount', { emoji: reaction.emoji, count: reaction.count })}
    onPress={onPress} style={[styles.reaction, reaction.me && styles.selected]}>
    <Text style={styles.count}>{reaction.emoji}{actors?.length ? '' : ` ${reaction.count}`}</Text>
    {actors ? <View style={styles.responders}>{[...actors].sort((a, b) => Number(b.isSelf) - Number(a.isSelf)).map(actor => {
      const member = members.find(member => member.actorId === actor.actorId);
      return <BotGroupAvatar key={actor.actorId} deviceId="" online size={iconSize.md}
        identity={identityFor(actor.actorId, member?.name ?? actor.name ?? '')} />;
    })}</View> : null}
  </Pressable>;
}
const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  entry: { minHeight: 44, flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: spacing.sm },
  responders: { flexDirection: 'row' }, overlap: { marginLeft: -spacing.xs },
  count: { fontSize: typeScale.bodySmall, lineHeight: lineHeight.bodySmall, fontWeight: fontWeight.medium, color: colors.textPrimary },
  metadata: { fontSize: typeScale.caption, lineHeight: lineHeight.caption, fontWeight: fontWeight.regular, color: colors.textTertiary },
  unreadDot: { width: 6, height: 6, borderRadius: radius.pill, backgroundColor: colors.botUnread },
  unread: { fontSize: typeScale.footnote, lineHeight: lineHeight.caption, color: colors.textPrimary },
  note: { fontSize: typeScale.footnote, lineHeight: lineHeight.caption, fontWeight: fontWeight.regular, color: colors.textSecondary },
  hint: { flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end' },
  hit: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  section: { fontSize: typeScale.footnote, lineHeight: lineHeight.caption, fontWeight: fontWeight.regular, color: colors.textTertiary, paddingVertical: spacing.sm },
  topicRow: { paddingVertical: spacing.md, gap: spacing.xs },
  topicText: { fontSize: typeScale.body, lineHeight: lineHeight.body, fontWeight: fontWeight.medium, color: colors.textPrimary },
  share: { borderLeftWidth: 2, borderLeftColor: colors.border, paddingLeft: spacing.md, gap: spacing.sm },
  actions: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: spacing.xs },
  reaction: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border, borderRadius: radius.pill, padding: spacing.sm, minHeight: 44, justifyContent: 'center' },
  selected: { backgroundColor: colors.surfaceElevated },
});
