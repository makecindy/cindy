import {
  createContext,
  useContext,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { GlassView } from "expo-glass-effect";
import {
  ChevronLeft,
  ChevronRight,
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
import { useLiquidGlassAvailable } from "./useLiquidGlassAvailable";

export interface PreviewCollectionNavigation {
  index: number;
  names: readonly string[];
  onSelect(index: number): void;
}
export const PreviewCollectionContext = createContext<
  PreviewCollectionNavigation | undefined
>(undefined);

export interface PreviewAction {
  key: string;
  label: string;
  onPress: () => void;
  icon?: LucideIcon;
  disabled?: boolean;
}

export function PreviewIconButton({
  label,
  icon: Icon,
  onPress,
  disabled,
  testID,
  hint,
}: {
  label: string;
  icon: LucideIcon;
  onPress: () => void;
  disabled?: boolean;
  testID?: string;
  hint?: string;
}) {
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={hint}
      accessibilityState={{ disabled: !!disabled }}
      disabled={disabled}
      onPress={onPress}
      testID={testID}
      style={({ pressed }) => [styles.button, pressed && styles.pressed]}
    >
      <Icon
        color={disabled ? colors.textTertiary : colors.textPrimary}
        size={iconSize.action}
        strokeWidth={iconStroke.regular}
      />
    </Pressable>
  );
}

/**
 * 预览外壳与内置浏览器同一做法(用户定稿 2026-11-03):按钮浮在页面上,iOS 26+ 用
 * 系统 Liquid Glass,其它环境退回实色圆角底;工具按钮成组放进一枚胶囊,不铺满整行底栏。
 */
export function PreviewGlass({
  children,
  style,
}: {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  const glass = useLiquidGlassAvailable();
  const { mode } = useTheme();
  const styles = useThemedStyles(makeStyles);
  return glass ? (
    <GlassView
      colorScheme={mode}
      glassEffectStyle="regular"
      style={[styles.glass, style]}
    >
      {children}
    </GlassView>
  ) : (
    <View style={[styles.glass, styles.glassFallback, style]}>{children}</View>
  );
}

/** 查看器自己的工具行(页码、缩放、查找等):透明行里一枚居中的玻璃胶囊。 */
export function PreviewToolbar({ children }: { children: ReactNode }) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.toolbarRow}>
      <PreviewGlass>{children}</PreviewGlass>
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
  return (
    <>
      <View
        testID="preview.header"
        pointerEvents="box-none"
        style={[
          styles.header,
          {
            height: insets.top + 64,
            paddingTop: insets.top,
            paddingLeft: insets.left + spacing.md,
            paddingRight: insets.right + spacing.md,
          },
        ]}
      >
        <PreviewGlass>
          <PreviewIconButton
            icon={X}
            label={t("message.attachmentPreview.close")}
            onPress={onClose}
            disabled={closeDisabled}
            testID={closeTestID}
          />
        </PreviewGlass>
        <View pointerEvents="box-none" style={styles.titleSlot}>
          <PreviewGlass style={styles.titleCapsule}>
            <Text numberOfLines={1} style={styles.title} testID="preview.title">
              {name}
            </Text>
          </PreviewGlass>
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
            <PreviewGlass>
              <PreviewIconButton
                icon={Ellipsis}
                label={t("message.attachmentPreview.more")}
                // 系统菜单接管点按;没有系统菜单的旧包退回底部面板。
                onPress={nativeMenu ? () => {} : () => setMenu(true)}
                testID="preview.more"
              />
            </PreviewGlass>
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

export function PreviewFooter({
  children,
  collection: ownCollection,
  hideCollection = false,
}: {
  children?: ReactNode;
  collection?: PreviewCollectionNavigation;
  hideCollection?: boolean;
}) {
  const inheritedCollection = useContext(PreviewCollectionContext);
  const collection = hideCollection
    ? undefined
    : (inheritedCollection ?? ownCollection);
  const styles = useThemedStyles(makeStyles);
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const [list, setList] = useState(false);
  const selected = useRef<number | null>(null);
  const multiple = collection && collection.names.length > 1;
  if (!children && !multiple) return null;
  return (
    <>
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
        {children ? (
          <View pointerEvents="box-none" style={styles.tools}>
            <PreviewGlass style={styles.toolsGroup}>{children}</PreviewGlass>
          </View>
        ) : null}
        {multiple ? (
          <View pointerEvents="box-none" style={styles.tools}>
            <PreviewGlass>
              <PreviewIconButton
                icon={ChevronLeft}
                label={t("message.attachmentPreview.previous")}
                disabled={collection.index === 0}
                onPress={() => collection.onSelect(collection.index - 1)}
              />
              <Pressable
                accessibilityRole="button"
                onPress={() => setList(true)}
                style={styles.button}
              >
                <Text
                  testID="preview.collectionCount"
                  style={styles.detail}
                >{`${collection.index + 1} / ${collection.names.length}`}</Text>
              </Pressable>
              <PreviewIconButton
                icon={ChevronRight}
                label={t("message.attachmentPreview.next")}
                disabled={collection.index === collection.names.length - 1}
                onPress={() => collection.onSelect(collection.index + 1)}
              />
            </PreviewGlass>
          </View>
        ) : null}
      </View>
      <SheetModal
        visible={list}
        onRequestClose={() => setList(false)}
        onBackdropPress={() => setList(false)}
        onClosed={() => {
          if (selected.current !== null) collection?.onSelect(selected.current);
          selected.current = null;
        }}
      >
        <ScrollView
          style={styles.sheet}
          contentContainerStyle={{ paddingBottom: insets.bottom + spacing.md }}
        >
          {collection?.names.map((name, index) => (
            <Pressable
              accessibilityRole="button"
              key={`${index}:${name}`}
              style={styles.menuRow}
              onPress={() => {
                selected.current = index;
                setList(false);
              }}
            >
              <Text style={styles.menuLabel}>
                {index + 1}. {name}
              </Text>
            </Pressable>
          ))}
        </ScrollView>
      </SheetModal>
    </>
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
    // 宽屏(iPad)上文件名胶囊限宽居中,不拉满整行。
    titleSlot: { flex: 1, minWidth: 0, alignItems: "center" },
    titleCapsule: {
      width: "100%",
      maxWidth: 560,
      minWidth: 0,
      minHeight: 48,
      justifyContent: "center",
      paddingHorizontal: spacing.lg,
    },
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
