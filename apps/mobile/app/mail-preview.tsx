import { useCallback, useEffect, useRef, useState } from 'react';
import { Linking, Platform, Pressable, ScrollView, StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { ExternalLink, Forward, Reply, ReplyAll } from 'lucide-react-native';
import { mailMessageFields, mailParticipantEmail, parseMailMessage, parseMailReaderChoices, parseMailDraftCallId, type MailMessage, type MailMessageSummary, type MailReaderChoice } from '@cindy/maker-shared/mail-message';
import { ghostCardRecipients, mailPreviewImages, visibleMailAttachments } from '@cindy/maker-shared/ghost-card-form';
import { MAIL_PAPER_COLOR } from '@cindy/maker-shared/mail-text-edit';
import { Text } from '@/components/AppText';
import { FileTypeIcon } from '@/components/FileTypeIcon';
import { MainWindowActionButton } from '@/components/MobilePrimitives';
import { MobileUserAvatar } from '@/components/MobileUserAvatar';
import { mobileInteractionStyles } from '@/components/mobileInteractionStyles';
import { useAuth } from '@/auth/AuthContext';
import { useDeviceLink } from '@/device-link/DeviceLinkContext';
import { getRemoteResource } from '@/device-link/remoteResources';
import { SimpleStackHeader, simpleScrollInsetProps, simpleScrollScreenSafeAreaEdges } from '@/platform/chrome';
import { MobileMailHtmlPreview } from '@/plugins/MobileMailHtmlPreview';
import { PluginCardActions } from '@/plugins/PluginCardActions';
import { formatMailDate } from '@/plugins/mailReaderDate';
import { appendQuote, truncateQuoteText } from '@/session/chatQuoteStore';
import { usePluginResultCard } from '@/session/usePluginResultCard';
import { MessageListRevealContext } from '@/session/messageListReveal';
import { useMobileKeyboardState } from '@/session/useMobileKeyboardState';
import { fontWeight, iconSize, iconStroke, lineHeight, spacing, typeScale, useTheme, useThemedStyles, type ThemeColors } from '@/theme';
import { goBackGuarded } from '@/utils/backGuard';

type ReadMail = (url: string, opened: boolean) => Promise<MailMessage | null>;
type ReplyKind = 'reply' | 'replyAll' | 'forward';

export default function MailPreviewScreen() {
  const params = useLocalSearchParams<{ deviceId: string; sessionId: string; url: string }>();
  const deviceId = typeof params.deviceId === 'string' ? params.deviceId : '';
  const sessionId = typeof params.sessionId === 'string' ? params.sessionId : '';
  const url = typeof params.url === 'string' ? params.url : '';
  const { t, i18n } = useTranslation(), styles = useThemedStyles(makeStyles), router = useRouter();
  const { mode, colors } = useTheme(), insets = useSafeAreaInsets();
  const scroll = useRef<ScrollView>(null), offset = useRef(0), userScrolled = useRef(false);
  const keyboard = useMobileKeyboardState();
  // Standalone drafts edit inside this page: keep the caret above the keyboard like the chat list does.
  const revealRect = useCallback((rect: { top: number; bottom: number }) => {
    const view = scroll.current;
    if (!view) return;
    (view as unknown as { measureInWindow(cb: (x: number, y: number, w: number, h: number) => void): void }).measureInWindow((_x, y, _w, h) => {
      const top = y + insets.top + 56, bottom = y + h - (Platform.OS === 'ios' ? keyboard.height : 0) - spacing.sm;
      const delta = rect.bottom > bottom ? Math.min(rect.bottom - bottom, rect.top - top) : rect.top < top ? rect.top - top : 0;
      if (Math.abs(delta) >= 1) scroll.current?.scrollTo({ y: Math.max(0, offset.current + delta), animated: true });
    });
  }, [insets.top, keyboard.height]);
  const { invoke, connectionEpoch, status } = useDeviceLink();
  const { accountGeneration } = useAuth();
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{ binding: string; message?: MailMessage; draftCallId?: string; error?: boolean; unavailable?: 'unavailable' | 'notReady'; providerId?: string; providers?: MailReaderChoice[] }>();
  const scope = JSON.stringify([accountGeneration, connectionEpoch, deviceId, sessionId, url]);
  const [selection, setSelection] = useState<{ scope: string; id: string }>();
  const providerId = selection?.scope === scope ? selection.id : undefined;
  const binding = JSON.stringify([scope, attempt, providerId]);
  useEffect(() => {
    let active = true;
    if (!deviceId || !sessionId || status !== 'online') return;
    void getRemoteResource(invoke, { deviceId, deviceName: deviceId },
      { collectionId: 'mail-messages', kind: 'message', id: JSON.stringify([sessionId, url, true]) }, undefined, ['mail-message'], providerId ? JSON.stringify({ opened: true, providerId }) : 'open').then(resource => {
      const data = resource.blocks?.[0]?.data as { supported?: unknown; error?: unknown; message?: unknown; draftCallId?: unknown; providers?: unknown; providerId?: unknown } | undefined;
      const message = !providerId || data?.providerId === providerId ? parseMailMessage(data?.message) : null;
      if (active) setResult({ binding, message: message || undefined, draftCallId: message ? parseMailDraftCallId(data?.draftCallId) : undefined, error: !message,
        unavailable: data?.supported === false ? 'unavailable' : data?.error === 'MAIL_PROVIDER_NOT_READY' ? 'notReady' : undefined,
        providerId: typeof data?.providerId === 'string' ? data.providerId : undefined,
        providers: parseMailReaderChoices(data?.providers) });
    }).catch(() => { if (active) setResult({ binding, error: true }); });
    return () => { active = false; };
  }, [binding, invoke, status]);
  const current = result?.binding === binding ? result : undefined, mail = current?.message;
  const resolvedProvider = current?.providerId;
  // Other messages in the thread use the reader that opened this one, like Desktop.
  const read = useCallback<ReadMail>(async (messageUrl, opened) => {
    const resource = await getRemoteResource(invoke, { deviceId, deviceName: deviceId },
      { collectionId: 'mail-messages', kind: 'message', id: JSON.stringify([sessionId, messageUrl, true]) }, undefined, ['mail-message'],
      resolvedProvider ? JSON.stringify({ opened, providerId: resolvedProvider }) : opened ? 'open' : undefined);
    return parseMailMessage((resource.blocks?.[0]?.data as { message?: unknown } | undefined)?.message);
  }, [invoke, deviceId, sessionId, resolvedProvider]);
  const openMailbox = () => { void Linking.openURL(url).catch(() => undefined); };
  const reply = (kind: ReplyKind) => {
    if (!mail) return;
    const lines = [[t(`plugins.mailReader.quote.${kind}`), mail.subject].filter(Boolean).join(' · '), [mail.from, mail.date].filter(Boolean).join(' · '), url];
    appendQuote(sessionId, { text: truncateQuoteText(lines.filter(Boolean).join('\n')) });
    router.navigate({ pathname: '/sessions/[sessionId]', params: { sessionId, deviceId, focusComposerRequestKey: String(Date.now()) } });
  };
  const draft = current?.draftCallId;
  const paper = mode === 'dark' ? colors.surface : MAIL_PAPER_COLOR;
  const recipientCount = mail ? ghostCardRecipients(mail.to).length + ghostCardRecipients(mail.cc).length : 0;
  return <SafeAreaView edges={simpleScrollScreenSafeAreaEdges()} style={[styles.root, { backgroundColor: paper }]}>
    <SimpleStackHeader scrollEdge title={t('plugins.mailReader.title')} onBack={() => goBackGuarded(router)}
      rightToolbar={Platform.OS === 'ios' ? <Stack.Toolbar placement="right">
        <Stack.Toolbar.Button icon="arrow.up.right.square" accessibilityLabel={t('plugins.mailReader.openMailbox')} onPress={openMailbox} />
      </Stack.Toolbar> : undefined}
      right={Platform.OS === 'ios' ? undefined : <Pressable accessibilityRole="button" accessibilityLabel={t('plugins.mailReader.openMailbox')}
        style={styles.headerButton} onPress={openMailbox}>
        <ExternalLink size={iconSize.action} strokeWidth={iconStroke.regular} color={colors.textPrimary} />
      </Pressable>} />
    <MessageListRevealContext.Provider value={revealRect}>
    <ScrollView ref={scroll} {...simpleScrollInsetProps} keyboardShouldPersistTaps="handled" scrollEventThrottle={16}
      onScroll={event => { offset.current = event.nativeEvent.contentOffset.y; }}
      onScrollBeginDrag={() => { userScrolled.current = true; }}
      contentContainerStyle={[styles.content, !mail || draft ? styles.contentPlain : null, draft && Platform.OS === 'ios' ? { paddingBottom: spacing.xl + keyboard.height } : null]}>
      {draft ? <DraftEditor key={binding} deviceId={deviceId} sessionId={sessionId} callId={draft} /> : mail ? <>
        <View style={styles.subject}>
          <Text selectable style={styles.title}>{mail.subject || t('plugins.mailReader.title')}</Text>
          {(mail.conversation?.messages.length ?? 0) > 1 && <Text style={styles.meta}>{t('plugins.mailReader.messageCount', { count: mail.conversation!.messages.length })}</Text>}
        </View>
        {mail.conversationUnavailable && <View style={styles.notice}>
          <Text style={styles.noticeText}>{t('plugins.mailReader.conversationFailed')}</Text>
          <MainWindowActionButton action={{ label: t('plugins.mailReader.retry'), onPress: () => setAttempt(n => n + 1) }} />
        </View>}
        <MailThread key={binding} mail={mail} deviceId={deviceId} read={read} language={i18n.language}
          onSelectedLayout={y => { if (!userScrolled.current) scroll.current?.scrollTo({ y: Math.max(0, y - spacing.md), animated: false }); }} />
      </> : <>
        {current?.providers?.length ? <>
          <Text style={styles.secondary}>{t('plugins.mailReader.choosePlugin')}</Text>
          {current.providers.map(p => <MainWindowActionButton key={p.id} action={{
            label: `${p.name} · ${p.namespace || t('plugins.mailReader.personalPlugin')}`,
            onPress: () => setSelection({ scope, id: p.id }),
          }} />)}
        </> : <>
          <Text style={styles.noticeText}>{t(current?.unavailable ? `plugins.mailReader.${current.unavailable}` : current?.error || status !== 'online' ? 'plugins.mailReader.failed' : 'plugins.mailReader.loading')}</Text>
          {current?.error && <View style={styles.actions}>
            {!current.unavailable && <MainWindowActionButton action={{ label: t('plugins.mailReader.retry'), onPress: () => setAttempt(n => n + 1) }} />}
            <MainWindowActionButton action={{ label: t('plugins.mailReader.openMailbox'), tone: 'secondary', onPress: openMailbox }} />
          </View>}
        </>}
      </>}
    </ScrollView>
    </MessageListRevealContext.Provider>
    {mail && !draft ? <View style={[styles.replyBar, { backgroundColor: paper, paddingBottom: Platform.OS === 'ios' ? Math.max(insets.bottom, spacing.sm) : spacing.sm }]}>
      <ReplyButton label={t('plugins.mailReader.reply')} Icon={Reply} onPress={() => reply('reply')} />
      {recipientCount > 1 && <ReplyButton label={t('plugins.mailReader.replyAll')} Icon={ReplyAll} onPress={() => reply('replyAll')} />}
      <ReplyButton label={t('plugins.mailReader.forward')} Icon={Forward} onPress={() => reply('forward')} />
    </View> : null}
  </SafeAreaView>;
}

function ReplyButton({ label, Icon, onPress }: { label: string; Icon: typeof Reply; onPress: () => void }) {
  const styles = useThemedStyles(makeStyles), { colors } = useTheme();
  return <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress}
    style={({ pressed }) => [styles.replyButton, pressed && styles.pressed]}>
    <Icon size={iconSize.action} strokeWidth={iconStroke.regular} color={colors.textPrimary} />
    <Text style={styles.replyLabel}>{label}</Text>
  </Pressable>;
}

