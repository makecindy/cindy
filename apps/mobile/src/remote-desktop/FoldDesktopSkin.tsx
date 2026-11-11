import { useRef, useState } from "react";
import { Image, Pressable, StyleSheet, View } from "react-native";
import { useTranslation } from "react-i18next";
import { Text } from "@/components/AppText";
import {
  fontWeight,
  lineHeight,
  monoFont,
  spacing,
  typeScale,
  useTheme,
  lightColors,
  darkColors,
  radius,
} from "@/theme";
import type { LayoutRect } from "@/platform/windowGeometry";
import { retroMacArtwork } from "./retroMacArtwork";
import { FoldTouchpad } from "./FoldTouchpad";
import { RemoteKeySurface } from "./RemoteKeySurface";
import {
  CONTROL_ASPECT,
  DECK_RAIL,
  WELL_PADDING,
  deckWell,
  retroDeckLayout,
} from "./retroDeckLayout";
import type { KeyRect } from "./remoteKeyLayout";

export const FOLD_DESKTOP_SKINS = [
  "classic",
  "compact",
  "edge",
  "macii",
  "powerbook",
  "thinkpad",
  "macbook",
  "modern",
  "keyboard",
] as const;
export type FoldDesktopSkin = (typeof FOLD_DESKTOP_SKINS)[number];
export type RetroDesktopSkin = Exclude<FoldDesktopSkin, "modern" | "keyboard">;
export const DEFAULT_FOLD_DESKTOP_SKIN: FoldDesktopSkin = "keyboard";
export function foldDesktopSkinColors(skin: FoldDesktopSkin) {
  return skin === "powerbook" || skin === "thinkpad" ? darkColors : lightColors;
}
function heritageDisplay(skin: FoldDesktopSkin) {
  return skin === "macii" || skin === "powerbook" || skin === "thinkpad"
    ? retroMacArtwork.displays[skin]
    : null;
}
function deckArtwork(skin: RetroDesktopSkin) {
  return skin === "macii" || skin === "powerbook" || skin === "thinkpad"
    ? retroMacArtwork.decks[skin]
    : retroMacArtwork.decks.classic;
}
/** Resizes artwork around one opening, so its edges keep their proportion. */
function SlicedArtwork({
  source,
  opening,
  size,
  target,
}: {
  source: number;
  opening: LayoutRect;
  size: { width: number; height: number };
  target: LayoutRect;
}) {
  const sourceX = [0, opening.x, opening.x + opening.width, 1];
  const sourceY = [0, opening.y, opening.y + opening.height, 1];
  const targetX = [0, target.x, target.x + target.width, size.width];
  const targetY = [0, target.y, target.y + target.height, size.height];
  return (
    <>
      {[0, 1, 2].flatMap((row) =>
        [0, 1, 2].map((column) => {
          const width = targetX[column + 1] - targetX[column];
          const height = targetY[row + 1] - targetY[row];
          if (width <= 0 || height <= 0) return null;
          const imageWidth = width / (sourceX[column + 1] - sourceX[column]);
          const imageHeight = height / (sourceY[row + 1] - sourceY[row]);
          return (
            <View
              key={`${row}-${column}`}
              style={{
                position: "absolute",
                left: targetX[column],
                top: targetY[row],
                width,
                height,
                overflow: "hidden",
              }}
            >
              <Image
                source={source}
                resizeMode="stretch"
                style={{
                  position: "absolute",
                  left: -sourceX[column] * imageWidth,
                  top: -sourceY[row] * imageHeight,
                  width: imageWidth,
                  height: imageHeight,
                }}
              />
            </View>
          );
        }),
      )}
    </>
  );
}
const VIEWPORTS = {
  macbook: { x: 0, y: 0, width: 1, height: 1 },
  macii: { x: 0.072, y: 0.082, width: 0.856, height: 0.73 },
  powerbook: { x: 0.08, y: 0.11, width: 0.84, height: 0.765 },
  thinkpad: { x: 0.07, y: 0.107, width: 0.86, height: 0.805 },
  // Measured inner glass edges in the 1536×1024 sources, including their
  // antialiased transition. An inset inside the black glass leaves a second
  // black frame in the case slices, outside the live desktop.
  classic: {
    x: 170 / 1536,
    y: 144 / 1024,
    width: 1197 / 1536,
    height: 617 / 1024,
  },
  compact: {
    x: 70 / 1536,
    y: 67 / 1024,
    width: 1398 / 1536,
    height: 781 / 1024,
  },
  edge: { x: 67 / 1536, y: 68 / 1024, width: 1404 / 1536, height: 886 / 1024 },
};
// Source openings describe the artwork; target openings reserve less case area
// without cropping away the original shell, badge or floppy slot.
const EXPANDED_VIEWPORTS = {
  classic: { x: 0.065, y: 0.08, width: 0.87, height: 0.76 },
  compact: { x: 0.04, y: 0.065, width: 0.92, height: 0.8 },
  edge: { x: 0.025, y: 0.05, width: 0.95, height: 0.9 },
};
function adjacentSkin(
  skin: FoldDesktopSkin,
  direction: number,
): FoldDesktopSkin {
  const i = FOLD_DESKTOP_SKINS.indexOf(skin);
  return FOLD_DESKTOP_SKINS[
    (i + direction + FOLD_DESKTOP_SKINS.length) % FOLD_DESKTOP_SKINS.length
  ];
}

