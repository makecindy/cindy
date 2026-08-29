/** Mobile confirmation gate before a smaller model window replaces native context. */
import { Alert, type AlertButton, type AlertOptions } from "react-native";

import { i18n } from "@/i18n";

type ShowAlert = (
  title: string,
  message?: string,
  buttons?: AlertButton[],
  options?: AlertOptions,
) => void;

function formatTokens(value: number): string {
  return value >= 1_000_000
    ? `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`
    : `${Math.round(value / 1_000)}K`;
}

/**
 * Matches Desktop's explicit-confirmation boundary: only overflow (usage >= target
 * window) prompts. Unknown values and ordinary low-pressure switches keep existing semantics.
 */
export function confirmMobileModelWindowSwitch(
  contextTokens: number | null | undefined,
  targetContextWindow: number | null | undefined,
  showAlert: ShowAlert = Alert.alert,
): Promise<boolean> {
  if (
    typeof contextTokens !== "number" ||
    !Number.isFinite(contextTokens) ||
    contextTokens <= 0 ||
    typeof targetContextWindow !== "number" ||
    !Number.isFinite(targetContextWindow) ||
    targetContextWindow <= 0 ||
    contextTokens < targetContextWindow
  ) {
    return Promise.resolve(true);
  }

  const vars = {
    used: formatTokens(contextTokens),
    total: formatTokens(targetContextWindow),
    pct: Math.round((contextTokens / targetContextWindow) * 100),
  };
  return new Promise((resolve) => {
    let settled = false;
    const finish = (confirmed: boolean) => {
      if (settled) return;
      settled = true;
      resolve(confirmed);
    };
    showAlert(
      i18n.t("models.contextWindowSwitch.title"),
      i18n.t("models.contextWindowSwitch.description", vars),
      [
        {
          text: i18n.t("models.contextWindowSwitch.cancel"),
          style: "cancel",
          onPress: () => finish(false),
        },
        {
          text: i18n.t("models.contextWindowSwitch.confirm"),
          onPress: () => finish(true),
        },
      ],
      { cancelable: true, onDismiss: () => finish(false) },
    );
  });
}
