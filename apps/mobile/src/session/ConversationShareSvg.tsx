import { forwardRef, useImperativeHandle, useMemo, useRef } from "react";
import { Image as NativeImage, StyleSheet, View } from "react-native";
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
import { createConversationShareFooterAssetGate } from "@/session/conversationShareAssetGate";
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
  const layout = useMemo(
    () =>
      buildConversationShareSvgLayout({
        allShareableIds,
        colors,
        messages,
        width,
      }),
    [allShareableIds, colors, messages, width],
  );
  const renderSize = useMemo(
    () => conversationShareSvgRenderSize(layout),
    [layout],
  );
  const logoAsset = colors.dark ? shareLogoDarkAsset : shareLogoLightAsset;
  const footerAssetGate = useMemo(
    () => createConversationShareFooterAssetGate(),
    [logoAsset],
  );
  const logoSource = NativeImage.resolveAssetSource(logoAsset);
  const logoWidth = (SHARE_LOGO_HEIGHT * logoSource.width) / logoSource.height;
  const lockupWidth = SHARE_CHARACTER_SIZE + SHARE_LOCKUP_GAP + logoWidth;
  const lockupX = (layout.width - lockupWidth) / 2;

  useImperativeHandle(
    ref,
    () => ({
      exportPng() {
        if (renderSize.sourceTooLarge) {
          return Promise.reject(
            new Error("conversation share content is too large"),
          );
        }
        return new Promise<string>((resolve, reject) => {
          let settled = false;
          const fail = (error: Error) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            reject(error);
          };
          const timer = setTimeout(() => {
            fail(new Error("conversation share svg export timed out"));
          }, SHARE_EXPORT_TIMEOUT_MS);
          void footerAssetGate.waitUntilReady().then(() => {
            if (settled) return;
            const svg = svgRef.current;
            if (!svg) {
              fail(new Error("conversation share svg renderer is unavailable"));
              return;
            }
            try {
              svg.toDataURL((base64) => {
                if (settled) return;
                if (!base64) {
                  fail(new Error("conversation share svg export was empty"));
                  return;
                }
                settled = true;
                clearTimeout(timer);
                resolve(base64);
              });
            } catch (error) {
              fail(error instanceof Error ? error : new Error(String(error)));
            }
          });
        });
      },
    }),
    [footerAssetGate, renderSize.sourceTooLarge],
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
              onLoad={() => footerAssetGate.markReady("character")}
              preserveAspectRatio="xMidYMid slice"
              width={SHARE_CHARACTER_SIZE}
              x={lockupX}
              y={layout.footerY}
            />
            <SvgImage
              height={SHARE_LOGO_HEIGHT}
              href={logoAsset}
              key={`conversation-share-logo-${colors.dark ? "dark" : "light"}`}
              onLoad={() => footerAssetGate.markReady("logo")}
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
  hidden: {
    left: 0,
    opacity: 0,
    position: "absolute",
    top: 0,
  },
});