// Keep the opening at the MacBook proportions tuned on Duo. Host displays with
// different ratios are fitted inside it by the viewer, without moving the case.
const MACBOOK_DISPLAY_ASPECT = 1.54;

/** CRTs follow their glass opening; MacBook has a fixed, top-aligned opening. */
export function retroDesktopViewport(
  region: LayoutRect,
  skin: RetroDesktopSkin = "classic",
  safeRegion: LayoutRect = region,
  aspectRatio?: number,
): LayoutRect {
  // Video runs behind the system status area and floating controls. Applying
  // safe insets here creates a black header above the desktop on Duo.
  if (skin === "macbook") {
    return {
      ...region,
      height: Math.min(region.height, region.width / MACBOOK_DISPLAY_ASPECT),
    };
  }
  const inset =
    skin === "classic" || skin === "compact" || skin === "edge"
      ? EXPANDED_VIEWPORTS[skin]
      : VIEWPORTS[skin];
  const x = Math.max(safeRegion.x, region.x + region.width * inset.x);
  const y = Math.max(safeRegion.y, region.y + region.height * inset.y);
  const available = {
    x,
    y,
    width: Math.max(
      0,
      Math.min(
        safeRegion.x + safeRegion.width,
        region.x + region.width * (inset.x + inset.width),
      ) - x,
    ),
    height: Math.max(
      0,
      Math.min(
        safeRegion.y + safeRegion.height,
        region.y + region.height * (inset.y + inset.height),
      ) - y,
    ),
  };
  if (!aspectRatio || !Number.isFinite(aspectRatio) || aspectRatio <= 0)
    return available;
  const width = Math.min(available.width, available.height * aspectRatio);
  const height = width / aspectRatio;
  return {
    x: available.x + (available.width - width) / 2,
    y: available.y + (available.height - height) / 2,
    width,
    height,
  };
}

/** A non-interactive case around the live desktop; it never replaces the viewer. */
export function FoldDesktopBezel({
  region,
  skin = "classic",
  viewport,
}: {
  region: LayoutRect;
  skin?: RetroDesktopSkin;
  viewport?: LayoutRect | null;
}) {
  if (skin === "macbook") {
    return (
      <>
        <View
          pointerEvents="none"
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          testID="remoteDesktop.macbookBezel"
          style={{
            position: "absolute",
            left: region.x,
            top: region.y,
            width: region.width,
            height: region.height,
            backgroundColor: lightColors.surfaceChip,
          }}
        />
        {viewport && (
          <View
            pointerEvents="none"
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            style={{
              position: "absolute",
              // Draw above the lower case so the shadow can cross the fold
              // seam without being cut off by the deck's opaque background.
              zIndex: 1,
              left: viewport.x,
              top: viewport.y + viewport.height,
              width: viewport.width,
              height: 20,
              backgroundColor: darkColors.surface,
              shadowColor: darkColors.surface,
              shadowOffset: { width: 0, height: 9 },
              shadowOpacity: 0.38,
              shadowRadius: 12,
            }}
          />
        )}
      </>
    );
  }
  const source =
    skin === "compact" || skin === "edge"
      ? retroMacArtwork[skin]
      : (heritageDisplay(skin) ?? retroMacArtwork.display);
  const opening = VIEWPORTS[skin];
  return (
    <View
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      testID="remoteDesktop.retroBezel"
      style={[
        { position: "absolute" },
        {
          left: region.x,
          top: region.y,
          width: region.width,
          height: region.height,
        },
      ]}
    >
      {/* Resize the original case around the very same opening used by the viewer. */}
      {viewport ? (
        <SlicedArtwork
          source={source}
          opening={opening}
          size={region}
          target={{
            x: viewport.x - region.x,
            y: viewport.y - region.y,
            width: viewport.width,
            height: viewport.height,
          }}
        />
      ) : (
        <Image source={source} resizeMode="stretch" style={styles.artwork} />
      )}
    </View>
  );
}

