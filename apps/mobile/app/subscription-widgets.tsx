import { useEffect, useState } from 'react';
import { useRouter } from 'expo-router';
import { Platform, ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import type { DeviceView } from '@cindy/device-link';
import { Text } from '@/components/AppText';
import { MainWindowActionButton, MainWindowOptionButton } from '@/components/MobilePrimitives';
import { SimpleStackHeader, simpleScreenSafeAreaEdges } from '@/platform/chrome';
import { fontWeight, lineHeight, radius, spacing, typeScale, useTheme } from '@/theme';
import { goBackGuarded } from '@/utils/backGuard';
import { useQuotaWidgetRefresh } from '@/widgets/QuotaWidgetBridge';
import { nativeQuotaWidget, quotaWidgetStore } from '@/widgets/quotaWidgetStore';
import { quotaWindowKey, quotaWindowState } from '@/widgets/quotaSnapshot';

export default function SubscriptionWidgetsScreen() {
  const { t, i18n } = useTranslation();
  const { colors } = useTheme();
  const router = useRouter();
  const { state, refresh, link } = useQuotaWidgetRefresh();
  const [devices, setDevices] = useState<DeviceView[]>([]);
  const [deviceError, setDeviceError] = useState(false);
  const [now, setNow] = useState(Date.now());
  const key = (name: string) => t(`settings.quotaWidget.${name}`);
  const time = (value: number | null) => value === null ? key('unknownTime') : new Date(value).toLocaleString(i18n.resolvedLanguage, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  useEffect(() => {
    let current = true;
    void link.readDeviceList().then(result => {
      if (current) { setDevices(result.devices.filter(d => !d.isSelf && d.remoteControlEnabled && !['ios', 'android'].includes(d.platform ?? ''))); setDeviceError(false); }
    }, () => { if (current) setDeviceError(true); });
    return () => { current = false; };
  }, [link.readDeviceList, link.connectionEpoch]);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 15_000); return () => clearInterval(timer); }, []);
  return (
    <SafeAreaView edges={simpleScreenSafeAreaEdges()} style={{ flex: 1, backgroundColor: colors.surface }}>
      <SimpleStackHeader title={key('title')} onBack={() => goBackGuarded(router, '/settings')} />
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={{ color: colors.textSecondary }}>{key('hint')}</Text>
        {!nativeQuotaWidget && <Text style={{ color: colors.textPrimary }}>{key('unsupported')}</Text>}
        <Text style={[styles.heading, { color: colors.textPrimary }]}>{key('chooseDevice')}</Text>
        {devices.map(device => <MainWindowOptionButton key={device.deviceId} label={device.name} selected={state.deviceId === device.deviceId} disabled={!nativeQuotaWidget || !state.ready} onPress={() => void quotaWidgetStore.selectDevice(device.deviceId)} />)}
        {!devices.length && <Text style={{ color: colors.textSecondary }}>{key('noDevices')}</Text>}
        <MainWindowActionButton action={{ label: key('refresh'), onPress: () => void refresh(), busy: state.busy, disabled: !state.deviceId || !nativeQuotaWidget, tone: 'primary' }} />
        {(state.error || deviceError) && <Text accessibilityRole="alert" style={{ color: colors.textPrimary }}>{key('failed')}</Text>}
        {state.snapshot.rows.map(row => (
          <View key={row.platform} style={[styles.card, { backgroundColor: colors.surfaceElevated, borderColor: colors.border }]}>
            <Text style={[styles.heading, { color: colors.textPrimary }]}>{({ codex: 'Codex / ChatGPT', claude: 'Claude', xai: 'SuperGrok' })[row.platform]}</Text>
            {state.accounts.find(a => a.platform === row.platform)?.label && <Text style={{ color: colors.textSecondary }}>{state.accounts.find(a => a.platform === row.platform)?.label}</Text>}
            {!row.windows.length && <Text style={{ color: colors.textSecondary }}>{key('unavailable')}</Text>}
            {row.windows.map(window => {
              const status = quotaWindowState(row, window, state.snapshot.connection, now);
              return <View key={quotaWindowKey(window)} style={styles.window}>
                <Text style={{ color: colors.textPrimary }}>{window.scope ?? (window.minutes === 300 ? key('fiveHour') : window.minutes === 10080 ? key('sevenDay') : window.minutes ? t('settings.quotaWidget.minutes', { count: window.minutes }) : key(window.kind))} · {['unavailable', 'awaitingRefresh'].includes(status) ? key(status) : t('settings.quotaWidget.remaining', { percent: Math.round(window.remainingPercent!) })}</Text>
                {status !== 'fresh' && !['unavailable', 'awaitingRefresh'].includes(status) && <Text style={{ color: colors.textSecondary }}>{key(status)}</Text>}
                <Text style={{ color: colors.textSecondary }}>{key('resets')} {time(window.resetAtMs)}</Text>
                <Text style={{ color: colors.textSecondary }}>{key('updated')} {time(window.observedAtMs)}</Text>
              </View>;
            })}
          </View>
        ))}
        {state.deviceId && !state.snapshot.rows.length && <Text style={{ color: colors.textSecondary }}>{key('unavailable')}</Text>}
        <Text style={{ color: colors.textSecondary }}>{key('accountHint')}</Text>
        <Text style={{ color: colors.textSecondary }}>{key(Platform.OS === 'android' ? 'addHintAndroid' : 'addHint')}</Text>
        {(state.deviceId || state.clearPending) && <MainWindowActionButton action={{ label: key('disable'), onPress: () => void quotaWidgetStore.selectDevice(null), tone: 'secondary' }} />}
      </ScrollView>
    </SafeAreaView>
  );
}
const styles = StyleSheet.create({
  content: { padding: spacing.lg, gap: spacing.md },
  heading: { fontSize: typeScale.body, lineHeight: lineHeight.body, fontWeight: fontWeight.medium },
  card: { padding: spacing.md, gap: spacing.sm, borderRadius: radius.container, borderWidth: 1 },
  window: { gap: spacing.xs },
});
