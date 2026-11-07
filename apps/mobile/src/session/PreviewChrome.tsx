import {
  useContext,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import {
  Ellipsis,
  X,
  type LucideIcon,
} from "lucide-react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTranslation } from "react-i18next";
import { Text } from "@/components/AppText";
import {
  fontWeight,
  iconSize,
  iconStroke,
  lineHeight,
  radius,
  spacing,
  typeScale,
  useTheme,
  useThemedStyles,
  type ThemeColors,
} from "@/theme";
import { NativePullDownMenu, usesNativePullDownMenu } from "@/platform/chrome";
import { SheetModal } from "./SheetModal";
import {
  NATIVE_PREVIEW_CHROME,
  NativePreviewButton,
  NativePreviewGroup,
  NativePreviewHeader,
  NativePreviewLabel,
  NativePreviewLoadingPill,
} from "./PreviewNativeChrome";
import {
  PreviewNativeGroupContext,
  type PreviewSystemImage,
} from "./PreviewNativeChrome.types";

export interface PreviewAction {
  key: string;
  label: string;
  onPress: () => void;
  icon?: LucideIcon;
  disabled?: boolean;
}

/**
 * 预览里的图标按钮。iOS 上在按钮组里画成 SwiftUI 原生按钮(`systemImage` 是它的
 * SF Symbol,玻璃、按压与禁用效果都由系统绘制);其它平台用 lucide 图标画同样的按钮。
 */
export function PreviewIconButton({
  label,
  icon: Icon,
  systemImage,
  onPress,
  disabled,
  testID,
  hint,
  title,
}: {
  label: string;
  icon: LucideIcon;
  systemImage: PreviewSystemImage;
  onPress: () => void;
  disabled?: boolean;
  testID?: string;
  hint?: string;
  /** 图标旁的文字(如视频下载进度);不传时只显示图标。 */
  title?: string;
}) {
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  if (useContext(PreviewNativeGroupContext))
    return (
      <NativePreviewButton
        label={label}
        systemImage={systemImage}
        onPress={onPress}
        disabled={disabled}
        testID={testID}
        hint={hint}
        title={title}
      />
    );
  const color = disabled ? colors.textTertiary : colors.textPrimary;
  return (
    <PreviewPressable
      accessibilityLabel={label}
      accessibilityHint={hint}
      disabled={disabled}
      onPress={onPress}
      testID={testID}
      style={title ? styles.titledButton : undefined}
    >
      <Icon color={color} size={iconSize.action} strokeWidth={iconStroke.regular} />
      {title ? (
        <Text numberOfLines={1} style={[styles.buttonTitle, { color }]}>
          {title}
        </Text>
      ) : null}
    </PreviewPressable>
  );
}

/** React Native 画法的点按热区:按下时加一层按压色(非 iOS,或查找栏这类不在按钮组里的按钮)。 */
function PreviewPressable({
  accessibilityLabel,
  accessibilityHint,
  disabled,
  onPress,
  testID,
  style,
  children,
}: {
  accessibilityLabel?: string;
  accessibilityHint?: string;
  disabled?: boolean;
  onPress: () => void;
  testID?: string;
  style?: StyleProp<ViewStyle>;
  children: ReactNode;
}) {
  const styles = useThemedStyles(makeStyles);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled: !!disabled }}
      disabled={disabled}
      onPress={onPress}
      testID={testID}
      style={({ pressed }) => [styles.button, style, pressed && styles.pressed]}
    >
      {children}
    </Pressable>
  );
}

/**
 * 一组浮动按钮(关闭、更多、底部工具、附件集合导航、查看器工具行)。iOS 上是一枚
 * SwiftUI 原生的可交互玻璃胶囊(App 里能用原生的都用原生,用户定稿 2026-11-07):
 * 玻璃随背后内容变亮变暗、图标跟着换色、按下的液态反馈都由系统负责,不压底色。
 * 其它平台整组一枚主题实色胶囊。
 */
export function PreviewGlassGroup({
  children,
  style,
}: {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  const styles = useThemedStyles(makeStyles);
  if (NATIVE_PREVIEW_CHROME) return <NativePreviewGroup>{children}</NativePreviewGroup>;
  return <View style={[styles.glass, styles.glassFallback, style]}>{children}</View>;
}

/** 按钮组里不可点的文字(PDF 页码)。 */
export function PreviewToolLabel({ text }: { text: string }) {
  const styles = useThemedStyles(makeStyles);
  if (useContext(PreviewNativeGroupContext)) return <NativePreviewLabel text={text} />;
  return (
    <View style={styles.toolLabel}>
      <Text style={styles.detail}>{text}</Text>
    </View>
  );
}

/** 查看器自己的工具行(页码、缩放、查找等):透明行里一枚居中的玻璃胶囊。 */
export function PreviewToolbar({ children }: { children: ReactNode }) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.toolbarRow}>
      <PreviewGlassGroup>{children}</PreviewGlassGroup>
    </View>
  );
}

