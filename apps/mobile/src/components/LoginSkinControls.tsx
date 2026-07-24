import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  Animated,
  Easing,
  Pressable,
  StyleSheet,
  View,
  type TextInputProps,
} from 'react-native';
import Svg, { Circle, Path } from 'react-native-svg';

import {
  formatResendCountdown,
  LOGIN_BACK,
  LOGIN_CONTROL,
  LOGIN_DISABLED_TEXT_OPACITY,
  LOGIN_ERROR_TEXT,
  LOGIN_GROUP,
  LOGIN_LOADING_RING,
  LOGIN_METHOD_ROW,
  LOGIN_SOCIAL,
  LOGIN_SPINNER,
  LOGIN_SUBTITLE,
  LOGIN_TEXT_LINK,
  LOGIN_TITLE,
  RESEND_COUNTDOWN_TICK_MS,
  resendCountdownRemaining,
} from '@/auth/loginSkinLayout';
import { Text, TextInput } from '@/components/AppText';
import { useTheme, useThemedStyles } from '@/theme';
import { fontWeight, loginSizes, radius, type ThemeColors } from '@/theme/tokens';

/**
 * LoginSkinControls —— 移动端登录皮肤组件库(figma-component-spec §4 RN 重建,
 * PR4a Step 5 WHAT2;与桌面 LoginControls.tsx 同参数源对齐)。
 *
 * 态系(design.md §2,移动无 hover):
 *  - pressed = 叠遮罩不改布局:主钮/圆钮亮色叠黑 50% / 暗色叠黑 10%(figma
 *    white_button Pressed)、浅底控件(方式行/tabs/返回钮)两模式叠黑 8%(§2.2)——
 *    overlay View 挂在内容之上,pointerEvents 穿透;
 *  - disabled = login.disabledButtonOverlay 白 70% 叠层 + 边 controlBorderDisabled
 *    + 文字 opacity 0.8(两模式同构,DESIGN.md §16.5 disabled 特例);
 *  - spinner/loading 环动画 = 外层 Animated 旋转 wrapper + 静态 SVG 图形
 *    (仓规 7 的 RN 对应:useNativeDriver transform,compositor-only;仅 loading 期挂载)。
 *
 * 尺寸全部为 750 设计 px(loginSkinLayout 常量),由消费方外层统一 transform 缩放。
 * 颜色只从 `colors.login` 双态色板取(仓规 16;暗色实现 PR 起登录皮随 light/dark
 * 二态切换,叠层 rgba 已并入色板二态,DESIGN.md §16.1/§16.5)。
 */

/** pressed / disabled 叠层(圆角随宿主传入,盖满整个控件面)。 */
function StateOverlay({
  pressed,
  disabled,
  cornerRadius,
  pressedTone,
}: {
  pressed: boolean;
  disabled?: boolean;
  cornerRadius: number;
  /** dark = 主钮/圆钮(亮黑50%/暗黑10%);light = 浅底控件(两模式黑8%) */
  pressedTone: 'dark' | 'light';
}) {
  const { colors } = useTheme();
  if (!pressed && !disabled) return null;
  return (
    <View
      pointerEvents="none"
      style={[
        StyleSheet.absoluteFill,
        { borderRadius: cornerRadius },
        disabled
          ? { backgroundColor: colors.login.disabledButtonOverlay }
          : {
              backgroundColor:
                pressedTone === 'dark'
                  ? colors.login.overlayButtonPressed
                  : colors.login.overlayControlPressed,
            },
      ]}
    />
  );
}

/** 面板(figma §4:680×440 r36 panelBg;wave4 1px inside 描边 368:1383 → RN borderWidth 1)。 */
export function LoginPanel({
  children,
  testID,
}: {
  children: ReactNode;
  testID?: string;
}) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.panel} testID={testID}>
      {children}
    </View>
  );
}

/** 标题块(figma §5.1:标题 y=31 h=38 32 Bold 居中;副标题 x=41 y=75 w=599 20 Regular 居中)。 */
export function LoginTitleBlock({
  title,
  subtitle,
  titleTestID,
}: {
  title: string;
  subtitle?: string;
  titleTestID?: string;
}) {
  const styles = useThemedStyles(makeStyles);
  return (
    <>
      <Text numberOfLines={1} style={styles.title} testID={titleTestID}>
        {title}
      </Text>
      {subtitle != null ? (
        <Text numberOfLines={1} style={styles.subtitle}>
          {subtitle}
        </Text>
      ) : null}
    </>
  );
}

/**
 * 输入框(figma §4.1/§4.2:540×80 r40 controlBg;default 边 controlBorder +
 * 24 Regular placeholder;focus/filled 边 controlBorderActive + 24 Bold controlText;
 * error 边 loginError;center=验证码变体居中)。
 */
export function LoginSkinInput({
  value,
  onChangeText,
  placeholder,
  editable = true,
  error,
  center,
  top = LOGIN_CONTROL.inputY,
  testID,
  ...inputProps
}: {
  value: string;
  onChangeText: (next: string) => void;
  placeholder: string;
  editable?: boolean;
  error?: boolean;
  /** 验证码变体:文本居中(figma §4.2) */
  center?: boolean;
  top?: number;
  testID?: string;
} & Omit<
  TextInputProps,
  'style' | 'value' | 'onChangeText' | 'placeholder' | 'editable'
>) {
  const [focused, setFocused] = useState(false);
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const filled = value.length > 0;
  const active = focused || filled;
  return (
    <TextInput
      {...inputProps}
      editable={editable}
      onBlur={() => setFocused(false)}
      onChangeText={onChangeText}
      onFocus={() => setFocused(true)}
      placeholder={placeholder}
      placeholderTextColor={colors.login.controlPlaceholder}
      style={[
        styles.input,
        {
          top,
          borderColor: error
            ? colors.login.loginError
            : active
              ? colors.login.controlBorderActive
              : colors.login.controlBorder,
          color: active
            ? colors.login.controlText
            : colors.login.controlPlaceholder,
          fontWeight: active ? fontWeight.bold : fontWeight.regular,
        },
        center ? styles.inputCenter : null,
      ]}
      testID={testID}
      value={value}
    />
  );
}

