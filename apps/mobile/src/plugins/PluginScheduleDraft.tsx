import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  AppState,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  useWindowDimensions,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTranslation } from "react-i18next";
import type { PluginNativeIntent } from "@cindy/device-link";
import {
  createMobileScheduleDraft,
  buildMobileScheduleInput,
  validateMobileScheduleDraft,
} from "@cindy/maker-shared/schedule-form";
import { Text, TextInput } from "@/components/AppText";
import { useDeviceLink } from "@/device-link/DeviceLinkContext";
import { useDeviceProviders } from "@/device-link/useDeviceProviders";
import { useMobileMakerTransport } from "@/device-link/useMobileMakerTransport";
import {
  getMobileAuthOwner,
  isMobileAuthOwnerCurrent,
} from "@/auth/authOwnerGeneration";
import { normalizeMobileAgentCapabilities } from "@/session/agentCapabilities";
import { ModelPickerSheet } from "@/session/ModelPickerSheet";
import {
  PLUGIN_ENGINE_DEFAULT_MODEL,
  findPluginEngine,
  isPluginEngineEffort,
  pluginEngineModelName,
  useControlledRemotePluginEngines,
  usePluginEngines,
} from "@/session/pluginEngines";
import { useRemoteAgentCatalogs } from "@/session/useRemoteAgentCatalogs";
import { SheetModal } from "@/session/SheetModal";
import {
  fontWeight,
  lineHeight,
  radius,
  spacing,
  typeScale,
  useTheme,
  useThemedStyles,
  type ThemeColors,
} from "@/theme";

