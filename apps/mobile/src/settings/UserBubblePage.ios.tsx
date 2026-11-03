import { useEffect, useState } from "react";
import { Alert, StyleSheet, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { useTranslation } from "react-i18next";
import { Host } from "@expo/ui";
import {
  Circle,
  Form,
  HStack,
  Picker,
  RNHostView,
  Section,
  Text as NativeText,
} from "@expo/ui/swift-ui";
import {
  foregroundStyle,
  frame,
  labelsHidden,
  pickerStyle,
  scrollContentBackground,
  scrollDisabled,
  strokeBorder,
  tag,
} from "@expo/ui/swift-ui/modifiers";
import {
  USER_BUBBLE_PRESETS,
  parseUserBubblePreference,
  userBubbleSeed,
  type UserBubblePreference,
} from "@cindy/maker-shared";
import { Text } from "@/components/AppText";
import {
  SimpleStackHeader,
  simpleScreenSafeAreaEdges,
} from "@/platform/chrome";
import {
  useTheme,
  useThemedStyles,
  type ThemeColors,
  fontWeight,
  lineHeight,
  radius,
  spacing,
  typeScale,
} from "@/theme";
import {
  resolveMobileUserBubbleColors,
  useUserBubbleAppearance,
} from "@/theme/userBubblePreference";
import { goBackGuarded } from "@/utils/backGuard";
import { UserBubbleHueSlider, hexToHue, hueToHex } from "./UserBubbleHueSlider";

const CUSTOM = "custom";
const HUE_ROW_HEIGHT = 44;

/** 首次切到自定义时,色带从当前预设的色相(默认则梦境)起步。 */
function pickerSeed(preference: UserBubblePreference): string {
  if (preference.startsWith("#")) return preference;
  return hueToHex(hexToHue(userBubbleSeed(preference === "default" ? "blue" : preference)!));
}

const SWATCH = frame({ width: 24, height: 24 });
let rememberedCustom: string | null = null;
const RAINBOW = [0, 60, 120, 180, 240, 300, 359].map(hueToHex);

/**
 * iOS「我的消息气泡」:顶部实时预览(RN,与会话气泡同款),下方原生 Form。
 * 预设与「自定义颜色」同在一个 inline Picker(系统勾选行);选中自定义才在其下展开色带。
 */
export function UserBubblePage() {
  const { t } = useTranslation();
  const router = useRouter();
  const { colors, mode } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { preference, setPreference, colors: saved } =
    useUserBubbleAppearance();
  // 拖动中的颜色只留在本页;松手才写全局偏好,避免所有已挂载的会话气泡逐帧重绘。
  const [draft, setDraft] = useState<string | null>(null);
  const bubble = draft
    ? resolveMobileUserBubbleColors(parseUserBubblePreference(draft), mode, colors)
    : saved;
  const custom = preference.startsWith("#");
  // 偏好异步加载,首帧可能还是 default;起点在点按「自定义颜色」时再取。
  // 选过的自定义色记在模块级,App 运行期间离开页面再回来也能恢复。
  const [lastCustom, setLastCustomState] = useState(rememberedCustom);
  const setLastCustom = (hex: string) => {
    rememberedCustom = hex;
    setLastCustomState(hex);
  };
  useEffect(() => {
    if (preference.startsWith("#")) {
      rememberedCustom = preference;
      setLastCustomState(preference);
    }
  }, [preference]);
  const [dragging, setDragging] = useState(false);
  const label = (name: string) => t(`settings.appearance.userBubble.${name}`);
  // 写入失败时内存里已是新值,所以「重试」要强制再写一次,不能被「没变化」跳过。
  const select = (next: UserBubblePreference, force = false) => {
    if (!force && next === preference) return;
    void setPreference(next).catch(() =>
      Alert.alert(label("title"), label("saveFailed"), [
        { text: label("cancel"), style: "cancel" },
        { text: label("retry"), onPress: () => select(next, true) },
      ]),
    );
  };
  return (
    <SafeAreaView
      edges={simpleScreenSafeAreaEdges()}
      style={styles.screen}
      testID="settings.userBubble.screen"
    >
      <SimpleStackHeader
        title={label("title")}
        backTestID="settings.userBubble.back"
        onBack={() => goBackGuarded(router)}
      />
      <View
        accessibilityLabel={label("preview")}
        style={styles.preview}
        testID="settings.userBubble.preview"
      >
        <View
          style={[
            styles.bubble,
            bubble && {
              backgroundColor: bubble.background,
              borderColor: bubble.border,
            },
          ]}
        >
          <Text style={styles.message}>{label("sampleUser")}</Text>
        </View>
        <Text style={styles.message}>{label("sampleAssistant")}</Text>
      </View>
      <Host style={styles.form} colorScheme={mode}>
        <Form
          modifiers={[
            scrollContentBackground("hidden"),
            scrollDisabled(dragging),
          ]}
        >
          <Section
            title={label("presets")}
            footer={<NativeText>{label(custom ? "customHint" : "hint")}</NativeText>}
          >
            <Picker<string | null>
              label={label("presets")}
              selection={custom ? CUSTOM : preference}
              onSelectionChange={(next) => {
                if (next === CUSTOM)
                  select(parseUserBubblePreference(lastCustom ?? pickerSeed(preference)));
                else if (next) select(next as UserBubblePreference);
              }}
              modifiers={[pickerStyle("inline"), labelsHidden()]}
              testID="settings.userBubble.presets"
            >
              {USER_BUBBLE_PRESETS.map((id) => {
                const swatch = resolveMobileUserBubbleColors(id, mode, colors);
                return (
                  <HStack key={id} spacing={spacing.md} modifiers={[tag(id)]}>
                    <Circle
                      modifiers={[
                        SWATCH,
                        foregroundStyle(
                          swatch?.background ?? colors.surfaceElevated,
                        ),
                        strokeBorder({
                          color: swatch?.border ?? colors.border,
                          shape: "circle",
                          style: { lineWidth: 1 },
                        }),
                      ]}
                    />
                    <NativeText>{label(id)}</NativeText>
                  </HStack>
                );
              })}
              <HStack spacing={spacing.md} modifiers={[tag(CUSTOM)]}>
                <Circle
                  modifiers={[
                    SWATCH,
                    custom && bubble
                      ? foregroundStyle(bubble.background)
                      : foregroundStyle({
                          type: "angularGradient",
                          colors: RAINBOW,
                          center: { x: 0.5, y: 0.5 },
                        }),
                    strokeBorder({
                      color: custom && bubble ? bubble.border : colors.border,
                      shape: "circle",
                      style: { lineWidth: 1 },
                    }),
                  ]}
                />
                <NativeText>{label("custom")}</NativeText>
              </HStack>
            </Picker>
            {custom ? (
              // 尺寸交给原生行决定(含系统行内边距),RN 只填满这一行;maxWidth 取大数撑满行宽。
              <HStack modifiers={[frame({ maxWidth: 10000, height: HUE_ROW_HEIGHT })]}>
                <RNHostView>
                  <View style={styles.hueRow}>
                    <UserBubbleHueSlider
                      label={label("hue")}
                      value={draft ?? preference}
                      onDragChange={setDragging}
                      onChange={setDraft}
                      onChangeEnd={(hex) => {
                        setDraft(null);
                        setLastCustom(hex);
                        select(parseUserBubblePreference(hex));
                      }}
                    />
                  </View>
                </RNHostView>
              </HStack>
            ) : null}
          </Section>
        </Form>
      </Host>
    </SafeAreaView>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: colors.surface },
    preview: {
      gap: spacing.lg,
      paddingHorizontal: spacing.xl,
      paddingTop: spacing.lg,
      paddingBottom: spacing.sm,
    },
    // 与 MessageRenderer 的 bubble + bubbleCompact + userBubble 一致(示例是单行短句,
    // 真实对话里走 compact 密度),预览即实际效果;那边改样式时这里要同步。
    bubble: {
      alignSelf: "flex-end",
      maxWidth: "86%",
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
      borderRadius: radius.container,
      borderWidth: StyleSheet.hairlineWidth,
      backgroundColor: colors.surfaceElevated,
      borderColor: colors.border,
    },
    message: {
      color: colors.textPrimary,
      fontSize: typeScale.bodyLarge,
      lineHeight: lineHeight.bodyLarge,
      fontWeight: fontWeight.regular,
    },
    form: { flex: 1, backgroundColor: colors.surface },
    hueRow: { flex: 1, justifyContent: "center" },
  });