/**
 * 固定国家码手机号输入。外层视觉沿用 LoginSkinInput,左侧纯文本前缀不可点击,
 * 输入框只承载本地 11 位号码。
 */
export function LoginSkinPhoneInput({
  value,
  onChangeText,
  placeholder,
  prefix,
  editable = true,
  error,
  top = LOGIN_CONTROL.inputY,
  testID,
  ...inputProps
}: {
  value: string;
  onChangeText: (next: string) => void;
  placeholder: string;
  prefix: string;
  editable?: boolean;
  error?: boolean;
  top?: number;
  testID?: string;
} & Omit<
  TextInputProps,
  'style' | 'value' | 'onChangeText' | 'placeholder' | 'editable'
>) {
  const [focused, setFocused] = useState(false);
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const filled = value.length > 0;
  const active = focused || filled;
  const borderColor = error
    ? colors.login.loginError
    : active
      ? colors.login.controlBorderActive
      : colors.login.controlBorder;
  return (
    <View
      style={[styles.phoneInput, { top, borderColor }]}
      testID={testID ? `${testID}.shell` : undefined}
    >
      <Text
        accessibilityElementsHidden
        importantForAccessibility="no"
        numberOfLines={1}
        style={styles.phonePrefix}
      >
        {prefix}
      </Text>
      <TextInput
        {...inputProps}
        editable={editable}
        onBlur={() => setFocused(false)}
        onChangeText={onChangeText}
        onFocus={() => setFocused(true)}
        placeholder={placeholder}
        placeholderTextColor={colors.login.controlPlaceholder}
        style={[
          styles.phoneInputField,
          {
            color: active
              ? colors.login.controlText
              : colors.login.controlPlaceholder,
            fontWeight: active ? fontWeight.bold : fontWeight.regular,
          },
        ]}
        testID={testID}
        value={value}
      />
    </View>
  );
}

/** spinner 图形(静态 SVG,旋转由外层 Animated wrapper 承载——仓规 7 RN 对应)。 */
function LoginSpinnerGlyph({ box }: { box: number }) {
  const { colors } = useTheme();
  return (
    <Svg width={box} height={box} viewBox="0 0 24 24" fill="none" aria-hidden>
      <Circle
        cx="12"
        cy="12"
        r="10"
        stroke={colors.login.primaryButtonText}
        strokeOpacity="0.25"
        strokeWidth="3"
      />
      <Path
        d="M22 12a10 10 0 0 0-10-10"
        stroke={colors.login.primaryButtonText}
        strokeWidth="3"
        strokeLinecap="round"
      />
    </Svg>
  );
}

/** 旋转 wrapper(Animated.loop + useNativeDriver transform;仅挂载期常转,离场即卸)。 */
function SpinBox({ box, children }: { box: number; children: ReactNode }) {
  const spin = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.timing(spin, {
        duration: 900,
        easing: Easing.linear,
        toValue: 1,
        useNativeDriver: true,
      }),
    );
    loop.start();
    return () => loop.stop();
  }, [spin]);
  const rotate = spin.interpolate({
    inputRange: [0, 1],
    outputRange: ['0deg', '360deg'],
  });
  return (
    <Animated.View style={{ height: box, transform: [{ rotate }], width: box }}>
      {children}
    </Animated.View>
  );
}

/**
 * 主按钮(figma §4.3 五态的移动子集:normal / pressed 黑 50% / loading spinner 24@(487,27)
 * / disabled 白 70% 叠层 + 边 controlBorderDisabled + 文字 80%)。busy 阻断交互但
 * 不套 disabled 视觉(五态互斥,对齐桌面)。
 */
export function LoginPrimaryButton({
  label,
  onPress,
  disabled,
  busy,
  top = LOGIN_CONTROL.buttonY,
  testID,
}: {
  label: string;
  onPress?: () => void;
  disabled?: boolean;
  busy?: boolean;
  top?: number;
  testID?: string;
}) {
  const inert = disabled || busy;
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ busy, disabled: inert }}
      disabled={inert}
      onPress={busy ? undefined : onPress}
      style={[
        styles.primaryButton,
        {
          top,
          // disabled 底/边/字两模式同构(暗色不随 primaryButtonBg 反相为白;figma Disable)
          backgroundColor: disabled
            ? colors.login.disabledButtonBg
            : colors.login.primaryButtonBg,
          borderColor: disabled
            ? colors.login.controlBorderDisabled
            : colors.login.primaryButtonBorder,
        },
      ]}
      testID={testID}
    >
      {({ pressed }) => (
        <>
          <Text
            numberOfLines={1}
            style={[
              styles.primaryButtonText,
              disabled
                ? [styles.disabledText, { color: colors.login.disabledButtonText }]
                : null,
            ]}
          >
            {label}
          </Text>
          {busy ? (
            <View accessibilityRole="progressbar" style={styles.primarySpinner}>
              <SpinBox box={LOGIN_SPINNER.size}>
                <LoginSpinnerGlyph box={LOGIN_SPINNER.size} />
              </SpinBox>
            </View>
          ) : null}
          <StateOverlay
            cornerRadius={LOGIN_CONTROL.radius}
            disabled={disabled}
            pressed={pressed && !inert}
            pressedTone="dark"
          />
        </>
      )}
    </Pressable>
  );
}

/**
 * 第三方圆钮行(figma §4.5:y=480、80×80、gap 70,行内水平居中——demo socialRow left 公式)。
 * SSO 圆钮同款,作为行内最后一颗(329:243)。
 */
