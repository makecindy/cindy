/**
 * SwipeableSessionRow —— 首页会话行的 iOS 式滑动操作包装。
 *
 * 交互契约(2026-07-07 与产品确认):
 *  - 右滑露出「置顶/取消置顶」(按 pinnedAt 切换),全滑(超过屏宽 55%)松手直接触发;
 *  - 左滑露出「选项」+「归档」,全滑=归档(归档按钮越过阈值时扩展盖满,预告松手即触发);
 *  - 删除不做滑动直达,只在「选项」菜单里(带系统 Alert 确认),由页面层承接;
 *  - 同一时间只允许一行滑开:互斥由页面级 SwipeRowRegistry 驱动(开新关旧、滚动关行)。
 *
 * 视觉对齐新 iOS(26)的滑动操作形态(2026-07-07 产品反馈迭代两轮):
 * 按钮是**悬浮的圆形图标钮**(radius.pill,从圆起步),随露出进度淡入 + 缩放弹入;
 * 继续拖动时主按钮从圆**拉长成胶囊**(宽度跟手、圆角恒为半高),图标钉在行边缘一侧跟手,
 * 全滑阈值后主按钮拉伸盖满整个露出区。非全高色块、非方角浮块。
 *
 * 实现要点(RNGH 经典 Swipeable 的测量机制决定的结构约束):
 *  - 面板 snap 宽度由 render*Actions 返回内容的布局宽度决定(库用 marker 元素测量),
 *    因此外层「壳」必须定宽;会随拖动伸缩的按钮全部 position:'absolute',不参与测量;
 *  - friction / overshootFriction 保持默认 1:面板 1:1 跟手,overshoot 不衰减,
 *    全滑阈值才够得着(overshootFriction>1 时 translation 被压缩,永远到不了阈值);
 *  - 全滑判定在 onSwipeableWillOpen 同步读取松手位移;不在手指按住时移除行,
 *    避免拆手势树。读取失败时才回退到 Animated listener 的最近值。
 */
import { memo, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Animated, Pressable, StyleSheet, View, useWindowDimensions } from 'react-native';
import {
  ClassicSwipeable as Swipeable,
  type ClassicSwipeableMethods,
} from '@/platform/gestureHandler';
import { Archive, ArchiveRestore, Ellipsis, Pin, PinOff } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import { pinToggleAction, statusToggleAction, type SwipeRowRegistry } from '@/session/swipeRowRegistry';
import type { RemoteSession } from '@/session/types';
import { iconSize, iconStroke, useTheme, useThemedStyles, type ThemeColors } from '@/theme';
import { radius, spacing } from '@/theme/tokens';

/** 圆形按钮直径(静置态是正圆,拖长后变胶囊;78 高的行内上下各留 11)。 */
const BUTTON_SIZE = 56;
/** 按钮与行边缘 / 屏幕边缘 / 相邻按钮的间距(iOS 26 的悬浮圆钮留白比色块时代更宽)。 */
const BUTTON_GAP = spacing.md;
/** 左面板(置顶):gap + 圆 + gap;右面板(选项 + 归档):gap + 圆 + gap + 圆 + gap。 */
const LEFT_PANEL_WIDTH = BUTTON_GAP * 2 + BUTTON_SIZE;
const RIGHT_PANEL_WIDTH = BUTTON_GAP * 3 + BUTTON_SIZE * 2;
/** 全滑触发阈值:位移超过屏宽的这个比例,松手即执行(iOS Mail 惯例的 50-60% 区间)。 */
const FULL_SWIPE_RATIO = 0.55;
/** 「归档」按钮越过全滑阈值时扩展盖满右侧面板的过渡时长。 */
const ARM_ANIMATION_MS = 150;
const ICON_SIZE = iconSize.swipeAction;
type SwipeTranslation = Animated.AnimatedInterpolation<number>;
type ReadableSwipeTranslation = SwipeTranslation & { __getValue?(): unknown };
type ClassicSwipeDirection = 'left' | 'right';

