import { useRouter } from 'expo-router';
import * as Clipboard from 'expo-clipboard';
import * as Updates from 'expo-updates';
import { useUpdates } from 'expo-updates';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, DevSettings, Platform, ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { Text } from '@/components/AppText';
import { MainWindowActionButton } from '@/components/MobilePrimitives';
import { getAnalyticsConsentState, hydrateAnalyticsConsent, subscribeAnalyticsConsent } from '@/analytics/analyticsConsentStore';
import { useAuth } from '@/auth/AuthContext';
import { AUTH_API_BASE_URL, AUTH_REGION } from '@/config/env';
import {
  DEV_SERVER_ENVIRONMENT_SWITCH_ENABLED,
  switchDevServerEnvironmentAndReload,
  type DevServerEnvironment,
} from '@/config/devServerEnvironment';
import { useDevServerEnvironment } from '@/config/useDevServerEnvironment';
import { diagnosticUploadConfigured, uploadMobileDiagnostics } from '@/debug/mobileDiagnosticUpload';
import { clearDiagnostics, diagnosticsEnabled, exportDiagnostics, hydrateDiagnostics, setDiagnosticsEnabled } from '@/debug/localDiagnostics';
import { SimpleStackHeader, simpleScrollInsetProps, simpleScrollScreenSafeAreaEdges } from '@/platform/chrome';
import { ActionInfoRow, InfoRow, SettingsGroup, SettingsSwitchRow } from '@/session/SettingsGroupRows';
import { buildMobileDebugRows, type MobileSettingsRow } from '@/settings/mobileSettings';
import { buildMobileUpdateInfoRows, currentMobileOtaVersion } from '@/settings/updateInfo';
import { useThemedStyles, type ThemeColors } from '@/theme';
import { fontWeight, lineHeight, spacing, typeScale } from '@/theme/tokens';
import { probeBetaChannel } from '@/update/fetchLatestRelease';
import { useBetaChannel } from '@/update/useBetaChannel';
import { goBackGuarded } from '@/utils/backGuard';

/**
 * 设置的二级页「开发者」:原先折叠在设置页底部的调试 / 开发者分组。
 *
 * 按用途分组,每组一段 footer 说明(iOS Section footer):Debug 日志、Beta 测试渠道、
 * 服务器环境(仅 CindyDev)、标识信息、更新信息。卡片里不放成句说明。
 */