/** Chronological, like Desktop: the opened message is shown in full; others are one
 * tap away and read only when the user asks, so hidden bodies are never fetched. */
function MailThread({ mail, deviceId, read, language, onSelectedLayout }: { mail: MailMessage; deviceId: string; read: ReadMail; language: string; onSelectedLayout?: (y: number) => void }) {
  const { t } = useTranslation(), styles = useThemedStyles(makeStyles);
  const [revealed, setRevealed] = useState<Set<string>>(() => new Set());
  const threadY = useRef(0), reported = useRef(false);
  const messages: MailMessageSummary[] = mail.conversation?.messages ?? [{ messageId: mail.messageId, url: '', from: mail.from, date: mail.date, subject: mail.subject, snippet: '' }];
  if (messages.length === 1) return <MessageContent mail={mail} deviceId={deviceId} language={language} />;
  const selectedIndex = messages.findIndex(m => m.messageId === mail.messageId);
  const visible = (index: number) => messages.length <= 6 || index === 0 || index >= messages.length - 2 ||
    Math.abs(index - selectedIndex) <= 2 || revealed.has(messages[index].messageId);
  const rows = [];
  for (let i = 0; i < messages.length;) {
    if (!visible(i)) {
      const start = i;
      while (i < messages.length && !visible(i)) i++;
      const hidden = messages.slice(start, i);
      rows.push(<Pressable key={`gap-${hidden[0].messageId}`} accessibilityRole="button" style={styles.gap}
        onPress={() => setRevealed(old => new Set([...old, ...hidden.map(m => m.messageId)]))}>
        <Text style={styles.gapText}>{t('plugins.mailReader.showMessages', { count: hidden.length })}</Text>
      </Pressable>);
      continue;
    }
    const summary = messages[i++];
    const selected = summary.messageId === mail.messageId;
    rows.push(<View key={summary.messageId} onLayout={selected && selectedIndex > 0 ? (event: LayoutChangeEvent) => {
      // Open on the message the user came for, once; later manual scrolling is never overridden.
      if (reported.current) return;
      const y = event.nativeEvent.layout.y;
      reported.current = true; setTimeout(() => onSelectedLayout?.(threadY.current + y), 0); // parent layout is reported after its children
    } : undefined}>
      <ThreadMessage summary={summary} initial={selected ? mail : undefined}
        accountId={mail.accountId} deviceId={deviceId} read={read} language={language} />
    </View>);
  }
  return <View onLayout={event => { threadY.current = event.nativeEvent.layout.y; }}>{rows}</View>;
}