/**
 * 页面级滑动控制 bundle:registry + 三个动作回调打包成一个稳定引用(useMemo),
 * 供 ProjectRow / AutomationGroupChildren 等嵌套渲染路径向下透传——不提供时对应
 * 行退化为不可滑动(选择态或不需要手势的调用点保持原行为)。
 */
export interface SessionSwipeControls {
  registry: SwipeRowRegistry;
  onTogglePin(session: RemoteSession): void;
  onArchive(session: RemoteSession): void;
  onShowOptions(session: RemoteSession): void;
}

export interface SwipeableSessionRowProps {
  /** 目标会话:id 作互斥 key,pinnedAt 决定右滑按钮图标(Pin/PinOff)与动作方向。 */
  session: RemoteSession;
  registry: SwipeRowRegistry;
  /**
   * 回调统一带 session 入参:页面层可以传稳定引用(useCallback / setState),
   * renderItem 里不必为每行现造闭包(否则 memo 的浅比较永远失败,review P2)。
   */
  /** 右滑按钮 / 右滑全滑:置顶或取消置顶(实现方负责先关行再发 RPC 的时序)。 */
  onTogglePin(session: RemoteSession): void;
  /** 左滑「归档」按钮 / 左滑全滑(不关行:乐观更新立即把行移出列表,失败由页面层回滚收口)。 */
  onArchive(session: RemoteSession): void;
  /** 左滑「选项」按钮:先关行,再由页面层弹出操作菜单。 */
  onShowOptions(session: RemoteSession): void;
  testID?: string;
  children: ReactNode;
}