export default function DeveloperSettingsScreen() {
  const router = useRouter();
  const styles = useThemedStyles(makeStyles);
  const { t } = useTranslation();
  const auth = useAuth();

  // —— Debug 日志 ——
  const [localLogsEnabled, setLocalLogsEnabled] = useState(false);
  const [localLogsReady, setLocalLogsReady] = useState(false);
  const [localLogsBusy, setLocalLogsBusy] = useState(false);
  const [localLogsConsent, setLocalLogsConsent] = useState(false);
  const [localLogUploadMessage, setLocalLogUploadMessage] = useState<string | null>(null);
  const localLogsLock = useRef(false);
  useEffect(() => {
    let mounted = true;
    void hydrateDiagnostics().then(() => {
      if (mounted) {
        setLocalLogsEnabled(diagnosticsEnabled());
        setLocalLogsReady(true);
      }
    });
    return () => {
      mounted = false;
    };
  }, []);
  // 上传日志沿用隐私政策同意事实;store 是本机唯一真相,订阅以免设置页改动后本页陈旧。
  useEffect(() => {
    let cancelled = false;
    const sync = () => {
      if (!cancelled) setLocalLogsConsent(getAnalyticsConsentState().consent);
    };
    void hydrateAnalyticsConsent().then(sync).catch(() => undefined);
    const unsubscribe = subscribeAnalyticsConsent(sync);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);
  const runLocalLogAction = async (action: () => Promise<void>) => {
    if (localLogsLock.current) return;
    localLogsLock.current = true;
    setLocalLogsBusy(true);
    try {
      await action();
    } catch {
      Alert.alert(
        t('settings.localLogs.title'),
        t('settings.localLogs.failed'),
      );
    } finally {
      setLocalLogsEnabled(diagnosticsEnabled());
      setLocalLogsBusy(false);
      localLogsLock.current = false;
    }
  };
  const confirmClearLocalLogs = () => {
    if (!localLogsReady || localLogsBusy) return;
    Alert.alert(t('settings.localLogs.clear'), t('settings.localLogs.clearHint'), [
      { text: t('settings.localLogs.cancel'), style: 'cancel' },
      { text: t('settings.localLogs.clear'), style: 'destructive', onPress: () => void runLocalLogAction(clearDiagnostics) },
    ]);
  };
  const uploadLocalLogs = () =>
    void runLocalLogAction(async () => {
      const result = await uploadMobileDiagnostics();
      if (result.kind === 'uploaded') {
        let copied = false;
        try { await Clipboard.setStringAsync(result.uploadCode); copied = true; } catch { /* upload already succeeded */ }
        setLocalLogUploadMessage(t(copied ? 'settings.localLogs.uploadCopied' : 'settings.localLogs.uploadSucceeded', { code: result.uploadCode }));
      } else setLocalLogUploadMessage(t(`settings.localLogs.uploadResult.${result.kind}`));
    });
  const uploadConfigured = diagnosticUploadConfigured();
  // 上传不可用的原因、上传结果都接在本组说明后面,不写进行里。
  const localLogsStatus = !uploadConfigured
    ? t('settings.localLogs.uploadResult.unavailable')
    : !localLogsConsent ? t('settings.localLogs.uploadResult.consentRequired')
      : localLogUploadMessage;

  // —— Beta 测试渠道 ——
  // 落盘后通知通道订阅,根部会按有效通道重新检查整包更新。
  const { enabled: betaEnabled, ready: betaReady, setEnabled: setBetaEnabled } = useBetaChannel();
  const [betaBusy, setBetaBusy] = useState(false);
  const toggleBeta = useCallback(async () => {
    if (betaBusy) return;
    setBetaBusy(true);
    const next = !betaEnabled;
    try {
      if (next) {
        // 打开 beta 前预检(与桌面端 probeBetaManifest 对称):探测 /latest?channel=beta
        // 是否可达。服务端未部署 beta 时拒绝开启,避免设备静默收不到 OTA/整包/强更记录。
        const available = await probeBetaChannel(
          Platform.OS === 'android' ? 'android' : 'ios',
        );
        if (!available) {
          Alert.alert(t('settings.betaChannel.title'), t('settings.betaChannel.unavailable'));
          return; // 不落盘,开关保持关闭
        }
      }
      await setBetaEnabled(next);
    } catch {
      // 只可能是本机存储异常;store 会回推真值,这里仅提示未保存成功。
      Alert.alert(t('settings.betaChannel.title'), t('settings.betaChannel.saveFailed'));
    } finally {
      setBetaBusy(false);
    }
  }, [betaBusy, betaEnabled, setBetaEnabled, t]);

  // —— 服务器环境(仅 CindyDev) ——
  const {
    environment: devServerEnvironment,
    ready: devServerEnvironmentReady,
    setEnvironment: setDevServerEnvironment,
  } = useDevServerEnvironment();
  const [devServerEnvironmentBusy, setDevServerEnvironmentBusy] = useState(false);
  const switchDevServerEnvironment = useCallback(
    async (next: DevServerEnvironment) => {
      if (
        !DEV_SERVER_ENVIRONMENT_SWITCH_ENABLED ||
        devServerEnvironmentBusy ||
        !devServerEnvironmentReady ||
        next === devServerEnvironment
      ) {
        return;
      }
      const reload = __DEV__
        ? () => DevSettings.reload()
        : Updates.isEnabled
          ? () => Updates.reloadAsync()
          : null;
      if (!reload) {
        Alert.alert(
          t('settings.devServerEnvironment.title'),
          t('settings.devServerEnvironment.switchFailed'),
        );
        return;
      }
      setDevServerEnvironmentBusy(true);
      try {
        // 旧环境的 push 注销、token 与账号缓存必须先在旧端点仍生效时清理。
        await auth.logout();
        await switchDevServerEnvironmentAndReload({
          current: devServerEnvironment,
          next,
          reload,
          setEnvironment: setDevServerEnvironment,
        });
      } catch {
        Alert.alert(
          t('settings.devServerEnvironment.title'),
          t('settings.devServerEnvironment.switchFailed'),
        );
      } finally {
        setDevServerEnvironmentBusy(false);
      }
    },
    [
      auth,
      devServerEnvironment,
      devServerEnvironmentBusy,
      devServerEnvironmentReady,
      setDevServerEnvironment,
      t,
    ],
  );
  const confirmDevServerEnvironmentSwitch = useCallback(() => {
    if (
      !DEV_SERVER_ENVIRONMENT_SWITCH_ENABLED ||
      devServerEnvironmentBusy ||
      !devServerEnvironmentReady
    ) {
      return;
    }
    const next: DevServerEnvironment =
      devServerEnvironment === 'dev' ? 'release' : 'dev';
    Alert.alert(
      t('settings.devServerEnvironment.confirmTitle', {
        environment: t(`settings.devServerEnvironment.options.${next}`),
      }),
      t('settings.devServerEnvironment.confirmBody'),
      [
        { text: t('settings.devServerEnvironment.cancel'), style: 'cancel' },
        {
          text: t('settings.devServerEnvironment.switchAction'),
          style: 'destructive',
          onPress: () => void switchDevServerEnvironment(next),
        },
      ],
    );
  }, [
    devServerEnvironment,
    devServerEnvironmentBusy,
    devServerEnvironmentReady,
    switchDevServerEnvironment,
    t,
  ]);

  // —— 标识信息 / 更新信息 ——
  // t 依赖:行构造走 i18n.t,语言切换时重算。
  const identityRows = useMemo(
    () => buildMobileDebugRows({
      authBaseUrl: AUTH_API_BASE_URL,
      authRegion: AUTH_REGION,
      deviceId: auth.deviceId,
      userId: auth.user?.id,
    }),
    [auth.deviceId, auth.user?.id, t],
  );
  const [copiedRowId, setCopiedRowId] = useState<string | null>(null);
  const copyRow = useCallback(async (row: MobileSettingsRow) => {
    if (!row.copyValue) return;
    await Clipboard.setStringAsync(row.copyValue);
    setCopiedRowId(row.id);
  }, []);
  // 当前运行的 OTA bundle 信息(只读),用于核验热更是否生效。
  const { currentlyRunning } = useUpdates();
  const updateInfoRows = useMemo(() => buildMobileUpdateInfoRows(currentlyRunning), [currentlyRunning, t]);
  const otaVersion = useMemo(() => currentMobileOtaVersion(currentlyRunning), [currentlyRunning, t]);

  const localLogsDisabled = !localLogsReady || localLogsBusy;

  return (
    <SafeAreaView edges={simpleScrollScreenSafeAreaEdges()} style={styles.safeArea} testID="settings.developer.screen">
      <SimpleStackHeader
        scrollEdge
        backTestID="settings.developer.backButton"
        onBack={() => goBackGuarded(router, '/settings')}
        title={t('settings.developer.title')}
      />
      <ScrollView {...simpleScrollInsetProps} contentContainerStyle={styles.content} testID="settings.developer.scroll">
        <SettingsGroup
          footer={t('settings.localLogs.footer')}
          messages={[localLogsStatus ? { text: localLogsStatus, testID: 'settings.localLogs.status' } : null]}
          title={t('settings.localLogs.title')}
        >
          <SettingsSwitchRow
            accessibilityLabel={t('settings.localLogs.record')}
            disabled={localLogsDisabled}
            key="local-logs-toggle"
            label={t('settings.localLogs.record')}
            onValueChange={(value) =>
              void runLocalLogAction(() =>
                setDiagnosticsEnabled(value),
              )
            }
            testID="settings.localLogs"
            value={localLogsEnabled}
          />
          <ActionInfoRow
            accessibilityLabel={t('settings.localLogs.export')}
            disabled={localLogsDisabled}
            key="local-logs-export"
            label={t('settings.localLogs.export')}
            onPress={() => void runLocalLogAction(exportDiagnostics)}
            testID="settings.localLogs.export"
            value={localLogsBusy ? t('settings.localLogs.busy') : ''}
          />
          <ActionInfoRow
            accessibilityLabel={t('settings.localLogs.upload')}
            chevron={false}
            disabled={localLogsDisabled || !uploadConfigured || !localLogsConsent}
            key="local-logs-upload"
            label={t('settings.localLogs.upload')}
            onPress={uploadLocalLogs}
            testID="settings.localLogs.upload"
            value={localLogsBusy ? t('settings.localLogs.busy') : ''}
          />
          <ActionInfoRow
            accessibilityLabel={t('settings.localLogs.clear')}
            chevron={false}
            disabled={localLogsDisabled}
            key="local-logs-clear"
            label={t('settings.localLogs.clear')}
            onPress={confirmClearLocalLogs}
            testID="settings.localLogs.clear"
          />
        </SettingsGroup>

        <SettingsGroup
          footer={t('settings.betaChannel.description')}
          title={t('settings.betaChannel.title')}
        >
          <SettingsSwitchRow
            accessibilityLabel={t('settings.betaChannel.title')}
            disabled={betaBusy || !betaReady}
            label={t('settings.betaChannel.title')}
            onValueChange={() => void toggleBeta()}
            switchTestID="settings.betaChannelToggle"
            testID="settings.betaChannelToggleRow"
            value={betaEnabled}
          />
        </SettingsGroup>

        {DEV_SERVER_ENVIRONMENT_SWITCH_ENABLED ? (
          <SettingsGroup
            footer={t('settings.devServerEnvironment.description')}
            title={t('settings.devServerEnvironment.title')}
          >
            <ActionInfoRow
              accessibilityLabel={t('settings.devServerEnvironment.accessibility')}
              label={t('settings.devServerEnvironment.title')}
              onPress={confirmDevServerEnvironmentSwitch}
              testID="settings.devServerEnvironment"
              value={
                devServerEnvironmentBusy
                  ? t('settings.devServerEnvironment.switching')
                  : t(`settings.devServerEnvironment.options.${devServerEnvironment}`)
              }
            />
          </SettingsGroup>
        ) : null}

        <SettingsGroup title={t('settings.developer.identity')}>
          {identityRows.map((row) => (
            row.copyValue ? (
              <CopyRow copied={copiedRowId === row.id} key={row.id} onCopy={copyRow} row={row} />
            ) : (
              <InfoRow key={row.id} label={row.label} testID={`settings.row.${row.id}`} value={row.value} />
            )
          ))}
        </SettingsGroup>

        <SettingsGroup title={t('settings.developer.updateInfo')}>
          <InfoRow
            key="ota-version"
            label={t('settings.updateInfo.otaVersion')}
            testID="settings.otaVersion"
            value={otaVersion}
          />
          {updateInfoRows.map((row) => (
            <InfoRow key={row.id} label={row.label} testID={`settings.updateInfo.${row.id}`} value={row.value} />
          ))}
        </SettingsGroup>
      </ScrollView>
    </SafeAreaView>
  );
}

/** 可复制行(长 ID / URL):标签 + 值堆叠在左,复制按钮在右。 */
function CopyRow({
  copied,
  onCopy,
  row,
}: {
  copied: boolean;
  onCopy(row: MobileSettingsRow): void;
  row: MobileSettingsRow;
}) {
  const styles = useThemedStyles(makeStyles);
  const { t } = useTranslation();
  return (
    <View style={styles.copyRow} testID={`settings.row.${row.id}`}>
      <View style={styles.copyText}>
        <Text style={styles.copyLabel}>{row.label}</Text>
        <Text selectable style={styles.copyValue} numberOfLines={2}>{row.value}</Text>
      </View>
      {row.copyValue ? (
        // 自守卫:没有 copyValue 就不渲染复制按钮,避免出现"按了没反应"的死按钮。
        <MainWindowActionButton
          action={{
            accessibilityLabel: t('settings.copyRow.accessibility', { label: row.label }),
            label: copied ? t('settings.copyRow.done') : t('settings.copyRow.action'),
            onPress: () => onCopy(row),
            testID: `settings.copy.${row.id}`,
          }}
          density="compact"
          style={styles.copyButton}
        />
      ) : null}
    </View>
  );
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  safeArea: { backgroundColor: colors.surface, flex: 1 },
  content: {
    gap: spacing.xl,
    paddingBottom: spacing.xxl,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.lg,
  },
  copyRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.md,
    minHeight: 60,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  copyText: { flex: 1, gap: spacing.xs, minWidth: 0 },
  copyLabel: { color: colors.textSecondary, fontSize: typeScale.footnote, lineHeight: lineHeight.caption, fontWeight: fontWeight.regular },
  copyValue: { color: colors.textPrimary, fontSize: typeScale.bodySmall, lineHeight: lineHeight.bodySmall },
  copyButton: { flexShrink: 0, minWidth: 60 },
});
