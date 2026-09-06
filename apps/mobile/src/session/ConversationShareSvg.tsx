import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { Image as NativeImage, Platform, StyleSheet, View } from "react-native";
import Svg, {
  ClipPath,
  Defs,
  Image as SvgImage,
  Rect,
  Text as SvgText,
  TSpan,
} from "react-native-svg";

import type {
  ConversationShareMessage,
  ConversationShareWebViewColors,
} from "@/session/conversationShareWebViewHtml";
import { createConversationShareAssetGate } from "@/session/conversationShareAssetGate";
import {
  buildConversationShareSvgLayout,
  conversationShareSvgRenderSize,
  type ConversationShareSvgBubble,
} from "@/session/conversationShareSvgLayout";
import { typeScale } from "@/theme";

export interface ConversationShareSvgHandle {
  exportPng(): Promise<string>;
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
const shareCharacterAsset = require("../../assets/share/cindy-share-character.jpg");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const shareLogoLightAsset = require("../../assets/login/login-wordmark.png");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const shareLogoDarkAsset = require("../../assets/login/login-wordmark-dark.png");
const SHARE_CHARACTER_SIZE = 22;
const SHARE_LOGO_HEIGHT = 18;
const SHARE_LOCKUP_GAP = 6;
const SHARE_EXPORT_TIMEOUT_MS = 20_000;
// Leave time within the existing export deadline for fallback layout + capture.
const SHARE_DECODE_TIMEOUT_MS = 15_000;
// Export-card geometry: this is a 1px bubble border in the SVG coordinate
// system, not a Lucide icon stroke (whose thinnest token is intentionally 1.75).
const SHARE_BUBBLE_STROKE_WIDTH = 1;

export const ConversationShareSvg = forwardRef<
  ConversationShareSvgHandle,
  {
    allShareableIds: readonly string[];
    colors: ConversationShareWebViewColors;
    messages: readonly ConversationShareMessage[];
    width: number;
  }
>(function ConversationShareSvg(
  { allShareableIds, colors, messages, width },
  ref,
) {
  const svgRef = useRef<Svg | null>(null);
  const [imageKeysByUri] = useState(() => {
    const original = buildConversationShareSvgLayout({
      allShareableIds,
      colors,
      messages,
      width,
    });
    const keys = new Map<string, string[]>();
    original.images.forEach((image, index) => {
      const occurrences = keys.get(image.uri) ?? [];
      occurrences.push(`image-${index}`);
      keys.set(image.uri, occurrences);
    });
    return keys;
  });
  const [assetGate] = useState(() =>
    createConversationShareAssetGate([
      "character",
      "logo",
      ...Array.from(imageKeysByUri.values()).flat(),
    ]),
  );
  const [readyAssets, setReadyAssets] = useState<ReadonlySet<string> | null>(
    null,
  );
  const captureMessages = useMemo(
    () =>
      readyAssets
        ? messages.map((message) => ({
            ...message,
            images: new Map(
              Array.from(message.images ?? []).filter(([, image]) =>
                imageKeysByUri
                  .get(image.uri)
                  ?.every((key) => readyAssets.has(key)),
              ),
            ),
          }))
        : messages,
    [imageKeysByUri, messages, readyAssets],
  );
  const layout = useMemo(
    () =>
      buildConversationShareSvgLayout({
        allShareableIds,
        colors,
        messages: captureMessages,
        width,
      }),
    [allShareableIds, colors, captureMessages, width],
  );
  // Removing a failed URI must not remount already decoded SVG occurrences.
  const keyedImages = useMemo(() => {
    const occurrences = new Map<string, number>();
    return layout.images.map((image) => {
      const occurrence = occurrences.get(image.uri) ?? 0;
      occurrences.set(image.uri, occurrence + 1);
      return { ...image, key: imageKeysByUri.get(image.uri)![occurrence]! };
    });
  }, [imageKeysByUri, layout.images]);
  const renderSize = useMemo(
    () => conversationShareSvgRenderSize(layout),
    [layout],
  );
  const logoAsset = colors.dark ? shareLogoDarkAsset : shareLogoLightAsset;
  // The screen keys this component by prepared snapshot + theme.
  const exportJob = useRef<{
    promise: Promise<string>;
    cancel(): void;
    capture(sourceTooLarge: boolean): void;
  } | null>(null);
  useEffect(() => () => exportJob.current?.cancel(), []);
  const logoSource = NativeImage.resolveAssetSource(logoAsset);
  const logoWidth = (SHARE_LOGO_HEIGHT * logoSource.width) / logoSource.height;
  const lockupWidth = SHARE_CHARACTER_SIZE + SHARE_LOCKUP_GAP + logoWidth;
  const lockupX = (layout.width - lockupWidth) / 2;

  useImperativeHandle(
    ref,
    () => ({
      exportPng() {
        if (exportJob.current) return exportJob.current.promise;
        if (renderSize.sourceTooLarge) {
          return Promise.reject(
            new Error("conversation share content is too large"),
          );
        }
        let capture = (_sourceTooLarge: boolean) => {};
        let cancel = () => {};
        const promise = new Promise<string>((resolve, reject) => {
          let phase: "decoding" | "layout" | "capturing" | "settled" =
            "decoding";
          const finish = (error?: Error, base64?: string) => {
            if (phase === "settled") return;
            phase = "settled";
            clearTimeout(timer);
            clearTimeout(decodeTimer);
            assetGate.finish();
            if (error) reject(error);
            else resolve(base64!);
          };
          const timer = setTimeout(() => {
            finish(new Error("conversation share svg export timed out"));
          }, SHARE_EXPORT_TIMEOUT_MS);
          const prepareCapture = () => {
            if (phase !== "decoding") return;
            phase = "layout";
            clearTimeout(decodeTimer);
            const ready = assetGate.finish();
            if (!ready.has("character") || !ready.has("logo")) {
              finish(new Error("conversation share footer is unavailable"));
              return;
            }
            setReadyAssets(ready);
          };
          const decodeTimer = setTimeout(
            prepareCapture,
            SHARE_DECODE_TIMEOUT_MS,
          );
          void assetGate.waitUntilSettled().then(prepareCapture);
          cancel = () =>
            finish(new Error("conversation share svg export cancelled"));
          capture = (sourceTooLarge) => {
            if (phase !== "layout") return;
            phase = "capturing";
            if (sourceTooLarge) {
              finish(new Error("conversation share content is too large"));
              return;
            }
            const svg = svgRef.current;
            if (!svg) {
              finish(
                new Error("conversation share svg renderer is unavailable"),
              );
              return;
            }
            try {
              svg.toDataURL((base64) => {
                if (phase === "settled") return;
                if (!base64) {
                  finish(new Error("conversation share svg export was empty"));
                  return;
                }
                finish(undefined, base64);
              });
            } catch (error) {
              finish(error instanceof Error ? error : new Error(String(error)));
            }
          };
        });
        exportJob.current = { promise, cancel, capture };
        return promise;
      },
    }),
    [assetGate, renderSize.sourceTooLarge],
  );

  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      pointerEvents="none"
      style={[
        styles.hidden,
        { height: renderSize.height, width: renderSize.width },
      ]}
    >
      {Platform.OS === "android" && !renderSize.sourceTooLarge
        ? [
            { source: shareCharacterAsset, keys: ["character"] },
            { source: logoAsset, keys: ["logo"] },
            ...Array.from(imageKeysByUri, ([uri, keys]) => ({
              source: { uri },
              keys,
            })),
          ].map(({ source, keys }) => (
            <NativeImage
              key={keys[0]}
              source={source}
              resizeMethod="none"
              fadeDuration={0}
              style={styles.decodeProbe}
              onLoad={() => {
                // Bundled footer bitmaps are held by this mounted view.
                // Release Android may resolve them to resource names, which the
                // URI-only queryCache API cannot look up as native res:/ IDs.
                if (keys[0] === "character" || keys[0] === "logo") {
                  keys.forEach(assetGate.markReady);
                  return;
                }
                // Android SVG cache hits do not emit onLoad. This mounted Image
                // holds the same unresized Fresco bitmap; encoded/disk cache alone
                // is insufficient, including when Fresco refuses a large bitmap.
                const uri = NativeImage.resolveAssetSource(source).uri;
                const cached = NativeImage.queryCache?.([uri]);
                if (!cached) {
                  keys.forEach(assetGate.markFailed);
                  return;
                }
                void cached.then(
                  (cache) => {
                    const mark = cache[uri]?.includes("memory")
                      ? assetGate.markReady
                      : assetGate.markFailed;
                    keys.forEach(mark);
                  },
                  () => keys.forEach(assetGate.markFailed),
                );
              }}
              onError={() => keys.forEach(assetGate.markFailed)}
            />
          ))
        : null}
      <Svg
        height={renderSize.height}
        ref={svgRef}
        viewBox={`0 0 ${layout.width} ${layout.height}`}
        width={renderSize.width}
      >
        <Rect
          fill={colors.background}
          height={layout.height}
          width={layout.width}
        />
        {!renderSize.sourceTooLarge ? (
          <>
            {layout.bubbles.map((bubble, bubbleIndex) => (
              <SvgBubbleView bubble={bubble} key={`bubble-${bubbleIndex}`} />
            ))}
            {keyedImages.map((image) => (
              <SvgImage
                key={image.key}
                href={{ uri: image.uri }}
                x={image.x}
                y={image.y}
                width={image.width}
                height={image.height}
                preserveAspectRatio="xMidYMid meet"
                onLoad={() => {
                  if (Platform.OS !== "android") assetGate.markReady(image.key);
                }}
              />
            ))}
            {layout.gaps.map((gap, gapIndex) => (
              <SvgText
                fill={gap.color}
                fontFamily="Arial"
                fontSize={typeScale.body}
                key={`gap-${gapIndex}`}
                letterSpacing={4}
                textAnchor="middle"
                x={layout.width / 2}
                y={gap.y}
              >
                ⋯
              </SvgText>
            ))}
            <Defs>
              <ClipPath id="conversation-share-character-clip">
                <Rect
                  height={SHARE_CHARACTER_SIZE}
                  rx={6}
                  width={SHARE_CHARACTER_SIZE}
                  x={lockupX}
                  y={layout.footerY}
                />
              </ClipPath>
            </Defs>
            <SvgImage
              clipPath="url(#conversation-share-character-clip)"
              height={SHARE_CHARACTER_SIZE}
              href={shareCharacterAsset}
              key={`conversation-share-character-${colors.dark ? "dark" : "light"}`}
              onLoad={() => {
                if (Platform.OS !== "android") assetGate.markReady("character");
              }}
              preserveAspectRatio="xMidYMid slice"
              width={SHARE_CHARACTER_SIZE}
              x={lockupX}
              y={layout.footerY}
            />
            <SvgImage
              height={SHARE_LOGO_HEIGHT}
              href={logoAsset}
              key={`conversation-share-logo-${colors.dark ? "dark" : "light"}`}
              onLoad={() => {
                if (Platform.OS !== "android") assetGate.markReady("logo");
              }}
              preserveAspectRatio="xMinYMid meet"
              width={logoWidth}
              x={lockupX + SHARE_CHARACTER_SIZE + SHARE_LOCKUP_GAP}
              y={
                layout.footerY + (SHARE_CHARACTER_SIZE - SHARE_LOGO_HEIGHT) / 2
              }
            />
          </>
        ) : null}
      </Svg>
      {readyAssets ? (
        // A newly mounted native layout event is the commit barrier: capture
        // must see the fallback SVG, even when its outer size did not change.
        <View
          collapsable={false}
          onLayout={() => exportJob.current?.capture(renderSize.sourceTooLarge)}
          style={styles.decodeProbe}
        />
      ) : null}
    </View>
  );
});

