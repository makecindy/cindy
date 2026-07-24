/**
 * SessionActionSheet —— 首页会话行左滑「选项」触发的底部操作菜单
 * (重命名 / 置顶切换 / 归档 / 删除 + 独立「取消」,iOS ActionSheet 形态)。
 *
 * 刻意不用 SheetSurface:它是内容型 snap 面板(half/full 档位 + 把手拖拽),
 * 五行固定菜单套进去要伪造档位状态。这里沿用 DeviceMenuModal 的轻量模式:
 * 单 Modal + 自绘动画(overlay 淡入、卡片 translateY 滑入),关闭动画播完才真正
 * 卸载,并经 onClosed 通知父级 —— 兄弟 Modal(重命名弹窗)必须等本 Modal 卸载后
 * 再挂,否则 iOS present-during-dismiss 会把新弹窗吞掉。
 * 视觉(圆角卡片分组 / 行高 / 危险色)对齐会话详情页 SessionMenuSheet 的 actionGroup。
 */
import { useEffect, useRef, useState } from 'react';
import {
  Animated,
  Easing,
  Modal,
  Pressable,
  StyleSheet,
  View,
} from 'react-native';
import {
  Archive,
  Pencil,
  Pin,
  PinOff,
  Trash2,
  type LucideIcon,
} from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { Text } from '@/components/AppText';
import { BlurBackdrop } from '@/session/BlurBackdrop';
import {
  buildSessionActionMenu,
  type SessionSwipeAction,
} from '@/session/swipeRowRegistry';
import { iconSize, iconStroke, useTheme, useThemedStyles, type ThemeColors } from '@/theme';
import { fontWeight, lineHeight, radius, spacing, typeScale } from '@/theme/tokens';

/** 卡片滑入距离(略大于卡片实高即可,滑入曲线吃掉误差)。 */
const CARD_SLIDE_DISTANCE = 360;

const ACTION_ICONS: Record<SessionSwipeAction, LucideIcon> = {
  archive: Archive,
  delete: Trash2,
  pin: Pin,
  rename: Pencil,
  unpin: PinOff,
};

export function SessionActionSheet({
  onAction,
  onClose,
  onClosed,
  pinnedAt,
  visible,
}: {
  /** 点菜单项:父级负责关 sheet 并串后续(删除 Alert / 重命名弹窗 / 直接执行)。 */
  onAction(action: SessionSwipeAction): void;
  onClose(): void;
  /** 关闭动画完成、Modal 真正卸载后触发(兄弟 Modal 时序,同 DeviceMenuModal.onClosed)。 */
  onClosed?(): void;
  pinnedAt: string | null | undefined;
  visible: boolean;
}) {
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const [mounted, setMounted] = useState(visible);
  const progress = useRef(new Animated.Value(visible ? 1 : 0)).current;

  useEffect(() => {
    if (visible) {
      setMounted(true);
      Animated.timing(progress, {
        duration: 220,
        easing: Easing.out(Easing.cubic),
        toValue: 1,
        useNativeDriver: true,
      }).start();
    } else {
      Animated.timing(progress, {
        duration: 160,
        easing: Easing.in(Easing.quad),
        toValue: 0,
        useNativeDriver: true,
      }).start(({ finished }) => {
        if (finished) setMounted(false);
      });
    }
  }, [visible, progress]);

  // onClosed 等 Modal 真正从树上卸载后再触发(同 DeviceMenuModal:动画回调里同步挂
  // 第二个 Modal 会和本 Modal 的卸载挤进同一个 commit,iOS 可能吞掉新弹窗)。
  const onClosedRef = useRef(onClosed);
  onClosedRef.current = onClosed;
  const wasMountedRef = useRef(mounted);
  useEffect(() => {
    const wasMounted = wasMountedRef.current;
    wasMountedRef.current = mounted;
    if (wasMounted && !mounted) onClosedRef.current?.();
  }, [mounted]);

  const translateY = progress.interpolate({
    inputRange: [0, 1],
    outputRange: [CARD_SLIDE_DISTANCE, 0],
  });
  const menu = buildSessionActionMenu(pinnedAt);

  return (
    <Modal animationType="none" onRequestClose={onClose} transparent visible={mounted}>
      <View style={styles.overlay}>
        <Animated.View style={[StyleSheet.absoluteFill, { opacity: progress }]}>
          <BlurBackdrop />
          <Pressable
            accessibilityLabel={t('session.row.closeActionMenu')}
            onPress={onClose}
            style={styles.backdrop}
            testID="home.sessionActions.backdrop"
          />
        </Animated.View>
        <Animated.View
          style={[
            styles.cardArea,
            { paddingBottom: Math.max(insets.bottom, spacing.md), transform: [{ translateY }] },
          ]}
          testID="home.sessionActions"
        >
          <View style={styles.actionCard}>
            <BlurBackdrop intensity={32} overlayColor={colors.sheetActionSurface} />
            {menu.map((item) => {
              const IconComponent = ACTION_ICONS[item.action];
              const color = item.destructive ? colors.destructive : colors.sheetActionText;
              return (
                <Pressable
                  accessibilityLabel={item.label}
                  accessibilityRole="button"
                  key={item.action}
                  onPress={() => onAction(item.action)}
                  style={({ pressed }) => [styles.actionRow, pressed && styles.pressed]}
                  testID={`home.sessionActions.${item.action}`}
                >
                  <IconComponent color={color} size={iconSize.lg} strokeWidth={iconStroke.regular} />
                  <Text numberOfLines={1} style={[styles.actionLabel, item.destructive && styles.actionLabelDanger]}>
                    {item.label}
                  </Text>
                </Pressable>
              );
            })}
          </View>
          <Pressable
            accessibilityLabel={t('session.common.cancel')}
            accessibilityRole="button"
            onPress={onClose}
            style={({ pressed }) => [styles.cancelCard, pressed && styles.pressed]}
            testID="home.sessionActions.cancel"
          >
            <BlurBackdrop intensity={32} overlayColor={colors.sheetActionSurface} />
            <Text style={styles.cancelText}>{t('session.common.cancel')}</Text>
          </Pressable>
        </Animated.View>
      </View>
    </Modal>
  );
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  overlay: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  backdrop: {
    // 背板玻璃色由 BlurBackdrop 承担(absoluteFill 在本 Pressable 之下);Pressable 透明,
    // 仅占触摸区接收点按关闭。
    flex: 1,
  },
  cardArea: {
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
  },
  actionCard: {
    backgroundColor: 'transparent',
    borderColor: colors.sheetActionBorder,
    borderRadius: radius.container,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
  },
  actionRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.md,
    minHeight: 54,
    paddingHorizontal: spacing.lg,
  },
  actionLabel: {
    color: colors.sheetActionText,
    flexShrink: 1,
    fontSize: typeScale.listBody,
    fontWeight: fontWeight.semibold,
    lineHeight: lineHeight.listBody,
  },
  actionLabelDanger: {
    color: colors.destructive,
  },
  cancelCard: {
    alignItems: 'center',
    backgroundColor: 'transparent',
    borderColor: colors.sheetActionBorder,
    borderRadius: radius.container,
    borderWidth: StyleSheet.hairlineWidth,
    justifyContent: 'center',
    minHeight: 54,
  },
  cancelText: {
    color: colors.sheetActionText,
    fontSize: typeScale.listBody,
    fontWeight: fontWeight.semibold,
    lineHeight: lineHeight.listBody,
  },
  pressed: {
    opacity: 0.72,
  },
});
