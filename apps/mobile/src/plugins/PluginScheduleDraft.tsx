import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  AppState,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from "react-native";
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
  const link = useDeviceLink(),
    maker = useMobileMakerTransport(deviceId),
    providers = useDeviceProviders(deviceId);
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
  const [picker, setPicker] = useState(false),
    [busy, setBusy] = useState(false),
    [unknown, setUnknown] = useState(false);
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
        [buildMobileScheduleInput(draft)],
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
  const modelName =
    providers.providers
      .find((provider) => provider.id === draft.providerId)
      ?.models[draft.agentKind]?.find((model) => model.id === draft.model)
      ?.name ?? draft.model;
  return (
    <>
      <SheetModal
        visible={!picker}
        keyboardAvoiding
        onBackdropPress={() => {}}
        onRequestClose={onClose}
      >
        <ScrollView
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={styles.sheet}
        >
          <Text style={styles.title}>{t("plugins.automationDraft")}</Text>
          <Text style={styles.hint}>
            {intent.ghostName} · {t("plugins.automationDraftHint")}
          </Text>
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
        visible={picker}
        onClose={() => setPicker(false)}
        agentKind={draft.agentKind}
        providers={providers.providers}
        providersReady={providers.ready}
        providersUnsupported={providers.unsupported}
        modelVisibilityOverrides={providers.modelVisibilityOverrides}
        flatOptions={[]}
        capabilities={null}
        activeModelId={draft.model}
        selectedProviderId={draft.providerId || null}
        selectedEffort={draft.effort}
        selectedFastMode={draft.fastMode}
        loading={providers.loading}
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
            assertCurrent();
            setDraft((d) => ({
              ...d,
              agentKind: value.agent,
              model: value.modelId,
              providerId: value.providerId,
              effort: value.effort || "",
              fastMode: value.fast,
            }));
            setPicker(false);
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