export function LoginSocialRow({
  children,
  count,
}: {
  children: ReactNode;
  count: number;
}) {
  const styles = useThemedStyles(makeStyles);
  const left = Math.max(
    0,
    (LOGIN_GROUP.width -
      (count * LOGIN_SOCIAL.size + Math.max(0, count - 1) * LOGIN_SOCIAL.gap)) /
      2,
  );
  return (
    <View style={[styles.socialRow, { left }]} testID="login.socialRow">
      {children}
    </View>
  );
}

/**
 * 第三方/SSO 圆钮(80×80 r50→radius.pill 圆,icon 48 居中)。
 *
 * 态系(§10 拍板 2026-07-21):仅 normal + pressed(双端,黑 50% 叠层照抄主按钮);
 * **无 disabled / loading 态**(用户 2026-07-21 拍板移除,覆盖 §2.2 表 2026-07-19
 * loading/disabled 两行;圆钮从不曾实现 loading/busy,disabled 渲染路径本轮删除)。
 * 移动端无 hover(figma §0.1)。normal 底色/描边走 loginColors token;pressed 叠层
 * 为 figma §2.1 实测 rgba 字面参数(与主按钮同款,非主题色——token-decision-table §3)。
 */
export function LoginSocialButton({
  label,
  onPress,
  children,
  testID,
  busy,
}: {
  label: string;
  onPress: () => void;
  children: ReactNode;
  testID?: string;
  /**
   * in-flight 态(登录发起中):仅输出 accessibilityState.busy 无障碍语义,不传原生 disabled——
   * 圆钮无 disabled 视觉态(§10 拍板 2026-07-21 移除 loading/disabled 态),视觉/交互态不变;
   * 交互 guard 由调用方 onPress 闭包兜(login.tsx SC-SOC-7:`if (disabled) return`),
   * 与本组件对称的桌面 LoginSocialButton `aria-disabled` 语义一致。
   */
  busy?: boolean;
}) {
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  return (
    <Pressable
      accessibilityLabel={label}
      accessibilityRole="button"
      // 无障碍语义:in-flight 时标 busy(对齐桌面 aria-disabled);不传原生 disabled——
      // 圆钮无 disabled 视觉态(§10 拍板),视觉/交互态不变。
      accessibilityState={{ busy: busy }}
      onPress={onPress}
      style={[
        styles.socialButton,
        {
          borderColor: colors.login.primaryButtonBorder,
        },
      ]}
      testID={testID}
    >
      {({ pressed }) => (
        <>
          <View style={styles.socialIconBox}>{children}</View>
          <StateOverlay
            cornerRadius={radius.pill}
            pressed={pressed}
            pressedTone="dark"
          />
        </>
      )}
    </Pressable>
  );
}

/** 返回按钮(figma §4.6:@(20,20) 60×60 r40 controlBg,边框白 247:1636;pressed 黑 8%)。 */
export function LoginBackButton({
  label,
  onPress,
  disabled,
  testID,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  testID?: string;
}) {
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  return (
    <Pressable
      accessibilityLabel={label}
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={styles.backButton}
      testID={testID}
    >
      {({ pressed }) => (
        <>
          {/* 24 box 内左向 chevron(247:1635 icon 语义;矢量重绘,静态) */}
          <Svg
            width={LOGIN_BACK.icon}
            height={LOGIN_BACK.icon}
            viewBox="0 0 24 24"
            fill="none"
            aria-hidden
          >
            <Path
              d="M14.5 5.5 8 12l6.5 6.5"
              stroke={colors.login.controlText}
              strokeWidth="2.4"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </Svg>
          <StateOverlay
            cornerRadius={LOGIN_BACK.radius}
            pressed={pressed && !disabled}
            pressedTone="light"
          />
        </>
      )}
    </Pressable>
  );
}

/** 错误提示文本(figma §4.8:680×50 @(0,380) 20 Regular loginError 居中)。 */
export function LoginErrorText({
  children,
  testID,
}: {
  children: ReactNode;
  testID?: string;
}) {
  const styles = useThemedStyles(makeStyles);
  return (
    <Text
      accessibilityRole="alert"
      numberOfLines={2}
      style={styles.errorText}
      testID={testID}
    >
      {children}
    </Text>
  );
}

/**
 * 方式行(figma §4.9 + demo:540×100 r60 controlBg/controlBorder;标题 24 Bold /
 * 副行 20 secondaryText 左对齐 x=67;左 enterprise 24 box @(27,37) / person 18×20 @(30,39);
 * 右 share 18 @(490,40);pressed 黑 8%)。
 */
export function LoginMethodRow({
  top,
  title,
  subtitle,
  onPress,
  disabled,
  icon = 'enterprise',
  testID,
  accessibilityLabel,
}: {
  top: number;
  title: string;
  subtitle?: string;
  onPress: () => void;
  disabled?: boolean;
  icon?: 'enterprise' | 'person';
  testID?: string;
  accessibilityLabel?: string;
}) {
  const styles = useThemedStyles(makeStyles);
  return (
    <Pressable
      accessibilityLabel={accessibilityLabel ?? title}
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={[styles.methodRow, { top }]}
      testID={testID}
    >
      {({ pressed }) => (
        <>
          <View
            style={
              icon === 'person'
                ? styles.methodRowPersonIcon
                : styles.methodRowLeftIcon
            }
          >
            {icon === 'person' ? <PersonIcon /> : <EnterpriseIcon />}
          </View>
          <View style={styles.methodRowTextBox}>
            <Text numberOfLines={1} style={styles.methodRowTitle}>
              {title}
            </Text>
            {subtitle != null ? (
              <Text numberOfLines={1} style={styles.methodRowSubtitle}>
                {subtitle}
              </Text>
            ) : null}
          </View>
          <View style={styles.methodRowRightIcon}>
            <ShareIcon />
          </View>
          <StateOverlay
            cornerRadius={LOGIN_METHOD_ROW.radius}
            pressed={pressed && !disabled}
            pressedTone="light"
          />
        </>
      )}
    </Pressable>
  );
}

