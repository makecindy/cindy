/**
 * 选一个供应商来分享(「我分享的供应商」里某台电脑的「分享其他供应商」)；选到已经分享过的，进的是它的同一页。
 * 只列那台电脑上现在就能分享的：已连接，并且在那台电脑上打开了「允许被远程调用」
 * (provider-sharing.md §3 的逐级开启；开关只能在那台电脑上改)。目录沿用模型选择器的按电脑缓存。
 */
import { ActivityIndicator, ScrollView, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';

import { useAuth } from '@/auth/AuthContext';
import { ErrorNotice } from '@/components/ErrorNotice';
import { MainWindowEmptyState } from '@/components/MobilePrimitives';
import { useDeviceProviders } from '@/device-link/useDeviceProviders';
import {
  SimpleStackHeader,
  simpleScrollInsetProps,
  simpleScrollScreenSafeAreaEdges,
} from '@/platform/chrome/SimpleStackHeader';
import { ActionInfoRow, SettingsGroup } from '@/session/SettingsGroupRows';
import { useTheme, useThemedStyles, type ThemeColors } from '@/theme';
import { spacing } from '@/theme/tokens';
import { goBackGuarded } from '@/utils/backGuard';
import { useGuardedPush } from '@/utils/useGuardedPush';

import { shareableProviders } from './providerShareManagementPresentation';

export default function ProviderSharePickScreen() {
  const { accountGeneration } = useAuth();
  const { deviceId, deviceName } = useLocalSearchParams<{ deviceId: string; deviceName?: string }>();
  return (
    <ProviderSharePickContent key={`${accountGeneration}:${deviceId}`} deviceId={deviceId} deviceName={deviceName ?? ''} />
  );
}

function ProviderSharePickContent({ deviceId, deviceName }: { deviceId: string; deviceName: string }) {
  const router = useRouter();
  const push = useGuardedPush();
  const { t } = useTranslation();
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const catalog = useDeviceProviders(deviceId);
  const providers = catalog.ready ? shareableProviders(catalog.providers) : [];

  return (
    <SafeAreaView edges={simpleScrollScreenSafeAreaEdges()} style={styles.screen} testID="providerSharePick.screen">
      <SimpleStackHeader
        scrollEdge
        title={t('providerShare.manage.pick.title')}
        backTestID="providerSharePick.back"
        onBack={() => goBackGuarded(router)}
      />
      <ScrollView {...simpleScrollInsetProps} contentContainerStyle={styles.content}>
        {!catalog.ready && catalog.error ? (
          <ErrorNotice accessibilityRole="alert" message={t('providerShare.manage.loadFailed')} />
        ) : null}
        {!catalog.ready && !catalog.error ? (
          <ActivityIndicator color={colors.textSecondary} style={styles.loading} />
        ) : null}
        {catalog.ready && providers.length === 0 ? (
          <MainWindowEmptyState
            copy={t('providerShare.manage.pick.footer')}
            testID="providerSharePick.empty"
            title={t('providerShare.manage.pick.empty')}
          />
        ) : null}
        {providers.length > 0 ? (
          <SettingsGroup footer={t('providerShare.manage.pick.footer')} testID="providerSharePick.list">
            {providers.map((provider) => (
              <ActionInfoRow
                key={provider.id}
                accessibilityLabel={provider.name}
                label={provider.name}
                onPress={() => push({
                  pathname: '/provider-shares/detail',
                  params: { deviceId, deviceName, providerId: provider.id, label: provider.name },
                })}
                testID={`providerSharePick.provider.${provider.id}`}
              />
            ))}
          </SettingsGroup>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  screen: { backgroundColor: colors.surface, flex: 1 },
  content: { gap: spacing.lg, padding: spacing.lg },
  loading: { paddingVertical: spacing.lg },
});