/** A dedicated swipe rail keeps skin navigation out of the remote pointer gesture. */
export function FoldDesktopSkinSwitch({
  skin,
  onChange,
}: {
  skin: FoldDesktopSkin;
  onChange(value: FoldDesktopSkin): void;
}) {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const retro = skin !== "modern" && skin !== "keyboard";
  const start = useRef<{ x: number; y: number } | null>(null);
  return (
    <View
      testID="remoteDesktop.skinSwipe"
      onStartShouldSetResponderCapture={(e) => {
        start.current = { x: e.nativeEvent.pageX, y: e.nativeEvent.pageY };
        return false;
      }}
      onMoveShouldSetResponderCapture={(e) => {
        if (!start.current) return false;
        const dx = e.nativeEvent.pageX - start.current.x,
          dy = e.nativeEvent.pageY - start.current.y;
        return Math.abs(dx) >= 12 && Math.abs(dx) > Math.abs(dy) * 1.5;
      }}
      onStartShouldSetResponder={() => true}
      onResponderGrant={(e) => {
        start.current ??= { x: e.nativeEvent.pageX, y: e.nativeEvent.pageY };
      }}
      onResponderRelease={(e) => {
        const origin = start.current;
        start.current = null;
        if (!origin) return;
        const dx = e.nativeEvent.pageX - origin.x,
          dy = e.nativeEvent.pageY - origin.y;
        if (Math.abs(dx) >= 48 && Math.abs(dx) > Math.abs(dy) * 1.5)
          onChange(adjacentSkin(skin, dx < 0 ? 1 : -1));
      }}
      onResponderTerminate={() => {
        start.current = null;
      }}
      style={styles.switchRail}
    >
      <Pressable
        testID="remoteDesktop.skinSwitch"
        accessibilityRole="button"
        accessibilityLabel={t("remoteDesktop.nextSkin")}
        accessibilityValue={{ text: t(`remoteDesktop.skin_${skin}`) }}
        accessibilityHint={t("remoteDesktop.skinSwipeHint")}
        onPress={() => onChange(adjacentSkin(skin, 1))}
        style={styles.switchButton}
      >
        <Text
          style={[
            styles.legend,
            {
              color: retro
                ? foldDesktopSkinColors(skin).textSecondary
                : colors.textTertiary,
            },
          ]}
        >
          {t(`remoteDesktop.skin_${skin}`)}
          {`  ‹  ${FOLD_DESKTOP_SKINS.indexOf(skin) + 1} / ${FOLD_DESKTOP_SKINS.length}  ›`}
        </Text>
      </Pressable>
    </View>
  );
}

