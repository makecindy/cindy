import { Check } from "lucide-react-native";
import { Pressable, StyleSheet } from "react-native";
import { useTranslation } from "react-i18next";
import { useTheme, useThemedStyles, type ThemeColors } from "@/theme";
import { iconSize, iconStroke, radius, spacing } from "@/theme/tokens";
import {
  shareSelectionStore,
  useIsMessageSelected,
} from "@/session/shareSelectionStore";

export function ShareMessageCheckbox({ clientId }: { clientId: string }) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const selected = useIsMessageSelected(clientId);

  return (
    <Pressable
      accessibilityLabel={t("session.shareImage.checkboxLabel")}
      accessibilityRole="checkbox"
      accessibilityState={{ checked: selected }}
      hitSlop={spacing.sm}
      onPress={() => shareSelectionStore.toggle(clientId)}
      style={({ pressed }) => [
        styles.button,
        selected && styles.selected,
        pressed && styles.pressed,
      ]}
      testID={`session.shareImage.checkbox.${clientId}`}
    >
      {selected ? (
        <Check
          color={colors.ctaText}
          size={iconSize.sm}
          strokeWidth={iconStroke.bold}
        />
      ) : null}
    </Pressable>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    button: {
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
