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
 * 实现要点(RNGH ReanimatedSwipeable 的测量机制决定的结构约束):
 *  - 面板 snap 宽度由 render*Actions 返回内容的布局宽度决定(库用 marker 元素测量),
 *    因此外层「壳」必须定宽;会随拖动伸缩的按钮全部 position:'absolute',不参与测量;
 *  - friction / overshootFriction 保持默认 1:面板 1:1 跟手,overshoot 不衰减,
 *    全滑阈值才够得着(overshootFriction>1 时 translation 被压缩,永远到不了阈值);
 *  - 全滑判定在 onSwipeableWillOpen(松手后的 JS 回调)同步读 translation,不在
 *    worklet 拖动中触发 —— 手指还按着时行被移除会拆手势树。
 */
import { memo, useCallback, useEffect, useRef, type ReactNode } from 'react';
import { Pressable, StyleSheet, View, useWindowDimensions } from 'react-native';
import {
  ReanimatedSwipeable as Swipeable,
  SwipeDirection,
  type SwipeableMethods,
} from '@/platform/gestureHandler';
import Animated, {
  interpolate,
  useAnimatedReaction,
  useAnimatedStyle,
  useDerivedValue,
  useSharedValue,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';
import { Archive, Ellipsis, Pin, PinOff } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import { pinToggleAction, type SwipeRowRegistry } from '@/session/swipeRowRegistry';
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

/**
 * 页面级滑动控制 bundle:registry + 三个动作回调打包成一个稳定引用(useMemo),
 * 供 ProjectRow / AutomationGroupChildren 等嵌套渲染路径向下透传——不提供时对应
 * 行退化为不可滑动(设备详情页等未接滑动的调用点保持原行为)。
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

  const methodsRef = useRef<SwipeableMethods | null>(null);
  // render*Actions 的回调参数是库内部的 translation SharedValue,渲染期存进 ref,
  // 供松手回调(handleWillOpen)同步读取当前位移做全滑判定。
  const translationRef = useRef<SharedValue<number> | null>(null);

  // 行卸载(归档/删除后随数据消失、列表虚拟化回收)时注销;registry 内部只清
  // 「当前记录仍是自己」的条目,不会误伤已经接管的新行。
  useEffect(() => () => {
    registry.onRowClose(rowKey);
  }, [registry, rowKey]);

  const close = useCallback(() => {
    methodsRef.current?.close();
  }, []);

  const handleOpenStartDrag = useCallback(() => {
    registry.onRowOpen(rowKey, close);
  }, [registry, rowKey, close]);

  const handleClose = useCallback(() => {
    registry.onRowClose(rowKey);
  }, [registry, rowKey]);

  // 全滑判定:松手瞬间(库在 release 时派发 WillOpen)读当前位移,超阈值即触发。
  // direction 语义:RIGHT = 右滑(露出左面板/置顶),LEFT = 左滑(露出右面板/归档)。
  const handleWillOpen = useCallback((direction: (typeof SwipeDirection)[keyof typeof SwipeDirection]) => {
    const translation = translationRef.current;
    if (!translation) return;
    if (direction === SwipeDirection.RIGHT) {
      if (translation.value >= fullSwipeThreshold) {
        // 置顶后行只重排不消失:先关再发,避免重排后行停在打开态。
        close();
        onTogglePin(session);
      }
      return;
    }
    if (-translation.value >= fullSwipeThreshold) {
      // 归档刻意不先关:乐观更新立即把行移出列表(卸载即收行);失败由页面层回滚 + Alert 收口。
      onArchive(session);
    }
  }, [fullSwipeThreshold, close, onTogglePin, onArchive, session]);

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
    (_progress: SharedValue<number>, translation: SharedValue<number>) => {
      translationRef.current = translation;
      return (
        <PinActionPanel
          label={pinLabel}
          onPress={handlePinPress}
          pinned={pinned}
          styles={styles}
          testID={testID ? `${testID}.pinAction` : undefined}
          translation={translation}
        />
      );
    },
    [pinLabel, pinned, handlePinPress, styles, testID],
  );

  const renderRightActions = useCallback(
    (_progress: SharedValue<number>, translation: SharedValue<number>) => {
      translationRef.current = translation;
      return (
        <RightActionsPanel
          fullSwipeThreshold={fullSwipeThreshold}
          onArchive={handleArchivePress}
          onOptions={handleOptionsPress}
          styles={styles}
          testID={testID}
          translation={translation}
        />
      );
    },
    [fullSwipeThreshold, handleArchivePress, handleOptionsPress, styles, testID],
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
 * 右滑露出的「置顶」浮块:定宽壳决定 snap 位;按钮绝对定位、随露出进度淡入 + 微缩放
 * 弹入;overshoot / 全滑时按钮保持圆角横向拉伸(宽度 = 位移 - 两侧 gap),图标钉在
 * 行边缘一侧跟手(iOS Mail 同款)。
 */
function PinActionPanel({
  label,
  onPress,
  pinned,
  styles,
  testID,
  translation,
}: {
  label: string;
  onPress(): void;
  pinned: boolean;
  styles: SwipeStyles;
  testID?: string;
  translation: SharedValue<number>;
}) {
  const { colors } = useTheme();
  const buttonStyle = useAnimatedStyle(() => {
    const revealed = Math.max(0, translation.value);
    const progress = Math.min(1, revealed / LEFT_PANEL_WIDTH);
    return {
      opacity: interpolate(progress, [0.15, 0.7], [0, 1], 'clamp'),
      transform: [{ scale: interpolate(progress, [0.15, 1], [0.5, 1], 'clamp') }],
      // 静置是正圆;继续拖动从圆拉长成胶囊(radius.pill 让圆角恒为半高)。
      width: Math.max(BUTTON_SIZE, revealed - BUTTON_GAP * 2),
    };
  });
  const IconComponent = pinned ? PinOff : Pin;
  return (
    <View style={styles.pinShell}>
      <Animated.View style={[styles.pinButton, buttonStyle]}>
        <Pressable
          accessibilityLabel={label}
          accessibilityRole="button"
          onPress={onPress}
          style={styles.actionPressable}
          testID={testID}
        >
          <View style={styles.pinIconWrap}>
            <IconComponent color={colors.swipeActionText} size={ICON_SIZE} strokeWidth={iconStroke.regular} />
          </View>
        </Pressable>
      </Animated.View>
    </View>
  );
}

/**
 * 左滑露出的「选项 + 归档」浮块:定宽壳(152)决定 snap 位;两块绝对定位锚右缘,
 * 随露出进度错峰淡入(靠屏缘的「归档」先现身);overshoot 时「选项」跟着行边缘
 * 外扩保持贴行间距;越过全滑阈值「归档」150ms 拉伸盖满(预告松手即归档)、「选项」淡出。
 */
function RightActionsPanel({
  fullSwipeThreshold,
  onArchive,
  onOptions,
  styles,
  testID,
  translation,
}: {
  fullSwipeThreshold: number;
  onArchive(): void;
  onOptions(): void;
  styles: SwipeStyles;
  testID?: string;
  translation: SharedValue<number>;
}) {
  const { colors } = useTheme();
  const { t } = useTranslation();
  // armed = 位移越过全滑阈值。独立 SharedValue 只在跨越阈值时写入,避免
  // useDerivedValue 里对逐帧变化的 translation 直接 withTiming(目标每帧重设,动画走不完)。
  const armed = useSharedValue(false);
  useAnimatedReaction(
    () => -translation.value >= fullSwipeThreshold,
    (next) => {
      if (next !== armed.value) armed.value = next;
    },
  );
  const armedProgress = useDerivedValue(
    () => withTiming(armed.value ? 1 : 0, { duration: ARM_ANIMATION_MS }),
  );

  const optionsStyle = useAnimatedStyle(() => {
    const revealed = Math.max(0, -translation.value);
    const progress = Math.min(1, revealed / RIGHT_PANEL_WIDTH);
    return {
      // 错峰弹入(靠内的「选项」后现身);armed 时淡出让位给拉伸的「归档」。
      opacity: interpolate(progress, [0.3, 0.8], [0, 1], 'clamp') * (1 - armedProgress.value),
      // overshoot(revealed > 面板宽)时跟着行边缘外扩,保持「贴着行」的间距不脱节。
      right: Math.max(BUTTON_GAP * 2 + BUTTON_SIZE, revealed - BUTTON_SIZE - BUTTON_GAP),
      transform: [{ scale: interpolate(progress, [0.3, 1], [0.5, 1], 'clamp') }],
    };
  });
  const archiveStyle = useAnimatedStyle(() => {
    const revealed = Math.max(0, -translation.value);
    const progress = Math.min(1, revealed / RIGHT_PANEL_WIDTH);
    return {
      opacity: interpolate(progress, [0.08, 0.45], [0, 1], 'clamp'),
      transform: [{ scale: interpolate(progress, [0.08, 0.6], [0.5, 1], 'clamp') }],
      // armed 时从正圆拉长成胶囊铺满整个露出区(保留两侧 gap),盖过「选项」。
      width: BUTTON_SIZE
        + Math.max(0, revealed - BUTTON_GAP * 2 - BUTTON_SIZE) * armedProgress.value,
    };
  });

  return (
    <View style={styles.rightShell}>
      <Animated.View style={[styles.optionsButton, optionsStyle]}>
        <Pressable
          accessibilityLabel={t('session.row.moreOptions')}
          accessibilityRole="button"
          onPress={onOptions}
          style={styles.actionPressable}
          testID={testID ? `${testID}.optionsAction` : undefined}
        >
          <View style={styles.rightIconWrap}>
            <Ellipsis color={colors.swipeActionText} size={ICON_SIZE} strokeWidth={iconStroke.regular} />
          </View>
        </Pressable>
      </Animated.View>
      <Animated.View style={[styles.archiveButton, archiveStyle]}>
        <Pressable
          accessibilityLabel={t('session.row.archiveConversation')}
          accessibilityRole="button"
          onPress={onArchive}
          style={styles.actionPressable}
          testID={testID ? `${testID}.archiveAction` : undefined}
        >
          <View style={styles.rightIconWrap}>
            <Archive color={colors.swipeActionText} size={ICON_SIZE} strokeWidth={iconStroke.regular} />
          </View>
        </Pressable>
      </Animated.View>
    </View>
  );
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
    backgroundColor: colors.swipeActionPin,
    // radius.pill:正圆起步,拉长后自动变胶囊(圆角恒为半高),iOS 26 同款。
    borderRadius: radius.pill,
    height: BUTTON_SIZE,
    left: BUTTON_GAP,
    // 行高内垂直居中(面板 wrapper 与行等高):50% 锚点 + 负半径回拉,不写死行高。
    marginTop: -BUTTON_SIZE / 2,
    overflow: 'hidden',
    position: 'absolute',
    top: '50%',
  },
  pinIconWrap: {
    // 图标钉在按钮尾缘(紧贴行内容边缘),按钮拉长成胶囊时图标跟着行走(iOS Mail 同款)。
    alignItems: 'center',
    bottom: 0,
    justifyContent: 'center',
    position: 'absolute',
    right: 0,
    top: 0,
    width: BUTTON_SIZE,
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
    top: '50%',
    width: BUTTON_SIZE,
  },
  archiveButton: {
    backgroundColor: colors.swipeActionArchive,
    borderRadius: radius.pill,
    height: BUTTON_SIZE,
    marginTop: -BUTTON_SIZE / 2,
    overflow: 'hidden',
    position: 'absolute',
    right: BUTTON_GAP,
    top: '50%',
  },
  rightIconWrap: {
    // 图标钉在按钮首缘(紧贴行内容一侧):归档拉伸盖满时图标不跳中心,停在行边附近。
    alignItems: 'center',
    bottom: 0,
    justifyContent: 'center',
    left: 0,
    position: 'absolute',
    top: 0,
    width: BUTTON_SIZE,
  },
  actionPressable: {
    flex: 1,
  },
});

export const SwipeableSessionRow = memo(SwipeableSessionRowInner);
