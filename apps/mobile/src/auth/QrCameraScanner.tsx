/**
 * 扫码登录的相机取景（只识别二维码）。只能经 qr-scan 页按需加载：expo-camera 在 import
 * 期就要求原生模块存在，入口先用 isQrScanSupported() 判断。
 *
 * 进入即开相机：未决定时自动请求一次权限（系统弹授权框），授权后直接取景，不需要先点按钮。
 * 系统不再弹窗（iOS 拒绝过）时显示「打开系统设置」；Android 拒绝后仍可再问时显示「允许使用相机」，
 * 由用户决定是否再试，不自动反复弹窗。从系统设置回到 App 时重新读取权限。
 */
import { CameraView, useCameraPermissions } from 'expo-camera';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AppState, Linking, StyleSheet, View } from 'react-native';

import { Text } from '@/components/AppText';
import { MainWindowActionButton } from '@/components/MobilePrimitives';
import { useThemedStyles, type ThemeColors } from '@/theme';
import { fontWeight, lineHeight, radius, spacing, typeScale } from '@/theme/tokens';

export default function QrCameraScanner({
  paused,
  onScanned,
}: {
  /** 处理上一次结果或已进入确认时暂停识别，避免同一个码连续触发。 */
  paused: boolean;
  onScanned: (data: string) => void;
}) {
  const { t } = useTranslation();
  const styles = useThemedStyles(makeStyles);
  const [permission, requestPermission, getPermission] = useCameraPermissions();
  const [autoRequest, setAutoRequest] = useState<'idle' | 'pending' | 'done'>('idle');

  useEffect(() => {
    if (!permission || permission.granted || !permission.canAskAgain || autoRequest !== 'idle') return;
    setAutoRequest('pending');
    void requestPermission()
      .catch(() => undefined)
      .finally(() => setAutoRequest('done'));
  }, [autoRequest, permission, requestPermission]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') void getPermission().catch(() => undefined);
    });
    return () => subscription.remove();
  }, [getPermission]);

  let body;
  if (!permission || (!permission.granted && permission.canAskAgain && autoRequest !== 'done')) {
    // 权限未读到或系统授权框还在：只显示空取景框，不闪按钮。
    body = null;
  } else if (!permission.granted) {
    body = (
      <View style={styles.permission} testID="qrScan.permission">
        <Text style={styles.permissionText}>{t('settings.qrLogin.cameraNeeded')}</Text>
        <MainWindowActionButton
          action={permission.canAskAgain
            ? {
                label: t('settings.qrLogin.grantCamera'),
                onPress: () => void requestPermission(),
                testID: 'qrScan.grantCamera',
                tone: 'primary',
              }
            : {
                label: t('settings.qrLogin.openSettings'),
                onPress: () => void Linking.openSettings().catch(() => undefined),
                testID: 'qrScan.openSettings',
                tone: 'primary',
              }}
        />
      </View>
    );
  } else {
    body = (
      <CameraView
        barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
        facing="back"
        onBarcodeScanned={paused ? undefined : (result) => onScanned(result.data)}
        style={StyleSheet.absoluteFill}
        testID="qrScan.camera"
      />
    );
  }
  return <View style={styles.viewfinder}>{body}</View>;
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  viewfinder: {
    alignSelf: 'stretch',
    aspectRatio: 1,
    backgroundColor: colors.surfaceElevated,
    borderColor: colors.border,
    borderRadius: radius.container,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
  },
  permission: {
    alignItems: 'center',
    flex: 1,
    gap: spacing.md,
    justifyContent: 'center',
    padding: spacing.lg,
  },
  // 相机权限说明:15/20 400 textSecondary,居中。
  permissionText: {
    color: colors.textSecondary,
    fontSize: typeScale.bodySmall,
    fontWeight: fontWeight.regular,
    lineHeight: lineHeight.bodySmall,
    textAlign: 'center',
  },
});