/** Hardware keeps its historical material in either theme; its palmrest is a larger invisible input surface. */
export function FoldDesktopDeck({
  keys,
  skin,
  onChange,
  safeInsets = { top: 0, bottom: 0, left: 0, right: 0 },
  bottomReserve = 0,
}: {
  keys: Omit<
    Parameters<typeof RemoteKeySurface>[0],
    | "compact"
    | "mode"
    | "strip"
    | "palette"
    | "renderKeycap"
    | "renderOverlay"
    | "testID"
    | "onInputMethod"
  >;
  skin: RetroDesktopSkin;
  onChange(value: FoldDesktopSkin): void;
  safeInsets?: { top: number; bottom: number; left: number; right: number };
  bottomReserve?: number;
}) {
  const { send, enabled } = keys;
  const palette = foldDesktopSkinColors(skin);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const artwork = deckArtwork(skin);
  const { well, control } = retroDeckLayout(
    size,
    skin,
    safeInsets,
    bottomReserve,
  );
  const aspect =
    CONTROL_ASPECT[
      skin === "macii" || skin === "powerbook" || skin === "thinkpad"
        ? skin
        : "classic"
    ];
  const controlHeight = Math.min(
    control.height - 8,
    skin === "thinkpad" ? 24 : 56,
  );
  if (skin === "macbook")
    return (
      <View
        testID="remoteDesktop.retroDeck"
        style={{ flex: 1, backgroundColor: lightColors.surfaceChip }}
      >
        <View
          style={{
            paddingTop: safeInsets.top,
            paddingLeft: safeInsets.left,
            paddingRight: safeInsets.right,
          }}
        >
          <FoldDesktopSkinSwitch skin={skin} onChange={onChange} />
        </View>
        <View
          style={{
            flex: 1,
            minHeight: 0,
            paddingLeft: safeInsets.left,
            paddingRight: safeInsets.right,
          }}
        >
          <View
            style={[
              {
                flex: 1,
                minHeight: 0,
                marginHorizontal: "4%",
                marginBottom: 6,
              },
              styles.macbookKeywell,
            ]}
          >
            <RemoteKeySurface
              {...keys}
              key={skin}
              testID="remoteDesktop.retroKeys"
              mode="classic"
              palette={darkColors}
              renderKeycap={(rect) => (
                <FoldDesktopKeycap
                  skin={skin}
                  wide={rect.width > rect.height * 1.3}
                />
              )}
            />
          </View>
          <View style={{ height: 110 + safeInsets.bottom + bottomReserve }}>
            <View
              testID="remoteDesktop.palmrest"
              style={[
                StyleSheet.absoluteFill,
                styles.macbookTouchpad,
                { bottom: safeInsets.bottom + bottomReserve + spacing.sm },
              ]}
            >
              <FoldTouchpad send={send} enabled={enabled} bare />
            </View>
          </View>
        </View>
      </View>
    );
  return (
    <View
      testID="remoteDesktop.retroDeck"
      onLayout={({ nativeEvent: { layout } }) =>
        setSize({ width: layout.width, height: layout.height })
      }
      style={{
        flex: 1,
        overflow: "hidden",
        backgroundColor: palette.surface,
      }}
    >
      <View pointerEvents="none" style={StyleSheet.absoluteFill}>
        <SlicedArtwork
          source={artwork.deck}
          opening={deckWell(skin)}
          size={size}
          target={well}
        />
      </View>
      <View
        pointerEvents="none"
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          top: control.y,
          height: control.height,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Image
          source={artwork.control}
          resizeMode="contain"
          style={{
            width: Math.max(0, controlHeight) * aspect,
            height: Math.max(0, controlHeight),
          }}
        />
      </View>
      <View
        testID="remoteDesktop.palmrest"
        style={{
          position: "absolute",
          left: safeInsets.left,
          right: safeInsets.right,
          top: control.y,
          height: control.height,
        }}
      >
        <FoldTouchpad send={send} enabled={enabled} bare />
      </View>
      <View
        style={{
          position: "absolute",
          left: well.x + WELL_PADDING,
          top: well.y + WELL_PADDING,
          width: Math.max(0, well.width - WELL_PADDING * 2),
          height: Math.max(0, well.height - WELL_PADDING * 2),
        }}
      >
        <RemoteKeySurface
          // A new skin starts clean: locked modifiers must not carry across.
          key={skin}
          {...keys}
          testID="remoteDesktop.retroKeys"
          mode="classic"
          palette={palette}
          renderKeycap={(rect) => (
            <FoldDesktopKeycap
              skin={skin}
              wide={rect.width > rect.height * 1.3}
            />
          )}
          renderOverlay={
            skin === "thinkpad"
              ? (rects) => <Trackpoint rects={rects} />
              : undefined
          }
        />
      </View>
      {/* Last, so a swipe on the rail stays clear of the keys below it. */}
      <View
        style={{
          position: "absolute",
          left: safeInsets.left,
          right: safeInsets.right,
          top: safeInsets.top,
          height: DECK_RAIL,
        }}
      >
        <FoldDesktopSkinSwitch skin={skin} onChange={onChange} />
      </View>
    </View>
  );
}

/** Sits where the G, H and B keys meet, as on the original keyboard. */
function Trackpoint({ rects }: { rects: KeyRect[] }) {
  const g = rects.find((rect) => rect.id === "KeyG");
  if (!g) return null;
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{
        position: "absolute",
        left: g.x + g.width - 9,
        top: g.y + g.height - 7,
        width: 18,
        height: 18,
      }}
    >
      <Image
        source={retroMacArtwork.trackpoint}
        style={styles.artwork}
        resizeMode="contain"
      />
    </View>
  );
}

