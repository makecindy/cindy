import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Animated, Image, Platform, StyleSheet } from 'react-native';
import { useLoginHandoffOptional } from '@/auth/MobileLoginHandoffContext';
import { useLoginFirstLaunchLight } from '@/auth/loginFirstLaunchGate';
import { resolveStartupSplashHandoff } from '@/auth/startupSplashContinuity';
import { CenteredScreen } from '@/components/CenteredScreen';
import { motionDuration, useTheme } from '@/theme';

/** splash 释放后的淡出时长(ms):盖住底下首屏首帧的绘制间隙,避免红→白闪帧 */
const SPLASH_FADE_OUT_MS = 220;
const nativeSplashHeroAsset = require('../../assets/login/login-hero.png');

type StartupSplashContextValue = {
  /** 启动链最后一道门通过后调用:淡出并卸载常驻 splash(幂等,可重复调用) */
  releaseSplash: () => void;
  /** splash 是否仍完整盖在业务树之上(淡出开始即为 false),供状态栏样式等联动 */
  splashActive: boolean;
};

const StartupSplashContext = createContext<StartupSplashContextValue>({
  releaseSplash: () => {},
  splashActive: false,
});

export function useStartupSplash(): StartupSplashContextValue {
  return useContext(StartupSplashContext);
}

/**
 * 启动 splash 常驻覆盖层。
 *
 * 启动闸门链(端点清单 → canary 渠道 → OTA 热更门 → auth 恢复)此前每一关各自渲染
 * 一个独立的 splash 实例,关与关交接时整棵子树 unmount/remount:导航器挂载空档会
 * 露出 surface 底色、splash 图片资源重新解码,肉眼可见"红→白→红"闪帧。改为在根部
 * 常驻同一个 splash 实例压在业务树之上,所有闸门期间保持挂载不动,最后一道门通过后
 * 整体淡出卸载,从结构上消除全部接缝。
 *
 * - `hidden`:启动被阻断(如端点清单拉取失败)需要露出底下错误屏时置 true;
 *   重试回到 pending 时自动恢复显示(release 之前覆盖层只是条件不渲染,状态不销毁)。
 * - 淡出是一次性 opacity 动画(非常驻循环),符合 compositor-only 动效要求。
 */
export function StartupSplashOverlay({
  hidden = false,
  children,
}: {
  hidden?: boolean;
  children: ReactNode;
}) {
  const { colors, mode } = useTheme();
  const handoffContext = useLoginHandoffOptional();
  const firstLaunchGate = useLoginFirstLaunchLight();
  const handoff = resolveStartupSplashHandoff(firstLaunchGate, mode);
  const nativeBridgeRequired = Platform.OS === 'android';
  const [nativeBridgeMounted, setNativeBridgeMounted] =
    useState(nativeBridgeRequired);
  const nativeBridgeOpacity = useRef(new Animated.Value(1)).current;
  const [releaseRequested, setReleaseRequested] = useState(false);
  const [released, setReleased] = useState(false);
  const [mounted, setMounted] = useState(true);
  const opacity = useRef(new Animated.Value(1)).current;
  const releaseSplash = useCallback(() => setReleaseRequested(true), []);

  // Android JS 首帧复刻原生红底 + hero。首启门决议后只淡出这一层，
  // 露出已选定正确主题的 MobileLoginHandoffStage；iOS 不挂该层，行为不变。
  useEffect(() => {
    if (!nativeBridgeMounted || handoff.showNativeBridge) return;
    if (handoffContext?.state.reducedMotion) {
      nativeBridgeOpacity.setValue(0);
      setNativeBridgeMounted(false);
      return;
    }
    const animation = Animated.timing(nativeBridgeOpacity, {
      duration: motionDuration.fast,
      toValue: 0,
      useNativeDriver: true,
    });
    animation.start(({ finished }) => {
      if (finished) setNativeBridgeMounted(false);
    });
    return () => animation.stop();
  }, [
    handoff.showNativeBridge,
    handoffContext?.state.reducedMotion,
    nativeBridgeMounted,
    nativeBridgeOpacity,
  ]);

  // 即使 auth 很快完成，也要等原生复刻层交接完再释放整个覆盖层。
  useEffect(() => {
    if (releaseRequested && !nativeBridgeMounted) setReleased(true);
  }, [nativeBridgeMounted, releaseRequested]);

  useEffect(() => {
    if (!released) return;
    const animation = Animated.timing(opacity, {
      duration: SPLASH_FADE_OUT_MS,
      toValue: 0,
      useNativeDriver: true,
    });
    animation.start(({ finished }) => {
      if (finished) setMounted(false);
    });
    return () => animation.stop();
  }, [opacity, released]);

  const value = useMemo(
    () => ({ releaseSplash, splashActive: mounted && !released && !hidden }),
    [hidden, mounted, released, releaseSplash],
  );

  return (
    <StartupSplashContext.Provider value={value}>
      {children}
      {mounted && !hidden ? (
        <Animated.View
          pointerEvents={released ? 'none' : 'auto'}
          style={[StyleSheet.absoluteFill, styles.overlay, { opacity }]}
        >
          <CenteredScreen title="Cindy" variant="splash" />
          {nativeBridgeMounted ? (
            <Animated.View
              pointerEvents="none"
              style={[
                StyleSheet.absoluteFill,
                styles.nativeBridge,
                {
                  backgroundColor: colors.brandSplashBackground,
                  opacity: nativeBridgeOpacity,
                },
              ]}
            >
              <Image
                accessible={false}
                resizeMode="contain"
                source={nativeSplashHeroAsset}
                style={styles.nativeBridgeHero}
              />
            </Animated.View>
          ) : null}
        </Animated.View>
      ) : null}
    </StartupSplashContext.Provider>
  );
}

const styles = StyleSheet.create({
  overlay: {
    // 业务树里带 elevation 的 Android 视图不允许爬到覆盖层之上
    elevation: 1000,
    zIndex: 1000,
  },
  nativeBridge: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  nativeBridgeHero: {
    // Expo Android 资源生成器把 imageWidth contain 到同宽方框，再居中放入
    // 288×288 drawable；这里保持同一 128×128 视口，避免 native → JS 缩放跳变。
    height: 128,
    width: 128,
  },
});