/** Always reachable, including when the content hides its playback/gesture chrome. */
export function PreviewHeader({
  name,
  detail,
  onClose,
  actions = [],
  closeDisabled = false,
  closeTestID = "preview.close",
}: {
  name: string;
  detail?: string;
  onClose: () => void;
  actions?: readonly PreviewAction[];
  closeDisabled?: boolean;
  closeTestID?: string;
}) {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const styles = useThemedStyles(makeStyles);
  const [menu, setMenu] = useState(false);
  const afterClose = useRef<(() => void) | null>(null);
  // 「文件信息」始终在「更多」里:标题只显示一行,被截断的完整文件名要有地方看
  // (没有 detail 时只显示文件名)。
  const menuActions: readonly PreviewAction[] = [
    {
      key: "preview.fileInfo",
      label: t("files.preview.browserFileInfo"),
      onPress: () => Alert.alert(name, detail),
    },
    ...actions,
  ];
  const nativeMenu = usesNativePullDownMenu();
  const frame = [
    styles.header,
    {
      height: insets.top + PREVIEW_HEADER_HEIGHT,
      paddingTop: insets.top,
      paddingLeft: insets.left + spacing.md,
      paddingRight: insets.right + spacing.md,
    },
  ];
  if (NATIVE_PREVIEW_CHROME)
    return (
      <View testID="preview.header" pointerEvents="box-none" style={frame}>
        <NativePreviewHeader
          name={name}
          onClose={onClose}
          closeLabel={t("message.attachmentPreview.close")}
          closeDisabled={closeDisabled}
          closeTestID={closeTestID}
          moreLabel={t("message.attachmentPreview.more")}
          actions={menuActions}
        />
      </View>
    );
  return (
    <>
      <View
        testID="preview.header"
        pointerEvents="box-none"
        style={frame}
      >
        <PreviewGlassGroup>
          <PreviewIconButton
            icon={X}
            systemImage="xmark"
            label={t("message.attachmentPreview.close")}
            onPress={onClose}
            disabled={closeDisabled}
            testID={closeTestID}
          />
        </PreviewGlassGroup>
        <View pointerEvents="box-none" style={styles.titleSlot}>
          <View style={[styles.glass, styles.glassFallback, styles.titleCapsule]}>
            <Text numberOfLines={1} style={[styles.title, styles.titleText]} testID="preview.title">
              {name}
            </Text>
          </View>
        </View>
        {menuActions.length ? (
          <NativePullDownMenu
            accessibilityLabel={t("message.attachmentPreview.more")}
            actions={menuActions.map((action) => ({
              id: action.key,
              title: action.label,
              icon: action.icon,
              disabled: action.disabled,
            }))}
            onAction={(id) => menuActions.find((action) => action.key === id)?.onPress()}
            testID="preview.moreMenu"
          >
            <PreviewGlassGroup>
              <PreviewIconButton
                icon={Ellipsis}
                systemImage="ellipsis"
                label={t("message.attachmentPreview.more")}
                // 系统菜单接管点按;没有系统菜单的旧包退回底部面板。
                onPress={nativeMenu ? () => {} : () => setMenu(true)}
                testID="preview.more"
              />
            </PreviewGlassGroup>
          </NativePullDownMenu>
        ) : (
          <View style={styles.button} />
        )}
      </View>
      <SheetModal
        visible={menu}
        onRequestClose={() => setMenu(false)}
        onBackdropPress={() => setMenu(false)}
        onClosed={() => {
          const action = afterClose.current;
          afterClose.current = null;
          action?.();
        }}
      >
        <View
          style={[styles.sheet, { paddingBottom: insets.bottom + spacing.md }]}
        >
          <Text selectable style={styles.title}>
            {name}
          </Text>
          {detail ? (
            <Text selectable style={styles.detail}>
              {detail}
            </Text>
          ) : null}
          <ScrollView>
            {actions.map((action) => (
              <Pressable
                key={action.key}
                accessibilityRole="button"
                disabled={action.disabled}
                onPress={() => {
                  afterClose.current = action.onPress;
                  setMenu(false);
                }}
                style={styles.menuRow}
              >
                <Text
                  style={[styles.menuLabel, action.disabled && styles.disabled]}
                >
                  {action.label}
                </Text>
              </Pressable>
            ))}
          </ScrollView>
        </View>
      </SheetModal>
    </>
  );
}

/** 预览顶栏(关闭 / 文件名 / 更多)在安全区之下占的高度。 */
export const PREVIEW_HEADER_HEIGHT = 64;
/** 底部每一行玻璃胶囊(类型工具、附件集合)占的高度。 */
export const PREVIEW_FOOTER_ROW_HEIGHT = 56;

/**
 * 底栏的载入胶囊:内容还在载入时整条底栏只显示它,不摆一排点不动的工具
 * (用户定稿 2026-10-31,2026-11-06 收进共享外壳)。与工具胶囊同高,载入完成换回工具时不跳。
 */
