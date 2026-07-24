import { useEffect, useMemo, useRef, type ReactNode } from 'react';
import {
  Animated,
  Easing,
  Image,
  StyleSheet,
  useWindowDimensions,
  View,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import Svg, { Circle, Path } from 'react-native-svg';

import {
  resolveLoginStage,
  resolveLoginSurface,
  type LoginStageBox,
  type LoginStageLayout,
  type LoginSurfaceLayout,
} from '@/auth/loginSkinLayout';
import {
  LOGIN_HANDOFF_EASING,
  LOGIN_HANDOFF_TIMING,
  loginHandoffMoveMs,
  loginHandoffSloganDelayMs,
} from '@/auth/loginHandoff';
import { useLoginHandoffOptional } from '@/auth/MobileLoginHandoffContext';
import { useLoginFirstLaunchLight } from '@/auth/loginFirstLaunchGate';
import { ThemeOverrideProvider, useTheme } from '@/theme';

/**
 * MobileLoginHandoffStage —— 白底体系登录/闸门**唯一 full-viewport 品牌宿主**
 * (PR4a 静态视觉宿主,implementation-plan Step 5 WHAT1 / v6.10;PR4b Step 5b
 * 接入 handoff 状态/入场动画 + §3.6 平板双构图 + 键盘位移)。
 *
 * 职责与坐标空间冻结(v6.5;背景 2026-07-22 对齐 PR#104 改纯平):
 *  - 背景 = 主题 surface 纯平底色(edge-to-edge 铺满含 safe area 外区域),
 *    早期 wave4 的双红叠层已撤除;endpoint/OTA/auth 各闸、config-missing、
 *    登录页、iPad 横竖屏全部复用本宿主,共享同一纯平底;
 *  - 底色钉在根 View 上不随键盘位移(keyboardShiftPx 只作用于品牌层,children 的
 *    位移由登录页内层 translate 容器自管,见 v5 冻结测量拓扑);
 *  - 品牌三要素(立绘/SLOGAN/字标)走 stage 坐标(resolveLoginSurface 布局引擎,
 *    U-8a 照 demo;§3.6 平板竖屏 744×1133 / 横屏 1180×820 双构图);新字标
 *    423×145 在字标框内 contain 等比适配,禁止非等比拉伸(368:1381 资产行);
 *  - handoff 动画(demo splashHandoff 时序冻结):splash 期立绘/字标簇按
 *    splashOffset 居中 + spinner;readiness 达成后 300ms 起 650ms 位移到登录位
 *    (iPad 横屏无位移变体),Slogan 在面板起步后 100ms 起 500ms 渐显;
 *    reduced-motion / Provider 缺席 → 静态终态。动画全部 transform/opacity +
 *    useNativeDriver(compositor-only,规则 7);spinner 仅 splash/handoff 期挂载。
 */

// 品牌资产(asset-manifest 登记;@2x/@3x 由 Metro 按设备 scale 解析)。
// 暗色画布用白字版字标/slogan(figma 532:585 CINDY_Standard_White / SLOGAN #FBFBFB),
// 立绘两模式同资产。
const heroAsset = require('../../assets/login/login-hero.png');
const sloganAsset = require('../../assets/login/login-slogan.png');
const sloganDarkAsset = require('../../assets/login/login-slogan-dark.png');
const wordmarkAsset = require('../../assets/login/login-wordmark.png');
const wordmarkDarkAsset = require('../../assets/login/login-wordmark-dark.png');
// iPad/平板双构图专属立绘裁切(§3.6;slogan/字标与手机共用同一资产,demo 同源)
const heroPadPortraitAsset = require('../../assets/login/login-hero-pad-portrait.png');
const heroPadLandscapeAsset = require('../../assets/login/login-hero-pad-landscape.png');

/** hook:物理 viewport → §3.6 三构图 surface 布局(useWindowDimensions → resolveLoginSurface)。 */
export function useLoginSurface(): LoginSurfaceLayout {
  const { width, height } = useWindowDimensions();
  return useMemo(() => resolveLoginSurface(width, height), [width, height]);
}

/** 兼容出口(PR4a 消费面):物理 viewport → 750 手机 stage 两档插值布局。 */
export function useLoginStage(): LoginStageLayout {
  const { width, height } = useWindowDimensions();
  return useMemo(() => resolveLoginStage(width, height), [width, height]);
}

/** stage 几何框 → 绝对定位 style(stage 坐标系内,缩放由外层 transform 承担)。 */
function boxStyle(box: LoginStageBox) {
  return {
    position: 'absolute' as const,
    left: box.x,
    top: box.y,
    width: box.w,
    height: box.h,
  };
}

/**
 * splash spinner(demo msSpin 尺寸/落点;白底体系沿 LoginLoadingRing 圈样式——
 * demo 的 invert 白 spinner 为红底时代参数,wave4 白底以近黑环呈现)。
 * 1s linear infinite,transform-only + useNativeDriver;仅 splash/handoff 期挂载。
 */
function SplashSpinner({
  size,
  opacity,
}: {
  size: number;
  opacity: Animated.Value;
}) {
  const { colors } = useTheme();
  const rotation = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.timing(rotation, {
        toValue: 1,
        duration: 1000,
        easing: Easing.linear,
        useNativeDriver: true,
      }),
    );
    loop.start();
    return () => loop.stop();
  }, [rotation]);
  const spin = rotation.interpolate({
    inputRange: [0, 1],
    outputRange: ['0deg', '360deg'],
  });
  return (
    <Animated.View
      style={{ width: size, height: size, opacity, transform: [{ rotate: spin }] }}
    >
      <Svg width={size} height={size} viewBox="0 0 64 64" fill="none" aria-hidden>
        <Circle
          cx="32"
          cy="32"
          r="29"
          stroke={colors.login.loadingRingTrack}
          strokeWidth="6"
        />
        <Path
          d="M61 32a29 29 0 0 0-29-29"
          stroke={colors.login.primaryButtonBg}
          strokeWidth="6"
          strokeLinecap="round"
        />
      </Svg>
    </Animated.View>
  );
}