function SwipeableSessionRowInner({
  session,
  registry,
  onTogglePin,
  onArchive,
  onShowOptions,
  testID,
  children,
}: SwipeableSessionRowProps) {
  const rowKey = session.id;
  const pinnedAt = session.pinnedAt;
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  const { width: windowWidth } = useWindowDimensions();
  const fullSwipeThreshold = windowWidth * FULL_SWIPE_RATIO;

  const methodsRef = useRef<ClassicSwipeableMethods | null>(null);
  // 经典 Swipeable 在调用 WillOpen 前会把松手位移写入 transX 的 JS Animated 图。
  // 保留该节点可同步读取真正的松手位置;listener 最近值只作 RN 内部读值不可用时的兜底。
  const translationRef = useRef<ReadableSwipeTranslation | null>(null);
  const latestTranslationRef = useRef(0);
  const armedRef = useRef(false);
  const armedProgress = useRef(new Animated.Value(0)).current;
  const previousRowKeyRef = useRef(rowKey);
  const [mountedActionRowKey, setMountedActionRowKey] = useState<string | null>(null);
  const actionsMounted = mountedActionRowKey === rowKey;

  const stopActionAnimation = useCallback(() => {
    armedRef.current = false;
    armedProgress.stopAnimation();
    armedProgress.setValue(0);
  }, [armedProgress]);

  // Project child windowing reuses a small pool of native swipe rows. When a
  // slot starts representing another session, clear the previous gesture
  // position immediately so an open/partially-open row cannot follow the slot
  // onto the new session. The registry cleanup below separately retires the
  // previous session id.
  useEffect(() => {
    if (previousRowKeyRef.current === rowKey) return;
    methodsRef.current?.reset();
    translationRef.current = null;
    latestTranslationRef.current = 0;
    stopActionAnimation();
    setMountedActionRowKey(null);
    previousRowKeyRef.current = rowKey;
  }, [rowKey, stopActionAnimation]);

  // 行卸载(归档/删除后随数据消失、列表虚拟化回收)时注销;registry 内部只清
  // 「当前记录仍是自己」的条目,不会误伤已经接管的新行。
  useEffect(() => () => {
    armedProgress.stopAnimation();
    registry.onRowClose(rowKey);
  }, [armedProgress, registry, rowKey]);

  const close = useCallback(() => {
    methodsRef.current?.close();
  }, []);

  const handleOpenStartDrag = useCallback(() => {
    stopActionAnimation();
    // The fixed shells are measured on the initial row mount. Only the one active
    // row pays for both action trees, which also keeps direction reversal during
    // the same gesture from revealing an empty panel.
    setMountedActionRowKey(rowKey);
    registry.onRowOpen(rowKey, close);
  }, [registry, rowKey, close, stopActionAnimation]);

  const handleClose = useCallback(() => {
    latestTranslationRef.current = 0;
    stopActionAnimation();
    setMountedActionRowKey(null);
    registry.onRowClose(rowKey);
  }, [registry, rowKey, stopActionAnimation]);

  const handleTranslationValue = useCallback((value: number) => {
    latestTranslationRef.current = value;
    const nextArmed = -value >= fullSwipeThreshold;
    if (nextArmed === armedRef.current) return;
    armedRef.current = nextArmed;
    Animated.timing(armedProgress, {
      duration: ARM_ANIMATION_MS,
      toValue: nextArmed ? 1 : 0,
      useNativeDriver: true,
    }).start();
  }, [armedProgress, fullSwipeThreshold]);

  const readReleaseTranslation = useCallback((): number => {
    try {
      const value = translationRef.current?.__getValue?.();
      if (typeof value === 'number' && Number.isFinite(value)) return value;
    } catch {
      // Native Animated implementations may decline synchronous reads. The listener value
      // remains a conservative fallback: missing a borderline full swipe is safer than
      // archiving after the user crossed the threshold and then deliberately dragged back.
    }
    return latestTranslationRef.current;
  }, []);

  // 经典 Swipeable 的 direction 表示露出的 action 面板:left = 右滑露出左面板,
  // right = 左滑露出右面板。
  const handleWillOpen = useCallback((direction: ClassicSwipeDirection) => {
    const releaseTranslation = readReleaseTranslation();
    if (direction === 'left') {
      if (releaseTranslation < fullSwipeThreshold) return;
      // 置顶后行只重排不消失:先关再发,避免重排后行停在打开态。
      close();
      onTogglePin(session);
      return;
    }
    if (-releaseTranslation < fullSwipeThreshold) return;
    // 归档刻意不先关:乐观更新立即把行移出列表(卸载即收行);失败由页面层回滚 + Alert 收口。
    onArchive(session);
  }, [fullSwipeThreshold, close, onTogglePin, onArchive, readReleaseTranslation, session]);

  const handlePinPress = useCallback(() => {
    close();
    onTogglePin(session);
  }, [close, onTogglePin, session]);

  const handleOptionsPress = useCallback(() => {
    close();
    onShowOptions(session);
  }, [close, onShowOptions, session]);

  const handleArchivePress = useCallback(() => {
    onArchive(session);
  }, [onArchive, session]);

  const pinned = !!pinnedAt;
  const pinLabel = pinToggleAction(pinnedAt).label;

  const renderLeftActions = useCallback(
    (_progress: SwipeTranslation, translation: SwipeTranslation) => {
      translationRef.current = translation as ReadableSwipeTranslation;
      return (
        <View style={styles.pinShell}>
          {actionsMounted ? (
            <PinActionContent
              label={pinLabel}
              onTranslationValue={handleTranslationValue}
              onPress={handlePinPress}
              pinned={pinned}
              styles={styles}
              testID={testID ? `${testID}.pinAction` : undefined}
              translation={translation}
              windowWidth={windowWidth}
            />
          ) : null}
        </View>
      );
    },
    [
      handlePinPress,
      handleTranslationValue,
      actionsMounted,
      pinLabel,
      pinned,
      styles,
      testID,
      windowWidth,
    ],
  );

  const statusToggle = statusToggleAction(session.status);

  const renderRightActions = useCallback(
    (_progress: SwipeTranslation, translation: SwipeTranslation) => {
      translationRef.current = translation as ReadableSwipeTranslation;
      return (
        <View style={styles.rightShell}>
          {actionsMounted ? (
            <RightActionsContent
              armedProgress={armedProgress}
              archiveLabel={statusToggle.label}
              archived={statusToggle.action === 'restore'}
              onArchive={handleArchivePress}
              onOptions={handleOptionsPress}
              onTranslationValue={handleTranslationValue}
              styles={styles}
              testID={testID}
              translation={translation}
              windowWidth={windowWidth}
            />
          ) : null}
        </View>
      );
    },
    [
      armedProgress,
      handleArchivePress,
      handleOptionsPress,
      handleTranslationValue,
      actionsMounted,
      statusToggle,
      styles,
      testID,
      windowWidth,
    ],
  );

  return (
    <Swipeable
      ref={methodsRef}
      childrenContainerStyle={{ backgroundColor: colors.surface }}
      containerStyle={{ backgroundColor: colors.surface }}
      onSwipeableClose={handleClose}
      onSwipeableOpenStartDrag={handleOpenStartDrag}
      onSwipeableWillOpen={handleWillOpen}
      renderLeftActions={renderLeftActions}
      renderRightActions={renderRightActions}
      testID={testID}
    >
      {children}
    </Swipeable>
  );
}

