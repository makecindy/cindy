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
  resolveHostModelGroup,
  useHostModelGroupPickerOptions,
  useHostModelGroupsPayload,
} from "@/session/hostModelGroups";
import {
  normalizeMobileAgentCapabilities,
  type MobileAgentCapabilities,
} from "@/session/agentCapabilities";
import {
  isPluginEngineEffort,
  PLUGIN_ENGINE_DEFAULT_MODEL,
  pluginEngineModelName,
  usePluginEngines,
} from "@/session/pluginEngines";
import { useRemoteAgentCatalogs } from "@/session/useRemoteAgentCatalogs";
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
  const isAcpConfig = config?.agentKind === "acp";
  const agent =
    config?.agentKind === "cc"
      ? "claude-code"
      : config?.agentKind === "codex" || config?.agentKind === "pi"
        ? config.agentKind
        : "codex";
  const pluginEngines = usePluginEngines(maker, deviceId, picker || isAcpConfig);
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
  const agentDeviceId = config?.agentDeviceId ?? null;
  const activeModelGroup = config?.modelGroup ?? null;
  const hostModelGroupsPayload = useHostModelGroupsPayload(
    deviceId,
    maker,
    picker || activeModelGroup !== null,
  );
  // Same sources as an ordinary task on that computer. Older Hosts do not save a run
  // location, so they keep listing only their own models.
  const remoteSupported = preferences?.remoteRoutes === true;
  const remoteCatalogs = useRemoteAgentCatalogs({
    enabled: remoteSupported && (picker || agentDeviceId !== null),
    controlledDeviceId: deviceId,
    keepDeviceIds: agentDeviceId ? [agentDeviceId] : [],
    keepOnly: !picker,
  });
  const location = agentDeviceId
    ? remoteCatalogs.find((catalog) => catalog.deviceId === agentDeviceId)
    : undefined;
  const activePluginEngine =
    isAcpConfig && config?.providerId && !agentDeviceId
      ? {
          providerId: config.providerId,
          modelId: config.model || PLUGIN_ENGINE_DEFAULT_MODEL,
          ...(isPluginEngineEffort(config.effort) ? { effort: config.effort } : {}),
        }
      : null;
  const matchedPluginEngine = activePluginEngine
    ? pluginEngines.engines.find((engine) => engine.providerId === activePluginEngine.providerId)
    : undefined;
  const modelName = isAcpConfig
    ? pluginEngineModelName(matchedPluginEngine, config?.model)
      ?? (config?.model && config.model !== PLUGIN_ENGINE_DEFAULT_MODEL
        ? config.model
        : matchedPluginEngine?.name ?? t("models.pluginEngines.genericName"))
    : ((agentDeviceId ? (location?.providers ?? []) : providers.providers)
        .find((p) => p.id === config?.providerId)
        ?.models[agent]?.find((m) => m.id === config?.model)?.name ??
      config?.model);
  const activeRouteLabel = !isAcpConfig && activeModelGroup
    ? (hostModelGroupsPayload?.groups.find((g) => g.id === activeModelGroup)?.name
      ?? hostModelGroupsPayload?.expandedRoutes.find((r) => r.id === activeModelGroup)?.parent.name
      ?? null)
    : null;
  const concreteName = modelName && location ? `${modelName} · ${location.name}` : modelName;
  const name = activeRouteLabel
    ? (concreteName ? `${activeRouteLabel} (${concreteName})` : activeRouteLabel)
    : concreteName;
  const selectModelGroupForTask = async (
    id: string,
    overrides?: { effort?: string; fastMode?: boolean | "ultrafast" },
  ): Promise<boolean> => {
    const resolved = await resolveHostModelGroup(
      maker,
      id,
      overrides ? { effort: overrides.effort || undefined, fastMode: overrides.fastMode } : undefined,
      remoteSupported ? undefined : { agentDeviceId: null },
    );
    if (!current()) return false;
    if (!resolved || resolved.outcome !== "routed") {
      Alert.alert(t("models.modelGroups.picker.chooseUnavailable", { name: resolved?.groupName ?? "" }));
      return false;
    }
    const { route } = resolved;
    const ok = await save({
      model: {
        agentKind: route.agentKind,
        model: route.model,
        providerId: route.providerId,
        ...(remoteSupported ? { agentDeviceId: route.agentDeviceId ?? null } : {}),
        ...(route.effort || overrides?.effort ? { effort: route.effort ?? overrides?.effort } : {}),
        fastMode: route.fastMode ?? overrides?.fastMode ?? false,
        modelGroup: id,
      },
    });
    if (ok && current()) setPicker(false);
    return ok;
  };
  const taskModelGroupOptions = useHostModelGroupPickerOptions(
    hostModelGroupsPayload?.groups ?? null,
    isAcpConfig ? null : activeModelGroup,
    (id) => selectModelGroupForTask(id),
    t,
    {
      sourceRoutesPayload: hostModelGroupsPayload,
      activeRouteId: isAcpConfig ? null : activeModelGroup,
      onPickMerged: (routeId, value) =>
        selectModelGroupForTask(routeId, { effort: value.effort, fastMode: value.fast }),
    },
  );
  return (
    <View>
      <Text style={styles.sectionLabel}>{t("plugins.taskSettings")}</Text>
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
      {agentDeviceId ? (
        <Text style={styles.hint}>{t("plugins.remoteQuickAnswerHint")}</Text>
      ) : null}
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
        activeModelId={isAcpConfig ? "" : (config?.model ?? "")}
        selectedProviderId={isAcpConfig ? null : (config?.providerId ?? null)}
        selectedEffort={isAcpConfig ? "" : (config?.effort ?? "")}
        selectedFastMode={isAcpConfig ? false : (config?.fastMode ?? false)}
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
          remote: remoteSupported
            ? {
                catalogs: remoteCatalogs,
                selectedDeviceId: isAcpConfig ? null : agentDeviceId,
                hostDeviceId: deviceId,
              }
            : undefined,
          ...(pluginEngines.engines.length || activePluginEngine
            ? {
                pluginEngines: {
                  engines: pluginEngines.engines,
                  active: activePluginEngine,
                  onSelect: async (next) => {
                    const result = await save({
                      model: {
                        agentKind: "acp",
                        model: next.modelId || PLUGIN_ENGINE_DEFAULT_MODEL,
                        providerId: next.providerId,
                        ...(remoteSupported ? { agentDeviceId: null } : {}),
                        ...(next.effort ? { effort: next.effort } : {}),
                        fastMode: false,
                      },
                    });
                    if (result && current()) setPicker(false);
                    return result;
                  },
                  onOpen: pluginEngines.refresh,
                },
              }
            : {}),
          scope: JSON.stringify([owner.accountKey, deviceId]),
          agents: ["claude-code", "codex", "pi"],
          ...(taskModelGroupOptions ? { modelGroups: taskModelGroupOptions } : {}),
          loadCapabilities: async (kind) => {
            const caps = normalizeMobileAgentCapabilities(
              await maker.getCapabilities(kind),
            );
            if (!caps) throw new Error("CAPABILITIES_UNAVAILABLE");
            return caps;
          },
          onSelect: async (value, source) => {
            const result = await save({
              model: {
                agentKind: value.agent === "claude-code" ? "cc" : value.agent,
                model: value.modelId,
                providerId: value.providerId,
                // Null explicitly selects the Host, including a same-named local model.
                ...(remoteSupported ? { agentDeviceId: source?.deviceId ?? null } : {}),
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
    sectionLabel: {
      fontSize: typeScale.footnote,
      lineHeight: lineHeight.caption,
      fontWeight: fontWeight.semibold,
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
      lineHeight: lineHeight.caption,
      fontWeight: fontWeight.regular,
      color: colors.textSecondary,
      marginVertical: spacing.sm,
    },
  });