/** The near edge faces the seated user; modern scissor keys have less travel. */
export function foldDesktopKeyDepth(skin: FoldDesktopSkin) {
  return skin === "macbook" ? 3 : 7;
}

export function FoldDesktopKeycap({
  skin = "classic",
  wide = false,
}: {
  skin?: FoldDesktopSkin;
  wide?: boolean;
}) {
  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      {/* Retro textures already contain the front wall and bevel. Drawing
          them again underneath creates two stacked keys, not extra depth. */}
      {skin === "macbook" && (
        <View style={[StyleSheet.absoluteFill, styles.keycapFront]} />
      )}
      <View
        style={[
          StyleSheet.absoluteFill,
          styles.keycapTop,
          { bottom: skin === "macbook" ? foldDesktopKeyDepth(skin) : 0 },
        ]}
      >
        <FoldDesktopKeyArtwork skin={skin} wide={wide} />
      </View>
    </View>
  );
}

function FoldDesktopKeyArtwork({
  skin = "classic",
  wide = false,
}: {
  skin?: FoldDesktopSkin;
  wide?: boolean;
}) {
  if (skin === "macbook") {
    return (
      <View
        pointerEvents="none"
        style={[StyleSheet.absoluteFill, styles.macbookKeycap]}
      />
    );
  }
  const source =
    skin === "powerbook" || skin === "thinkpad"
      ? retroMacArtwork.darkKeycap
      : retroMacArtwork.keycap;
  if (!wide)
    return (
      <View pointerEvents="none" style={StyleSheet.absoluteFill}>
        <Image source={source} resizeMode="stretch" style={styles.artwork} />
      </View>
    );
  return (
    <View
      pointerEvents="none"
      style={[StyleSheet.absoluteFill, { flexDirection: "row" }]}
    >
      {/* Scale both ends with key height; only the flat middle grows in width.
          A spacebar must not turn the square key's bevel into a wide wedge. */}
      <View style={styles.keycapEnd}>
        <Image
          source={source}
          resizeMode="stretch"
          style={{
            position: "absolute",
            left: 0,
            top: 0,
            width: "400%",
            height: "100%",
          }}
        />
      </View>
      <View style={{ flex: 1, overflow: "hidden" }}>
        <Image
          source={source}
          resizeMode="stretch"
          style={{
            position: "absolute",
            left: "-50%",
            top: 0,
            width: "200%",
            height: "100%",
          }}
        />
      </View>
      <View style={styles.keycapEnd}>
        <Image
          source={source}
          resizeMode="stretch"
          style={{
            position: "absolute",
            right: 0,
            top: 0,
            width: "400%",
            height: "100%",
          }}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  keycapFront: {
    top: 3,
    bottom: 1,
    borderRadius: radius.micro,
    borderBottomWidth: 1,
    backgroundColor: darkColors.border,
    borderBottomColor: darkColors.surface,
  },
  keycapTop: {
    // Only the material tilts. The full cell remains the touch target, so
    // adjacent keys never overlap and a held modifier keeps its own finger.
    transform: [{ perspective: 220 }, { rotateX: "12deg" }],
  },
  macbookKeywell: {
    backgroundColor: lightColors.textSecondary,
    borderRadius: radius.control,
    padding: 3,
  },
  macbookKeycap: {
    backgroundColor: darkColors.surfaceElevated,
    borderColor: darkColors.border,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.micro,
  },
  macbookTouchpad: {
    left: "23%",
    right: "23%",
    top: 6,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: lightColors.borderStrong,
    borderRadius: radius.control,
    backgroundColor: lightColors.surfaceListExpanded,
  },
  darkDeckArtwork: { left: "-2%", width: "104%" },
  keycapEnd: { height: "100%", aspectRatio: 0.25, overflow: "hidden" },
  // Native Image keeps its asset's intrinsic size unless both dimensions are
  // explicit; absoluteFill alone does not constrain a bundled bitmap.
  artwork: { ...StyleSheet.absoluteFill, width: "100%", height: "100%" },
  legend: {
    fontFamily: monoFont,
    fontSize: typeScale.caption,
    lineHeight: lineHeight.caption,
    fontWeight: fontWeight.regular,
  },
  switchRail: { minHeight: 44, alignItems: "center", justifyContent: "center" },
  switchButton: {
    minHeight: 44,
    paddingHorizontal: spacing.lg,
    justifyContent: "center",
  },
});
