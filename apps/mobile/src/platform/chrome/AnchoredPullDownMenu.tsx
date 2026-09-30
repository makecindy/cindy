/**
 * Android 的「贴着触发控件弹出」菜单:与 iOS UIMenu 同一交互(点触发器在旁边弹出、点外面
 * 收起、选中项打勾、内联分组带标题、子菜单逐层进入、keepPresented 的项点完不收起),
 * 外观用 Cindy 自己的浮层卡片(与 token 速度浮层同款:surfaceElevated 实底 + 1px 边框、
 * 零阴影)和首页菜单的行样式,跟随浅色 / 深色主题。系统 PopupMenu 画不出分组标题、会给每个可勾选项画空复选框,也不支持保持打开。
 *
 * 触发器整块作为一个无障碍按钮:子控件不再单独接收触摸或读屏焦点,读屏双击即打开菜单。
 */
import {
  isValidElement,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  Animated,
  Easing,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
  useWindowDimensions,
  type AccessibilityProps,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Check, ChevronLeft, ChevronRight, Minus } from "lucide-react-native";
import { Text } from "@/components/AppText";
import { useReduceMotionEnabled } from "@/hooks/useReduceMotion";
import type { NativePullDownAction } from "@/platform/chrome/NativePullDownMenu";
import {
  buildPullDownMenuSections,
  resolvePullDownSubmenu,
} from "@/platform/chrome/pullDownMenuModel";
import {
  fontWeight,
  iconSize,
  iconStroke,
  lineHeight,
  motionDuration,
  motionEasing,
  radius,
  spacing,
  typeScale,
  useTheme,
  useThemedStyles,
  type ThemeColors,
} from "@/theme";

const MENU_MIN_WIDTH = 220;
const MENU_MAX_WIDTH = 300;
const MENU_GAP = 4;
const EDGE_MARGIN = spacing.sm;
/** 下方剩余空间不足这个高度且上方更宽裕时,改为向上弹出。 */
const PREFERRED_MIN_HEIGHT = 240;

type Anchor = { x: number; y: number; width: number; height: number };

type ChildAccessibility = Pick<
  AccessibilityProps,
  | "accessibilityHint"
  | "accessibilityLabel"
  | "accessibilityState"
  | "accessibilityValue"
>;

/**
 * 外层按钮替子控件成为唯一的读屏节点,要带上子控件原有的读屏信息(如筛选按钮的
 * selected),只在状态上叠加菜单的 expanded。
 */
function childAccessibility(children: ReactNode): ChildAccessibility {
  if (!isValidElement(children)) return {};
  const props = children.props as ChildAccessibility;
  return {
    accessibilityHint:
      typeof props.accessibilityHint === "string"
        ? props.accessibilityHint
        : undefined,
    accessibilityLabel:
      typeof props.accessibilityLabel === "string"
        ? props.accessibilityLabel
        : undefined,
    accessibilityState: props.accessibilityState ?? undefined,
    accessibilityValue: props.accessibilityValue ?? undefined,
  };
}

export function AnchoredPullDownMenu({
  accessibilityLabel,
  actions,
  children,
  longPress = false,
  onAction,
  style,
  testID,
}: {
  accessibilityLabel?: string;
  actions: readonly NativePullDownAction[];
  children: ReactNode;
  longPress?: boolean;
  onAction(id: string): void;
  /** 触发器在父布局里的样式(如 flex: 1);外层替子元素占据父布局里的位置。 */
  style?: StyleProp<ViewStyle>;
  testID?: string;
}) {
  const styles = useThemedStyles(makeStyles);
  const anchorRef = useRef<View>(null);
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const [path, setPath] = useState<string[]>([]);
  const open = anchor !== null;

  const show = useCallback(() => {
    const node = anchorRef.current;
    if (!node) return;
    node.measureInWindow((x, y, width, height) => {
      setPath([]);
      setAnchor({ x, y, width, height });
    });
  }, []);
  const close = useCallback(() => setAnchor(null), []);

  const child = childAccessibility(children);
  return (
    <>
      <Pressable
        ref={anchorRef}
        accessibilityHint={child.accessibilityHint}
        accessibilityLabel={accessibilityLabel ?? child.accessibilityLabel}
        accessibilityRole="button"
        accessibilityState={{ ...child.accessibilityState, expanded: open }}
        accessibilityValue={child.accessibilityValue}
        collapsable={false}
        onLongPress={longPress ? show : undefined}
        onPress={longPress ? undefined : show}
        style={({ pressed }) => [style, pressed && styles.triggerPressed]}
        testID={testID}
      >
        {/* 触发器外观仍是调用方的按钮;它不再单独响应触摸或读屏,整块由外层 Pressable 接管。 */}
        <View
          importantForAccessibility="no-hide-descendants"
          pointerEvents="none"
          style={style ? styles.triggerFill : undefined}
        >
          {children}
        </View>
      </Pressable>
      {open ? (
        <AnchoredMenuOverlay
          actions={actions}
          anchor={anchor}
          onAction={onAction}
          onBack={() => setPath((current) => current.slice(0, -1))}
          onClose={close}
          onEnter={(id) => setPath((current) => [...current, id])}
          path={path}
          testID={testID ? `${testID}.menu` : undefined}
        />
      ) : null}
    </>
  );
}