export function PreviewLoadingPill({
  label,
  testID,
}: {
  label: string;
  testID?: string;
}) {
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  if (NATIVE_PREVIEW_CHROME)
    return <NativePreviewLoadingPill label={label} testID={testID} />;
  return (
    <View style={[styles.glass, styles.glassFallback, styles.loadingPill]}>
      <View
        accessible
        accessibilityLabel={label}
        accessibilityLiveRegion="polite"
        accessibilityRole="progressbar"
        style={styles.loadingPillBody}
        testID={testID}
      >
        <ActivityIndicator color={colors.textSecondary} size="small" />
        <Text style={styles.detail}>{label}</Text>
      </View>
    </View>
  );
}

/**
 * 底部浮动工具。传 `loading` 时整条工具胶囊换成载入胶囊,子节点不渲染。
 * 手机不放附件集合的上一项 / 下一项(用户定稿 2026-11-07):图片与视频在看图器里左右滑动
 * 切换,其它附件关掉预览再点下一个。
 */
export function PreviewFooter({
  children,
  loading,
  loadingTestID,
}: {
  children?: ReactNode;
  loading?: string;
  loadingTestID?: string;
}) {
  const styles = useThemedStyles(makeStyles);
  const insets = useSafeAreaInsets();
  if (!loading && !children) return null;
  return (
    <View
      pointerEvents="box-none"
      style={[
        styles.footer,
        {
          paddingBottom: insets.bottom,
          paddingLeft: insets.left + spacing.sm,
          paddingRight: insets.right + spacing.sm,
        },
      ]}
    >
      <View pointerEvents="box-none" style={styles.tools}>
        {loading ? (
          <PreviewLoadingPill label={loading} testID={loadingTestID} />
        ) : (
          <PreviewGlassGroup style={styles.toolsGroup}>{children}</PreviewGlassGroup>
        )}
      </View>
    </View>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    header: {
      position: "absolute",
      top: 0,
      left: 0,
      right: 0,
      zIndex: 20,
      minHeight: 64,
      flexDirection: "row",
      alignItems: "center",
      gap: spacing.sm,
      paddingBottom: spacing.sm,
    },
    button: {
      minWidth: 48,
      minHeight: 48,
      alignItems: "center",
      justifyContent: "center",
      borderRadius: radius.pill,
    },
    pressed: { backgroundColor: colors.surfaceChip },
    titledButton: { flexDirection: "row", gap: spacing.sm, paddingHorizontal: spacing.md },
    buttonTitle: {
      fontSize: typeScale.footnote,
      lineHeight: lineHeight.caption,
      fontWeight: fontWeight.medium,
    },
    toolLabel: { minHeight: 48, justifyContent: "center", paddingHorizontal: spacing.xs },
    glass: {
      flexDirection: "row",
      alignItems: "center",
      borderRadius: radius.pill,
      overflow: "hidden",
    },
    glassFallback: {
      backgroundColor: colors.surfaceElevated,
      borderColor: colors.border,
      borderWidth: StyleSheet.hairlineWidth,
    },
    // 文件名的玻璃和文件名一样宽、居中;过长时最宽占满中间一栏(宽屏限 560pt)再截断。
    titleSlot: { flex: 1, minWidth: 0, alignItems: "center" },
    titleCapsule: {
      maxWidth: "100%",
      minHeight: 48,
      justifyContent: "center",
      paddingHorizontal: spacing.lg,
    },
    titleText: { flexShrink: 1, maxWidth: 560 },
    title: {
      color: colors.textPrimary,
      fontSize: typeScale.body,
      lineHeight: lineHeight.body,
      fontWeight: fontWeight.semibold,
    },
    detail: {
      color: colors.textSecondary,
      fontSize: typeScale.caption,
      lineHeight: lineHeight.caption,
    },
    footer: {
      position: "absolute",
      left: 0,
      right: 0,
      bottom: 0,
      zIndex: 20,
    },
    tools: {
      minHeight: 56,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
    },
    toolsGroup: { flexWrap: "wrap", justifyContent: "center", maxWidth: "100%" },
    loadingPill: { maxWidth: "100%" },
    loadingPillBody: {
      minHeight: 48,
      flexDirection: "row",
      alignItems: "center",
      gap: spacing.sm,
      paddingHorizontal: spacing.lg,
    },
    toolbarRow: {
      minHeight: 56,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      paddingHorizontal: spacing.sm,
    },
    sheet: {
      backgroundColor: colors.surface,
      borderTopLeftRadius: radius.container,
      borderTopRightRadius: radius.container,
      padding: spacing.lg,
      maxHeight: "75%",
    },
    menuRow: {
      minHeight: 48,
      justifyContent: "center",
      paddingVertical: spacing.sm,
    },
    menuLabel: {
      color: colors.textPrimary,
      fontSize: typeScale.body,
      lineHeight: lineHeight.body,
      fontWeight: fontWeight.medium,
    },
    disabled: { color: colors.textTertiary },
  });