function SvgBubbleView({ bubble }: { bubble: ConversationShareSvgBubble }) {
  return (
    <>
      {bubble.fill || bubble.stroke ? (
        <Rect
          fill={bubble.fill ?? "none"}
          height={bubble.height}
          rx={12}
          stroke={bubble.stroke}
          strokeWidth={bubble.stroke ? SHARE_BUBBLE_STROKE_WIDTH : undefined}
          width={bubble.width}
          x={bubble.x}
          y={bubble.y}
        />
      ) : null}
      {bubble.textBlocks.map((block, blockIndex) => (
        <SvgText
          fill={block.color}
          fontFamily="Arial"
          fontSize={block.fontSize}
          key={`text-${blockIndex}`}
          x={block.x}
          y={block.y}
        >
          {block.lines.map((line, lineIndex) => (
            <TSpan
              dy={lineIndex === 0 ? 0 : block.lineHeight}
              key={`line-${lineIndex}`}
              x={block.x}
            >
              {line || " "}
            </TSpan>
          ))}
        </SvgText>
      ))}
    </>
  );
}

const styles = StyleSheet.create({
  decodeProbe: { position: "absolute", width: 1, height: 1 },
  hidden: {
    left: 0,
    opacity: 0,
    position: "absolute",
    top: 0,
  },
});