/**
 * 大 loading 环(figma §5.2:64×64 @(308,158/193);底圈浅 + 深色内弧;
 * 静态 SVG + 外层 Animated 旋转 wrapper,仅挂载期动画)。
 */
export function LoginLoadingRing({ y, label }: { y: number; label: string }) {
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  return (
    <View
      accessibilityLabel={label}
      accessibilityRole="progressbar"
      style={[styles.loadingRing, { top: y }]}
    >
      <SpinBox box={LOGIN_LOADING_RING.size}>
        <Svg
          width={LOGIN_LOADING_RING.size}
          height={LOGIN_LOADING_RING.size}
          viewBox="0 0 64 64"
          fill="none"
          aria-hidden
        >
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
      </SpinBox>
    </View>
  );
}

/**
 * 验证码重发倒计时链接(figma §4.7 + Step 3a 契约:@(70,238) 540×50 20;
 * 倒计时中 = controlPlaceholder 无下划线「{n} 秒后可重新发送」(42 起,首帧 42);
 * 归零 = controlText 带下划线「重新发送验证码」可点)。
 * 绝对 deadline 模型:渲染每 tick 用 Date.now() 重算剩余秒(非递减计数,
 * 系统休眠/挂起恢复自校正);deadline 变化(重发成功重置)即重启 tick;
 * 卸载/离开清理 interval。
 */
export function LoginResendCountdown({
  deadline,
  countdownTemplate,
  resendLabel,
  onResend,
  disabled,
  testID,
}: {
  /** 绝对 deadline(ms);null = 无倒计时,直接可点 */
  deadline: number | null;
  /** 5 语「{n} 秒后可重新发送」模板(loginText('resendCountdown')) */
  countdownTemplate: string;
  /** 归零后的「重新发送验证码」文案 */
  resendLabel: string;
  onResend: () => void;
  disabled?: boolean;
  testID?: string;
}) {
  const styles = useThemedStyles(makeStyles);
  const [now, setNow] = useState(() => Date.now());
  const remaining =
    deadline == null ? 0 : resendCountdownRemaining(deadline, now);
  useEffect(() => {
    if (deadline == null) return;
    // deadline <= now 时同步切链接态,无需再起 interval
    if (resendCountdownRemaining(deadline, Date.now()) <= 0) {
      setNow(Date.now());
      return;
    }
    setNow(Date.now());
    const timer = setInterval(() => {
      const ts = Date.now();
      setNow(ts);
      // 归零即停表:切链接态后不再空 tick(避免每秒无意义 setState/重渲染)
      if (resendCountdownRemaining(deadline, ts) <= 0) clearInterval(timer);
    }, RESEND_COUNTDOWN_TICK_MS);
    return () => clearInterval(timer);
  }, [deadline]);
  if (remaining > 0) {
    return (
      <View pointerEvents="none" style={styles.textLinkSlotBox}>
        <Text numberOfLines={1} style={styles.countdownText}>
          {formatResendCountdown(countdownTemplate, remaining)}
        </Text>
      </View>
    );
  }
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onResend}
      style={styles.textLinkSlotBox}
      testID={testID}
    >
      <Text numberOfLines={1} style={styles.resendLinkText}>
        {resendLabel}
      </Text>
    </Pressable>
  );
}

/** Text_link 位静态说明文案(sso-org hint / binding contact 等,figma §4.7 位)。
 *  共享 textLinkSlotBox 槽(与 LoginResendCountdown 倒计时/重发同槽),View +
 *  justifyContent center 构造保证各屏同位、切换零跳(iOS 上 Text 的 textAlignVertical
 *  不生效,旧写法顶对齐→与重发 Pressable 居中错位)。 */
export function LoginTextLinkSlot({
  children,
  top,
  tone = 'placeholder',
}: {
  children: ReactNode;
  top?: number;
  tone?: 'placeholder' | 'secondary';
}) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View pointerEvents="none" style={[styles.textLinkSlotBox, top != null && { top }]}>
      <Text
        numberOfLines={2}
        style={[
          styles.textLinkSlotText,
          tone === 'secondary'
            ? styles.textLinkSecondary
            : styles.textLinkPlaceholder,
        ]}
      >
        {children}
      </Text>
    </View>
  );
}

/* ── 图标(矢量源 = figma 现导 SVG path 内联,登记见 asset-manifest.md;
      Google/WeChat fill 为厂商固定品牌色,跨模式不变;Apple/SSO 为单色图标,
      随圆钮底反相(亮色深圆上白/浅图标,暗色白圆上 #2A2828 深图标——figma
      white apple 489:676 / white SSO 489:710 核验)——与桌面 assets/login/icons 同源) ── */

/** Apple(247:1692,ic:baseline-apple;亮白 / 暗 #2A2828 反相)。 */
function AppleIcon() {
  const { mode } = useTheme();
  return (
    <Svg width="100%" height="100%" viewBox="0 0 48 48" fill="none" aria-hidden>
      <Path
        d="M33.0984 39.56C31.1384 41.46 28.9984 41.16 26.9384 40.26C24.7584 39.34 22.7584 39.3 20.4584 40.26C17.5784 41.5 16.0584 41.14 14.3384 39.56C4.57837 29.5 6.01838 14.18 17.0984 13.62C19.7984 13.76 21.6784 15.1 23.2584 15.22C25.6184 14.74 27.8784 13.36 30.3984 13.54C33.4184 13.78 35.6984 14.98 37.1984 17.14C30.9584 20.88 32.4384 29.1 38.1584 31.4C37.0184 34.4 35.5384 37.38 33.0784 39.58L33.0984 39.56ZM23.0584 13.5C22.7584 9.04 26.3784 5.36 30.5384 5C31.1184 10.16 25.8584 14 23.0584 13.5Z"
        fill={mode === 'dark' ? '#2A2828' : '#FFFFFF'}
      />
    </Svg>
  );
}

