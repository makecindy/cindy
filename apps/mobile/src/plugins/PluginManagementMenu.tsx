import { Stack } from "expo-router";
import { nativeToolbarMenuItems } from "@/platform/chrome/nativeToolbarMenuItems";
import { Alert, Pressable, StyleSheet } from "react-native";
import { Settings } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import {
  NativePullDownMenu,
  usesNativePullDownMenu,
  type NativePullDownAction,
} from "@/platform/chrome/NativePullDownMenu";
import { iconSize, useTheme } from "@/theme";

export function PluginManagementMenu({
  actions,
  onAction,
  nativeToolbar = false,
}: {
  actions: NativePullDownAction[];
  nativeToolbar?: boolean;
  onAction(id: string): void;
}) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const disabled = !actions.some((action) => !action.disabled);
  if (nativeToolbar) return (
    <Stack.Toolbar placement="right">
      <Stack.Toolbar.Menu icon="gearshape" disabled={disabled}
        accessibilityLabel={t("plugins.management.manage")}>
        {nativeToolbarMenuItems(actions, onAction)}
      </Stack.Toolbar.Menu>
    </Stack.Toolbar>
  );
  return (
    <NativePullDownMenu
      actions={actions}
      onAction={onAction}
      testID="plugins.managementMenu"
    >
      <Pressable
        testID="plugins.manage"
        accessibilityRole="button"
        accessibilityLabel={t("plugins.management.manage")}
        disabled={disabled}
        style={styles.trigger}
        onPress={
          usesNativePullDownMenu()
            ? undefined
            : () =>
                Alert.alert(t("plugins.management.manage"), undefined, [
                  ...actions
                    .filter((action) => !action.disabled)
                    .map((action) => ({
                      text: action.title,
                      style: action.destructive
                        ? ("destructive" as const)
                        : ("default" as const),
                      onPress: () => onAction(action.id),
                    })),
                  { text: t("plugins.cancel"), style: "cancel" },
                ])
        }
      >
        <Settings
          size={iconSize.md}
          color={disabled ? colors.textTertiary : colors.textPrimary}
        />
      </Pressable>
    </NativePullDownMenu>
  );
}
const styles = StyleSheet.create({
  trigger: {
    width: 44,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
  },
});
