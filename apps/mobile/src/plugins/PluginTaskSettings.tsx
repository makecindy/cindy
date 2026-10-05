import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Platform,
  Pressable,
  StyleSheet,
  View,
} from "react-native";
import { ChevronRight } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import type { PluginTaskPreferences } from "@cindy/device-link";
import { Text } from "@/components/AppText";
import { useDeviceLink } from "@/device-link/DeviceLinkContext";
import { useDeviceProviders } from "@/device-link/useDeviceProviders";
import { useMobileMakerTransport } from "@/device-link/useMobileMakerTransport";
import {
  getMobileAuthOwner,
  isMobileAuthOwnerCurrent,
} from "@/auth/authOwnerGeneration";
import { ModelPickerSheet } from "@/session/ModelPickerSheet";
import {
  normalizeMobileAgentCapabilities,
  type MobileAgentCapabilities,
} from "@/session/agentCapabilities";
import { permissionPresentation } from "@/session/permissionPresentation";
import {
  iconSize,
  fontWeight,
  lineHeight,
  radius,
  spacing,
  typeScale,
  useTheme,
  useThemedStyles,
  type ThemeColors,
} from "@/theme";
import { invokePlugin } from "./pluginClient";

/** Native Host settings. Author content has no access to this invoke or stored configuration. */
export function PluginTaskSettings({
  deviceId,
  pluginId,
}: {
  deviceId: string;
  pluginId: string;
}) {
  const { t } = useTranslation(),
    { invoke } = useDeviceLink(),
    { colors } = useTheme(),
    styles = useThemedStyles(makeStyles);
  const maker = useMobileMakerTransport(deviceId),
    providers = useDeviceProviders(deviceId);
  const [preferences, setPreferences] = useState<PluginTaskPreferences>();
  const [error, setError] = useState(false),
    [picker, setPicker] = useState(false),
    [busy, setBusy] = useState(false);
  const [capabilities, setCapabilities] =
    useState<MobileAgentCapabilities | null>(null);
  const alive = useRef(true),
    lock = useRef(false),
    owner = useRef(getMobileAuthOwner()).current;
  const current = () => alive.current && isMobileAuthOwnerCurrent(owner);
  const call = <T,>(action: string, input: Record<string, unknown> = {}) =>
    invokePlugin<T>(
      (device, channel, args) =>
        invoke(device, channel, args, {
          preSend: () => {
            if (!current()) throw new Error("PLUGIN_SETTINGS_CLOSED");
          },
        }),
      deviceId,
      pluginId,
      action,
      input,
    );
  const load = async () => {
    try {
      const value = await call<PluginTaskPreferences>("task-settings:get");
      if (
        !value ||
        typeof value.revision !== "string" ||
        !value.config ||
        !Array.isArray(value.permissionModes)
      )
        throw new Error("PLUGIN_SETTINGS_INVALID");
      if (current()) {
        setPreferences(value);
        setError(false);
      }
    } catch {
      if (current()) setError(true);
    }
  };
  useEffect(() => {
    alive.current = true;
    void load();
    return () => {
      alive.current = false;
    };
  }, []);
  const config = preferences?.config;
  const agent =
    config?.agentKind === "cc" ? "claude-code" : (config?.agentKind ?? "codex");
  useEffect(() => {
    let cancelled = false;
    if (!picker) return;
    setCapabilities(null);
    void maker
      .getCapabilities(agent)
      .then((raw) => {
        if (!cancelled && current())
          setCapabilities(normalizeMobileAgentCapabilities(raw));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [picker, maker, agent]);
  const save = async (patch: Record<string, unknown>) => {
    if (!preferences || lock.current || !current()) return false;
    lock.current = true;
    setBusy(true);
    try {
      const value = await call<PluginTaskPreferences>("task-settings:set", {
        expectedRevision: preferences.revision,
        ...patch,
      });
      if (!current()) return false;
      setPreferences(value);
      setError(false);
      return true;
    } catch {
      if (current()) {
        setError(true);
        Alert.alert(t("plugins.actionFailed"));
      }
      // Unknown receipt is read back only; configuration writes are never automatically replayed.
      return false;
    } finally {
      lock.current = false;
      if (current()) setBusy(false);
    }
  };
  const choosePermission = () => {
    if (!preferences || busy) return;
    Alert.alert(t("plugins.taskPermission"), t("plugins.permissionHint"), [
      ...preferences.permissionModes.map((mode) => ({
        text: permissionPresentation(mode).label,
        onPress: () => {
          if (mode === "auto")
            Alert.alert(
              t("plugins.taskPermission"),
              t("plugins.autoPermissionHint"),
              [
                { text: t("plugins.cancel"), style: "cancel" },
                {
                  text: t("plugins.confirm"),
                  onPress: () => {
                    void save({ permissionMode: mode });
                  },
                },
              ],
            );
          else void save({ permissionMode: mode });
        },
      })),
      {
        text: t("plugins.followDefault"),
        onPress: () => {
          void save({ permissionMode: null });
        },
      },
      { text: t("plugins.cancel"), style: "cancel" },
    ]);
  };
  const name =
    providers.providers
      .find((p) => p.id === config?.providerId)
      ?.models[agent]?.find((m) => m.id === config?.model)?.name ??
    config?.model;
  return (
    <View>
      <Text style={styles.label}>{t("plugins.taskSettings")}</Text>
      <View style={styles.card}>
        <Pressable
          accessibilityRole="button"
          disabled={!preferences || busy || error}
          style={styles.row}
          onPress={() => setPicker(true)}
        >
          <View style={styles.fill}>
            <Text style={styles.title}>{t("plugins.taskModel")}</Text>
            <Text style={styles.secondary}>
              {name ?? t("plugins.followDefault")}
            </Text>
          </View>
          <ChevronRight size={iconSize.md} color={colors.textTertiary} />
        </Pressable>
        <Pressable
          accessibilityRole="button"
          disabled={!preferences || busy || error}
          style={styles.row}
          onPress={choosePermission}
        >
          <Text style={[styles.title, styles.fill]}>
            {t("plugins.taskPermission")}
          </Text>
          <Text style={styles.secondary}>
            {preferences
              ? permissionPresentation(
                  config?.permissionMode ?? preferences.defaultPermissionMode,
                ).label
              : ""}
          </Text>
          <ChevronRight size={iconSize.md} color={colors.textTertiary} />
        </Pressable>
        {config?.model ? (
          <Pressable
            accessibilityRole="button"
            disabled={busy || error}
            style={styles.row}
            onPress={() => {
              void save({ model: null });
            }}
          >
            <Text style={styles.secondary}>{t("plugins.followDefault")}</Text>
          </Pressable>
        ) : null}
      </View>
      <Text style={styles.hint}>{t("plugins.taskSettingsHint")}</Text>
      {busy || (!preferences && !error) ? (
        <ActivityIndicator color={colors.textSecondary} />
      ) : null}
      {error ? (
        <Pressable
          accessibilityRole="button"
          style={styles.row}
          onPress={() => {
            void load();
          }}
        >
          <Text style={styles.secondary}>{t("plugins.settingsReload")}</Text>
        </Pressable>
      ) : null}
      <ModelPickerSheet
        visible={picker}
        onClose={() => setPicker(false)}
        agentKind={agent}
        providers={providers.providers}
        providersReady={providers.ready}
        providersUnsupported={providers.unsupported}
        modelVisibilityOverrides={providers.modelVisibilityOverrides}
        flatOptions={[]}
        capabilities={capabilities}
        activeModelId={config?.model ?? ""}
        selectedProviderId={config?.providerId ?? null}
        selectedEffort={config?.effort ?? ""}
        selectedFastMode={config?.fastMode ?? false}
        loading={providers.loading}
        disabled={busy || error}
        hidePermissionTrigger
        activePermissionMode={
          config?.permissionMode ?? preferences?.defaultPermissionMode ?? ""
        }
        permissionOptions={[]}
        onSelectPermissionMode={() => {}}
        onSelectFlatModel={() => {}}
        onSelectProviderRow={() => {}}
        keyboardAvoidingBehavior={Platform.OS === "ios" ? "padding" : "height"}
        emptyHint={t("plugins.modelsUnavailable")}
        unified={{
          scope: JSON.stringify([owner.accountKey, deviceId]),
          agents: ["claude-code", "codex", "pi"],
          loadCapabilities: async (kind) => {
            const caps = normalizeMobileAgentCapabilities(
              await maker.getCapabilities(kind),
            );
            if (!caps) throw new Error("CAPABILITIES_UNAVAILABLE");
            return caps;
          },
          onSelect: async (value) => {
            const result = await save({
              model: {
                agentKind: value.agent === "claude-code" ? "cc" : value.agent,
                model: value.modelId,
                providerId: value.providerId,
                ...(value.effort ? { effort: value.effort } : {}),
                fastMode: value.fast,
              },
            });
            if (result && current()) setPicker(false);
            return result;
          },
        }}
      />
    </View>
  );
}
const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    fill: { flex: 1 },
    label: {
      fontSize: typeScale.footnote,
      lineHeight: lineHeight.bodySmall,
      fontWeight: fontWeight.regular,
      color: colors.textTertiary,
      marginBottom: spacing.sm,
    },
    card: {
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
      borderRadius: radius.container,
      backgroundColor: colors.surfaceElevated,
      overflow: "hidden",
    },
    row: {
      minHeight: 52,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
      flexDirection: "row",
      alignItems: "center",
      gap: spacing.sm,
    },
    title: {
      fontSize: typeScale.body,
      lineHeight: lineHeight.body,
      fontWeight: fontWeight.regular,
      color: colors.textPrimary,
    },
    secondary: {
      fontSize: typeScale.bodySmall,
      lineHeight: lineHeight.bodySmall,
      fontWeight: fontWeight.regular,
      color: colors.textSecondary,
    },
    hint: {
      fontSize: typeScale.footnote,
      lineHeight: lineHeight.bodySmall,
      fontWeight: fontWeight.regular,
      color: colors.textTertiary,
      marginVertical: spacing.sm,
    },
  });
