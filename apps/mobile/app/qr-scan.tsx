/**
 * 扫码登录（App 内扫码）。只有一个方向：电脑已登录，在「远程控制 Cindy」弹窗里显示二维码；
 * 手机在登录页「还没有 Cindy 账号」里点「扫码登录」，扫这张码认领，回到登录页等电脑允许
 * （电脑是另一个版本时，是否切换也在登录页询问）。
 *
 * 二维码是带 cindy_login 参数的官网下载页链接；不是 Cindy 登录码的一律提示后继续识别。
 */
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { decodeQrLoginUrl } from '@cindy/auth-client';

import { useAuth } from '@/auth/AuthContext';
import { isQrScanSupported } from '@/auth/qrScanSupport';
import { Text } from '@/components/AppText';
import {
  SimpleStackHeader,
  simpleScrollInsetProps,
  simpleScrollScreenSafeAreaEdges,
} from '@/platform/chrome/SimpleStackHeader';
import { useThemedStyles, type ThemeColors } from '@/theme';
import { fontWeight, lineHeight, radius, spacing, typeScale } from '@/theme/tokens';
import { goBackGuarded } from '@/utils/backGuard';

const QrCameraScanner = lazy(() => import('@/auth/QrCameraScanner'));

/** 认错码后的提示停留时间，之后恢复识别。 */
const RESCAN_DELAY_MS = 1_500;

export default function QrScanScreen() {
  const router = useRouter();
  const { t } = useTranslation();
  const styles = useThemedStyles(makeStyles);
  const auth = useAuth();
  const [message, setMessage] = useState<string | null>(null);
  const handlingRef = useRef(false);
  const rescanTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const supported = isQrScanSupported();

  const leave = useCallback(() => goBackGuarded(router, '/login'), [router]);

  useEffect(() => () => {
    if (rescanTimerRef.current) clearTimeout(rescanTimerRef.current);
  }, []);

  const handleScanned = useCallback((data: string) => {
    if (handlingRef.current) return;
    handlingRef.current = true;
    const payload = decodeQrLoginUrl(data);
    if (!payload) {
      setMessage(t('settings.qrLogin.wrongCode'));
      if (rescanTimerRef.current) clearTimeout(rescanTimerRef.current);
      rescanTimerRef.current = setTimeout(() => {
        handlingRef.current = false;
      }, RESCAN_DELAY_MS);
      return;
    }
    setMessage(null);
    // 认领、版本切换询问与等待允许都在登录页进行；失败也在登录页显示。
    void auth.dispatchLoginAction({ type: 'qr-claim', payload });
    leave();
  }, [auth, leave, t]);

  return (
    <SafeAreaView edges={simpleScrollScreenSafeAreaEdges()} style={styles.screen} testID="qrScan.screen">
      <SimpleStackHeader scrollEdge title={t('settings.qrLogin.scanTitle')} backTestID="qrScan.back" onBack={leave} />
      <ScrollView {...simpleScrollInsetProps} contentContainerStyle={styles.content}>
        {supported ? (
          <Suspense fallback={<View style={styles.viewfinderFallback} />}>
            <QrCameraScanner paused={false} onScanned={handleScanned} />
          </Suspense>
        ) : null}
        <Text style={styles.hint}>{t('settings.qrLogin.hintLogin')}</Text>
        <Text style={styles.note}>{t('settings.qrLogin.hintLoginDetail')}</Text>
        {message ? (
          <Text accessibilityLiveRegion="polite" style={styles.error} testID="qrScan.message">{message}</Text>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  screen: { backgroundColor: colors.surface, flex: 1 },
  content: { gap: spacing.md, padding: spacing.lg, paddingTop: spacing.xl },
  viewfinderFallback: {
    alignSelf: 'stretch',
    aspectRatio: 1,
    backgroundColor: colors.surfaceElevated,
    borderRadius: radius.container,
  },
  // 扫码说明:15/20 500 textPrimary。
  hint: {
    color: colors.textPrimary,
    fontSize: typeScale.bodySmall,
    fontWeight: fontWeight.medium,
    lineHeight: lineHeight.bodySmall,
  },
  // 说明 / 提示:13/18 400 textSecondary。
  note: {
    color: colors.textSecondary,
    fontSize: typeScale.footnote,
    fontWeight: fontWeight.regular,
    lineHeight: lineHeight.caption,
  },
  // 失败说明:13/18 400 errorText(黑白系)。
  error: {
    color: colors.errorText,
    fontSize: typeScale.footnote,
    fontWeight: fontWeight.regular,
    lineHeight: lineHeight.caption,
  },
});
