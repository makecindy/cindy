import { useRef, useState } from 'react';
import { useLocalSearchParams } from 'expo-router';
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { buildRemotePluginSetupPresentation, buildPluginSetupCancelDecision } from '@cindy/maker-shared/interaction';
import { Text } from '@/components/AppText';
import { useDeviceLink } from '@/device-link/DeviceLinkContext';
import { useThemedStyles, type ThemeColors } from '@/theme';
import { lineHeight, spacing, typeScale } from '@/theme/tokens';
import { PluginSetupMessageContent } from './InteractionPanel';
import type { NormalizedRemoteMessage } from './messageNormalize';

/** Remote transcript projection; credentials and browser login remain on the trusted Host. */
export function AuthorizationMessageCard({ message }: { message: NormalizedRemoteMessage }) {
  const { t } = useTranslation();
  const { deviceId } = useLocalSearchParams<{ deviceId?: string }>();
  const { invoke } = useDeviceLink();
  const styles = useThemedStyles(makeStyles);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const inFlight = useRef(false);
  const request = message.authorization ?? {};
  const card = buildRemotePluginSetupPresentation(request);
  const cancel = buildPluginSetupCancelDecision(request);
  const cancelRequest = () => {
    if (!cancel || !deviceId || inFlight.current) return;
    inFlight.current = true; setBusy(true); setFailed(false);
    void invoke(deviceId, 'maker:resolve-interaction', [request.requestId, cancel])
      .then(value => { if (!(value as { accepted?: boolean })?.accepted) setFailed(true); })
      .catch(() => setFailed(true)).finally(() => { inFlight.current = false; setBusy(false); });
  };
  return <View style={styles.wrapper} testID="authorization.message">
    <PluginSetupMessageContent request={request} busy={busy} onCancel={!card.terminal && cancel && deviceId ? cancelRequest : undefined} />
    {failed ? <Text style={styles.error}>{t('devices.companions.actionFailed')}</Text> : null}
  </View>;
}
const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  wrapper: { marginVertical: spacing.sm, gap: spacing.xs },
  error: { color: colors.statusError, fontSize: typeScale.footnote, lineHeight: lineHeight.caption },
});
