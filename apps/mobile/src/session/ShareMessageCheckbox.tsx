import { Check } from "lucide-react-native";
import { Pressable, StyleSheet, View } from "react-native";
import { useTranslation } from "react-i18next";
import { useTheme, useThemedStyles, type ThemeColors } from "@/theme";
import { iconSize, iconStroke, radius } from "@/theme/tokens";
import {
  shareSelectionStore,
  useIsMessageSelected,
} from "@/session/shareSelectionStore";

export function ShareMessageCheckbox({
  clientId,
  disabled = false,
}: {
  clientId: string;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const selected = useIsMessageSelected(clientId);

  return (
    <Pressable
      accessibilityLabel={t("session.shareImage.checkboxLabel")}
      accessibilityRole="checkbox"
      accessibilityState={{ checked: selected, disabled }}
      disabled={disabled}
      onPress={() => shareSelectionStore.toggle(clientId)}
      style={({ pressed }) => [styles.button, pressed && styles.pressed]}
      testID={`session.shareImage.checkbox.${clientId}`}
    >
      <View style={[styles.mark, selected && styles.selected]}>
        {selected ? (
          <Check
            color={colors.ctaText}
            size={iconSize.sm}
            strokeWidth={iconStroke.bold}
          />
        ) : null}
      </View>
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