/** Google(247:1714,material-icon-theme:google 四色品牌 mark)。 */
function GoogleIcon() {
  return (
    <Svg width="100%" height="100%" viewBox="0 0 48 48" fill="none" aria-hidden>
      <Path
        d="M22.1323 7.58511C23.8472 7.39351 24.862 7.39351 26.7047 7.58511C29.9666 8.06789 32.9903 9.57562 35.3387 11.8903C33.7518 13.3903 32.1857 14.9122 30.6409 16.4556C27.6825 13.9482 24.3803 13.3695 20.7343 14.7194C18.0597 15.9494 16.1973 17.9427 15.147 20.6993C13.4307 19.4215 11.7368 18.114 10.066 16.7773C9.94986 16.7162 9.81724 16.6938 9.6875 16.7135C12.3416 11.5962 16.489 8.55259 22.1299 7.58274"
        fill="#F44336"
        opacity={0.987}
      />
      <Path
        d="M9.68212 16.7126C9.81617 16.6921 9.94311 16.7134 10.063 16.7765C11.7338 18.1132 13.4277 19.4207 15.144 20.6984C14.8739 21.7725 14.7037 22.8692 14.6354 23.9746C14.6938 25.0438 14.8633 26.0933 15.144 27.1231L9.80986 31.3691C7.48696 26.5151 7.44438 21.6297 9.68212 16.7126Z"
        fill="#FFC107"
        opacity={0.997}
      />
      <Path
        d="M35.0866 36.513C33.4257 35.0483 31.6869 33.6743 29.8779 32.3971C31.6914 31.1166 32.7921 29.3598 33.1801 27.1268H24.293V20.9553C29.4182 20.9127 34.541 20.9561 39.6615 21.0854C40.6329 26.3604 39.5109 31.1166 36.2954 35.3539C35.913 35.7604 35.508 36.1472 35.0866 36.513Z"
        fill="#448AFF"
        opacity={0.999}
      />
      <Path
        d="M15.1466 27.127C17.0863 31.9478 20.6424 34.1981 25.8149 33.878C27.2669 33.7099 28.6591 33.2027 29.8788 32.3972C31.6892 33.6777 33.4255 35.0497 35.0876 36.5132C32.454 38.8797 29.0961 40.2839 25.5618 40.4966C24.7589 40.5608 23.952 40.5608 23.149 40.4966C17.1281 39.787 12.6826 36.745 9.8125 31.3706L15.1466 27.127Z"
        fill="#43A047"
        opacity={0.993}
      />
    </Svg>
  );
}

/** WeChat(247:1724,selfhst:wechat 品牌绿)。 */
function WeChatIcon() {
  return (
    <Svg width="100%" height="100%" viewBox="0 0 48 48" fill="none" aria-hidden>
      <Path
        d="M39.0664 35.6885C41.4488 33.9711 43 31.4421 43 28.6088C43 23.4566 37.8195 19.3116 31.5035 19.3116C25.1875 19.3116 20.1109 23.4566 20.1109 28.6088C20.1109 33.761 25.1875 37.9132 31.5035 37.9132C32.8469 37.9132 34.0938 37.7103 35.2293 37.4059C35.6449 37.3045 36.0605 37.4059 36.1645 37.5074L38.7547 38.9204C39.0664 39.1233 39.3781 38.9204 39.2742 38.5146L38.6508 36.29C38.6508 35.9929 38.8586 35.79 39.0664 35.6885ZM27.6738 27.0943C26.8426 27.3117 25.9965 26.8262 25.7738 26.0146C25.5512 25.203 26.0484 24.3769 26.8797 24.1595C27.1395 24.0943 27.4141 24.0943 27.6738 24.1595C28.5051 24.3769 28.9949 25.203 28.7797 26.0146C28.6387 26.5435 28.2156 26.9566 27.6738 27.0943ZM35.3406 27.0943C34.5094 27.3117 33.6633 26.8262 33.4406 26.0146C33.218 25.203 33.7152 24.3769 34.5465 24.1595C34.8062 24.0943 35.0809 24.0943 35.3406 24.1595C36.1719 24.3769 36.6617 25.203 36.4465 26.0146C36.298 26.5435 35.875 26.9566 35.3406 27.0943ZM18.6711 9C11.1082 9 5 14.0507 5 20.2174C5 23.5508 6.75898 26.587 9.66094 28.6088C9.97266 28.8117 10.1805 29.116 10.0766 29.6233L9.34922 32.0508C9.24531 32.5581 9.66094 32.761 9.97266 32.6595L13.0824 30.9421C13.3941 30.7392 13.8098 30.6378 14.218 30.7392C16.9121 31.5508 19.1906 31.3479 19.4949 31.3479C17.0086 22.8551 25.6031 18 32.2309 18.4058C31.1992 13.1449 25.4992 9 18.6711 9ZM14.1141 18.3986C13.1121 18.6305 12.1102 18.029 11.8652 17.058C11.6203 16.087 12.2438 15.1015 13.2383 14.8623C13.5277 14.7971 13.8246 14.7971 14.1141 14.8623C15.116 15.0942 15.732 16.0797 15.4871 17.058C15.3238 17.7247 14.7895 18.2392 14.1141 18.3986ZM23.3246 18.3986C22.3227 18.6305 21.3207 18.029 21.0758 17.058C20.8309 16.087 21.4543 15.1015 22.4488 14.8623C22.7383 14.7971 23.0352 14.7971 23.3246 14.8623C24.3266 15.0942 24.9426 16.0797 24.6977 17.058C24.5418 17.7247 24.0074 18.2392 23.3246 18.3986Z"
        fill="#00C70A"
      />
    </Svg>
  );
}

