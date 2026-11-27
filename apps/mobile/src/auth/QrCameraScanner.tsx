/**
 * 扫码登录的相机取景（只识别二维码）。只能经 qr-scan 页按需加载：expo-camera 在 import
 * 期就要求原生模块存在，入口先用 isQrScanSupported() 判断。
 */
import { CameraView, useCameraPermissions } from 'expo-camera';
import { useTranslation } from 'react-i18next';
import { Linking, StyleSheet, View } from 'react-native';

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
  const [permission, requestPermission] = useCameraPermissions();

  let body;
  if (!permission) {
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
