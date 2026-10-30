import { useEffect, useMemo, useRef, useState } from "react";
import { StyleSheet, View } from "react-native";
import { useTranslation } from "react-i18next";
import {
  THINKING_TRANSLATION_MAX_LENGTH,
  type ThinkingTranslationResult,
} from "@cindy/maker-shared/thinking-text";
import { Text } from "@/components/AppText";
import { useAuth } from "@/auth/AuthContext";
import {
  getMobileAuthOwner,
  isMobileAuthOwnerCurrent,
} from "@/auth/authOwnerGeneration";
import { useDeviceLink } from "@/device-link/DeviceLinkContext";
import { resolveSystemLocale } from "@/i18n/locale";
import { useThemedStyles, type ThemeColors } from "@/theme";
import {
  fontWeight,
  lineHeight,
  navigationChrome,
  spacing,
  typeScale,
} from "@/theme/tokens";
import { CompanionCardButton } from "./CompanionCardButton";

export function useThinkingTranslation(
  text: string,
  blockKey: string,
  sessionId: string,
  deviceId: string | undefined,
  running: boolean,
) {
  const { t, i18n } = useTranslation();
  const { accountGeneration } = useAuth();
  const { invoke } = useDeviceLink();
  const styles = useThemedStyles(makeStyles);
  const locale = resolveSystemLocale(i18n?.resolvedLanguage ?? i18n?.language);
  const bindingKey = JSON.stringify([
    accountGeneration,
    deviceId,
    sessionId,
    blockKey,
    locale,
    running,
    text,
  ]);
  // A → B → A must not revive state or replies from the first A.
  const binding = useMemo(() => ({ key: bindingKey }), [bindingKey]);
  const current = useRef<typeof binding | null>(binding);
  current.current = binding;
  const pending = useRef<typeof binding | null>(null);
  const [state, setState] = useState<{
    binding: typeof binding;
    text?: string;
    translated?: boolean;
    loading?: boolean;
    error?: "unavailable" | "failed" | "unsupported";
  }>();
  useEffect(() => {
    current.current = binding;
    return () => {
      current.current = null;
    };
  }, [binding]);
  const active = state?.binding === binding ? state : undefined;
  const translate = async () => {
    if (!deviceId || running || pending.current === binding) return;
    const owner = getMobileAuthOwner();
    pending.current = binding;
    setState({ binding, loading: true });
    try {
      const result = await invoke<ThinkingTranslationResult>(
        deviceId,
        "maker:translate-thinking",
        [{ sessionId, text, locale }],
        {
          preSend: () => {
            if (current.current !== binding || !isMobileAuthOwnerCurrent(owner))
              throw new Error("Stale translation");
          },
        },
      );
      if (current.current !== binding || !isMobileAuthOwnerCurrent(owner))
        return;
      setState(
        result.text
          ? { binding, text: result.text, translated: true }
          : {
              binding,
              error: result.error === "unavailable" ? "unavailable" : "failed",
            },
      );
    } catch (error) {
      if (current.current === binding && isMobileAuthOwnerCurrent(owner)) {
        setState({
          binding,
          error: /CHANNEL_NOT_ALLOWED/.test(String(error))
            ? "unsupported"
            : "failed",
        });
      }
    } finally {
      if (pending.current === binding) pending.current = null;
    }
  };
  const tooLong = text.length > THINKING_TRANSLATION_MAX_LENGTH;
  const controls =
    !!deviceId && !!text.trim() && !running ? (
      <View style={styles.controls}>
        <View style={styles.actions}>
          <CompanionCardButton
            label={t(
              active?.loading
                ? "message.thinkingTranslation.loading"
                : active?.text
                  ? active.translated
                    ? "message.thinkingTranslation.showOriginal"
                    : "message.thinkingTranslation.showTranslation"
                  : "message.thinkingTranslation.translate",
            )}
            busy={active?.loading}
            disabled={tooLong}
            onPress={() => {
              if (active?.text)
                setState({ ...active, translated: !active.translated });
              else void translate();
            }}
          />
        </View>
        {active?.translated && (
          <Text style={styles.metadata}>
            {t("message.thinkingTranslation.machineTranslated")}
          </Text>
        )}
        {!active?.text && (
          <Text style={styles.hint}>
            {t(
              tooLong
                ? "message.thinkingTranslation.tooLong"
                : "message.thinkingTranslation.disclosure",
            )}
          </Text>
        )}
        {active?.error && (
          <Text accessibilityLiveRegion="polite" style={styles.hint}>
            {t(`message.thinkingTranslation.${active.error}`)}
          </Text>
        )}
      </View>
    ) : null;
  return {
    displayContent: !running && active?.translated ? active.text! : text,
    controls,
  };
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    controls: { gap: spacing.xs, marginTop: spacing.sm },
    actions: {
      flexDirection: "row",
      alignItems: "center",
      minHeight: navigationChrome.target,
    },
    hint: {
      fontSize: typeScale.footnote,
      lineHeight: lineHeight.caption,
      fontWeight: fontWeight.regular,
      color: colors.textSecondary,
    },
    metadata: {
      fontSize: typeScale.caption,
      lineHeight: lineHeight.caption,
      fontWeight: fontWeight.regular,
      color: colors.textTertiary,
    },
  });