/**
 * 品牌宿主组件。children 渲染在品牌层之上的 viewport 坐标 overlay
 * (登录页在其中自行铺设 stage 缩放的 Log_in 组;闸门屏放退化后的内容层)。
 * Provider 缺席时按静态终态渲染(PR4a 行为不变)。
 */
export function MobileLoginHandoffStage(props: {
  children?: ReactNode;
  /** handoff 动画期品牌层由本宿主状态机驱动;静态调用方恒显 */
  showBrand?: boolean;
  /** 键盘位移(物理 px,向上为正;只作用品牌层——children 位移由登录页自管) */
  keyboardShiftPx?: number;
  testID?: string;
  accessibilityLabel?: string;
}) {
  // 首启亮色门在品牌宿主层消费(DESIGN.md §16.5 主题跟随):splash/闸门/登录
  // 共享同一覆盖,首启不出现「舞台暗 → 登录亮」闪变;覆盖仅限本宿主子树。
  const firstLaunchGate = useLoginFirstLaunchLight();
  // pending(AsyncStorage 未决,eager kick 下近零时长且宿主在 auth.initialized
  // 后才挂载,实际几乎不会命中)时不渲染品牌内容:按任何主题渲染都可能产出
  // 错误主题帧(真首启透传系统暗色 → 判定后切亮),等判定完成再上。
  if (firstLaunchGate === 'pending') return null;
  return (
    <ThemeOverrideProvider mode={firstLaunchGate === 'light' ? 'light' : null}>
      <MobileLoginHandoffStageInner {...props} />
    </ThemeOverrideProvider>
  );
}