/** Opening this draft never writes a schedule. Only the native Save gesture may create one. */
export function PluginScheduleDraft({
  intent,
  deviceId,
  onClose,
}: {
  intent: Extract<PluginNativeIntent, { kind: "schedule" }>;
  deviceId: string;
  onClose(): void;
}) {
  const { t } = useTranslation(),
    { colors } = useTheme(),
    styles = useThemedStyles(makeStyles);
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const link = useDeviceLink(),
    maker = useMobileMakerTransport(deviceId),
    providers = useDeviceProviders(deviceId);
  // 旧版电脑会静默丢掉运行位置，只有它声明支持定时任务的位置选择才列出远程模型。
  const [remoteSupported, setRemoteSupported] = useState(false);
  const owner = useRef(getMobileAuthOwner()).current,
    alive = useRef(true),
    sent = useRef(false),
    epoch = useRef(link.connectionEpoch).current;
  const liveEpoch = useRef(link.connectionEpoch);
  liveEpoch.current = link.connectionEpoch;
  const [draft, setDraft] = useState(() => ({
    ...createMobileScheduleDraft(),
    name: intent.name,
    prompt: intent.prompt,
    model: "",
    providerId: "",
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    ...(intent.intervalMs ? { sourceIntervalMs: intent.intervalMs } : {}),
  }));
  const [frequency, setFrequency] = useState<
    "daily" | "weekdays" | "interval" | "custom"
  >(intent.intervalMs ? "interval" : "daily");
  const [clock, setClock] = useState("09:00");
  const applyFrequency = (next: typeof frequency) => {
    setFrequency(next);
    const [hour, minute] = clock.split(":").map(Number);
    setDraft((d) => ({
      ...d,
      intervalMinutes: "",
      intervalMinutesTouched: next !== "interval",
      sourceIntervalMs:
        next === "interval" ? (intent.intervalMs ?? 3600000) : undefined,
      cronExpr:
        next === "daily" || next === "weekdays"
          ? `${minute} ${hour} * * ${next === "weekdays" ? "1-5" : "*"}`
          : d.cronExpr,
    }));
  };
  const [checkEnabled, setCheckEnabled] = useState(true);
  const [picker, setPicker] = useState(false),
    [pickerVisible, setPickerVisible] = useState(false),
    [busy, setBusy] = useState(false),
    [unknown, setUnknown] = useState(false);
  useEffect(() => {
    let cancelled = false;
    maker
      .getCapabilities("claude-code")
      .then((value) => {
        if (!cancelled)
          setRemoteSupported(
            normalizeMobileAgentCapabilities(value)
              ?.supportsScheduleAgentDeviceSelection === true,
          );
      })
      .catch(() => {
        if (!cancelled) setRemoteSupported(false);
      });
    return () => {
      cancelled = true;
    };
  }, [maker]);
  const remoteCatalogs = useRemoteAgentCatalogs({
    enabled: (picker || !!draft.modelAgentDeviceId) && remoteSupported,
    controlledDeviceId: deviceId,
    keepDeviceIds: draft.modelAgentDeviceId ? [draft.modelAgentDeviceId] : [],
  });
  const pluginEngines = usePluginEngines(
    maker,
    deviceId,
    picker || draft.agentKind === "acp",
  );
  const remotePluginEngines = useControlledRemotePluginEngines({
    controlledDeviceId: deviceId,
    enabled: (picker || !!draft.modelAgentDeviceId) && remoteSupported,
    discoverAll: picker && remoteSupported,
    invoke: link.invoke,
    remoteCatalogs,
    keepDeviceIds: draft.modelAgentDeviceId ? [draft.modelAgentDeviceId] : [],
    connectionEpoch: link.connectionEpoch,
  });
  const allPluginEngines = [
    ...pluginEngines.engines,
    ...(remoteSupported ? remotePluginEngines.engines : []),
  ];
  const onPluginEnginesOpen = useCallback(() => {
    pluginEngines.refresh();
    if (remoteSupported) remotePluginEngines.refresh();
  }, [pluginEngines.refresh, remotePluginEngines.refresh, remoteSupported]);
  useEffect(
    () => () => {
      alive.current = false;
    },
    [],
  );
  const assertCurrent = () => {
    if (
      !alive.current ||
      !isMobileAuthOwnerCurrent(owner) ||
      liveEpoch.current !== epoch ||
      AppState.currentState !== "active"
    )
      throw new Error("PLUGIN_DRAFT_CLOSED");
  };
  const save = async () => {
    if (sent.current || !draft.model || !draft.providerId) return;
    const validation =
      frequency === "interval" &&
      draft.intervalMinutesTouched &&
      !draft.intervalMinutes.trim()
        ? { message: t("plugins.automationInvalid") }
        : (frequency === "daily" || frequency === "weekdays") &&
            !/^([01]\d|2[0-3]):[0-5]\d$/.test(clock)
          ? { message: t("plugins.automationTimeInvalid") }
          : validateMobileScheduleDraft(draft, {
              translate: (_key, _fallback, _values) =>
                t("plugins.automationInvalid"),
            });
    if (validation) return;
    try {
      assertCurrent();
    } catch {
      return;
    }
    sent.current = true;
    setBusy(true);
    try {
      const result = await link.invoke<{ id: string }>(
        deviceId,
        "maker:schedule:create",
        [{ ...buildMobileScheduleInput(draft),
          ...(checkEnabled && intent.preRunPlugin ? { preRunPlugin: intent.preRunPlugin } : {}),
        }],
        { preSend: assertCurrent },
      );
      if (!result || typeof result.id !== "string")
        throw new Error("PLUGIN_DRAFT_UNCONFIRMED");
      assertCurrent();
      onClose();
    } catch {
      if (alive.current) setUnknown(true);
    } finally {
      if (alive.current) setBusy(false);
    }
  };
  const validation =
    frequency === "interval" &&
    draft.intervalMinutesTouched &&
    !draft.intervalMinutes.trim()
      ? { message: t("plugins.automationInvalid") }
      : (frequency === "daily" || frequency === "weekdays") &&
          !/^([01]\d|2[0-3]):[0-5]\d$/.test(clock)
        ? { message: t("plugins.automationTimeInvalid") }
        : validateMobileScheduleDraft(draft, {
            translate: (_key, _fallback, _values) =>
              t("plugins.automationInvalid"),
          });
  const remoteCatalog = draft.modelAgentDeviceId
    ? remoteCatalogs.find((catalog) => catalog.deviceId === draft.modelAgentDeviceId)
    : undefined;
  const draftIsPluginEngine = draft.agentKind === "acp";
  const activePluginEngine = draftIsPluginEngine && draft.providerId
    ? {
        providerId: draft.providerId,
        ...(draft.modelAgentDeviceId ? { deviceId: draft.modelAgentDeviceId } : {}),
        modelId: draft.model || PLUGIN_ENGINE_DEFAULT_MODEL,
        ...(isPluginEngineEffort(draft.effort) ? { effort: draft.effort } : {}),
      }
    : null;
  const activeEngine = draftIsPluginEngine
    ? findPluginEngine(allPluginEngines, draft.providerId, draft.modelAgentDeviceId || null)
    : null;
  const shownModel = draft.agentKind === "acp"
    ? [
        activeEngine?.name ?? t("models.pluginEngines.genericName"),
        pluginEngineModelName(activeEngine, draft.model)
          ?? (draft.model === PLUGIN_ENGINE_DEFAULT_MODEL
            ? t("models.pluginEngines.defaultModel")
            : draft.model),
      ]
        .filter(Boolean)
        .join(" · ")
    : (remoteCatalog?.providers ?? providers.providers)
        .find((provider) => provider.id === draft.providerId)
        ?.models[draft.agentKind]?.find((model) => model.id === draft.model)
        ?.name ?? draft.model;
  const remoteName = remoteCatalog?.name ?? (draftIsPluginEngine ? activeEngine?.deviceName : undefined);
  const modelName = remoteName ? `${shownModel} · ${remoteName}` : shownModel;
  return (
    <>
      <SheetModal
        visible={!picker}
        onClosed={() => { if (picker) setPickerVisible(true); }}
        keyboardAvoiding
        onBackdropPress={() => {}}
        onRequestClose={onClose}
      >
        <ScrollView
          keyboardShouldPersistTaps="handled"
          style={{ flexGrow: 0, maxHeight: height - insets.top - spacing.lg }}
          contentContainerStyle={[styles.sheet, { paddingBottom: insets.bottom + spacing.lg }]}
        >
          <Text style={styles.title}>{t("plugins.automationDraft")}</Text>
          <Text style={styles.hint}>
            {intent.ghostName} · {t("plugins.automationDraftHint")}
          </Text>
          {intent.preRunPlugin ? (
            <View style={styles.checkRow}>
              <Text style={styles.checkLabel}>{t("plugins.automationCheck", { name: intent.ghostName })}</Text>
              <Switch value={checkEnabled} onValueChange={setCheckEnabled} disabled={sent.current}
                accessibilityLabel={t("plugins.automationCheck", { name: intent.ghostName })} />
            </View>
          ) : null}
          <Text style={styles.body}>{t("plugins.automationName")}</Text>
          <TextInput
            accessibilityLabel={t("plugins.automationName")}
            value={draft.name}
            editable={!sent.current}
            maxLength={80}
            onChangeText={(name) => setDraft((d) => ({ ...d, name }))}
            style={styles.input}
          />
          <Text style={styles.body}>{t("plugins.automationPrompt")}</Text>
          <TextInput
            accessibilityLabel={t("plugins.automationPrompt")}
            value={draft.prompt}
            editable={!sent.current}
            multiline
            maxLength={12000}
            onChangeText={(prompt) => setDraft((d) => ({ ...d, prompt }))}
            style={styles.input}
          />
          <View style={styles.frequencies}>
            {(["daily", "weekdays", "interval", "custom"] as const).map(
              (value) => (
                <Pressable
                  key={value}
                  accessibilityRole="radio"
                  accessibilityState={{ checked: frequency === value }}
                  disabled={sent.current}
                  style={[
                    styles.frequency,
                    frequency === value && styles.selectedFrequency,
                  ]}
                  onPress={() => applyFrequency(value)}
                >
                  <Text style={styles.body}>
                    {t(`plugins.frequency_${value}`)}
                  </Text>
                </Pressable>
              ),
            )}
          </View>
          {frequency === "daily" || frequency === "weekdays" ? (
            <TextInput
              accessibilityLabel={t("plugins.automationTime")}
              value={clock}
              placeholder="09:00"
              placeholderTextColor={colors.textPlaceholder}
              maxLength={5}
              autoCorrect={false}
              editable={!sent.current}
              onChangeText={(value) => {
                setClock(value);
                if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) return;
                const [hour, minute] = value.split(":").map(Number);
                setDraft((d) => ({
                  ...d,
                  cronExpr: `${minute} ${hour} * * ${frequency === "weekdays" ? "1-5" : "*"}`,
                }));
              }}
              style={styles.input}
            />
          ) : frequency === "interval" ? (
            <>
              <Text style={styles.body}>{t("plugins.automationInterval")}</Text>
              <TextInput
                accessibilityLabel={t("plugins.automationInterval")}
                placeholder={
                  draft.sourceIntervalMs
                    ? String(draft.sourceIntervalMs / 60000)
                    : ""
                }
                placeholderTextColor={colors.textPlaceholder}
                value={draft.intervalMinutes}
                keyboardType="number-pad"
                editable={!sent.current}
                onChangeText={(intervalMinutes) =>
                  setDraft((d) => ({
                    ...d,
                    intervalMinutes,
                    intervalMinutesTouched: true,
                  }))
                }
                style={styles.input}
              />
            </>
          ) : (
            <>
              <Text style={styles.body}>{t("plugins.automationCron")}</Text>
              <TextInput
                accessibilityLabel={t("plugins.automationCron")}
                value={draft.cronExpr}
                autoCapitalize="none"
                autoCorrect={false}
                editable={!sent.current}
                onChangeText={(cronExpr) =>
                  setDraft((d) => ({ ...d, cronExpr }))
                }
                style={styles.input}
              />
            </>
          )}
          <TextInput
            accessibilityLabel={t("plugins.automationTimezone")}
            value={draft.timezone}
            autoCapitalize="none"
            autoCorrect={false}
            editable={!sent.current}
            onChangeText={(timezone) => setDraft((d) => ({ ...d, timezone }))}
            style={styles.input}
          />
          <Pressable
            accessibilityRole="button"
            disabled={sent.current}
            style={styles.row}
            onPress={() => setPicker(true)}
          >
            <Text style={styles.body}>
              {modelName || t("plugins.taskModel")}
            </Text>
          </Pressable>
          {validation ? (
            <Text style={styles.hint}>{validation.message}</Text>
          ) : null}
          {unknown ? (
            <Text style={styles.hint}>
              {t("plugins.automationUnconfirmed")}
            </Text>
          ) : null}
          {busy ? <ActivityIndicator color={colors.textSecondary} /> : null}
          <View style={styles.buttons}>
            <Pressable
              accessibilityRole="button"
              style={styles.row}
              onPress={onClose}
            >
              <Text style={styles.body}>{t("plugins.cancel")}</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              disabled={
                sent.current ||
                !!validation ||
                !draft.model ||
                !draft.providerId
              }
              style={styles.row}
              onPress={() => void save()}
            >
              <Text style={styles.body}>{t("plugins.saveConfiguration")}</Text>
            </Pressable>
          </View>
        </ScrollView>
      </SheetModal>
      <ModelPickerSheet
        visible={pickerVisible}
        onClose={() => setPickerVisible(false)}
        onClosed={() => setPicker(false)}
        agentKind={draft.agentKind === "acp" ? "claude-code" : draft.agentKind}
        providers={providers.providers}
        providersReady={providers.ready}
        providersUnsupported={providers.unsupported}
        modelVisibilityOverrides={providers.modelVisibilityOverrides}
        flatOptions={[]}
        capabilities={null}
        activeModelId={draftIsPluginEngine ? "" : draft.model}
        selectedProviderId={draftIsPluginEngine ? null : (draft.providerId || null)}
        selectedEffort={draftIsPluginEngine ? "" : draft.effort}
        selectedFastMode={draftIsPluginEngine ? false : draft.fastMode}
        loading={providers.loading && allPluginEngines.length === 0}
        disabled={busy || sent.current}
        hidePermissionTrigger
        activePermissionMode=""
        permissionOptions={[]}
        onSelectPermissionMode={() => {}}
        onSelectFlatModel={() => {}}
        onSelectProviderRow={() => {}}
        keyboardAvoidingBehavior={Platform.OS === "ios" ? "padding" : "height"}
        emptyHint={t("plugins.modelsUnavailable")}
        unified={{
          // 旧版电脑不认运行位置，不能把远程模型列出来再悄悄在本机运行。
          remote: remoteSupported
            ? {
                catalogs: remoteCatalogs,
                selectedDeviceId: draft.modelAgentDeviceId || null,
                hostDeviceId: deviceId,
              }
            : undefined,
          scope: JSON.stringify([owner.accountKey, deviceId]),
          agents: ["claude-code", "codex", "pi"],
          loadCapabilities: async (kind) => {
            const caps = normalizeMobileAgentCapabilities(
              await maker.getCapabilities(kind),
            );
            if (!caps) throw new Error("CAPABILITIES_UNAVAILABLE");
            return caps;
          },
          ...(allPluginEngines.length > 0 || activePluginEngine
            ? {
                pluginEngines: {
                  engines: allPluginEngines,
                  active: activePluginEngine,
                  onOpen: onPluginEnginesOpen,
                  onSelect: async (selection) => {
                    assertCurrent();
                    setDraft((d) => ({
                      ...d,
                      agentKind: "acp",
                      modelAgentKind: "acp",
                      modelAgentDeviceId: selection.deviceId || undefined,
                      model: selection.modelId || PLUGIN_ENGINE_DEFAULT_MODEL,
                      providerId: selection.providerId,
                      effort: selection.effort || "",
                      fastMode: false,
                    }));
                    setPickerVisible(false);
                    return true;
                  },
                },
              }
            : {}),
          onSelect: async (value, source) => {
            assertCurrent();
            setDraft((d) => ({
              ...d,
              ...(source?.deviceId
                ? { modelAgentKind: value.agent, modelAgentDeviceId: source.deviceId }
                : { modelAgentKind: undefined, modelAgentDeviceId: undefined }),
              agentKind: value.agent,
              model: value.modelId,
              providerId: value.providerId,
              effort: value.effort || "",
              fastMode: value.fast,
            }));
            setPickerVisible(false);
            return true;
          },
        }}
      />
    </>
  );
}
const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    sheet: {
      backgroundColor: colors.surfaceElevated,
      padding: spacing.lg,
      gap: spacing.md,
    },
    checkRow: { flexDirection: "row", alignItems: "center", gap: spacing.md, minHeight: 44 },
    checkLabel: { flex: 1, fontSize: typeScale.body, lineHeight: lineHeight.body,
      fontWeight: fontWeight.medium, color: colors.textPrimary },
    frequencies: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
    frequency: {
      minHeight: 44,
      justifyContent: "center",
      paddingHorizontal: spacing.sm,
      borderRadius: radius.control,
      borderWidth: 1,
      borderColor: colors.border,
    },
    selectedFrequency: {
      backgroundColor: colors.surfaceChip,
      borderColor: colors.borderStrong,
    },
    buttons: { flexDirection: "row", gap: spacing.lg },
    row: { minHeight: 44, paddingVertical: spacing.sm },
    title: {
      fontSize: typeScale.title,
      lineHeight: lineHeight.title,
      fontWeight: fontWeight.semibold,
      color: colors.textPrimary,
    },
    body: {
      fontSize: typeScale.body,
      lineHeight: lineHeight.body,
      fontWeight: fontWeight.regular,
      color: colors.textPrimary,
    },
    hint: {
      fontSize: typeScale.footnote,
      lineHeight: lineHeight.bodySmall,
      fontWeight: fontWeight.regular,
      color: colors.textTertiary,
    },
    input: {
      fontSize: typeScale.bodySmall,
      lineHeight: lineHeight.bodySmall,
      fontWeight: fontWeight.regular,
      color: colors.textPrimary,
      borderColor: colors.border,
      borderWidth: StyleSheet.hairlineWidth,
      borderRadius: radius.control,
      minHeight: 44,
      padding: spacing.sm,
    },
  });
