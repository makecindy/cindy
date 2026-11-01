import {
  createContext,
  useContext,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";
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
import { SheetModal } from "./SheetModal";

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
  return (
    <>
      <View
        testID="preview.header"
        style={[
          styles.header,
          {
            height: insets.top + 64,
            paddingTop: insets.top,
            paddingLeft: insets.left + spacing.sm,
            paddingRight: insets.right + spacing.sm,
          },
        ]}
      >
        <PreviewIconButton
          icon={X}
          label={t("message.attachmentPreview.close")}
          onPress={onClose}
          disabled={closeDisabled}
          testID={closeTestID}
        />
        <View style={styles.titleColumn}>
          <Text numberOfLines={1} style={styles.title}>
            {name}
          </Text>
          {detail ? (
            <Text numberOfLines={1} style={styles.detail}>
              {detail}
            </Text>
          ) : null}
        </View>
        {actions.length ? (
          <PreviewIconButton
            icon={Ellipsis}
            label={t("message.attachmentPreview.more")}
            onPress={() => setMenu(true)}
            testID="preview.more"
          />
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
        style={[
          styles.footer,
          {
            paddingBottom: insets.bottom,
            paddingLeft: insets.left + spacing.sm,
            paddingRight: insets.right + spacing.sm,
          },
        ]}
      >
        {children ? <View style={styles.tools}>{children}</View> : null}
        {multiple ? (
          <View style={styles.tools}>
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
      backgroundColor: colors.surface,
      borderBottomColor: colors.border,
      borderBottomWidth: StyleSheet.hairlineWidth,
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
    titleColumn: { flex: 1, minWidth: 0, alignItems: "center" },
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
      backgroundColor: colors.surface,
      borderTopColor: colors.border,
      borderTopWidth: StyleSheet.hairlineWidth,
    },
    tools: {
      minHeight: 56,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      flexWrap: "wrap",
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