function AnchoredMenuOverlay({
  actions,
  anchor,
  onAction,
  onBack,
  onClose,
  onEnter,
  path,
  testID,
}: {
  actions: readonly NativePullDownAction[];
  anchor: Anchor;
  onAction(id: string): void;
  onBack(): void;
  onClose(): void;
  onEnter(id: string): void;
  path: readonly string[];
  testID?: string;
}) {
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  const window = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const reduceMotion = useReduceMotionEnabled();
  const progress = useRef(new Animated.Value(reduceMotion ? 1 : 0)).current;

  useEffect(() => {
    if (reduceMotion) {
      progress.setValue(1);
      return;
    }
    Animated.timing(progress, {
      toValue: 1,
      duration: motionDuration.fast,
      easing: Easing.bezier(...motionEasing.out),
      useNativeDriver: true,
    }).start();
  }, [progress, reduceMotion]);

  // 子菜单路径失效(actions 已变化)时回到根页,而不是停在一个已不存在的层级。
  const submenu = path.length ? resolvePullDownSubmenu(actions, path) : null;
  const pageActions = submenu?.subactions ?? actions;
  const sections = buildPullDownMenuSections(pageActions);

  const width = Math.min(
    MENU_MAX_WIDTH,
    Math.max(MENU_MIN_WIDTH, anchor.width),
    window.width - EDGE_MARGIN * 2,
  );
  const anchorCenter = anchor.x + anchor.width / 2;
  const clampLeft = (value: number) =>
    Math.min(Math.max(EDGE_MARGIN, value), window.width - EDGE_MARGIN - width);
  // 与 UIMenu 一致:居中的触发器(如首页标题)菜单居中展开,靠边的触发器沿同侧边缘对齐。
  const left =
    Math.abs(anchorCenter - window.width / 2) <= window.width * 0.1
      ? clampLeft(anchorCenter - width / 2)
      : anchorCenter > window.width / 2
        ? clampLeft(
            Math.min(anchor.x + anchor.width, window.width - EDGE_MARGIN) -
              width,
          )
        : clampLeft(anchor.x);
  const spaceBelow =
    window.height -
    insets.bottom -
    EDGE_MARGIN -
    (anchor.y + anchor.height + MENU_GAP);
  const spaceAbove = anchor.y - MENU_GAP - insets.top - EDGE_MARGIN;
  const below = spaceBelow >= PREFERRED_MIN_HEIGHT || spaceBelow >= spaceAbove;
  const maxHeight = Math.max(below ? spaceBelow : spaceAbove, 120);
  const vertical = below
    ? { top: anchor.y + anchor.height + MENU_GAP }
    : { bottom: window.height - anchor.y + MENU_GAP };

  const choose = (action: NativePullDownAction) => {
    if (action.disabled) return;
    if (action.subactions?.length && !action.displayInline) {
      onEnter(action.id);
      return;
    }
    onAction(action.id);
    if (!action.keepPresented) onClose();
  };

  return (
    <Modal
      animationType="none"
      navigationBarTranslucent
      onRequestClose={submenu ? onBack : onClose}
      statusBarTranslucent
      supportedOrientations={[
        "portrait",
        "portrait-upside-down",
        "landscape-left",
        "landscape-right",
      ]}
      transparent
      visible
    >
      <Pressable
        accessible={false}
        onPress={onClose}
        style={StyleSheet.absoluteFill}
        testID={testID ? `${testID}.backdrop` : undefined}
      />
      <Animated.View
        accessibilityViewIsModal
        style={[
          styles.positioner,
          { left, width, ...vertical },
          {
            opacity: progress,
            transform: [
              {
                scale: progress.interpolate({
                  inputRange: [0, 1],
                  outputRange: [0.96, 1],
                }),
              },
            ],
          },
        ]}
      >
        <View style={styles.panel} testID={testID ?? "pullDownMenu"}>
          <ScrollView
            bounces={false}
            contentContainerStyle={styles.panelBody}
            style={{ maxHeight }}
            showsVerticalScrollIndicator
          >
            {submenu ? (
              <Pressable
                accessibilityLabel={submenu.title}
                accessibilityRole="button"
                onPress={onBack}
                style={({ pressed }) => [
                  styles.row,
                  pressed && styles.rowPressed,
                ]}
              >
                <View style={styles.leading}>
                  <ChevronLeft
                    color={colors.textSecondary}
                    size={iconSize.md}
                    strokeWidth={iconStroke.medium}
                  />
                </View>
                <Text numberOfLines={1} style={styles.backTitle}>
                  {submenu.title}
                </Text>
              </Pressable>
            ) : null}
            {sections.map((section, index) => (
              <View key={section.key}>
                {index > 0 || submenu ? <View style={styles.divider} /> : null}
                {section.title ? (
                  <Text accessibilityRole="header" style={styles.sectionTitle}>
                    {section.title}
                  </Text>
                ) : null}
                {section.rows.map((action) => (
                  <MenuRow
                    key={action.id}
                    action={action}
                    onPress={() => choose(action)}
                  />
                ))}
              </View>
            ))}
          </ScrollView>
        </View>
      </Animated.View>
    </Modal>
  );
}