/** SSO(329:248,「SSO」三字母矢量;亮 #EEEEEE / 暗 #2A2828 反相)。 */
function SsoIcon() {
  const { mode } = useTheme();
  const fill = mode === 'dark' ? '#2A2828' : '#EEEEEE';
  return (
    <Svg width="100%" height="100%" viewBox="0 0 48 48" fill="none" aria-hidden>
      <Path
        d="M37.8674 37.1222C35.8843 37.1222 34.3663 36.5591 33.3135 35.4329C32.2608 34.3066 31.7344 32.7152 31.7344 30.6585V17.1434C31.7344 15.0868 32.2608 13.4953 33.3135 12.3691C34.3663 11.2428 35.8843 10.6797 37.8674 10.6797C39.8506 10.6797 41.3685 11.2428 42.4213 12.3691C43.4741 13.4953 44.0005 15.0868 44.0005 17.1434V30.6585C44.0005 32.7152 43.4741 34.3066 42.4213 35.4329C41.3685 36.5591 39.8506 37.1222 37.8674 37.1222ZM37.8674 33.4497C39.263 33.4497 39.9607 32.605 39.9607 30.9156V16.8863C39.9607 15.197 39.263 14.3523 37.8674 14.3523C36.4719 14.3523 35.7741 15.197 35.7741 16.8863V30.9156C35.7741 32.605 36.4719 33.4497 37.8674 33.4497Z"
        fill={fill}
      />
      <Path
        d="M23.6135 37.1222C21.6548 37.1222 20.1736 36.5714 19.1698 35.4696C18.166 34.3433 17.6641 32.7396 17.6641 30.6585V29.1895H21.4834V30.9523C21.4834 32.6172 22.1812 33.4497 23.5768 33.4497C24.2623 33.4497 24.7764 33.2538 25.1192 32.8621C25.4864 32.4458 25.6701 31.7848 25.6701 30.8789C25.6701 29.8016 25.4252 28.8589 24.9356 28.051C24.4459 27.2185 23.54 26.2269 22.2179 25.0762C20.5531 23.6072 19.3901 22.285 18.7291 21.1098C18.068 19.9101 17.7375 18.5635 17.7375 17.07C17.7375 15.0378 18.2517 13.4708 19.28 12.3691C20.3082 11.2428 21.8017 10.6797 23.7604 10.6797C25.6945 10.6797 27.1513 11.2428 28.1306 12.3691C29.1344 13.4708 29.6363 15.0623 29.6363 17.1434V18.2085H25.817V16.8863C25.817 16.0049 25.6456 15.3683 25.3028 14.9766C24.9601 14.5604 24.4581 14.3523 23.7971 14.3523C22.4505 14.3523 21.7772 15.1725 21.7772 16.8129C21.7772 17.7433 22.0221 18.6125 22.5117 19.4204C23.0259 20.2284 23.944 21.2077 25.2661 22.3585C26.9554 23.8275 28.1184 25.1619 28.7549 26.3616C29.3915 27.5613 29.7098 28.9691 29.7098 30.5851C29.7098 32.6907 29.1834 34.3066 28.1306 35.4329C27.1023 36.5591 25.5966 37.1222 23.6135 37.1222Z"
        fill={fill}
      />
      <Path
        d="M9.94942 37.1222C7.99076 37.1222 6.50953 36.5714 5.50572 35.4696C4.50191 34.3433 4 32.7396 4 30.6585V29.1895H7.81938V30.9523C7.81938 32.6172 8.51715 33.4497 9.91269 33.4497C10.5982 33.4497 11.1124 33.2538 11.4551 32.8621C11.8224 32.4458 12.006 31.7848 12.006 30.8789C12.006 29.8016 11.7612 28.8589 11.2715 28.051C10.7818 27.2185 9.87597 26.2269 8.55387 25.0762C6.88902 23.6072 5.72606 22.285 5.06502 21.1098C4.40397 19.9101 4.07345 18.5635 4.07345 17.07C4.07345 15.0378 4.5876 13.4708 5.61589 12.3691C6.64418 11.2428 8.13766 10.6797 10.0963 10.6797C12.0305 10.6797 13.4872 11.2428 14.4666 12.3691C15.4704 13.4708 15.9723 15.0623 15.9723 17.1434V18.2085H12.1529V16.8863C12.1529 16.0049 11.9815 15.3683 11.6388 14.9766C11.296 14.5604 10.7941 14.3523 10.133 14.3523C8.78646 14.3523 8.11318 15.1725 8.11318 16.8129C8.11318 17.7433 8.35801 18.6125 8.84767 19.4204C9.36182 20.2284 10.2799 21.2077 11.602 22.3585C13.2914 23.8275 14.4543 25.1619 15.0909 26.3616C15.7274 27.5613 16.0457 28.9691 16.0457 30.5851C16.0457 32.6907 15.5193 34.3066 14.4666 35.4329C13.4383 36.5591 11.9326 37.1222 9.94942 37.1222Z"
        fill={fill}
      />
    </Svg>
  );
}

/** 第三方圆钮图标分发(figma §4.5 icon 48;providers.social 驱动显隐,无返回不渲染)。 */
export function LoginSocialGlyph({
  provider,
}: {
  provider: 'apple' | 'google' | 'wechat' | 'sso';
}) {
  if (provider === 'apple') return <AppleIcon />;
  if (provider === 'google') return <GoogleIcon />;
  if (provider === 'wechat') return <WeChatIcon />;
  return <SsoIcon />;
}

/** 方式行左 icon:carbon:enterprise(figma 现导矢量)。 */
function EnterpriseIcon() {
  const { colors } = useTheme();
  return (
    <Svg width="100%" height="100%" viewBox="0 0 24 24" fill="none" aria-hidden>
      <Path
        d="M6 6H7.5V9H6V6ZM6 10.5H7.5V13.5H6V10.5ZM10.5 6H12V9H10.5V6ZM10.5 10.5H12V13.5H10.5V10.5ZM6 15H7.5V18H6V15ZM10.5 15H12V18H10.5V15Z"
        fill={colors.login.controlText}
      />
      <Path
        d="M22.5 10.5C22.5 10.1022 22.342 9.72064 22.0607 9.43934C21.7794 9.15804 21.3978 9 21 9H16.5V3C16.5 2.60218 16.342 2.22064 16.0607 1.93934C15.7794 1.65804 15.3978 1.5 15 1.5H3C2.60218 1.5 2.22064 1.65804 1.93934 1.93934C1.65804 2.22064 1.5 2.60218 1.5 3V22.5H22.5V10.5ZM3 3H15V21H3V3ZM16.5 21V10.5H21V21H16.5Z"
        fill={colors.login.controlText}
      />
    </Svg>
  );
}

