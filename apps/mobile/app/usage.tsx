import { useRouter } from 'expo-router';
import { ScrollView } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { UsageDashboard, useAutomaticUsage } from '@/widgets/UsageDashboard';
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
  return (
    <SafeAreaView edges={simpleScrollScreenSafeAreaEdges()} style={{ flex: 1, backgroundColor: colors.surface }}>
      <SimpleStackHeader scrollEdge title={title} onBack={() => goBackGuarded(router)} />
      <ScrollView {...simpleScrollInsetProps} contentContainerStyle={{ padding: spacing.lg, gap: spacing.lg }}>
        {state?.kind === 'snapshot'
          ? <UsageDashboard snapshot={state.snapshot} name={state.deviceName} />
          : <ErrorNotice message={t('session.menu.usage.quotaUnavailable')} />}
      </ScrollView>
    </SafeAreaView>
  );
}
