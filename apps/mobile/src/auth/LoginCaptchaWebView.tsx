import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, BackHandler, Pressable, StyleSheet, View } from 'react-native';
import { WebView } from 'react-native-webview';

import { parseCaptchaWebViewMessage } from '@/auth/loginCaptchaMessage';
import {
  isAllowedLoginCaptchaNavigation,
  withLoginCaptchaTheme,
} from '@/auth/loginCaptchaUrl';
import { loginText } from '@/auth/loginMessages';
import { Text } from '@/components/AppText';
import { useTheme } from '@/theme';
import { fontWeight, lineHeight, radius, spacing, typeScale } from '@/theme/tokens';

/** 挑战总时限：网络半通或 iframe 卡死时转入弹窗内重试态。 */
const CHALLENGE_TIMEOUT_MS = 120_000;

/**
 * LoginCaptchaWebView — 登录人机验证模态层(global 邮箱发码前置闸)。
 *
 * 内嵌 WebView 装载 auth-server 托管的 Turnstile 挑战页;导航白名单只放行
 * 托管页同源与 Turnstile 挑战 iframe,其余一律拒。结果经 onResult 一次性回传:
 * token = 通过,null = 用户取消。加载失败/挑战页报错 → 卡片内重试态。
 * 遮罩与 Android 返回键语义对齐 LoginConsentDialog(遮罩不可点穿、返回 = 取消)。
 */
export function LoginCaptchaWebView({
  url,
  onResult,
}: {
  /** 托管挑战页完整地址(AuthContext 按构建区域 authApiBaseUrl 拼出)。 */
  url: string;
  onResult: (token: string | null) => void;
}) {
  const { colors, mode } = useTheme();
  const login = colors.login;
  const [failed, setFailed] = useState(false);
  const [ready, setReady] = useState(false);
  const [generation, setGeneration] = useState(0);

  // Android 硬件返回键 = 取消(非原生 Modal 需自行拦截,同 LoginConsentDialog)。
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      onResult(null);
      return true;
    });
    return () => sub.remove();
  }, [onResult]);

  // 此组件位于 MobileLoginHandoffStage 的 ThemeOverrideProvider 内，mode 是登录
  // 子树真正显示的主题（首次启动固定 light，之后才跟随系统）。
  const themedUrl = useMemo(() => withLoginCaptchaTheme(url, mode), [mode, url]);

  // WebView 主文档成功不代表 Cloudflare iframe 一定能完成；为加载、挑战与回传
  // 设置同桌面端一致的总时限。成功/取消会卸载组件，失败与重试会重跑 effect，
  // cleanup 因而覆盖完成、重试和卸载三条清理路径。
  useEffect(() => {
    if (failed) return;
    const timeoutTimer = setTimeout(() => {
      setReady(false);
      setFailed(true);
    }, CHALLENGE_TIMEOUT_MS);
    return () => clearTimeout(timeoutTimer);
  }, [failed, generation, themedUrl]);

  const retry = () => {
    setReady(false);
    setFailed(false);
    setGeneration((value) => value + 1);
  };

  return (
    <View
      accessibilityViewIsModal
      style={[
        StyleSheet.absoluteFill,
        {
          alignItems: 'center',
          backgroundColor: login.consentOverlay,
          justifyContent: 'center',
          paddingHorizontal: spacing.lg,
          zIndex: 100,
        },
      ]}
      testID="login.captcha"
    >
      <View
        style={{
          alignItems: 'center',
          backgroundColor: login.panelBg,
          borderColor: login.panelBorder,
          borderRadius: radius.container,
          borderWidth: 1,
          paddingBottom: 12,
          paddingHorizontal: 16,
          paddingTop: 16,
          maxWidth: 340,
          width: '100%',
        }}
      >
        <Text
          style={{
            color: login.titleText,
            fontSize: typeScale.body,
            fontWeight: fontWeight.bold,
            lineHeight: lineHeight.bodyRelaxed,
          }}
        >
          {loginText('captchaTitle')}
        </Text>
        {failed ? (
          <View
            style={{
              alignItems: 'center',
              alignSelf: 'stretch',
              height: 220,
              justifyContent: 'center',
            }}
          >
            <Text style={{ color: login.loginError, fontSize: typeScale.footnote, textAlign: 'center' }}>
              {loginText('captchaFailed')}
            </Text>
            <Pressable
              accessibilityRole="button"
              onPress={retry}
              style={{
                alignItems: 'center',
                justifyContent: 'center',
                marginTop: spacing.md,
                minHeight: 44,
                minWidth: 44,
              }}
              testID="login.captcha.retry"
            >
              <Text style={{ color: login.linkText, fontSize: typeScale.footnote }}>
                {loginText('captchaRetry')}
              </Text>
            </Pressable>
          </View>
        ) : (
          <View style={{ alignSelf: 'stretch', height: 220, marginTop: 8 }}>
            <WebView
              key={generation}
              source={{ uri: themedUrl }}
              // react-native-webview 会把 originWhitelist 未命中的 URL 主动交给
              // Linking.openURL。因此这里只负责让导航进入下方回调;真正的同源
              // 白名单由回调精确判定,其余(含任意跳转/唤起外部)一律拒绝。
              originWhitelist={['*']}
              // Android 的 window.open/target=_blank 默认走 onCreateWindow，可能
              // 绕过导航回调并唤起外部浏览器；禁用多窗口后统一落回本 WebView 闸。
              setSupportMultipleWindows={false}
              onShouldStartLoadWithRequest={(request) =>
                isAllowedLoginCaptchaNavigation(request, themedUrl)
              }
              onMessage={(event) => {
                // 客户端不是认证边界：Android WebMessageListener 只上报 source origin，
                // 不保证带托管页 pathname。这里只校验 wire 契约；token 的真实性、action、
                // hostname、时效与一次性均由 auth-server Siteverify 最终裁决。
                const result = parseCaptchaWebViewMessage(event.nativeEvent.data);
                if (!result) return;
                if (result.ok) {
                  onResult(result.token);
                  return;
                }
                setFailed(true);
              }}
              onLoadEnd={() => setReady(true)}
              onError={() => setFailed(true)}
              onHttpError={() => setFailed(true)}
              onContentProcessDidTerminate={() => setFailed(true)}
              onRenderProcessGone={() => setFailed(true)}
              style={{ backgroundColor: 'transparent', flex: 1 }}
            />
            {!ready ? (
              <View
                pointerEvents="none"
                style={[StyleSheet.absoluteFill, { alignItems: 'center', justifyContent: 'center' }]}
              >
                <ActivityIndicator color={login.secondaryText} />
              </View>
            ) : null}
          </View>
        )}
        <Pressable
          accessibilityRole="button"
          onPress={() => onResult(null)}
          style={{
            alignItems: 'center',
            justifyContent: 'center',
            marginTop: spacing.sm,
            minHeight: 44,
            minWidth: 44,
          }}
          testID="login.captcha.cancel"
        >
          <Text style={{ color: login.secondaryText, fontSize: typeScale.footnote }}>
            {loginText('captchaCancel')}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}
