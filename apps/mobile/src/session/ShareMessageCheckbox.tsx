import { type ReactNode } from "react";
import { Check } from "lucide-react-native";
import { Pressable, StyleSheet, View } from "react-native";
import { useTranslation } from "react-i18next";
import { useTheme, useThemedStyles, type ThemeColors } from "@/theme";
import { iconSize, iconStroke, radius, spacing } from "@/theme/tokens";
import {
  shareSelectionStore,
  useIsMessageSelected,
} from "@/session/shareSelectionStore";

export function ShareCheckboxMark({ checked }: { checked: boolean }) {
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);

  return (
    <View style={[styles.mark, checked && styles.selected]}>
      {checked ? (
        <Check
          color={colors.ctaText}
          size={iconSize.sm}
          strokeWidth={iconStroke.bold}
        />
      ) : null}
    </View>
  );
}

export function ShareMessageCheckbox({
  children,
  clientId,
  disabled = false,
  fill = false,
}: {
  children?: ReactNode;
  clientId: string;
  disabled?: boolean;
  fill?: boolean;
}) {
  const { t } = useTranslation();
  const styles = useThemedStyles(makeStyles);
  const selected = useIsMessageSelected(clientId);

  return (
    <Pressable
      accessibilityLabel={t("session.shareImage.checkboxLabel")}
      accessibilityRole="checkbox"
      accessibilityState={{ checked: selected, disabled }}
      disabled={disabled}
      onPress={() => shareSelectionStore.toggle(clientId)}
      style={({ pressed }) => [
        fill ? styles.rowButton : styles.button,
        pressed && styles.pressed,
      ]}
      testID={`session.shareImage.checkbox.${clientId}`}
    >
      <View style={fill ? styles.rowMarkGutter : undefined}>
        <ShareCheckboxMark checked={selected} />
      </View>
      {children}
    </Pressable>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    button: {
      alignItems: "center",
      height: 44,
      justifyContent: "center",
      width: 44,
    },
    rowButton: {
      alignItems: "flex-start",
      flexDirection: "row",
      gap: spacing.sm,
      minWidth: 0,
      width: "100%",
    },
    rowMarkGutter: {
      alignItems: "center",
      paddingTop: spacing.sm,
      width: spacing.xl * 2,
    },
    mark: {
      alignItems: "center",
      borderColor: colors.borderStrong,
      borderRadius: radius.pill,
      borderWidth: StyleSheet.hairlineWidth,
      height: 22,
      justifyContent: "center",
      width: 22,
    },
    selected: {
      backgroundColor: colors.cta,
      borderColor: colors.cta,
    },
    pressed: { opacity: 0.72 },
  });