/**
 * 右滑露出的「置顶」浮块:定宽壳决定 snap 位;按钮绝对定位;overshoot / 全滑时
 * 背景用 native-driver transform 拉成长胶囊,图标跟着行边缘移动。经典 Animated
 * 不经过 Reanimated synchronouslyUpdateUIProps,列表批量卸载时不会追写失效 Fabric tag。
 */
function PinActionContent({
  label,
  onTranslationValue,
  onPress,
  pinned,
  styles,
  testID,
  translation,
  windowWidth,
}: {
  label: string;
  onTranslationValue(value: number): void;
  onPress(): void;
  pinned: boolean;
  styles: SwipeStyles;
  testID?: string;
  translation: SwipeTranslation;
  windowWidth: number;
}) {
  const { colors } = useTheme();
  const opacity = translation.interpolate({
    extrapolate: 'clamp',
    inputRange: [LEFT_PANEL_WIDTH * 0.15, LEFT_PANEL_WIDTH * 0.7],
    outputRange: [0, 1],
  });
  const scale = translation.interpolate({
    extrapolate: 'clamp',
    inputRange: [LEFT_PANEL_WIDTH * 0.15, LEFT_PANEL_WIDTH],
    outputRange: [0.5, 1],
  });
  const extension = translation.interpolate({
    extrapolate: 'clamp',
    inputRange: [LEFT_PANEL_WIDTH, Math.max(LEFT_PANEL_WIDTH + 1, windowWidth)],
    outputRange: [0, Math.max(0, windowWidth - LEFT_PANEL_WIDTH)],
  });
  const backgroundScaleX = Animated.add(1, Animated.divide(extension, BUTTON_SIZE));
  const halfExtension = Animated.divide(extension, 2);
  const IconComponent = pinned ? PinOff : Pin;
  return (
    <>
      <TranslationObserver onValue={onTranslationValue} translation={translation} />
      <Animated.View style={[styles.pinButton, { opacity, transform: [{ scale }] }]}>
        <Animated.View
          pointerEvents="none"
          style={[
            styles.pinButtonBackground,
            { transform: [{ translateX: halfExtension }, { scaleX: backgroundScaleX }] },
          ]}
        />
        <Animated.View style={[styles.actionPressableFrame, { transform: [{ translateX: extension }] }]}>
          <Pressable
            accessibilityLabel={label}
            accessibilityRole="button"
            onPress={onPress}
            style={styles.actionPressable}
            testID={testID}
          >
            <View style={styles.actionIconWrap}>
            <IconComponent color={colors.swipeActionText} size={ICON_SIZE} strokeWidth={iconStroke.regular} />
            </View>
          </Pressable>
        </Animated.View>
      </Animated.View>
    </>
  );
}

