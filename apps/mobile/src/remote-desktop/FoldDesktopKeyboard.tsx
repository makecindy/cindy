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
import { FoldDesktopSkinSwitch, type FoldDesktopSkin } from "./FoldDesktopSkin";
import { FoldTouchpad } from "./FoldTouchpad";
import { DECK_RAIL } from "./retroDeckLayout";
import { RemoteKeySurface } from "./RemoteKeySurface";

type KeySurfaceProps = Omit<
  Parameters<typeof RemoteKeySurface>[0],
  "compact" | "mode" | "strip"
>;

const MIN_TARGET = 44;
// Smallest strip the deck can get (the 96pt pad minimum on a short window), so
// the slop below always completes a 44pt target.
const STRIP_HEIGHT_FLOOR = 24;

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
      // The strip is shorter than 44pt: the whole cell is the target, and the
      // missing height reaches up into the empty lower part of the skin rail,
      // never down onto the keys.
      hitSlop={{ top: MIN_TARGET - STRIP_HEIGHT_FLOOR }}
      style={styles.target}
    >
      {({ pressed }) => (
        <View style={[styles.round, pressed && styles.roundPressed]}>
          <Ellipsis
            size={iconSize.action}
            strokeWidth={iconStroke.regular}
            color={colors.textSecondary}
          />
        </View>
      )}
    </Pressable>
  );
}

/** The default tabletop deck: a full keyboard and trackpad that follow the app theme. */
export function FoldDesktopKeyboard({
  skin,
  onSkinChange,
  onOperations,
  clipboard,
  safeInsets,
  bottomReserve = 0,
  ...keys
}: KeySurfaceProps & {
  skin: FoldDesktopSkin;
  onSkinChange(value: FoldDesktopSkin): void;
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
          paddingBottom: safeInsets.bottom + bottomReserve + spacing.sm,
          paddingLeft: safeInsets.left + spacing.sm,
          paddingRight: safeInsets.right + spacing.sm,
        },
      ]}
    >
      {/* The swipe rail covers the fold band from the seam, as the retro decks
          do below it, so the keys start just under it rather than lower. */}
      <View style={{ height: Math.max(DECK_RAIL, safeInsets.top) }}>
        <FoldDesktopSkinSwitch skin={skin} onChange={onSkinChange} />
      </View>
      <View style={[styles.body, !keys.enabled && styles.disabled]}>
        <View style={styles.keys}>
          <RemoteKeySurface
            {...keys}
            // The strip takes the shared function-row share, so it stays
            // shorter than a key row however tall the deck is.
            strip={{}}
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
    </View>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    deck: { flex: 1, backgroundColor: colors.surface },
    body: { flex: 1, minHeight: 0, gap: spacing.md },
    keys: { flex: 1, minHeight: 0 },
    // A fixed share, not flex: Yoga starts a flex item from its minHeight, so
    // `flex: 32` with a minimum handed the pad half the deck and squashed the keys.
    lower: {
      flexBasis: "32%",
      flexShrink: 0,
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
    target: { width: "100%", height: "100%", alignItems: "center" },
    // Follows the strip's height, so the pressed circle never spills onto the keys.
    round: {
      height: "100%",
      aspectRatio: 1,
      alignItems: "center",
      justifyContent: "center",
      borderRadius: radius.pill,
    },
    roundPressed: { backgroundColor: colors.surfaceChip },
    disabled: { opacity: 0.4 },
  });
