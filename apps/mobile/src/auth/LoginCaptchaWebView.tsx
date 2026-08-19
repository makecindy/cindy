import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, BackHandler, Pressable, StyleSheet, View } from 'react-native';
import { WebView } from 'react-native-webview';

import { parseCaptchaWebViewMessage } from '@/auth/loginCaptchaMessage';
import {
  isAllowedLoginCaptchaNavigation,
  isAllowedLoginCaptchaPageUrl,
  withLoginCaptchaTheme,
} from '@/auth/loginCaptchaUrl';
import { loginText } from '@/auth/loginMessages';
import { Text } from '@/components/AppText';
import { useTheme } from '@/theme';
import { fontWeight, lineHeight, radius, typeScale } from '@/theme/tokens';

/**
 * LoginCaptchaWebView — 登录人机验证模态层(global 邮箱发码前置闸)。
 *
 * incognito WebView 装载 auth-server 托管的 Turnstile 挑战页;导航白名单只放行
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
          width: 340,
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
            style={{ alignItems: 'center', height: 220, justifyContent: 'center', width: 308 }}
          >
            <Text style={{ color: login.loginError, fontSize: typeScale.footnote, textAlign: 'center' }}>
              {loginText('captchaFailed')}
            </Text>
            <Pressable
              accessibilityRole="button"
              onPress={retry}
              style={{ marginTop: 12, padding: 6 }}
              testID="login.captcha.retry"
            >
              <Text style={{ color: login.linkText, fontSize: typeScale.footnote }}>
                {loginText('captchaRetry')}
              </Text>
            </Pressable>
          </View>
        ) : (
          <View style={{ height: 220, marginTop: 8, width: 308 }}>
            <WebView
              key={generation}
              incognito
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
                // 即使平台导航回调存在竞态，也只接收仍由预期托管顶层页发出的消息。
                if (!isAllowedLoginCaptchaPageUrl(event.nativeEvent.url, themedUrl)) return;
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
          style={{ marginTop: 8, padding: 6 }}
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
