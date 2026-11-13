import { ActivityIndicator, Keyboard, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Text, TextInput } from '@/components/AppText';
import { CompanionSheet } from '@/session/CompanionSheet';
import { ContextSheetRow } from '@/session/ContextSheet';
import { useTheme, useThemedStyles, type ThemeColors } from '@/theme';
import { fontWeight, lineHeight, radius, spacing, typeScale } from '@/theme/tokens';
import { ChatInviteAvatar } from './ChatInviteAvatar';
import type { ChatInviteModel } from './ChatInviteSheet';
export interface ChatInviteViewProps {
  visible: boolean; title: string; model: ChatInviteModel; input: boolean; validity?: string; message?: string; otherInvitationMessage?: string;
  primary?: { label: string; busy: boolean; disabled: boolean; onPress(): void };
}
export function ChatInviteView({ visible, title, model, input, validity, message, otherInvitationMessage, primary }: ChatInviteViewProps) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const identity = !!model.preview && !input && model.phase !== 'reading' && (!model.error || model.error === 'uncertain');
  return <CompanionSheet visible={visible} title={title} onClose={model.close} onClosed={model.closed}
    preventDismiss={model.phase === 'joining'} testID="chatInvite.sheet" footer={<View style={styles.actions}>
      {primary ? primary.busy ? <View style={styles.primary} testID="chatInvite.primary" accessible accessibilityLabel={primary.label}>
        <ActivityIndicator color={colors.ctaText} /><Text style={styles.primaryLabel}>{primary.label}</Text>
      </View> : <Pressable style={[styles.primary, primary.disabled && styles.disabled]} disabled={primary.disabled}
        accessibilityRole="button" accessibilityState={{ disabled: primary.disabled }} testID="chatInvite.primary"
        onPress={() => { Keyboard.dismiss(); primary.onPress(); }}><Text style={styles.primaryLabel}>{primary.label}</Text></Pressable> : null}
      {model.manual && !input && model.phase !== 'reading' ? <ContextSheetRow label={t('groupChat.invitation.editLink')} onPress={model.edit} disabled={model.phase === 'joining'} testID="chatInvite.edit" /> : null}
      <ContextSheetRow label={t('devices.common.cancel')} onPress={model.close} disabled={model.phase === 'joining'} testID="chatInvite.close" />
    </View>}>
    <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
      {input ? <TextInput accessibilityLabel={t('groupChat.invitation.inviteLink')} placeholder={t('groupChat.invitation.pasteLink')}
        placeholderTextColor={colors.textPlaceholder} value={model.input} onChangeText={model.setInput} keyboardType="url" autoCapitalize="none" autoCorrect={false}
        maxLength={8192} style={styles.field} returnKeyType="go" onSubmitEditing={() => { Keyboard.dismiss(); model.read(); }} testID="chatInvite.input" /> : null}
      {identity && model.preview ? <>
        <View style={styles.identity}><ChatInviteAvatar avatar={model.preview.avatar} members={model.preview.memberAvatars} /><View style={styles.names}>
          <Text style={styles.name}>{model.preview.name}</Text>
          <Text style={styles.note}>{model.preview.memberCount === undefined ? t('groupChat.invitation.countUnknown') : t('groupChat.memberCount', { count: model.preview.memberCount })}</Text>
        </View></View>
        <Text style={styles.centeredNote}>{t('groupChat.invitation.invitedBy', { name: model.preview.inviterName })}</Text>
        {validity ? <Text style={styles.centeredNote}>{validity}</Text> : null}
      </> : null}
      {model.phase === 'reading' ? <ActivityIndicator accessibilityLabel={t('groupChat.invitation.loadingInvite')} color={colors.textSecondary} /> : null}
      {message ? <Text style={styles.note} accessibilityRole={model.error ? 'alert' : undefined} testID="chatInvite.message">{message}</Text> : null}
      {otherInvitationMessage ? <Text style={styles.note}>{otherInvitationMessage}</Text> : null}
    </ScrollView>
  </CompanionSheet>;
}
const makeStyles = (c: ThemeColors) => StyleSheet.create({
  primary: { minHeight: 50, paddingHorizontal: spacing.lg, borderRadius: radius.pill, backgroundColor: c.cta, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.sm },
  primaryLabel: { fontSize: typeScale.body, lineHeight: lineHeight.body, fontWeight: fontWeight.medium, color: c.ctaText, textAlign: 'center' },
  disabled: { opacity: 0.45 },
  content: { gap: spacing.lg, paddingVertical: spacing.md }, actions: { gap: spacing.sm },
  identity: { alignItems: 'center', gap: spacing.md, paddingHorizontal: 28 }, names: { alignItems: 'center', gap: spacing.xs },
  name: { textAlign: 'center', fontSize: typeScale.inviteTitle, lineHeight: lineHeight.listTitle, fontWeight: fontWeight.semibold, color: c.textPrimary },
  note: { fontSize: typeScale.footnote, lineHeight: lineHeight.caption, fontWeight: fontWeight.regular, color: c.textSecondary },
  centeredNote: { textAlign: 'center', fontSize: typeScale.footnote, lineHeight: lineHeight.caption, color: c.textSecondary },
  field: { minHeight: 50, paddingHorizontal: spacing.lg, borderWidth: 0.5, backgroundColor: c.surfaceElevated, borderColor: c.border, borderRadius: radius.pill,
    color: c.textPrimary, fontSize: typeScale.body, fontWeight: fontWeight.regular },
});
