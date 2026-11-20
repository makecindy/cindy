import { useCallback, useState } from "react";
import { StyleSheet, View } from "react-native";
import { Redirect, Stack, useLocalSearchParams } from "expo-router";
import { useTranslation } from "react-i18next";
import { Text } from "@/components/AppText";
import { MOBILE_VISUAL_MOCK_ENABLED } from "@/config/env";
import { useAdaptiveWindow } from "@/platform/AdaptiveWindowContext";
import {
  FOLD_DESKTOP_SKINS,
  FoldDesktopBezel,
  FoldDesktopDeck,
  FoldDesktopSkinSwitch,
  retroDesktopViewport,
  type FoldDesktopSkin,
} from "@/remote-desktop/FoldDesktopSkin";
import { FoldDesktopKeyboard } from "@/remote-desktop/FoldDesktopKeyboard";
import { FoldTouchpad } from "@/remote-desktop/FoldTouchpad";
import { RemoteDesktopClipboardButton } from "@/remote-desktop/RemoteDesktopClipboardButton";
import {
  foldDesktopHardware,
  foldDesktopLayout,
} from "@/remote-desktop/foldDesktopLayout";
import { useTheme, spacing, typeScale, lineHeight } from "@/theme";
import type { RemoteKeyEvent } from "@/remote-desktop/remoteKeyInput";

/** Native material/input fixture, with the same window geometry and components as the viewer. */
export default function RetroSkinPreview() {
  const { skin } = useLocalSearchParams<{ skin?: string }>();
  if (!MOBILE_VISUAL_MOCK_ENABLED) return <Redirect href="/" />;
  const initialSkin =
    FOLD_DESKTOP_SKINS.find((value) => value === skin) ?? "iceblue";
  return <Preview key={initialSkin} initialSkin={initialSkin} />;
}

function Preview({ initialSkin }: { initialSkin: FoldDesktopSkin }) {
  const { t } = useTranslation();
  const geometry = useAdaptiveWindow();
  const { colors } = useTheme();
  const [skin, setSkin] = useState(initialSkin);
  const [lastKey, setLastKey] = useState("");
  // Like the real transport, keep the sender stable while key feedback rerenders.
  const send = useCallback((message: object) => {
    const event = (message as { events?: RemoteKeyEvent[] }).events?.at(-1);
    if (event?.kind === "key")
      setLastKey(`${event.code} · ${event.down ? "按下" : "松开"}`);
  }, []);
  const layout = foldDesktopLayout(geometry, 0, 0, false);
  const hardware = foldDesktopHardware(geometry);
  const retro = skin !== "modern" && skin !== "keyboard";
  const viewport =
    layout &&
    (retro
      ? retroDesktopViewport(hardware.media, skin, layout.media)
      : layout.media);
  const safeInsets = layout && {
    top: Math.max(0, layout.controls.y - hardware.controls.y),
    left: layout.controls.x,
    right: Math.max(
      0,
      geometry.width - layout.controls.x - layout.controls.width,
    ),
    bottom: Math.max(
      0,
      geometry.height - layout.controls.y - layout.controls.height,
    ),
  };
  const keys = {
    platform: "darwin",
    enabled: true,
    allowInput: () => true,
    systemActions: [],
    keyLabel: (code: string) => code,
    undo: () => setLastKey("Undo"),
    redo: () => setLastKey("Redo"),
    send,
  };
  return (
    <>
      <Stack.Screen
        options={{
          headerShown: false,
          statusBarHidden: true,
          gestureEnabled: false,
        }}
      />
      <View style={{ flex: 1, backgroundColor: colors.surface }}>
        {viewport && safeInsets ? (
          <>
            {retro && (
              <FoldDesktopBezel
                skin={skin}
                region={hardware.media}
                viewport={viewport}
              />
            )}
            <View
              testID="retroPreview.display"
              style={{
                position: "absolute",
                left: viewport.x,
                top: viewport.y,
                width: viewport.width,
                height: viewport.height,
                backgroundColor: colors.surfaceChip,
                alignItems: "center",
                justifyContent: "center",
                padding: spacing.lg,
                gap: spacing.md,
              }}
            >
              <Text
                style={{
                  fontSize: typeScale.title,
                  lineHeight: lineHeight.title,
                  color: colors.textPrimary,
                }}
              >
                {t(`remoteDesktop.skin_${skin}`)}
              </Text>
              <Text
                style={{
                  fontSize: typeScale.footnote,
                  lineHeight: lineHeight.caption,
                  color: colors.textSecondary,
                }}
              >
                原生皮肤预览 · 未连接远程电脑
              </Text>
              <Text
                testID="retroPreview.lastKey"
                style={{
                  fontSize: typeScale.footnote,
                  lineHeight: lineHeight.caption,
                  color: colors.textSecondary,
                }}
              >
                {lastKey || "按下键盘，查看真实按压效果"}
              </Text>
            </View>
            <View
              style={{
                position: "absolute",
                left: hardware.controls.x,
                top: hardware.controls.y,
                width: hardware.controls.width,
                height: hardware.controls.height,
              }}
            >
              {retro ? (
                <FoldDesktopDeck
                  skin={skin}
                  onChange={setSkin}
                  safeInsets={safeInsets}
                  bottomReserve={44}
                  keys={keys}
                />
              ) : skin === "keyboard" ? (
                <FoldDesktopKeyboard
                  {...keys}
                  skin={skin}
                  onSkinChange={setSkin}
                  safeInsets={safeInsets}
                  onOperations={() => setLastKey(t("remoteDesktop.operations"))}
                  onInputMethod={() =>
                    setLastKey(t("remoteDesktop.inputMethod"))
                  }
                  clipboard={
                    <RemoteDesktopClipboardButton
                      enabled={false}
                      supported={false}
                      transfer={async () => {}}
                    />
                  }
                />
              ) : (
                <>
                  <FoldDesktopSkinSwitch skin={skin} onChange={setSkin} />
                  <FoldTouchpad enabled send={send} />
                </>
              )}
            </View>
          </>
        ) : (
          <View
            style={[
              StyleSheet.absoluteFill,
              {
                justifyContent: "center",
                alignItems: "center",
                padding: spacing.lg,
              },
            ]}
          >
            <Text
              style={{
                fontSize: typeScale.footnote,
                lineHeight: lineHeight.caption,
                color: colors.textSecondary,
              }}
            >
              请将折叠屏置于竖向半折叠状态以预览皮肤
            </Text>
          </View>
        )}
      </View>
    </>
  );
}
