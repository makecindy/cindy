/**
 * 我分享的供应商(设置 → 供应商分享，或设备管理里某台电脑的入口；产品规则 provider-sharing.md §7.6)。
 * 按电脑列出已经分享出去、或有申请等着处理的供应商，点进去看额度、生成链接、处理申请。
 *
 * 只为读得到的电脑画分组：不在线、没开远程控制、版本太旧或这一轮没读出来的电脑，原因写在页面底部，
 * 不摆点不了的行(mobile-design-guide.md §4)。
 */
import { useCallback, useState } from 'react';
import { RefreshControl, ScrollView, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useIsFocused, useLocalSearchParams, useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';

import { useAuth } from '@/auth/AuthContext';
import { Text } from '@/components/AppText';
import { ErrorNotice } from '@/components/ErrorNotice';
import { MainWindowActionButton, MainWindowEmptyState } from '@/components/MobilePrimitives';
import {
  SimpleStackHeader,
  simpleScrollInsetProps,
  simpleScrollScreenSafeAreaEdges,
} from '@/platform/chrome/SimpleStackHeader';
import { ActionInfoRow, SettingsGroup } from '@/session/SettingsGroupRows';
import { useTheme, useThemedStyles, type ThemeColors } from '@/theme';
import { fontWeight, lineHeight, spacing, typeScale } from '@/theme/tokens';
import { goBackGuarded } from '@/utils/backGuard';
import { useGuardedPush } from '@/utils/useGuardedPush';

import type { ShareManagementShare } from './providerShareManagement';
import { sharedProviderRows } from './providerShareManagementPresentation';
import { useProviderShareOverview, type ProviderShareComputer } from './useProviderShareOverview';

export default function ProviderSharesScreen() {
  const { accountGeneration } = useAuth();
  const { deviceId } = useLocalSearchParams<{ deviceId?: string }>();
  return <ProviderSharesContent key={`${accountGeneration}:${deviceId ?? ''}`} onlyDeviceId={deviceId || undefined} />;
}

function ProviderSharesContent({ onlyDeviceId }: { onlyDeviceId?: string }) {
  const router = useRouter();
  const push = useGuardedPush();
  const { t } = useTranslation();
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const overview = useProviderShareOverview(useIsFocused(), onlyDeviceId);
  const [pulling, setPulling] = useState(false);
  const { refresh } = overview;
  const pull = useCallback(() => {
    setPulling(true);
    void refresh().finally(() => setPulling(false));
  }, [refresh]);

  const listed = overview.computers.filter((computer) => computer.reachable && computer.shares !== null
    && computer.error !== 'needs-update');
  const names = (match: (computer: ProviderShareComputer) => boolean) => overview.computers
    .filter(match)
    .map((computer) => computer.name)
    .join(t('providerShare.manage.list.separator'));
  const unreachable = names((computer) => !computer.reachable);
  const outdated = names((computer) => computer.reachable && computer.error === 'needs-update');
  const unread = names((computer) => computer.reachable && !computer.loading && computer.error !== null
    && computer.error !== 'needs-update');
  const syncing = overview.loading || overview.computers.some((computer) => computer.loading);

  const value = (share: ShareManagementShare) => share.requests.length > 0
    ? t('providerShare.manage.list.pendingCount', { count: share.requests.length })
    : t('providerShare.manage.list.membersCount', { count: share.members.length });

  return (
    <SafeAreaView edges={simpleScrollScreenSafeAreaEdges()} style={styles.screen} testID="providerShares.screen">
      <SimpleStackHeader
        scrollEdge
        syncing={syncing}
        title={t('providerShare.manage.list.title')}
        backTestID="providerShares.back"
        onBack={() => goBackGuarded(router)}
      />
      <ScrollView
        {...simpleScrollInsetProps}
        contentContainerStyle={styles.content}
        refreshControl={<RefreshControl refreshing={pulling} onRefresh={pull} tintColor={colors.textSecondary} />}
        testID="providerShares.scroll"
      >
        {overview.failed ? (
          <ErrorNotice accessibilityRole="alert" message={t('providerShare.manage.loadFailed')}>
            <MainWindowActionButton
              action={{
                busy: overview.loading,
                label: t('devices.management.retry'),
                onPress: pull,
                testID: 'providerShares.retry',
              }}
              style={styles.retry}
            />
          </ErrorNotice>
        ) : null}
        {overview.loaded && !overview.failed && overview.computers.every((computer) => !computer.reachable) ? (
          <MainWindowEmptyState
            copy={t('providerShare.manage.list.emptyCopy')}
            testID="providerShares.empty"
            title={t('providerShare.manage.list.emptyTitle')}
          />
        ) : null}
        {listed.map((computer) => (
          <SettingsGroup key={computer.deviceId} testID={`providerShares.computer.${computer.deviceId}`} title={computer.name}>
            {sharedProviderRows(computer.shares ?? []).map((share) => (
              <ActionInfoRow
                key={share.shareId}
                accessibilityLabel={`${share.providerLabel}, ${value(share)}`}
                label={share.providerLabel}
                onPress={() => push({
                  pathname: '/provider-shares/detail',
                  params: {
                    deviceId: computer.deviceId,
                    deviceName: computer.name,
                    providerId: share.providerId,
                    label: share.providerLabel,
                  },
                })}
                testID={`providerShares.share.${share.shareId}`}
                value={value(share)}
              />
            ))}
            <ActionInfoRow
              accessibilityLabel={t('providerShare.manage.list.shareOther')}
              label={t('providerShare.manage.list.shareOther')}
              onPress={() => push({
                pathname: '/provider-shares/pick',
                params: { deviceId: computer.deviceId, deviceName: computer.name },
              })}
              testID={`providerShares.shareOther.${computer.deviceId}`}
            />
          </SettingsGroup>
        ))}
        {listed.length > 0 ? <Text style={styles.note}>{t('providerShare.manage.list.note')}</Text> : null}
        {unread ? (
          <Text accessibilityLiveRegion="polite" style={styles.note} testID="providerShares.unread">
            {t('providerShare.manage.list.failed', { devices: unread })}
          </Text>
        ) : null}
        {outdated ? (
          <Text style={styles.note} testID="providerShares.outdated">
            {t('providerShare.manage.list.needsUpdate', { devices: outdated })}
          </Text>
        ) : null}
        {unreachable && listed.length > 0 ? (
          <Text style={styles.note} testID="providerShares.unreachable">
            {t('providerShare.manage.list.unreachable', { devices: unreachable })}
          </Text>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  screen: { backgroundColor: colors.surface, flex: 1 },
  content: { gap: spacing.lg, padding: spacing.lg },
  retry: { alignSelf: 'flex-start' },
  // 说明、提示(成句的话)：13/18 400 textSecondary；左右与分组标题对齐。
  note: {
    color: colors.textSecondary,
    fontSize: typeScale.footnote,
    fontWeight: fontWeight.regular,
    lineHeight: lineHeight.caption,
    paddingHorizontal: spacing.md,
  },
});
