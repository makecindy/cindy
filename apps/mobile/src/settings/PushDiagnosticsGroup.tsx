import { useCallback, useRef, useState } from 'react';
import { AppState, StyleSheet, View } from 'react-native';
import { useFocusEffect } from 'expo-router';
import * as Clipboard from 'expo-clipboard';
import { useTranslation } from 'react-i18next';
import { Text } from '@/components/AppText';
import { ActionInfoRow, InfoRow, SettingsGroup } from '@/session/SettingsGroupRows';
import { readIosPushDiagnostic, type PushDiagnostic } from '@/notifications/pushDiagnostics';
import { useThemedStyles, type ThemeColors } from '@/theme';
import { spacing, typeScale, lineHeight, fontWeight } from '@/theme/tokens';

/** No mount-time token read. Sensitive result lives only in the focused screen. */
export function PushDiagnosticsGroup() {
  const { t } = useTranslation();
  const styles = useThemedStyles(makeStyles);
  const generation = useRef(0);
  const focused = useRef(false);
  const pending = useRef(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<PushDiagnostic | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const clear = useCallback(() => {
    generation.current += 1;
    pending.current = false;
    setBusy(false);
    setResult(null);
    setMessage(null);
  }, []);
  useFocusEffect(useCallback(() => {
    focused.current = true;
    const listener = AppState.addEventListener('change', state => {
      if (state !== 'active') clear();
    });
    return () => { focused.current = false; listener.remove(); clear(); };
  }, [clear]));
  const read = async () => {
    if (pending.current || !focused.current || AppState.currentState !== 'active') return;
    clear();
    const current = generation.current;
    const isCurrent = () => focused.current && generation.current === current && AppState.currentState === 'active';
    pending.current = true;
    setBusy(true);
    // Late native results after timeout, backgrounding or navigation cannot reveal a token.
    const timeout = setTimeout(() => {
      if (!isCurrent()) return;
      clear();
      setMessage(t('settings.pushDiagnostics.failed'));
    }, 15_000);
    try {
      const next = await readIosPushDiagnostic(isCurrent);
      if (isCurrent()) setResult(next);
    } catch {
      if (isCurrent()) setMessage(t('settings.pushDiagnostics.failed'));
    } finally {
      clearTimeout(timeout);
      if (isCurrent()) { pending.current = false; setBusy(false); }
    }
  };
  const copy = async () => {
    if (!focused.current || AppState.currentState !== 'active' || !result?.token) return;
    const current = generation.current;
    try {
      await Clipboard.setStringAsync(result.token);
      if (generation.current === current) setMessage(t('settings.pushDiagnostics.copied'));
    } catch {
      if (generation.current === current) setMessage(t('settings.pushDiagnostics.copyFailed'));
    }
  };
  const flag = (v: boolean | null) => t(`settings.pushDiagnostics.${v === null ? 'unknown' : v ? 'on' : 'off'}`);
  return (
    <SettingsGroup title={t('settings.pushDiagnostics.title')} footer={t('settings.pushDiagnostics.hint')}
      messages={[message ? { text: message } : null]} testID="settings.pushDiagnostics">
      <ActionInfoRow accessibilityLabel={t('settings.pushDiagnostics.read')} label={t('settings.pushDiagnostics.read')} onPress={() => void read()} disabled={busy}
        value={busy ? t('settings.pushDiagnostics.busy') : ''} testID="settings.pushDiagnostics.read" chevron={false} />
      {result ? [
        <InfoRow key="bundle" label={t('settings.pushDiagnostics.bundle')} value={result.bundleId} />,
        <InfoRow key="build" label={t('settings.pushDiagnostics.build')} value={result.build} />,
        <InfoRow key="environment" label={t('settings.pushDiagnostics.environment')} value={result.environment === 'development' ? 'sandbox' : 'production'} />,
        <InfoRow key="permission" label={t('settings.pushDiagnostics.permission')} value={t(`settings.pushDiagnostics.permissions.${result.permission}`, { defaultValue: result.permission })} />,
        <InfoRow key="alerts" label={t('settings.pushDiagnostics.alerts')} value={flag(result.alerts)} />,
        <InfoRow key="lockScreen" label={t('settings.pushDiagnostics.lockScreen')} value={flag(result.lockScreen)} />,
        <InfoRow key="notificationCenter" label={t('settings.pushDiagnostics.notificationCenter')} value={flag(result.notificationCenter)} />,
        ...(result.token ? [
          <View key="token" style={styles.tokenArea}><Text selectable style={styles.token} testID="settings.pushDiagnostics.token">{result.token}</Text></View>,
          <ActionInfoRow key="copy" accessibilityLabel={t('settings.pushDiagnostics.copy')} label={t('settings.pushDiagnostics.copy')} onPress={() => void copy()} chevron={false} testID="settings.pushDiagnostics.copy" />,
        ] : []),
        <ActionInfoRow key="hide" accessibilityLabel={t('settings.pushDiagnostics.hide')} label={t('settings.pushDiagnostics.hide')} onPress={clear} chevron={false} />,
      ] : null}
    </SettingsGroup>
  );
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  tokenArea: { padding: spacing.lg },
  token: { color: colors.textPrimary, fontSize: typeScale.bodySmall, lineHeight: lineHeight.bodySmall, fontWeight: fontWeight.regular },
});
