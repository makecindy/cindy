import { useRef, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from "react-native";
import { useTranslation } from "react-i18next";
import {
  ChevronLeft,
  ChevronRight,
  CodeXml,
  Copy,
  Ellipsis,
  File,
  MessageSquarePlus,
  RotateCw,
  Share,
  X,
  type LucideIcon,
} from "lucide-react-native";
import { Text, TextInput } from "@/components/AppText";
import { SheetModal } from "./SheetModal";
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
import {
  HTML_BROWSER_CONTROL_SIZE as size,
  type HtmlBrowserChromeProps,
} from "./HtmlBrowserChrome.types";

/** Android/web use opaque themed surfaces so arbitrary webpage colors cannot erase the controls. */
export function HtmlBrowserChrome(p: HtmlBrowserChromeProps) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const [menuOpen, setMenuOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [address, setAddress] = useState(p.address);
  const afterClose = useRef<(() => void) | null>(null);
  const close = () => setMenuOpen(false);
  const choose = (action: () => void) => {
    afterClose.current = action;
    close();
  };
  const button = (
    Icon: LucideIcon,
    label: string,
    action: () => void,
    id: string,
    disabled = false,
  ) => (
    <Pressable
      accessibilityLabel={label}
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={action}
      testID={id}
      style={({ pressed }) => [
        styles.button,
        (pressed || disabled) && styles.dimmed,
      ]}
    >
      <Icon
        color={colors.textPrimary}
        size={iconSize.xl}
        strokeWidth={iconStroke.regular}
      />
    </Pressable>
  );
  return (
    <View pointerEvents="box-none" style={StyleSheet.absoluteFill}>
      <View
        pointerEvents="box-none"
        style={[styles.row, { top: p.top, left: p.left, right: p.right }]}
      >
        {button(X, t("files.preview.done"), p.onClose, "filePreview.done")}
        <View style={styles.address}>
          {editing ? <TextInput
            value={address}
            onChangeText={setAddress}
            autoFocus
            selectTextOnFocus
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            returnKeyType="go"
            submitBehavior="submit"
            onSubmitEditing={(event) => { if (p.onNavigate(event.nativeEvent.text)) setEditing(false); }}
            accessibilityLabel={t("files.preview.browserAddress")}
            testID="filePreview.browser.addressInput"
            style={[styles.title, { flex: 1, height: size, paddingHorizontal: spacing.md }]}
          /> : <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${t("files.preview.browserAddress")}: ${p.address}`}
            onPress={() => { setAddress(p.address); setEditing(true); }}
            testID="filePreview.browser.editAddress"
            style={styles.addressTitle}
          >
            <File
              color={colors.textSecondary}
              size={iconSize.md}
              strokeWidth={iconStroke.regular}
            />
            <Text
              numberOfLines={1}
              accessibilityLabel={p.path}
              style={styles.title}
              testID="filePreview.title"
            >
              {p.title}
            </Text>
          </Pressable>}
          {editing ? button(X, t("files.preview.browserCancelAddress"), () => setEditing(false), "filePreview.browser.cancelAddress") : p.loading ? (
            <View style={styles.button}>
              <ActivityIndicator color={colors.textSecondary} />
            </View>
          ) : (
            button(
              RotateCw,
              t("files.preview.htmlReload"),
              p.onReload,
              "filePreview.browser.reload",
              p.source || p.loading,
            )
          )}
        </View>
      </View>
      {p.notice ? (
        <View
          pointerEvents="none"
          style={[styles.notice, { bottom: p.bottom + size + spacing.sm }]}
        >
          {p.notice ? (
            <Text
              accessibilityLiveRegion="polite"
              testID="filePreview.notice"
              style={styles.noticeText}
            >
              {p.notice}
            </Text>
          ) : (
            <ActivityIndicator color={colors.textSecondary} />
          )}
        </View>
      ) : null}
      <View
        pointerEvents="box-none"
        style={[styles.row, { bottom: p.bottom, left: p.left, right: p.right }]}
      >
        <View style={styles.navigation}>
          {button(
            ChevronLeft,
            t("files.preview.browserBack"),
            p.onBack,
            "filePreview.browser.back",
            !p.canGoBack,
          )}
          {button(
            ChevronRight,
            t("files.preview.browserForward"),
            p.onForward,
            "filePreview.browser.forward",
            !p.canGoForward,
          )}
        </View>
        <View pointerEvents="none" style={styles.spacer} />
        {button(
          Share,
          t("files.preview.a11yShare"),
          p.onShare,
          "filePreview.share",
          p.busy,
        )}
        {button(
          Ellipsis,
          t("files.preview.browserMore"),
          () => setMenuOpen(true),
          "filePreview.browser.more",
        )}
      </View>
      <SheetModal
        visible={menuOpen}
        onBackdropPress={close}
        onRequestClose={close}
        onClosed={() => {
          const action = afterClose.current;
          afterClose.current = null;
          action?.();
        }}
      >
        <View style={[styles.menu, { paddingBottom: p.bottom }]}>
          <View style={styles.menuHeader}>
            <Text numberOfLines={1} style={styles.menuTitle}>
              {p.title}
            </Text>
            {button(
              X,
              t("shared.closePanel"),
              close,
              "filePreview.browser.menuClose",
            )}
          </View>
          <ScrollView>
            <Text selectable style={styles.path}>
              {p.path}
            </Text>
            {[
              {
                id: "filePreview.browser.source",
                Icon: CodeXml,
                label: t(
                  p.website ? "files.preview.browserReturnToFile" : p.source
                    ? "files.preview.browserShowPage"
                    : "files.preview.browserShowSource",
                ),
                action: p.onToggleSource,
                disabled: false,
              },
              {
                id: "filePreview.copyPath",
                Icon: Copy,
                label: t(p.website ? "files.preview.browserCopyAddress" : "files.preview.copyPath"),
                action: p.onCopyPath,
                disabled: p.busy,
              },
              {
                id: "filePreview.sendToSession",
                Icon: MessageSquarePlus,
                label: t("files.preview.browserAddToTask"),
                action: p.onAddToTask,
                disabled: p.busy,
              },
            ].filter(item => !p.website || item.id !== "filePreview.sendToSession").map(({ id, Icon, label, action, disabled }) => (
              <Pressable
                key={id}
                accessibilityRole="button"
                accessibilityState={{ disabled }}
                disabled={disabled}
                testID={id}
                onPress={() => choose(action)}
                style={({ pressed }) => [
                  styles.menuItem,
                  (pressed || disabled) && styles.dimmed,
                ]}
              >
                <Icon
                  size={iconSize.lg}
                  color={colors.textPrimary}
                  strokeWidth={iconStroke.regular}
                />
                <Text style={styles.menuLabel}>{label}</Text>
              </Pressable>
            ))}
          </ScrollView>
        </View>
      </SheetModal>
    </View>
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    row: {
      position: "absolute",
      flexDirection: "row",
      alignItems: "center",
      gap: spacing.sm,
    },
    button: {
      width: size,
      height: size,
      alignItems: "center",
      justifyContent: "center",
      borderRadius: radius.pill,
      backgroundColor: c.surfaceElevated,
    },
    dimmed: { opacity: 0.4 },
    address: {
      flex: 1,
      minWidth: 0,
      flexDirection: "row",
      alignItems: "center",
      borderRadius: radius.pill,
      backgroundColor: c.surfaceElevated,
      paddingLeft: spacing.lg,
    },
    title: { flex: 1, color: c.textPrimary, fontSize: typeScale.footnote },
    addressTitle: {
      flex: 1,
      minWidth: 0,
      minHeight: size,
      flexDirection: "row",
      alignItems: "center",
      gap: spacing.sm,
    },
    navigation: {
      flexDirection: "row",
      borderRadius: radius.pill,
      backgroundColor: c.surfaceElevated,
    },
    spacer: { flex: 1 },
    notice: {
      position: "absolute",
      left: spacing.lg,
      right: spacing.lg,
      alignItems: "center",
    },
    noticeText: {
      color: c.textPrimary,
      backgroundColor: c.surfaceElevated,
      padding: spacing.sm,
      borderRadius: radius.container,
      fontSize: typeScale.footnote,
      lineHeight: lineHeight.caption,
    },
    menu: {
      maxHeight: "80%",
      backgroundColor: c.surfaceElevated,
      borderTopLeftRadius: radius.container,
      borderTopRightRadius: radius.container,
      padding: spacing.lg,
    },
    menuHeader: { flexDirection: "row", alignItems: "center" },
    menuTitle: { flex: 1, color: c.textPrimary, fontSize: typeScale.body, lineHeight: lineHeight.body, fontWeight: fontWeight.semibold },
    path: {
      color: c.textSecondary,
      fontSize: typeScale.caption,
      lineHeight: lineHeight.caption,
      marginVertical: spacing.sm,
    },
    menuItem: {
      minHeight: size,
      flexDirection: "row",
      alignItems: "center",
      gap: spacing.md,
      padding: spacing.sm,
      borderRadius: radius.control,
    },
    menuLabel: { color: c.textPrimary, fontSize: typeScale.body, lineHeight: lineHeight.body },
  });