function ThreadMessage({ summary, initial, accountId, deviceId, read, language }: {
  summary: MailMessageSummary; initial?: MailMessage; accountId: string; deviceId: string; read: ReadMail; language: string;
}) {
  const { t } = useTranslation(), styles = useThemedStyles(makeStyles);
  const [expanded, setExpanded] = useState(Boolean(initial));
  const [message, setMessage] = useState(initial);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!expanded || message) return;
    let active = true;
    setFailed(false);
    // Expanding is an explicit open, which may mark it read like Desktop.
    void read(summary.url, true).then(next => {
      if (!active) return;
      if (next && next.accountId === accountId && next.messageId === summary.messageId) setMessage(next);
      else setFailed(true);
    }).catch(() => { if (active) setFailed(true); });
    return () => { active = false; };
  }, [expanded, message, attempt, read, summary.url, summary.messageId, accountId]);
  const from = message?.from || summary.from;
  return <View style={styles.threadItem}>
    <Pressable accessibilityRole="button" accessibilityState={{ expanded }}
      accessibilityLabel={t(expanded ? 'plugins.mailReader.collapseMessage' : 'plugins.mailReader.expandMessage', { from })}
      onPress={() => setExpanded(v => !v)}>
      <Sender from={from} date={message?.date || summary.date} photos={message?.participantPhotos} language={language}
        snippet={expanded ? undefined : summary.snippet || summary.subject} />
    </Pressable>
    {expanded && (message ? <MessageContent mail={message} deviceId={deviceId} language={language} hideSender />
      : <View style={styles.notice}>
        <Text style={styles.noticeText}>{t(failed ? 'plugins.mailReader.failed' : 'plugins.mailReader.loading')}</Text>
        {failed && <MainWindowActionButton action={{ label: t('plugins.mailReader.retry'), onPress: () => setAttempt(n => n + 1) }} />}
      </View>)}
  </View>;
}

