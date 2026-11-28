import { Image, StyleSheet, View } from "react-native";
import Animated from "react-native-reanimated";
import { Text } from "@/components/AppText";
import {
  fontWeight,
  radius,
  retroKeyboardMaterials,
  textStyles,
} from "@/theme";
import type { RetroDesktopSkin } from "./FoldDesktopSkin";
import type { KeyRect } from "./remoteKeyLayout";
import { retroMacArtwork } from "./retroMacArtwork";

type Pigments =
  (typeof retroKeyboardMaterials)[keyof typeof retroKeyboardMaterials];
type Printing = "oblique" | "upper-left" | "center";
const molds = {
  desktop: {
    travel: 4,
    lip: 4,
    shoulder: 2.4,
    lipRatio: 0.11,
    sideRatio: 0.06,
  },
  notebook: {
    travel: 2.5,
    lip: 2.7,
    shoulder: 1.5,
    lipRatio: 0.08,
    sideRatio: 0.045,
  },
  scissor: {
    travel: 1.5,
    lip: 1.4,
    shoulder: 0.8,
    lipRatio: 0.05,
    sideRatio: 0.03,
  },
} as const;

function makeProfile(
  material: Pigments,
  mold: keyof typeof molds,
  print: Printing,
  grain?: number,
) {
  // Build these once per material. A key press only moves the molded surfaces.
  const paint = StyleSheet.create({
    skirt: {
      // Each gradient covers one molded part. Tiling creates native replicator
      // layers and can exhaust the iOS compositor at fractional key sizes.
      experimental_backgroundRepeat: "no-repeat",
      backgroundColor: material.skirtMid,
      experimental_backgroundImage: `linear-gradient(180deg, ${material.skirtLight} 0%, ${material.skirtMid} 78%, ${material.faceShade} 90%, ${material.skirtShade} 100%)`,
      borderTopColor: material.skirtLight,
      borderLeftColor: material.skirtMid,
      borderRightColor: material.skirtShade,
      borderBottomColor: material.skirtFoot,
    },
    face: {
      experimental_backgroundRepeat: "no-repeat",
      backgroundColor: material.face,
      experimental_backgroundImage:
        mold === "scissor"
          ? `linear-gradient(165deg, ${material.faceLight} 0%, ${material.face} 43%, ${material.faceShade} 100%)`
          : `radial-gradient(ellipse at 43% 36%, ${material.faceShade} 0%, ${material.face} 57%, ${material.faceLight} 82%, ${material.face} 100%)`,
      borderTopColor: material.faceLight,
    },
    spacebar: {
      experimental_backgroundImage: `linear-gradient(180deg, ${material.faceLight} 0%, ${material.face} 56%, ${material.faceShade} 100%)`,
    },
    modifierTint: {
      ...StyleSheet.absoluteFill,
      backgroundColor: material.modifierTint,
    },
    ridge: {
      backgroundColor: material.faceLight,
      borderBottomColor: material.skirtShade,
    },
    ink: { color: material.ink },
    secondaryInk: { color: material.secondaryInk },
  });
  return { ...molds[mold], material, print, grain, paint };
}

export type RetroKeycapProfile = ReturnType<typeof makeProfile>;

const ivory = makeProfile(
  retroKeyboardMaterials.ivory,
  "desktop",
  "oblique",
  retroMacArtwork.keycap,
);
export const retroKeycaps = {
  classic: ivory,
  compact: ivory,
  edge: ivory,
  macii: makeProfile(
    retroKeyboardMaterials.platinum,
    "desktop",
    "oblique",
    retroMacArtwork.keycap,
  ),
  powerbook: makeProfile(
    retroKeyboardMaterials.powerbook,
    "notebook",
    "oblique",
    retroMacArtwork.darkKeycap,
  ),
  thinkpad: makeProfile(
    retroKeyboardMaterials.thinkpad,
    "notebook",
    "upper-left",
    retroMacArtwork.darkKeycap,
  ),
  iceblue: makeProfile(
    retroKeyboardMaterials.iceblue,
    "notebook",
    "oblique",
    retroMacArtwork.iceKeycap,
  ),
  macbook: makeProfile(retroKeyboardMaterials.macbook, "scissor", "center"),
} satisfies Record<RetroDesktopSkin, RetroKeycapProfile>;

