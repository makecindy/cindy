import { Animated, Easing, LayoutAnimation, Platform, UIManager, View } from 'react-native';
import { useEffect, useRef, useState } from 'react';
import { Text } from '@/components/AppText';
import { getCachedReduceMotionEnabled, useReduceMotionEnabled } from '@/hooks/useReduceMotion';
import { useThemedStyles, type ThemeColors } from '@/theme';
import { radius, typeScale } from '@/theme/tokens';
import { MOBILE_COMPOSER_CONTROL_SIZE } from '@/session/MobileComposerInputRow';

// 旧架构 Android 需要显式开启 LayoutAnimation;新架构(Fabric)下该开关是 no-op。
// 与 useComposerCardTransition / collapseAnimation 相同的模块级开关——本模块可能
// 在两者都未加载时独立使用,不能依赖别处的副作用(review 反馈)。
if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

/**
 * 录音中语音按钮的胶囊宽度(对齐桌面 VoiceInputButton 的红点+计时展开形态)。
 * 宽度是**驱动值**而非测量值:计时文本用 tabular-nums 定宽数字,宽度只取决于
 * 字符数(m:ss / mm:ss 两档),按钮与工具排占位 slot 从同一常量取值,推开左邻
 * 的停止按钮时零帧延迟、不会出现"胶囊先展开一帧盖住停止钮再弹开"的闪烁。
 * 估值按 iOS SF Pro / Android Roboto 的 13pt tabular 数字宽度取上限,内容居中,
 * 平台间 ±2pt 的差异被对称留白吸收。
 */
export const MOBILE_VOICE_RECORDING_PILL_WIDTH = 72;
export const MOBILE_VOICE_RECORDING_PILL_WIDTH_WIDE = 80;

/** 录音计时:从录音开始逐秒累计,格式 m:ss(对齐桌面 recTimeText)。 */
export function formatVoiceRecordingTime(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${minutes}:${String(remainder).padStart(2, '0')}`;
}

export interface MobileVoiceRecordingTimerInput {
  /** 胶囊是否展开(含按下即录的乐观 pending 期,展开时显示红点+计时)。 */
  expanded: boolean;
  /**
   * 是否正在真实采集音频(listening)。计时只在此期间走秒:启动链路
   * (权限弹窗/凭证/ASR 连接)不算录音时长,否则首次授权慢时胶囊一出现
   * 就已经显示好几秒(review 反馈)。pending 期展开显示静止的 0:00。
   */
  counting: boolean;
}

export interface MobileVoiceRecordingTimer {
  /** m:ss 计时文本;非展开态为 null(按钮应显示 Mic / spinner)。 */
  label: string | null;
  /** 语音按钮与工具排占位 slot 的当前应有宽度。 */
  pillWidth: number;
}

/**
 * 录音计时状态。counting 翻 true 时从 0 重新计时,expanded 翻 false 清零。
 * 同时在展开态翻转与宽度换档的下一帧布局注册一次 LayoutAnimation
 * (一次性瞬态、用户触发、有明确结束,符合动效红线;240ms 对齐桌面胶囊
 * 展开时长),让胶囊展开/收回与左邻按钮的让位在同一段运动里完成。
 */
export function useMobileVoiceRecordingTimer(
  { expanded, counting }: MobileVoiceRecordingTimerInput,
): MobileVoiceRecordingTimer {
  const [seconds, setSeconds] = useState(0);

  useEffect(() => {
    if (!counting) {
      if (!expanded) setSeconds(0);
      return;
    }
    setSeconds(0);
    const timer = setInterval(() => {
      setSeconds((current) => current + 1);
    }, 1000);
    return () => clearInterval(timer);
  }, [counting, expanded]);

  const label = expanded ? formatVoiceRecordingTime(seconds) : null;
  const pillWidth = label === null
    ? MOBILE_COMPOSER_CONTROL_SIZE
    : label.length > 4
      ? MOBILE_VOICE_RECORDING_PILL_WIDTH_WIDE
      : MOBILE_VOICE_RECORDING_PILL_WIDTH;

  const prevWidthRef = useRef(pillWidth);
  if (prevWidthRef.current !== pillWidth) {
    prevWidthRef.current = pillWidth;
    // reduce-motion 降级为直切,对齐桌面 prefers-reduced-motion 下
    // pillTransition = undefined 的行为。按 useReduceMotion 的约定,null
    // (首帧未查到)也按不播处理——缓存模块加载即预热,实际命中窗口极小。
    if (getCachedReduceMotionEnabled() === false) {
      LayoutAnimation.configureNext({
        duration: 240,
        update: { type: 'easeInEaseOut' },
      });
    }
  }

  return { label, pillWidth };
}

/**
 * 录音中胶囊的内容:脉冲红点 + m:ss 计时(对齐桌面 activeRecording 的
 * 红点 animate-pulse + tabular-nums 计时)。宿主按钮负责胶囊外形
 * (surfaceChip 底、pill 圆角、宽度取 useMobileVoiceRecordingTimer.pillWidth)。
 */
export function VoiceRecordingPillContent({ label, testID }: { label: string; testID?: string }) {
  const styles = useThemedStyles(makeVoiceRecordingPillStyles);
  const pulse = useRef(new Animated.Value(1)).current;
  const reduceMotion = useReduceMotionEnabled();

  useEffect(() => {
    // 与桌面 animate-pulse 同节奏(2s 往返、透明度 1↔0.5);opacity-only + native
    // driver,常驻循环动画的 compositor 约束(工程规范 §7 的 RN 对应物)满足。
    // reduce-motion 时不起循环,红点常亮(对齐桌面 motion-reduce:animate-none);
    // 循环动画按 hook 约定「只有 === false 才播」。
    if (reduceMotion !== false) {
      pulse.setValue(1);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, {
          duration: 1000,
          easing: Easing.inOut(Easing.ease),
          toValue: 0.5,
          useNativeDriver: true,
        }),
        Animated.timing(pulse, {
          duration: 1000,
          easing: Easing.inOut(Easing.ease),
          toValue: 1,
          useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [pulse, reduceMotion]);

  return (
    <View pointerEvents="none" style={styles.pillContent} testID={testID}>
      <Animated.View style={[styles.recordingDot, { opacity: pulse }]} />
      <Text style={styles.timeText}>{label}</Text>
    </View>
  );
}

const makeVoiceRecordingPillStyles = (colors: ThemeColors) => ({
  pillContent: {
    alignItems: 'center' as const,
    flexDirection: 'row' as const,
    gap: 6,
    justifyContent: 'center' as const,
  },
  recordingDot: {
    backgroundColor: colors.statusRecording,
    borderRadius: radius.pill,
    height: 8,
    width: 8,
  },
  timeText: {
    color: colors.textPrimary,
    fontSize: typeScale.footnote,
    fontVariant: ['tabular-nums' as const],
  },
});