/** 方式行左 icon:person(18×20,figma 现导矢量)。 */
function PersonIcon() {
  const { colors } = useTheme();
  return (
    <Svg width="100%" height="100%" viewBox="0 0 18 20" fill="none" aria-hidden>
      <Path
        d="M9 10C11.76 10 14 7.76 14 5C14 2.24 11.76 0 9 0C6.24 0 4 2.24 4 5C4 7.76 6.24 10 9 10ZM9 2C10.65 2 12 3.35 12 5C12 6.65 10.65 8 9 8C7.35 8 6 6.65 6 5C6 3.35 7.35 2 9 2ZM1 20H17C17.55 20 18 19.55 18 19V18C18 14.14 14.86 11 11 11H7C3.14 11 0 14.14 0 18V19C0 19.55 0.45 20 1 20ZM7 13H11C13.76 13 16 15.24 16 18H2C2 15.24 4.24 13 7 13Z"
        fill={colors.login.controlText}
      />
    </Svg>
  );
}

/** 方式行右 icon:icon-park:share(18×18,figma 现导矢量)。 */
function ShareIcon() {
  const { colors } = useTheme();
  return (
    <Svg width="100%" height="100%" viewBox="0 0 20 20" fill="none" aria-hidden>
      <Path
        d="M12 1H19V8"
        stroke={colors.login.controlText}
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <Path
        d="M19 12.7368V17.5C19 18.3285 18.3285 19 17.5 19H2.5C1.67158 19 1 18.3285 1 17.5V2.5C1 1.67158 1.67158 1 2.5 1H7"
        stroke={colors.login.controlText}
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <Path
        d="M10.8999 9.09995L18.5499 1.44995"
        stroke={colors.login.controlText}
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}

/* ── styles(全部为 750 设计 px;文字排版档为设计稿几何值,不走 typeScale 阶梯——
      整层由消费方 transform 缩放,故引用 loginSkinLayout 常量而非主题排版 token)。
      工厂形态:登录皮随 light/dark 二态切换(暗色实现 PR),色值经 colors.login
      进入,useThemedStyles 按 mode 编译缓存(模块级工厂身份稳定,零热路径分配)。 ── */

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
  panel: {
    backgroundColor: colors.login.panelBg,
    borderColor: colors.login.panelBorder,
    borderRadius: loginSizes.panelRadius,
    borderWidth: 1,
    height: loginSizes.panelHeight,
    left: 0,
    overflow: 'hidden',
    position: 'absolute',
    top: 0,
    width: loginSizes.panelWidth,
  },
  title: {
    color: colors.login.titleText,
    fontSize: LOGIN_TITLE.font,
    fontWeight: fontWeight.bold,
    left: 0,
    // 行框 = 设计 h(38 @32):RN 默认行高 <38 且固定 height 会裁 descender
    // (AVD 实拍「登录 Cindy」y 尾巴被切)——显式 lineHeight + 去固定高,字形完整
    lineHeight: LOGIN_TITLE.height,
    position: 'absolute',
    textAlign: 'center',
    top: LOGIN_TITLE.y,
    width: loginSizes.panelWidth,
  },
  subtitle: {
    color: colors.login.secondaryText,
    fontSize: LOGIN_SUBTITLE.font,
    fontWeight: fontWeight.regular,
    left: LOGIN_SUBTITLE.x,
    // 同查:不设固定 height(设计 h=23 仅几何参考),盒随字形,descender 不受裁切
    position: 'absolute',
    textAlign: 'center',
    top: LOGIN_SUBTITLE.y,
    width: LOGIN_SUBTITLE.width,
  },
  input: {
    backgroundColor: colors.login.controlBg,
    borderRadius: LOGIN_CONTROL.radius,
    borderWidth: 1,
    fontSize: LOGIN_CONTROL.font,
    height: LOGIN_CONTROL.height,
    left: LOGIN_CONTROL.x,
    paddingLeft: LOGIN_CONTROL.textPadLeft,
    paddingRight: LOGIN_CONTROL.textPadLeft,
    position: 'absolute',
    width: LOGIN_CONTROL.width,
  },
  inputCenter: {
    paddingLeft: 0,
    paddingRight: 0,
    textAlign: 'center',
  },
  phoneInput: {
    alignItems: 'center',
    backgroundColor: colors.login.controlBg,
    borderRadius: LOGIN_CONTROL.radius,
    borderWidth: 1,
    flexDirection: 'row',
    height: LOGIN_CONTROL.height,
    left: LOGIN_CONTROL.x,
    paddingLeft: LOGIN_CONTROL.textPadLeft,
    paddingRight: LOGIN_CONTROL.textPadLeft,
    position: 'absolute',
    width: LOGIN_CONTROL.width,
  },
  phonePrefix: {
    color: colors.login.controlText,
    fontSize: LOGIN_CONTROL.font,
    fontWeight: fontWeight.bold,
    marginRight: 18,
  },
  phoneInputField: {
    flex: 1,
    fontSize: LOGIN_CONTROL.font,
    height: LOGIN_CONTROL.height,
    minWidth: 0,
    paddingHorizontal: 0,
    paddingVertical: 0,
  },
  primaryButton: {
    alignItems: 'center',
    backgroundColor: colors.login.primaryButtonBg,
    borderRadius: LOGIN_CONTROL.radius,
    borderWidth: 1,
    height: LOGIN_CONTROL.height,
    justifyContent: 'center',
    left: LOGIN_CONTROL.x,
    overflow: 'hidden',
    position: 'absolute',
    width: LOGIN_CONTROL.width,
  },
  primaryButtonText: {
    color: colors.login.primaryButtonText,
    fontSize: LOGIN_CONTROL.font,
    fontWeight: fontWeight.bold,
  },
  disabledText: {
    opacity: LOGIN_DISABLED_TEXT_OPACITY,
  },
  primarySpinner: {
    height: LOGIN_SPINNER.size,
    left: LOGIN_SPINNER.x,
    position: 'absolute',
    top: LOGIN_SPINNER.y,
    width: LOGIN_SPINNER.size,
  },
  socialRow: {
    flexDirection: 'row',
    gap: LOGIN_SOCIAL.gap,
    height: LOGIN_SOCIAL.size,
    position: 'absolute',
    top: LOGIN_SOCIAL.y,
  },
  socialButton: {
    alignItems: 'center',
    backgroundColor: colors.login.primaryButtonBg,
    borderRadius: radius.pill,
    borderWidth: 1,
    height: LOGIN_SOCIAL.size,
    justifyContent: 'center',
    overflow: 'hidden',
    width: LOGIN_SOCIAL.size,
  },
  socialIconBox: {
    height: LOGIN_SOCIAL.icon,
    width: LOGIN_SOCIAL.icon,
  },
  backButton: {
    alignItems: 'center',
    backgroundColor: colors.login.actionControlBg,
    borderColor: colors.login.backBorder,
    borderRadius: LOGIN_BACK.radius,
    borderWidth: 1,
    height: LOGIN_BACK.size,
    justifyContent: 'center',
    left: LOGIN_BACK.x,
    overflow: 'hidden',
    position: 'absolute',
    top: LOGIN_BACK.y,
    width: LOGIN_BACK.size,
    zIndex: 2,
  },
  errorText: {
    color: colors.login.loginError,
    fontSize: LOGIN_ERROR_TEXT.font,
    fontWeight: fontWeight.regular,
    left: 0,
    position: 'absolute',
    textAlign: 'center',
    textAlignVertical: 'center',
    top: LOGIN_ERROR_TEXT.y,
    width: LOGIN_ERROR_TEXT.width,
  },
  methodRow: {
    backgroundColor: colors.login.actionControlBg,
    borderColor: colors.login.controlBorder,
    borderRadius: LOGIN_METHOD_ROW.radius,
    borderWidth: 1,
    height: LOGIN_METHOD_ROW.height,
    left: LOGIN_METHOD_ROW.x,
    overflow: 'hidden',
    position: 'absolute',
    width: LOGIN_METHOD_ROW.width,
  },
  methodRowLeftIcon: {
    height: LOGIN_METHOD_ROW.leftIcon.size,
    left: LOGIN_METHOD_ROW.leftIcon.x,
    position: 'absolute',
    top: LOGIN_METHOD_ROW.leftIcon.y,
    width: LOGIN_METHOD_ROW.leftIcon.size,
  },
  methodRowPersonIcon: {
    height: LOGIN_METHOD_ROW.personIcon.height,
    left: LOGIN_METHOD_ROW.personIcon.x,
    position: 'absolute',
    top: LOGIN_METHOD_ROW.personIcon.y,
    width: LOGIN_METHOD_ROW.personIcon.width,
  },
  methodRowTextBox: {
    gap: 5,
    height: '100%',
    justifyContent: 'center',
    left: LOGIN_METHOD_ROW.textX,
    position: 'absolute',
    top: 0,
    width: LOGIN_METHOD_ROW.textWidth,
  },
  methodRowTitle: {
    color: colors.login.controlText,
    fontSize: LOGIN_METHOD_ROW.titleFont,
    fontWeight: fontWeight.bold,
  },
  methodRowSubtitle: {
    color: colors.login.secondaryText,
    fontSize: LOGIN_METHOD_ROW.subtitleFont,
    fontWeight: fontWeight.regular,
  },
  methodRowRightIcon: {
    height: LOGIN_METHOD_ROW.rightIcon.size,
    left: LOGIN_METHOD_ROW.rightIcon.x,
    position: 'absolute',
    top: LOGIN_METHOD_ROW.rightIcon.y,
    width: LOGIN_METHOD_ROW.rightIcon.size,
  },
  loadingRing: {
    height: LOGIN_LOADING_RING.size,
    left: LOGIN_LOADING_RING.x,
    position: 'absolute',
    width: LOGIN_LOADING_RING.size,
  },
  countdownText: {
    color: colors.login.controlPlaceholder,
    fontSize: LOGIN_TEXT_LINK.font,
    fontWeight: fontWeight.regular,
  },
  // 共享次要文本行定位槽(倒计时/重发共用,figma §4.7 @(70,238) 540×50):View +
  // justifyContent center 构造保证两态同位、切换零跳。iOS 上 Text 的 textAlignVertical
  // 不生效(旧写法倒计时顶对齐 → 与重发 Pressable 居中错位 → 跳位);SSO hint 等
  // LoginTextLinkSlot 行待 SSO 位置裁定(设计稿 y=380 vs 重发位 y=238)后迁入此槽。
  textLinkSlotBox: {
    alignItems: 'center',
    height: LOGIN_TEXT_LINK.height,
    justifyContent: 'center',
    left: LOGIN_TEXT_LINK.x,
    position: 'absolute',
    top: LOGIN_TEXT_LINK.y,
    width: LOGIN_TEXT_LINK.width,
  },
  resendLinkText: {
    color: colors.login.linkText,
    fontSize: LOGIN_TEXT_LINK.font,
    fontWeight: fontWeight.regular,
    textDecorationLine: 'underline',
  },
  textLinkSlotText: {
    fontSize: LOGIN_TEXT_LINK.font,
    fontWeight: fontWeight.regular,
    textAlign: 'center',
    width: LOGIN_TEXT_LINK.width,
  },
  textLinkPlaceholder: {
    color: colors.login.controlPlaceholder,
  },
  textLinkSecondary: {
    color: colors.login.secondaryText,
  },
});