function MenuRow({
  action,
  onPress,
}: {
  action: NativePullDownAction;
  onPress(): void;
}) {
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  const submenu = !!action.subactions?.length && !action.displayInline;
  const tint = action.destructive ? colors.destructive : colors.textPrimary;
  return (
    <Pressable
      accessibilityLabel={
        action.subtitle ? `${action.title}, ${action.subtitle}` : action.title
      }
      accessibilityRole="menuitem"
      accessibilityState={{
        checked:
          action.state === "mixed"
            ? "mixed"
            : action.state === "on"
              ? true
              : undefined,
        disabled: !!action.disabled,
      }}
      disabled={action.disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.row,
        pressed && styles.rowPressed,
        action.disabled && styles.rowDisabled,
      ]}
      testID={`pullDownMenu.item.${action.id}`}
    >
      {/* 固定对位列:选中打勾(与 iOS UIMenu 一样放在行首),未选中留空,文字列对齐。 */}
      <View style={styles.leading}>
        {action.state === "on" ? (
          <Check
            color={tint}
            size={iconSize.md}
            strokeWidth={iconStroke.medium}
          />
        ) : action.state === "mixed" ? (
          <Minus
            color={tint}
            size={iconSize.md}
            strokeWidth={iconStroke.medium}
          />
        ) : null}
      </View>
      <View style={styles.rowText}>
        <Text
          numberOfLines={2}
          style={[
            styles.rowTitle,
            action.destructive && { color: colors.destructive },
          ]}
        >
          {action.title}
        </Text>
        {action.subtitle ? (
          <Text numberOfLines={2} style={styles.rowSubtitle}>
            {action.subtitle}
          </Text>
        ) : null}
      </View>
      {submenu ? (
        <ChevronRight
          color={colors.textTertiary}
          size={iconSize.md}
          strokeWidth={iconStroke.regular}
        />
      ) : null}
    </Pressable>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    triggerFill: {
      flexGrow: 1,
    },
    triggerPressed: {
      opacity: 0.72,
    },
    positioner: {
      position: "absolute",
    },
    panel: {
      backgroundColor: colors.surfaceElevated,
      borderColor: colors.border,
      borderRadius: radius.container,
      borderWidth: 1,
      overflow: "hidden",
    },
    panelBody: {
      padding: spacing.xs,
    },
    row: {
      alignItems: "center",
      borderRadius: radius.container,
      flexDirection: "row",
      gap: spacing.md,
      minHeight: 44,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
    },
    rowPressed: {
      backgroundColor: colors.surfaceChip,
    },
    rowDisabled: {
      opacity: 0.4,
    },
    leading: {
      alignItems: "center",
      width: iconSize.md,
    },
    rowText: {
      flex: 1,
      minWidth: 0,
    },
    rowTitle: {
      color: colors.textPrimary,
      fontSize: typeScale.body,
      fontWeight: fontWeight.medium,
      lineHeight: lineHeight.body,
    },
    rowSubtitle: {
      color: colors.textSecondary,
      fontSize: typeScale.caption,
      lineHeight: lineHeight.caption,
    },
    backTitle: {
      color: colors.textSecondary,
      flex: 1,
      fontSize: typeScale.body,
      fontWeight: fontWeight.medium,
      lineHeight: lineHeight.body,
    },
    sectionTitle: {
      color: colors.textTertiary,
      fontSize: typeScale.footnote,
      fontWeight: fontWeight.semibold,
      lineHeight: lineHeight.caption,
      paddingBottom: spacing.xs,
      paddingHorizontal: spacing.md,
      paddingTop: spacing.sm,
    },
    divider: {
      backgroundColor: colors.border,
      height: StyleSheet.hairlineWidth,
      marginHorizontal: spacing.sm,
      marginVertical: spacing.xs,
    },
  });
