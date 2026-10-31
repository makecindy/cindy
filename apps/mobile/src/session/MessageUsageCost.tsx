import { useEffect, useState } from "react";
import {
  Pressable,
  ScrollView,
  StyleSheet,
  View,
  type StyleProp,
  type TextStyle,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  normalizeUsageCostRows,
  type UsageCostRow,
} from "@cindy/maker-shared/usage-cost-details";
import { useDeviceLink } from "@/device-link/DeviceLinkContext";
import { Text } from "@/components/AppText";
import { useThemedStyles, type ThemeColors } from "@/theme";
import { spacing, radius } from "@/theme/tokens";
import { SheetModal } from "./SheetModal";
import { UsageCostDetails } from "./UsageCostDetails";

export function MessageUsageCost({
  label,
  accessibilityLabel,
  deviceId,
  sessionId,
  clientId,
  style,
}: {
  label: string;
  accessibilityLabel: string;
  deviceId?: string;
  sessionId: string;
  clientId: string;
  style: StyleProp<TextStyle>;
}) {
  const { invoke } = useDeviceLink();
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<UsageCostRow[] | null | undefined>(
    undefined,
  );
  const styles = useThemedStyles(makeStyles);
  const insets = useSafeAreaInsets();
  useEffect(() => {
    setOpen(false);
    setRows(undefined);
  }, [deviceId, sessionId, clientId]);
  useEffect(() => {
    if (!open || !deviceId) return;
    let cancelled = false;
    void invoke<{ costBreakdown?: unknown }>(
      deviceId,
      "local-db:messages:estimatedSessionValue",
      [sessionId, { includeBreakdown: true, clientId }],
    ).then(
      (result) => {
        if (!cancelled)
          setRows(
            Array.isArray(result.costBreakdown)
              ? normalizeUsageCostRows(result.costBreakdown)
              : null,
          );
      },
      () => {
        if (!cancelled) setRows(null);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [open, deviceId, sessionId, clientId, invoke, label]);
  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        style={styles.trigger}
        onPress={() => {
          setRows(undefined);
          setOpen(true);
        }}
      >
        <Text style={style} testID="message.turnCostText">
          {label}
        </Text>
      </Pressable>
      <SheetModal
        nativePresentation
        visible={open}
        onBackdropPress={() => setOpen(false)}
        onRequestClose={() => setOpen(false)}
      >
        <View
          style={[
            styles.surface,
            { paddingBottom: Math.max(insets.bottom, spacing.lg) },
          ]}
        >
          <ScrollView>
            <UsageCostDetails rows={deviceId ? rows : null} />
          </ScrollView>
        </View>
      </SheetModal>
    </>
  );
}
const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    trigger: {
      minHeight: 44,
      minWidth: 44,
      alignItems: "center",
      justifyContent: "center",
    },
    surface: {
      maxHeight: "75%",
      padding: spacing.lg,
      borderTopLeftRadius: radius.container,
      borderTopRightRadius: radius.container,
      backgroundColor: colors.surfaceElevated,
    },
  });