export function RetroKeycap({
  profile,
  rect,
  legend,
  shifted,
  depressed,
  travelDuration,
}: {
  profile: RetroKeycapProfile;
  rect: KeyRect;
  legend?: string;
  shifted?: string;
  depressed: boolean;
  travelDuration: number;
}) {
  // Keep the accessible key and its touch identity while the deck is measured.
  if (rect.width <= 1 || rect.height <= 1) return null;
  const { paint, print } = profile;
  // Tooling dimensions follow key height, including on the six-unit spacebar.
  const side = Math.min(profile.shoulder, rect.height * profile.sideRatio);
  const lip = Math.min(profile.lip, rect.height * profile.lipRatio);
  const compact = rect.width < 26 || rect.height < 24;
  const margin = compact
    ? 1
    : Math.min(6, rect.width * 0.15, rect.height * 0.15);
  const word = (legend?.length ?? 0) > 1;
  const letter = rect.id.startsWith("Key");
  const centered =
    compact ||
    rect.id.startsWith("Arrow") ||
    legend === "⌘" ||
    rect.id === "Backspace";
  const modifier = word || rect.id === "MetaLeft" || rect.id === "Backspace";

  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      <Animated.View
        style={[
          styles.skirt,
          paint.skirt,
          {
            bottom: depressed ? Math.max(0, lip - 0.8) : 0,
            transitionProperty: "bottom",
            transitionDuration: travelDuration,
            transitionTimingFunction: "ease-out",
          },
        ]}
      />
      <View
        style={[
          styles.face,
          paint.face,
          rect.id === "Space" && paint.spacebar,
          {
            left: side,
            right: side,
            top: StyleSheet.hairlineWidth,
            bottom: lip,
          },
        ]}
      >
        {profile.grain != null && (
          <Image
            source={profile.grain}
            resizeMode="cover"
            style={styles.satin}
          />
        )}
        {modifier && profile.material.modifierTint !== "transparent" && (
          <View style={paint.modifierTint} />
        )}
        {legend ? (
          <View
            style={[
              styles.print,
              { paddingHorizontal: margin, paddingVertical: compact ? 0 : 1 },
              letter && print === "oblique" && !compact && styles.obliquePrint,
              letter && print === "center" && styles.centerPrint,
              letter &&
                print === "upper-left" &&
                !compact && { paddingTop: margin },
              (word || Boolean(shifted)) && styles.lowerPrint,
              rect.id === "Enter" && styles.rightPrint,
              centered && styles.centerPrint,
            ]}
          >
            <Text
              numberOfLines={1}
              adjustsFontSizeToFit
              minimumFontScale={0.65}
              style={[
                word ? styles.word : styles.symbol,
                letter && print === "oblique" && styles.oblique,
                paint.ink,
              ]}
            >
              {word && print !== "upper-left" ? legend.toLowerCase() : legend}
            </Text>
          </View>
        ) : null}
        {shifted && !compact && (
          <Text
            numberOfLines={1}
            style={[styles.alternate, paint.secondaryInk, { right: margin }]}
          >
            {shifted}
          </Text>
        )}
        {!compact && (rect.code === "KeyF" || rect.code === "KeyJ") && (
          <View style={[styles.ridge, paint.ridge]} />
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  skirt: {
    ...StyleSheet.absoluteFill,
    borderRadius: radius.micro,
    borderWidth: StyleSheet.hairlineWidth,
  },
  face: {
    position: "absolute",
    overflow: "hidden",
    borderRadius: radius.micro,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  // Only sample the unprinted center. Sidewalls and bevels remain continuous at any width.
  satin: {
    position: "absolute",
    top: "-18%",
    left: "-18%",
    width: "136%",
    height: "136%",
    opacity: 0.25,
  },
  print: { ...StyleSheet.absoluteFill, alignItems: "flex-start" },
  obliquePrint: {
    justifyContent: "center",
    alignItems: "center",
    transform: [{ translateX: -2 }, { translateY: -2 }],
  },
  lowerPrint: { justifyContent: "flex-end" },
  rightPrint: { alignItems: "flex-end" },
  centerPrint: { alignItems: "center", justifyContent: "center" },
  symbol: { ...textStyles.footnote, fontWeight: fontWeight.regular },
  oblique: { fontStyle: "italic" },
  word: { ...textStyles.micro, fontWeight: fontWeight.regular },
  alternate: {
    position: "absolute",
    top: 0,
    ...textStyles.micro,
    fontWeight: fontWeight.regular,
  },
  ridge: {
    position: "absolute",
    alignSelf: "center",
    bottom: 3,
    width: 7,
    height: 1.5,
    borderRadius: radius.pill,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
});
