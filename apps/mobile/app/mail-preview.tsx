import { useEffect, useState } from 'react';
import { Linking, ScrollView, StyleSheet, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { mailMessageFields, parseMailMessage, parseMailReaderChoices, parseMailDraftCallId, type MailMessage, type MailReaderChoice } from '@cindy/maker-shared/mail-message';
import { mailPreviewImages, visibleMailAttachments } from '@cindy/maker-shared/ghost-card-form';
import { Text } from '@/components/AppText';
import { MainWindowActionButton } from '@/components/MobilePrimitives';
import { useAuth } from '@/auth/AuthContext';
import { useDeviceLink } from '@/device-link/DeviceLinkContext';
import { getRemoteResource } from '@/device-link/remoteResources';
import { SimpleStackHeader, simpleScreenSafeAreaEdges } from '@/platform/chrome';
import { MobileMailHtmlPreview } from '@/plugins/MobileMailHtmlPreview';
import { PluginCardRecipients } from '@/plugins/PluginCardRecipients';
import { PluginCardActions } from '@/plugins/PluginCardActions';
import { usePluginResultCard } from '@/session/usePluginResultCard';
import { fontWeight, lineHeight, spacing, typeScale, useThemedStyles, type ThemeColors } from '@/theme';
import { goBackGuarded } from '@/utils/backGuard';

export default function MailPreviewScreen() {
  const params = useLocalSearchParams<{ deviceId: string; sessionId: string; url: string }>();
  const deviceId = typeof params.deviceId === 'string' ? params.deviceId : '';
  const sessionId = typeof params.sessionId === 'string' ? params.sessionId : '';
  const url = typeof params.url === 'string' ? params.url : '';
  const { t } = useTranslation(), styles = useThemedStyles(makeStyles), router = useRouter();
  const { invoke, connectionEpoch, status } = useDeviceLink();
  const { accountGeneration } = useAuth();
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{ binding: string; message?: MailMessage; draftCallId?: string; error?: boolean; unavailable?: 'unavailable' | 'notReady'; providers?: MailReaderChoice[] }>();
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
        providers: parseMailReaderChoices(data?.providers) });
    }).catch(() => { if (active) setResult({ binding, error: true }); });
    return () => { active = false; };
  }, [binding, invoke, status]);
  const current = result?.binding === binding ? result : undefined, mail = current?.message;
  const fields = mail ? mailMessageFields(mail, key => t(`plugins.mailReader.${key}`)) : [];
  const values = Object.fromEntries(fields.map(f => [f.name, f.value]));
  return <SafeAreaView edges={simpleScreenSafeAreaEdges()} style={styles.root}>
    <SimpleStackHeader title={t('plugins.mailReader.title')} onBack={() => goBackGuarded(router)} />
    <ScrollView contentContainerStyle={styles.content}>
      <MainWindowActionButton action={{ label: t('plugins.mailReader.openMailbox'), onPress: () => { void Linking.openURL(url).catch(() => undefined); } }} />
      {current?.draftCallId ? <DraftEditor key={binding} deviceId={deviceId} sessionId={sessionId} callId={current.draftCallId} /> : mail ? <>
        {mail.markReadFailed && <Text style={styles.secondary}>{t('plugins.mailReader.markReadFailed')}</Text>}
        <Text selectable style={styles.title}>{mail.subject}</Text>
        <Text selectable style={styles.secondary}>{mail.from}{mail.date ? '\n' + mail.date : ''}</Text>
        <PluginCardRecipients fields={fields.filter(f => f.kind === 'recipients' && f.value.trim())} disabled readOnly onChange={() => {}} />
        {mail.bodyHtml ? <MobileMailHtmlPreview html={mail.bodyHtml} images={mailPreviewImages(values)} deviceId={deviceId} /> : <Text selectable style={styles.body}>{mail.bodyText}</Text>}
        {visibleMailAttachments(values).map(file => <View key={file.key} style={styles.attachment}>
          <Text selectable style={styles.secondary}>{file.filename}</Text>
          <Text style={styles.meta}>{file.mimeType || file.filename.split('.').pop()?.toUpperCase()}{file.bytes !== undefined ? ` · ${Math.ceil(file.bytes / 1024)} KB` : ''}</Text>
          {file.previewUrl && <MobileMailHtmlPreview html={'<img src="cid:attachment">'} images={[{ cid: 'attachment', url: file.previewUrl }]} deviceId={deviceId} />}
        </View>)}
      </> : <>
        {current?.providers?.length ? <>
          <Text style={styles.secondary}>{t('plugins.mailReader.choosePlugin')}</Text>
          {current.providers.map(p => <MainWindowActionButton key={p.id} action={{
            label: `${p.name} · ${p.namespace || t('plugins.mailReader.personalPlugin')}`,
            onPress: () => setSelection({ scope, id: p.id }),
          }} />)}
        </> : <>
          <Text style={styles.notice}>{t(current?.unavailable ? `plugins.mailReader.${current.unavailable}` : current?.error || status !== 'online' ? 'plugins.mailReader.failed' : 'plugins.mailReader.loading')}</Text>
          {current?.error && !current.unavailable && <MainWindowActionButton action={{ label: t('plugins.mailReader.retry'), onPress: () => setAttempt(n => n + 1) }} />}
        </>}
      </>}
    </ScrollView>
  </SafeAreaView>;
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
  root: { flex: 1, backgroundColor: colors.surface },
  content: { padding: spacing.lg, gap: spacing.md },
  title: { fontSize: typeScale.title, lineHeight: lineHeight.title, fontWeight: fontWeight.semibold, color: colors.textPrimary },
  body: { fontSize: typeScale.bodyLarge, lineHeight: lineHeight.bodyLarge, fontWeight: fontWeight.regular, color: colors.textPrimary },
  secondary: { fontSize: typeScale.bodySmall, lineHeight: lineHeight.bodySmall, fontWeight: fontWeight.regular, color: colors.textSecondary },
  notice: { fontSize: typeScale.footnote, lineHeight: lineHeight.caption, fontWeight: fontWeight.regular, color: colors.textSecondary },
  meta: { fontSize: typeScale.caption, lineHeight: lineHeight.caption, fontWeight: fontWeight.regular, color: colors.textTertiary },
  attachment: { gap: spacing.sm },
}); }
