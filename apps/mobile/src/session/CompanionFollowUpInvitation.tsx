import { useEffect, useRef, useState } from 'react';
import { Alert, StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Text } from '@/components/AppText';
import { useAuth } from '@/auth/AuthContext';
import { useDeviceLink } from '@/device-link/DeviceLinkContext';
import { invokeRemoteResourceAction } from '@/device-link/remoteResources';
import { useThemedStyles, type ThemeColors } from '@/theme';
import { fontWeight, lineHeight, radius, spacing, typeScale } from '@/theme/tokens';
import { loadCompanionProfile, type CompanionProfileData } from './companionProfileData';
import { CompanionCardActions, CompanionCardButton } from './CompanionCardButton';

/** Mounted only after an accepted user message, once the canonical chat is idle. */
export function CompanionFollowUpInvitation({ deviceId, deviceName, botId }: {
  deviceId: string; deviceName: string; botId: string;
}) {
  const { t, i18n } = useTranslation();
  const { accountGeneration } = useAuth();
  const { invoke } = useDeviceLink();
  const styles = useThemedStyles(makeStyles);
  const [data, setData] = useState<CompanionProfileData | null>(null);
  const [busy, setBusy] = useState(false);
  const alive = useRef(false);
  const saving = useRef(false);
  const current = useRef(accountGeneration); current.current = accountGeneration;
  useEffect(() => {
    alive.current = true;
    let cancelled = false;
    void loadCompanionProfile(invoke, deviceId, { collectionId: 'teammates', kind: 'bot', id: `settings:${botId}/follow-up` }, i18n.language)
      .then(next => { if (!cancelled && current.current === accountGeneration) setData(next); }).catch(() => {});
    return () => { cancelled = true; alive.current = false; };
  }, [accountGeneration, botId, deviceId, i18n.language, invoke]);
  const panel = data?.panels.find(item => item.id === 'follow-up');
  if (!data || !panel?.invitationAvailable || !panel.action || !panel.dismissAction) return null;
  const choose = async (enable: boolean) => {
    const actionId = (enable ? panel.action : panel.dismissAction)?.id;
    if (!actionId || saving.current) return;
    saving.current = true; setBusy(true);
    try {
      await invokeRemoteResourceAction(invoke, { deviceId, deviceName }, {
        collectionId: 'teammates', resourceRef: data.resource.ref, actionId, input: enable ? { enabled: true } : {},
      }, i18n.language);
      if (alive.current && current.current === accountGeneration) setData(null);
    } catch {
      if (alive.current && current.current === accountGeneration) {
        Alert.alert(t('session.followUp.saveFailed'));
        const next = await loadCompanionProfile(invoke, deviceId, data.resource.ref, i18n.language).catch(() => null);
        if (alive.current && current.current === accountGeneration) setData(next);
      }
    } finally { saving.current = false; if (alive.current) setBusy(false); }
  };
  return <View style={styles.card} testID="companion.followUp.invitation">
    <Text style={styles.title}>{t('session.followUp.title')}</Text>
    <Text style={styles.body}>{panel.text}</Text>
    <CompanionCardActions>
      <CompanionCardButton label={t('session.followUp.notNow')} disabled={busy} onPress={() => void choose(false)} />
      <CompanionCardButton label={t('session.followUp.start')} primary disabled={busy} onPress={() => void choose(true)} />
    </CompanionCardActions>
  </View>;
}
const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  card: { marginHorizontal: spacing.md, marginBottom: spacing.sm, padding: spacing.md, borderWidth: 1, borderColor: colors.border, borderRadius: radius.container },
  title: { fontSize: typeScale.subtitle, lineHeight: lineHeight.subtitle, fontWeight: fontWeight.medium, color: colors.textPrimary },
  body: { marginTop: spacing.sm, fontSize: typeScale.footnote, lineHeight: lineHeight.caption, fontWeight: fontWeight.regular, color: colors.textSecondary },
});