/**
 * 左滑露出的「选项 + 归档」浮块:定宽壳决定 snap 位;两块绝对定位锚右缘。
 * overshoot 时「选项」跟着行边缘外扩;越过全滑阈值后「归档」用 transform
 * 拉伸盖满露出区。所有跟手属性均可由 RN Animated native driver 执行。
 */
function RightActionsContent({
  armedProgress,
  archiveLabel,
  archived,
  onArchive,
  onOptions,
  onTranslationValue,
  styles,
  testID,
  translation,
  windowWidth,
}: {
  armedProgress: Animated.Value;
  archiveLabel: string;
  archived: boolean;
  onArchive(): void;
  onOptions(): void;
  onTranslationValue(value: number): void;
  styles: SwipeStyles;
  testID?: string;
  translation: SwipeTranslation;
  windowWidth: number;
}) {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const StatusIcon = archived ? ArchiveRestore : Archive;
  const revealed = Animated.multiply(translation, -1);
  const optionsOpacity = Animated.multiply(
    revealed.interpolate({
      extrapolate: 'clamp',
      inputRange: [RIGHT_PANEL_WIDTH * 0.3, RIGHT_PANEL_WIDTH * 0.8],
      outputRange: [0, 1],
    }),
    Animated.subtract(1, armedProgress),
  );
  const optionsScale = revealed.interpolate({
    extrapolate: 'clamp',
    inputRange: [RIGHT_PANEL_WIDTH * 0.3, RIGHT_PANEL_WIDTH],
    outputRange: [0.5, 1],
  });
  const optionsExtension = revealed.interpolate({
    extrapolate: 'clamp',
    inputRange: [RIGHT_PANEL_WIDTH, Math.max(RIGHT_PANEL_WIDTH + 1, windowWidth)],
    outputRange: [0, Math.max(0, windowWidth - RIGHT_PANEL_WIDTH)],
  });
  const archiveOpacity = revealed.interpolate({
    extrapolate: 'clamp',
    inputRange: [RIGHT_PANEL_WIDTH * 0.08, RIGHT_PANEL_WIDTH * 0.45],
    outputRange: [0, 1],
  });
  const archiveScale = revealed.interpolate({
    extrapolate: 'clamp',
    inputRange: [RIGHT_PANEL_WIDTH * 0.08, RIGHT_PANEL_WIDTH * 0.6],
    outputRange: [0.5, 1],
  });
  const archiveStretchStart = BUTTON_GAP * 2 + BUTTON_SIZE;
  const availableArchiveExtension = revealed.interpolate({
    extrapolate: 'clamp',
    inputRange: [archiveStretchStart, Math.max(archiveStretchStart + 1, windowWidth)],
    outputRange: [0, Math.max(0, windowWidth - archiveStretchStart)],
  });
  const archiveExtension = Animated.multiply(availableArchiveExtension, armedProgress);
  const archiveScaleX = Animated.add(1, Animated.divide(archiveExtension, BUTTON_SIZE));
  const negativeOptionsExtension = Animated.multiply(optionsExtension, -1);
  const negativeArchiveExtension = Animated.multiply(archiveExtension, -1);
  const negativeHalfArchiveExtension = Animated.divide(negativeArchiveExtension, 2);

  return (
    <>
      <TranslationObserver onValue={onTranslationValue} translation={translation} />
      <Animated.View
        style={[
          styles.optionsButton,
          { opacity: optionsOpacity, transform: [{ translateX: negativeOptionsExtension }, { scale: optionsScale }] },
        ]}
      >
        <Pressable
          accessibilityLabel={t('session.row.moreOptions')}
          accessibilityRole="button"
          onPress={onOptions}
          style={styles.actionPressable}
          testID={testID ? `${testID}.optionsAction` : undefined}
        >
          <View style={styles.actionIconWrap}>
            <Ellipsis color={colors.swipeActionText} size={ICON_SIZE} strokeWidth={iconStroke.regular} />
          </View>
        </Pressable>
      </Animated.View>
      <Animated.View style={[styles.archiveButton, { opacity: archiveOpacity, transform: [{ scale: archiveScale }] }]}>
        <Animated.View
          pointerEvents="none"
          style={[
            styles.archiveButtonBackground,
            { transform: [{ translateX: negativeHalfArchiveExtension }, { scaleX: archiveScaleX }] },
          ]}
        />
        <Animated.View style={[styles.actionPressableFrame, { transform: [{ translateX: negativeArchiveExtension }] }]}>
          <Pressable
            accessibilityLabel={archiveLabel}
            accessibilityRole="button"
            onPress={onArchive}
            style={styles.actionPressable}
            testID={testID ? `${testID}.archiveAction` : undefined}
          >
            <View style={styles.actionIconWrap}>
              <StatusIcon color={colors.swipeActionText} size={ICON_SIZE} strokeWidth={iconStroke.regular} />
            </View>
          </Pressable>
        </Animated.View>
      </Animated.View>
    </>
  );
}