function MobileLoginHandoffStageInner({
  children,
  showBrand = true,
  keyboardShiftPx = 0,
  testID,
  accessibilityLabel,
}: {
  children?: ReactNode;
  /** handoff 动画期品牌层由本宿主状态机驱动;静态调用方恒显 */
  showBrand?: boolean;
  /** 键盘位移(物理 px,向上为正;只作用品牌层——children 位移由登录页自管) */
  keyboardShiftPx?: number;
  testID?: string;
  accessibilityLabel?: string;
}) {
  const { colors, mode } = useTheme();
  const stage = useLoginSurface();
  const handoff = useLoginHandoffOptional();
  // Provider 缺席 = 静态终态(pr4a 兼容);缺席时不播动画、不挂 spinner
  const phase = handoff?.state.phase ?? 'done';

  // 品牌资产为打包 require 资源(随 bundle 同步可用),宿主挂载即上报 assets 就绪
  useEffect(() => {
    handoff?.dispatch({ type: 'assets-ready' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // handoff 动画驱动(demo splashHandoff 时序;值域 1=splash 居中位,0=登录终位)
  const brandProgress = useRef(
    new Animated.Value(phase === 'done' ? 0 : 1),
  ).current;
  const sloganOpacity = useRef(
    new Animated.Value(phase === 'done' ? 1 : 0),
  ).current;
  const spinnerOpacity = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    if (phase === 'handoff') {
      const moveMs = loginHandoffMoveMs(stage.mode);
      Animated.timing(spinnerOpacity, {
        toValue: 0,
        duration: LOGIN_HANDOFF_TIMING.spinnerFadeMs,
        useNativeDriver: true,
      }).start();
      Animated.sequence([
        Animated.delay(LOGIN_HANDOFF_TIMING.brandMoveDelayMs),
        Animated.timing(brandProgress, {
          toValue: 0,
          duration: moveMs,
          easing: Easing.bezier(
            LOGIN_HANDOFF_EASING.brandMove[0],
            LOGIN_HANDOFF_EASING.brandMove[1],
            LOGIN_HANDOFF_EASING.brandMove[2],
            LOGIN_HANDOFF_EASING.brandMove[3],
          ),
          useNativeDriver: true,
        }),
      ]).start();
      Animated.sequence([
        Animated.delay(loginHandoffSloganDelayMs(stage.mode)),
        Animated.timing(sloganOpacity, {
          toValue: 1,
          duration: LOGIN_HANDOFF_TIMING.sloganInMs,
          easing: Easing.bezier(
            LOGIN_HANDOFF_EASING.sloganIn[0],
            LOGIN_HANDOFF_EASING.sloganIn[1],
            LOGIN_HANDOFF_EASING.sloganIn[2],
            LOGIN_HANDOFF_EASING.sloganIn[3],
          ),
          useNativeDriver: true,
        }),
      ]).start();
      return;
    }
    if (phase === 'done') {
      brandProgress.setValue(0);
      sloganOpacity.setValue(1);
      spinnerOpacity.setValue(0);
      return;
    }
    brandProgress.setValue(1);
    sloganOpacity.setValue(0);
    spinnerOpacity.setValue(1);
  }, [phase, stage.mode, brandProgress, sloganOpacity, spinnerOpacity]);

  // splash 簇偏移(stage 坐标;外层 scale 会同步放大,pad-landscape 恒 0 无位移)
  const brandTranslate = brandProgress.interpolate({
    inputRange: [0, 1],
    outputRange: [0, stage.splashOffset],
  });

  const heroSource =
    stage.mode === 'pad-portrait'
      ? heroPadPortraitAsset
      : stage.mode === 'pad-landscape'
        ? heroPadLandscapeAsset
        : heroAsset;
  // 暗色画布用白字版字标/slogan;立绘两模式同资产(figma 532:585)
  const wordmarkSource = mode === 'dark' ? wordmarkDarkAsset : wordmarkAsset;
  const sloganSource = mode === 'dark' ? sloganDarkAsset : sloganAsset;

  return (
    <View
      accessibilityLabel={accessibilityLabel}
      style={[styles.root, { backgroundColor: colors.login.bgBase }]}
      testID={testID}
    >
      {/* 白底体系:状态栏随主题模式(旧红底 splash 的恒 light 样式随之退役) */}
      <StatusBar style={mode === 'dark' ? 'light' : 'dark'} />
      {showBrand ? (
        // 键盘位移层(demo kb-shift 同构):品牌随面板整体上顶,根 View 纯平底不动
        <View
          pointerEvents="none"
          style={[
            styles.stage,
            {
              left: stage.offsetX,
              top: stage.offsetY,
              width: stage.stageWidth,
              height: stage.stageHeight,
              transform: [
                { translateY: -keyboardShiftPx },
                { scale: stage.scale },
              ],
            },
          ]}
        >
          {/* splash 簇位移层:立绘 + 字标(demo splashHandoff 只移这两者) */}
          <Animated.View
            style={[
              StyleSheet.absoluteFill,
              { transform: [{ translateY: brandTranslate }] },
            ]}
          >
            <Image
              accessibilityIgnoresInvertColors
              resizeMode="contain"
              source={heroSource}
              style={boxStyle(stage.cindy)}
            />
            <Image
              accessibilityIgnoresInvertColors
              resizeMode="contain"
              source={wordmarkSource}
              style={boxStyle(stage.word)}
            />
          </Animated.View>
          {/* Slogan:splash 期隐藏,面板起步后 100ms 渐显(终位固定不随簇移) */}
          <Animated.View
            style={[boxStyle(stage.slogan), { opacity: sloganOpacity }]}
          >
            <Image
              accessibilityIgnoresInvertColors
              resizeMode="contain"
              source={sloganSource}
              style={styles.sloganImage}
            />
          </Animated.View>
          {/* splash spinner:仅 splash/handoff 期挂载(限时长,规则 7) */}
          {handoff != null && phase !== 'done' ? (
            <View
              style={{
                position: 'absolute',
                left: stage.spinner.x,
                top: stage.spinner.y,
              }}
            >
              <SplashSpinner size={stage.spinner.size} opacity={spinnerOpacity} />
            </View>
          ) : null}
        </View>
      ) : null}
      {children != null ? <View style={StyleSheet.absoluteFill}>{children}</View> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    overflow: 'hidden',
  },
  sloganImage: {
    height: '100%',
    width: '100%',
  },
  stage: {
    position: 'absolute',
    // stage → 物理 px:整层 transform 缩放,原点钉左上(demo transform-origin:0 0)
    transformOrigin: 'top left',
  },
});