function Sender({ from, date, photos, language, snippet }: {
  from: string; date: string; photos?: MailMessage['participantPhotos']; language: string; snippet?: string;
}) {
  const styles = useThemedStyles(makeStyles);
  const sender = ghostCardRecipients(from)[0];
  const email = sender ? mailParticipantEmail(sender.address) : undefined;
  const name = sender?.label || from;
  return <View style={styles.sender}>
    <MobileUserAvatar name={name} imageUrl={email ? photos?.find(p => p.email === email)?.url : undefined} />
    <View style={styles.senderText}>
      <View style={styles.senderLine}>
        <Text selectable={snippet === undefined} numberOfLines={snippet === undefined ? undefined : 1} style={styles.senderName}>{name}</Text>
        {date ? <Text style={styles.meta}>{formatMailDate(date, language)}</Text> : null}
      </View>
      {snippet !== undefined ? <Text numberOfLines={2} style={styles.secondary}>{snippet}</Text>
        : email && email !== name.toLowerCase() ? <Text selectable style={styles.address}>{email}</Text> : null}
    </View>
  </View>;
}

/** Header, recipients, body and attachments in one flow; the page scrolls them together. */
function MessageContent({ mail, deviceId, language, hideSender }: { mail: MailMessage; deviceId: string; language: string; hideSender?: boolean }) {
  const { t } = useTranslation(), styles = useThemedStyles(makeStyles);
  const fields = mailMessageFields(mail, key => t(`plugins.mailReader.${key}`));
  const values = Object.fromEntries(fields.map(f => [f.name, f.value]));
  const recipients = fields.filter(f => f.kind === 'recipients' && f.value.trim());
  const attachments = visibleMailAttachments(values);
  return <View style={styles.message}>
    {!hideSender && <Sender from={mail.from} date={mail.date} photos={mail.participantPhotos} language={language} />}
    {recipients.length ? <View style={styles.recipients}>
      {recipients.map(field => <Text key={field.name} selectable style={styles.secondary}>
        <Text style={styles.recipientLabel}>{field.label}  </Text>
        {ghostCardRecipients(field.value).map(r => r.address).join(', ')}
      </Text>)}
    </View> : null}
    {mail.markReadFailed && <Text style={styles.noticeText}>{t('plugins.mailReader.markReadFailed')}</Text>}
    {mail.bodyHtml ? <View style={styles.htmlBody}>
      <MobileMailHtmlPreview html={mail.bodyHtml} images={mailPreviewImages(values)} deviceId={deviceId} />
    </View> : <Text selectable style={styles.body}>{mail.bodyText}</Text>}
    {attachments.length ? <View style={styles.attachments}>
      {attachments.map(file => <View key={file.key} style={styles.attachment}>
        <View style={styles.attachmentRow}>
          <FileTypeIcon name={file.filename} mimeType={file.mimeType} size={iconSize.action} />
          <View style={styles.senderText}>
            <Text selectable numberOfLines={2} style={styles.attachmentName}>{file.filename}</Text>
            <Text style={styles.meta}>{file.mimeType || file.filename.split('.').pop()?.toUpperCase()}{file.bytes !== undefined ? ` · ${Math.ceil(file.bytes / 1024)} KB` : ''}</Text>
          </View>
        </View>
        {file.previewUrl && <MobileMailHtmlPreview html={'<img src="cid:attachment">'} images={[{ cid: 'attachment', url: file.previewUrl }]} deviceId={deviceId} />}
      </View>)}
    </View> : null}
  </View>;
}

