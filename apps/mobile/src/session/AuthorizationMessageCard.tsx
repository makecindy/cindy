import { useState } from 'react';
import { useLocalSearchParams } from 'expo-router';
import { Image, Pressable, StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { buildRemotePluginSetupPresentation, buildPluginSetupCancelDecision } from '@cindy/maker-shared/interaction';
import { Text } from '@/components/AppText';
import { useDeviceLink } from '@/device-link/DeviceLinkContext';
import { useThemedStyles, type ThemeColors } from '@/theme';
import { spacing, radius, typeScale } from '@/theme/tokens';
import type { NormalizedRemoteMessage } from './messageNormalize';

/** Remote transcript projection; credentials and browser login remain on the trusted Host. */
export function AuthorizationMessageCard({ message }: { message: NormalizedRemoteMessage }) {
  const { t } = useTranslation();
  const { deviceId } = useLocalSearchParams<{ deviceId?: string }>();
  const { invoke } = useDeviceLink();
  const styles = useThemedStyles(makeStyles);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const request = message.authorization ?? {};
  const card = buildRemotePluginSetupPresentation(request);
  const cancel = buildPluginSetupCancelDecision(request);
  return <View style={styles.card} testID="authorization.message">
    <View style={styles.header}>
      {card.iconDataUrl ? <Image source={{ uri: card.iconDataUrl }} style={styles.icon} /> : null}
      <Text style={styles.title}>{card.ghostName ?? message.body}</Text>
    </View>
    {card.groups.flatMap(group => group.steps.map(step => <View key={step.id}>
      {card.stepCount > 1 ? <Text style={styles.note}>{step.title}</Text> : null}
      {step.phase ? <Text style={styles.note}>{t(`interaction.pluginSetup.phase.${step.phase}`)}</Text> : null}
      {step.errorCode ? <Text style={styles.error}>{t(`interaction.pluginSetup.error.${step.errorCode}`)}</Text> : null}
    </View>))}
    {!card.terminal ? <Text style={styles.note}>{t('interaction.pluginSetup.completeOnDesktop')}</Text> : null}
    {!card.terminal && cancel ? <Pressable accessibilityRole="button" disabled={busy || !deviceId} style={styles.action}
      onPress={() => { setBusy(true); setFailed(false);
        void invoke(deviceId!, 'maker:resolve-interaction', [request.requestId, cancel])
          .then(value => { if (!(value as { accepted?: boolean })?.accepted) setFailed(true); })
          .catch(() => setFailed(true)).finally(() => setBusy(false));
      }}><Text style={styles.note}>{t('common.cancel')}</Text></Pressable> : null}
    {failed ? <Text style={styles.error}>{t('devices.companions.actionFailed')}</Text> : null}
  </View>;
}
const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  card: { marginVertical: spacing.sm, padding: spacing.md, gap: spacing.xs, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border, backgroundColor: colors.surfaceElevated, borderRadius: radius.container },
  header: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  icon: { width: 24, height: 24, borderRadius: radius.control },
  title: { color: colors.textPrimary, fontSize: typeScale.body, flexShrink: 1 },
  note: { color: colors.textSecondary, fontSize: typeScale.footnote },
  error: { color: colors.statusError, fontSize: typeScale.footnote },
  action: { minHeight: 44, paddingHorizontal: spacing.sm, justifyContent: 'center', alignSelf: 'flex-start', borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border, borderRadius: radius.pill },
});
