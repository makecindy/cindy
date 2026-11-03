import { useState } from "react";
import {
  Alert,
  Pressable,
  StyleSheet,
  View,
  useWindowDimensions,
} from "react-native";
import { Check } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  USER_BUBBLE_PRESETS,
  bubbleHueColor,
  parseUserBubblePreference,
  userBubbleSeed,
  type UserBubblePreference,
} from "@cindy/maker-shared";
import { Text, TextInput } from "@/components/AppText";
import { MainWindowActionButton } from "@/components/MobilePrimitives";
import { ActionInfoRow } from "@/session/SettingsGroupRows";
import { SheetModal } from "@/session/SheetModal";
import { SheetSurface } from "@/session/SheetSurface";
import {
  computeContextSheetSnapHeights,
  type ContextSheetSnap,
} from "@/session/contextSheetModel";
import {
  useTheme,
  useThemedStyles,
  type ThemeColors,
  fontWeight,
  iconSize,
  lineHeight,
  radius,
  spacing,
  typeScale,
} from "@/theme";
import {
  resolveMobileUserBubbleColors,
  useUserBubbleAppearance,
} from "@/theme/userBubblePreference";

export function UserBubbleSettings() {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const {
    preference,
    setPreference,
    mode,
    colors: bubble,
  } = useUserBubbleAppearance();
  const [open, setOpen] = useState(false);
  const [snap, setSnap] = useState<ContextSheetSnap>("full");
  const [customOpen, setCustomOpen] = useState(false);
  const [hex, setHex] = useState(() =>
    userBubbleSeed(preference === "default" ? "blue" : preference)!,
  );
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const label = (name: string) => t(`settings.appearance.userBubble.${name}`);
  const select = (next: UserBubblePreference) => {
    void setPreference(next).catch(() =>
      Alert.alert(label("title"), label("saveFailed"), [
        { text: label("cancel"), style: "cancel" },
        { text: label("retry"), onPress: () => select(next) },
      ]),
    );
  };
  return (
    <>
      <ActionInfoRow
        accessibilityLabel={`${label("title")}: ${label(preference.startsWith("#") ? "custom" : preference)}`}
        label={label("title")}
        onPress={() => {
          setHex(
            userBubbleSeed(preference === "default" ? "blue" : preference)!,
          );
          setCustomOpen(preference.startsWith("#"));
          setSnap("full");
          setOpen(true);
        }}
        testID="settings.userBubble.open"
        value={label(preference.startsWith("#") ? "custom" : preference)}
      />
      <SheetModal
        visible={open}
        onBackdropPress={() => setOpen(false)}
        onRequestClose={() => setOpen(false)}
      >
        <SheetSurface
          title={label("title")}
          onClose={() => setOpen(false)}
          snap={snap}
          onSnapChange={setSnap}
          bottomInset={insets.bottom}
          heights={computeContextSheetSnapHeights({
            safeAreaTopInset: insets.top,
            screenHeight: height,
          })}
          testID="settings.userBubble.sheet"
        >
          <View style={styles.content}>
            <View style={styles.preview}>
              <View
                testID="settings.userBubble.preview"
                style={[
                  styles.bubble,
                  bubble && {
                    backgroundColor: bubble.background,
                    borderColor: bubble.border,
                  },
                ]}
              >
                <Text style={styles.message}>{label("sampleUser")}</Text>
              </View>
              <Text style={styles.message}>{label("sampleAssistant")}</Text>
            </View>
            <View style={styles.grid}>
              {USER_BUBBLE_PRESETS.map((id) => {
                const palette = resolveMobileUserBubbleColors(id, mode, colors);
                return (
                  <Pressable
                    key={id}
                    accessibilityRole="radio"
                    accessibilityLabel={label(id)}
                    accessibilityState={{ checked: preference === id }}
                    testID={"settings.userBubble." + id}
                    onPress={() => select(id)}
                    style={styles.option}
                  >
                    <View
                      style={[
                        styles.swatch,
                        {
                          backgroundColor:
                            palette?.background ?? colors.surfaceElevated,
                          borderColor:
                            preference === id
                              ? colors.textPrimary
                              : (palette?.border ?? colors.border),
                        },
                      ]}
                    >
                      {preference === id && (
                        <Check size={iconSize.md} color={colors.textPrimary} />
                      )}
                    </View>
                    <Text style={styles.optionLabel}>{label(id)}</Text>
                  </Pressable>
                );
              })}
            </View>
            <MainWindowActionButton
              action={{
                label: label("custom"),
                active: customOpen,
                onPress: () => setCustomOpen(!customOpen),
                testID: "settings.userBubble.custom",
              }}
            />
            {customOpen && (
              <View style={styles.custom}>
                <View style={styles.hues}>
                  {Array.from({ length: 12 }, (_, i) =>
                    bubbleHueColor(i * 30),
                  ).map((color) => (
                    <Pressable
                      key={color}
                      accessibilityRole="button"
                      accessibilityLabel={label("custom") + " " + color}
                      onPress={() => {
                        setHex(color);
                        select(parseUserBubblePreference(color));
                      }}
                      style={styles.hueTarget}
                    >
                      <View
                        style={[
                          styles.hue,
                          {
                            backgroundColor: color,
                            borderColor: colors.border,
                          },
                        ]}
                      />
                    </Pressable>
                  ))}
                </View>
                <View style={styles.hexRow}>
                  <TextInput
                    accessibilityLabel={label("hex")}
                    value={hex}
                    onChangeText={setHex}
                    maxLength={7}
                    autoCapitalize="none"
                    autoCorrect={false}
                    style={styles.input}
                    testID="settings.userBubble.hex"
                  />
                  <MainWindowActionButton
                    action={{
                      label: label("apply"),
                      disabled: !/^#[\da-f]{6}$/i.test(hex),
                      onPress: () => select(parseUserBubblePreference(hex)),
                    }}
                  />
                </View>
              </View>
            )}
            <Text style={styles.hint}>{label("hint")}</Text>
            <MainWindowActionButton
              action={{
                label: label("reset"),
                onPress: () => select("default"),
              }}
            />
          </View>
        </SheetSurface>
      </SheetModal>
    </>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    content: { gap: spacing.lg, padding: spacing.lg },
    preview: {
      padding: spacing.md,
      gap: spacing.lg,
      backgroundColor: colors.surface,
      borderRadius: radius.container,
    },
    // 与 MessageRenderer 的 bubble + bubbleCompact + userBubble 一致,预览即实际效果。
    bubble: {
      alignSelf: "flex-end",
      maxWidth: "86%",
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
      borderRadius: radius.container,
      borderWidth: StyleSheet.hairlineWidth,
      backgroundColor: colors.surfaceElevated,
      borderColor: colors.border,
    },
    message: {
      color: colors.textPrimary,
      fontSize: typeScale.bodyLarge,
      lineHeight: lineHeight.bodyLarge,
      fontWeight: fontWeight.regular,
    },
    grid: { flexDirection: "row", flexWrap: "wrap", rowGap: spacing.md },
    option: {
      width: "33.33%",
      alignItems: "center",
      gap: spacing.sm,
      paddingVertical: spacing.xs,
    },
    swatch: {
      width: 44,
      height: 44,
      borderRadius: radius.pill,
      borderWidth: 1,
      alignItems: "center",
      justifyContent: "center",
    },
    optionLabel: {
      color: colors.textPrimary,
      fontSize: typeScale.body,
      lineHeight: lineHeight.body,
      fontWeight: fontWeight.medium,
    },
    custom: { gap: spacing.md },
    hues: { flexDirection: "row", flexWrap: "wrap" },
    hueTarget: {
      width: "16.66%",
      minHeight: 44,
      alignItems: "center",
      justifyContent: "center",
    },
    hue: {
      width: 28,
      height: 28,
      borderRadius: radius.pill,
      borderWidth: StyleSheet.hairlineWidth,
    },
    hexRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
    input: {
      flex: 1,
      minHeight: 44,
      paddingHorizontal: spacing.md,
      borderRadius: radius.pill,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
      backgroundColor: colors.surfaceElevated,
      color: colors.textPrimary,
      fontSize: typeScale.body,
      fontWeight: fontWeight.regular,
    },
    hint: {
      color: colors.textSecondary,
      fontSize: typeScale.footnote,
      lineHeight: lineHeight.caption,
      fontWeight: fontWeight.regular,
    },
  });
