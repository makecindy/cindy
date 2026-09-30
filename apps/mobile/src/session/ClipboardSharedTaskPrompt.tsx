import { useEffect, useRef } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { sharedTaskAccountName } from '@cindy/device-link';
import { Text } from '@/components/AppText';
import { clearSharedTaskInvitationIntent, confirmClipboardSharedTaskInvitation, getPendingSharedTaskInvitationIntent, usePendingSharedTaskInvitationIntent } from '@/device-link/sharedTaskInvitationIntent';
import { getMobileAuthOwner, isMobileAuthOwnerCurrent } from '@/auth/authOwnerGeneration';
import { invitationDigest, rememberClipboardInvitation } from '@/device-link/clipboardInvitationHistory';
import { useThemedStyles, type ThemeColors } from '@/theme';
import { fontWeight, lineHeight, spacing, typeScale } from '@/theme/tokens';
import { SharedTaskAdmissionDialog } from './SharedTaskAdmissionDialog';
import { SharedTaskAction } from './SharedTaskScreen';

/** Clipboard discovery must not replace the page underneath the confirmation. */
export function ClipboardSharedTaskPrompt({ accountName }: { accountName?: string | null }) {
  const invitation = usePendingSharedTaskInvitationIntent();
  const { t } = useTranslation();
  const styles = useThemedStyles(makeStyles);
  const owner = getMobileAuthOwner();
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  if (invitation?.source !== 'clipboard') return null;
  const onShow = () => {
    // Native presentation can finish after a new invitation, account switch, or unmount.
    if (!mounted.current || !owner.accountKey || owner.switching || !isMobileAuthOwnerCurrent(owner)
        || getPendingSharedTaskInvitationIntent()?.id !== invitation.id) return;
    void rememberClipboardInvitation(owner.accountKey, invitationDigest(invitation.invitation));
  };
  const dismiss = () => {
    if (getPendingSharedTaskInvitationIntent()?.id === invitation.id) clearSharedTaskInvitationIntent();
  };
  return <SharedTaskAdmissionDialog key={invitation.id} title={t('sharedTask.invitationDetected')} onClose={dismiss} onShow={onShow}>
    <Text style={styles.intro}>{t('sharedTask.joinIntro')}</Text>
    <Text style={styles.account}>{sharedTaskAccountName(accountName)}</Text>
    <Text style={styles.notice}>{t('sharedTask.joinNotice')}</Text>
    <View style={styles.footer}>
      <SharedTaskAction grow action={{ label: t('sharedTask.notNow'), onPress: dismiss }} />
      <SharedTaskAction grow action={{ label: t('sharedTask.join'), tone: 'primary', onPress: () => confirmClipboardSharedTaskInvitation(invitation.id) }} />
    </View>
  </SharedTaskAdmissionDialog>;
}
const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  intro: { color: colors.textSecondary, fontSize: typeScale.footnote, lineHeight: lineHeight.caption, marginBottom: spacing.lg },
  account: { color: colors.textPrimary, fontSize: typeScale.body, lineHeight: lineHeight.body, fontWeight: fontWeight.medium },
  notice: { color: colors.textSecondary, fontSize: typeScale.footnote, lineHeight: lineHeight.caption, marginTop: spacing.sm, marginBottom: spacing.lg },
  footer: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.lg },
});