function TranslationObserver({
  onValue,
  translation,
}: {
  onValue(value: number): void;
  translation: SwipeTranslation;
}) {
  useEffect(() => {
    const listenerId = translation.addListener(({ value }) => onValue(value));
    return () => translation.removeListener(listenerId);
  }, [onValue, translation]);
  return null;
}

type SwipeStyles = ReturnType<typeof makeStyles>;

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  pinShell: {
    // 定宽壳:库按内容布局宽度测 snap 位,壳宽即打开吸附宽度;伸缩按钮不参与测量。
    // overshoot 时按钮要伸出壳外(裁剪交给库的整行 wrapper),Android 需显式 visible。
    overflow: 'visible',
    width: LEFT_PANEL_WIDTH,
  },
  pinButton: {
    height: BUTTON_SIZE,
    left: BUTTON_GAP,
    // 行高内垂直居中(面板 wrapper 与行等高):50% 锚点 + 负半径回拉,不写死行高。
    marginTop: -BUTTON_SIZE / 2,
    overflow: 'visible',
    position: 'absolute',
    top: '50%',
    width: BUTTON_SIZE,
  },
  pinButtonBackground: {
    backgroundColor: colors.swipeActionPin,
    borderRadius: radius.pill,
    bottom: 0,
    left: 0,
    position: 'absolute',
    right: 0,
    top: 0,
  },
  rightShell: {
    overflow: 'visible',
    width: RIGHT_PANEL_WIDTH,
  },
  optionsButton: {
    backgroundColor: colors.swipeActionNeutral,
    borderRadius: radius.pill,
    height: BUTTON_SIZE,
    marginTop: -BUTTON_SIZE / 2,
    overflow: 'hidden',
    position: 'absolute',
    right: BUTTON_GAP * 2 + BUTTON_SIZE,
    top: '50%',
    width: BUTTON_SIZE,
  },
  archiveButton: {
    height: BUTTON_SIZE,
    marginTop: -BUTTON_SIZE / 2,
    overflow: 'visible',
    position: 'absolute',
    right: BUTTON_GAP,
    top: '50%',
    width: BUTTON_SIZE,
  },
  archiveButtonBackground: {
    backgroundColor: colors.swipeActionArchive,
    borderRadius: radius.pill,
    bottom: 0,
    left: 0,
    position: 'absolute',
    right: 0,
    top: 0,
  },
  actionPressableFrame: {
    bottom: 0,
    left: 0,
    position: 'absolute',
    right: 0,
    top: 0,
  },
  actionIconWrap: {
    alignItems: 'center',
    flex: 1,
    justifyContent: 'center',
  },
  actionPressable: {
    flex: 1,
  },
});

export const SwipeableSessionRow = memo(SwipeableSessionRowInner);
