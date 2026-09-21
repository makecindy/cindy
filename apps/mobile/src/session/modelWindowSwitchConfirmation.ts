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
 * Matches Desktop's switch boundary: pressured SSH sessions (usage >= 90% of the
 * target) are blocked, while local overflow requires confirmation. Unknown values
 * and ordinary low-pressure switches keep existing semantics.
 */
export function confirmMobileModelWindowSwitch(
  contextTokens: number | null | undefined,
  targetContextWindow: number | null | undefined,
  remoteHostId: string | null | undefined,
  showAlert: ShowAlert = Alert.alert,
): Promise<boolean> {
  if (
    typeof contextTokens !== "number" ||
    !Number.isFinite(contextTokens) ||
    contextTokens <= 0 ||
    typeof targetContextWindow !== "number" ||
    !Number.isFinite(targetContextWindow) ||
    targetContextWindow <= 0
  ) {
    return Promise.resolve(true);
  }

  const ratio = contextTokens / targetContextWindow;
  const pressuredRemote = !!remoteHostId && ratio >= 0.9;
  if (!pressuredRemote && ratio < 1) return Promise.resolve(true);

  const vars = {
    used: formatTokens(contextTokens),
    total: formatTokens(targetContextWindow),
    pct: Math.round(ratio * 100),
  };
  return new Promise((resolve) => {
    let settled = false;
    const finish = (confirmed: boolean) => {
      if (settled) return;
      settled = true;
      resolve(confirmed);
    };
    showAlert(
      i18n.t(
        pressuredRemote
          ? "models.contextWindowSwitch.remoteTitle"
          : "models.contextWindowSwitch.title",
      ),
      i18n.t(
        pressuredRemote
          ? "models.contextWindowSwitch.remoteDescription"
          : "models.contextWindowSwitch.description",
        vars,
      ),
      pressuredRemote
        ? [
            {
              text: i18n.t("models.contextWindowSwitch.cancel"),
              onPress: () => finish(false),
            },
          ]
        : [
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
