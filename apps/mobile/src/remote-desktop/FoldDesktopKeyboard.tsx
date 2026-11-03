import { type ReactNode } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { Ellipsis } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import {
  iconSize,
  iconStroke,
  radius,
  spacing,
  useTheme,
  useThemedStyles,
  type ThemeColors,
} from "@/theme";
import { FoldTouchpad } from "./FoldTouchpad";
import { RemoteKeySurface } from "./RemoteKeySurface";

type KeySurfaceProps = Omit<
  Parameters<typeof RemoteKeySurface>[0],
  "compact" | "mode" | "strip"
>;

function FoldDeckOperations({ onPress }: { onPress(): void }) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  return (
    <Pressable
      testID="remoteDesktop.foldOperations"
      accessibilityRole="button"
      accessibilityLabel={t("remoteDesktop.operations")}
      onPress={onPress}
      style={({ pressed }) => [styles.round, pressed && styles.roundPressed]}
    >
      <Ellipsis
        size={iconSize.action}
        strokeWidth={iconStroke.regular}
        color={colors.textSecondary}
      />
    </Pressable>
  );
}

const BAR_HEIGHT = 44;

/** The default tabletop deck: a full keyboard and trackpad that follow the app theme. */
export function FoldDesktopKeyboard({
  onOperations,
  clipboard,
  safeInsets,
  bottomReserve = 0,
  ...keys
}: KeySurfaceProps & {
  onOperations(): void;
  clipboard: ReactNode;
  safeInsets: { top: number; bottom: number; left: number; right: number };
  bottomReserve?: number;
}) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View
      testID="remoteDesktop.foldKeyboard"
      style={[
        styles.deck,
        {
          paddingTop: safeInsets.top + spacing.sm,
          paddingBottom: safeInsets.bottom + bottomReserve + spacing.sm,
          paddingLeft: safeInsets.left + spacing.sm,
          paddingRight: safeInsets.right + spacing.sm,
        },
        !keys.enabled && styles.disabled,
      ]}
    >
      <View style={styles.keys}>
        <RemoteKeySurface
          {...keys}
          strip={{ height: BAR_HEIGHT }}
          stripEnd={[clipboard, <FoldDeckOperations onPress={onOperations} />]}
        />
      </View>
      <View style={styles.lower}>
        <View pointerEvents="none" style={styles.pad} />
        {/* The whole palm rest moves the pointer; a thumb need not land on the visible pad. */}
        <View style={StyleSheet.absoluteFill}>
          <FoldTouchpad send={keys.send} enabled={keys.enabled} bare />
        </View>
      </View>
    </View>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    deck: {
      flex: 1,
      gap: spacing.md,
      backgroundColor: colors.surface,
    },
    keys: { flex: 68, minHeight: 0 },
    lower: {
      flex: 32,
      minHeight: 96,
      alignItems: "center",
    },
    // Close to a laptop trackpad's proportions, set by the deck height.
    pad: {
      height: "100%",
      aspectRatio: 1.9,
      maxWidth: "100%",
      borderRadius: radius.container,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.borderTranslucent,
      backgroundColor: colors.surfaceElevated,
    },
    round: {
      width: BAR_HEIGHT,
      height: BAR_HEIGHT,
      alignItems: "center",
      justifyContent: "center",
      borderRadius: radius.pill,
    },
    roundPressed: { backgroundColor: colors.surfaceChip },
    disabled: { opacity: 0.4 },
  });
