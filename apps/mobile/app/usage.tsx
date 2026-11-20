import { useState } from 'react';
import { Stack, useRouter } from 'expo-router';
import { Platform, ScrollView } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { UsageDashboard, useAutomaticUsage } from '@/widgets/UsageDashboard';
import { usageWidgetsSupported } from '@/widgets/usageWidgetSync';
import { UsageWidgetGuide } from '@/widgets/UsageWidgetGuide';
import { ErrorNotice } from '@/components/ErrorNotice';
import { SimpleStackHeader, simpleScrollInsetProps, simpleScrollScreenSafeAreaEdges } from '@/platform/chrome';
import { useTheme } from '@/theme';
import { spacing } from '@/theme/tokens';
import { goBackGuarded } from '@/utils/backGuard';

export default function UsageScreen() {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const router = useRouter();
  const state = useAutomaticUsage();
  const title = t('devices.usageTitle');
  const iosVersion = Platform.OS === 'ios' ? Number.parseInt(String(Platform.Version), 10) : 0;
  const canShowWidgetGuide = usageWidgetsSupported && (iosVersion >= 17 || Platform.OS === 'android');
  const [guideVisible, setGuideVisible] = useState(false);
  const instructions = Platform.OS === 'ios'
    ? t('devices.widgetGuideIOS', { picker: iosVersion >= 18 ? t('devices.widgetGuidePicker') : '+' })
    : t('devices.widgetGuideAndroid');
  const widgetAction = canShowWidgetGuide ? {
    label: t('devices.widgetGuideAction'), onPress: () => setGuideVisible(true), testID: 'usage.widgetGuide',
  } : undefined;
  return (
    <SafeAreaView edges={simpleScrollScreenSafeAreaEdges()} style={{ flex: 1, backgroundColor: colors.surface }}>
      <SimpleStackHeader scrollEdge title={title} onBack={() => goBackGuarded(router)}
        action={Platform.OS === 'android' ? widgetAction : undefined}
        rightToolbar={Platform.OS === 'ios' && widgetAction ? (
          <Stack.Toolbar placement="right">
            <Stack.Toolbar.Button onPress={widgetAction.onPress} accessibilityLabel={widgetAction.label}>
              {widgetAction.label}
            </Stack.Toolbar.Button>
          </Stack.Toolbar>
        ) : undefined} />
      <ScrollView {...simpleScrollInsetProps} contentContainerStyle={{ padding: spacing.lg, gap: spacing.lg }}>
        {state?.kind === 'snapshot'
          ? <UsageDashboard snapshot={state.snapshot} name={state.deviceName} />
          : <ErrorNotice message={t('session.menu.usage.quotaUnavailable')} />}
      </ScrollView>
      {canShowWidgetGuide && <UsageWidgetGuide visible={guideVisible} instructions={instructions}
        lockScreenHint={Platform.OS === 'ios' ? t('devices.widgetGuideLockIOS') : undefined} onClose={() => setGuideVisible(false)} />}
    </SafeAreaView>
  );
}