/** Reuse the chat card's controls, subscriptions and send confirmation. */
function DraftEditor({ deviceId, sessionId, callId }: { deviceId: string; sessionId: string; callId: string }) {
  const { t } = useTranslation(), styles = useThemedStyles(makeStyles);
  const { blocks, error, retry, hidden, callId: resolvedCallId } = usePluginResultCard(deviceId, sessionId, callId, true);
  const actions = !hidden && blocks?.find(block => block.primitive === 'plugin-card-actions');
  return actions && resolvedCallId ? <PluginCardActions key={resolvedCallId} data={actions.data} deviceId={deviceId} sessionId={sessionId} callId={resolvedCallId} /> : <>
    <Text style={styles.secondary}>{t(error || hidden ? 'plugins.mailReader.failed' : 'plugins.mailReader.loading')}</Text>
    {(error || hidden) && <MainWindowActionButton action={{ label: t('plugins.mailReader.retry'), onPress: retry }} />}
  </>;
}
function makeStyles(colors: ThemeColors) { return StyleSheet.create({
  root: { flex: 1 },
  content: { paddingHorizontal: spacing.lg, paddingTop: spacing.sm, paddingBottom: spacing.xl },
  contentPlain: { gap: spacing.md },
  headerButton: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  subject: { gap: spacing.xs, paddingBottom: spacing.lg },
  title: { fontSize: typeScale.title, lineHeight: lineHeight.title, fontWeight: fontWeight.semibold, color: colors.textPrimary },
  message: { gap: spacing.md },
  sender: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  senderText: { flex: 1, minWidth: 0 },
  senderLine: { flexDirection: 'row', alignItems: 'baseline', gap: spacing.sm },
  senderName: { flex: 1, fontSize: typeScale.body, lineHeight: lineHeight.body, fontWeight: fontWeight.medium, color: colors.textPrimary },
  address: { fontSize: typeScale.footnote, lineHeight: lineHeight.caption, fontWeight: fontWeight.regular, color: colors.textSecondary },
  recipients: { gap: spacing.xs },
  recipientLabel: { fontSize: typeScale.bodySmall, lineHeight: lineHeight.bodySmall, fontWeight: fontWeight.regular, color: colors.textTertiary },
  // The document keeps a 4px margin; let it reach close to the screen edge like a mail app.
  htmlBody: { marginHorizontal: -(spacing.lg - spacing.sm) },
  body: { fontSize: typeScale.bodyLarge, lineHeight: lineHeight.bodyLarge, fontWeight: fontWeight.regular, color: colors.textPrimary },
  secondary: { fontSize: typeScale.bodySmall, lineHeight: lineHeight.bodySmall, fontWeight: fontWeight.regular, color: colors.textSecondary },
  noticeText: { fontSize: typeScale.footnote, lineHeight: lineHeight.caption, fontWeight: fontWeight.regular, color: colors.textSecondary },
  notice: { gap: spacing.sm, paddingVertical: spacing.sm },
  actions: { gap: spacing.sm },
  meta: { fontSize: typeScale.caption, lineHeight: lineHeight.caption, fontWeight: fontWeight.regular, color: colors.textTertiary },
  attachments: { gap: spacing.md, paddingTop: spacing.sm },
  attachment: { gap: spacing.sm },
  attachmentRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingVertical: spacing.sm },
  attachmentName: { fontSize: typeScale.bodySmall, lineHeight: lineHeight.bodySmall, fontWeight: fontWeight.regular, color: colors.textPrimary },
  threadItem: { gap: spacing.md, paddingVertical: spacing.md, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
  gap: { minHeight: 44, justifyContent: 'center', alignItems: 'center', borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
  gapText: { fontSize: typeScale.footnote, lineHeight: lineHeight.caption, fontWeight: fontWeight.regular, color: colors.textSecondary },
  replyBar: { flexDirection: 'row', justifyContent: 'space-around', paddingTop: spacing.xs, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
  replyButton: { minWidth: 72, minHeight: 48, alignItems: 'center', justifyContent: 'center', gap: spacing.xs },
  replyLabel: { fontSize: typeScale.caption, lineHeight: lineHeight.caption, fontWeight: fontWeight.regular, color: colors.textSecondary },
  pressed: mobileInteractionStyles.pressed,
}); }
