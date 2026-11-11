import { goBackGuarded } from "@/utils/backGuard";
import { useEffect, useRef, useState } from "react";
import { Alert, Pressable, View } from "react-native";
import { useRouter } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import { useTranslation } from "react-i18next";
import type { PluginUsageSummary, RemoteResource } from "@cindy/device-link";
import { Text } from "@/components/AppText";
import { SimpleStackHeader, simpleScreenSafeAreaEdges } from "@/platform/chrome/SimpleStackHeader";
import { PluginDetailView } from "@/plugins/PluginDetailView";
import { pluginDetailModel } from "@/plugins/pluginDetailModel";
import { PluginManagementConfirmation } from "@/plugins/PluginManagementConfirmation";
import { PluginNotice } from "@/plugins/PluginNotice";
import { PluginSettingsCard } from "@/plugins/PluginSettingsCard";
import type { PluginSettingsClientOptions } from "@/plugins/pluginSettingsClient";
import type { PluginManagementController, PluginManagementState } from "@/plugins/pluginManagementController";
import type { HostedRemoteCollectionItem } from "@/device-link/remoteResources";
import { spacing, useTheme } from "@/theme";

/** Stable order for QA Next; all data/receipts are synthetic and never sent to a Host. */
export const PLUGIN_NOTICE_SCENARIOS = [
  "ready", "disabled", "loading", "setupRequired", "setupRequiredFallback", "setupExpired", "setupUnknown", "crashed",
  "offline", "loadFailed", "retired", "approvalRequired", "builtinRecovery", "fused",
  "managementRunning", "managementUnknown", "managementFailed", "managementUnsupported", "managementReadFailed",
  "offline-managementUnknown", "loadFailed-managementRunning", "fused-managementFailed", "managementUnknownUnsupported",
  "settingsLoadFailed", "settingsReadFailed", "settingsOperationFailed", "settingsResultUnknown", "settingsAuthorization", "settingsComputerCallback", "settingsUpdateRequired",
  "pluginNotice", "managementCancelled", "managementSucceeded", "managementSucceededReadFailed", "confirmation",
] as const;

export function PluginNoticePreview({ scenario, settingsOptions }: { scenario: string; settingsOptions: PluginSettingsClientOptions }) {
  const { colors } = useTheme(), router = useRouter();
  const initial = Math.max(0, PLUGIN_NOTICE_SCENARIOS.indexOf(scenario as typeof PLUGIN_NOTICE_SCENARIOS[number]));
  const [index, setIndex] = useState(initial), [reset, setReset] = useState(0);
  useEffect(() => { setIndex(initial); setReset((value) => value + 1); }, [initial]);
  return <SafeAreaView edges={simpleScreenSafeAreaEdges()} style={{ flex: 1, backgroundColor: colors.surface }}>
    <SimpleStackHeader title={`QA ${index + 1}/${PLUGIN_NOTICE_SCENARIOS.length}`} onBack={() => goBackGuarded(router)} right={
      <View style={{ flexDirection: "row", gap: spacing.sm }}>
        <Pressable testID="qa.plugin.reset" accessibilityRole="button" accessibilityLabel="QA Reset" onPress={() => setReset((value) => value + 1)} style={{ minHeight: 44, justifyContent: "center", paddingHorizontal: spacing.xs }}><Text style={{ color: colors.textPrimary }}>Reset</Text></Pressable>
        <Pressable testID="qa.plugin.next" accessibilityRole="button" accessibilityLabel="QA Next" onPress={() => { setIndex((value) => (value + 1) % PLUGIN_NOTICE_SCENARIOS.length); setReset(0); }} style={{ minHeight: 44, justifyContent: "center", paddingHorizontal: spacing.xs }}><Text style={{ color: colors.textPrimary }}>Next</Text></Pressable>
      </View>
    } />
    <NoticeScene key={`${index}:${reset}`} scenario={PLUGIN_NOTICE_SCENARIOS[index]} settingsOptions={settingsOptions} />
  </SafeAreaView>;
}

function NoticeScene({ scenario, settingsOptions }: { scenario: string; settingsOptions: PluginSettingsClientOptions }) {
  const { t } = useTranslation();
  const [resolved, setResolved] = useState(false), [enabled, setEnabled] = useState(scenario !== "disabled"), [feedback, setFeedback] = useState("");
  const [toast, setToast] = useState(scenario === "pluginNotice" ? "QA · Plugin notification" : "");
  useEffect(() => { if (!toast) return; const timer = setTimeout(() => setToast(""), 4000); return () => clearTimeout(timer); }, [toast]);
  const current = resolved ? "ready" : scenario;
  const online = !current.startsWith("offline"), loading = current === "loading", failed = current.startsWith("loadFailed");
  const required = current === "setupRequired" || current === "setupRequiredFallback", expired = current === "setupExpired", unknown = current === "setupUnknown";
  const usage: PluginUsageSummary = {
    taskUsable: true, hasSettings: required || expired || unknown || current.startsWith("settings"), builtin: current === "builtinRecovery",
    retired: current === "retired", approvalRequired: current === "approvalRequired" || current === "builtinRecovery",
    setup: { state: required || expired ? "required" : unknown ? "unknown" : "ready", missing: required ? ["QA account"] : [], expired: expired ? ["QA account"] : [] },
    ...(current.startsWith("fused") ? { runtimeIssue: "fused" as const } : current === "crashed" ? { runtimeIssue: "crashed" as const } : {}),
  };
  const row: HostedRemoteCollectionItem = { key: `qa-notice:${scenario}`, host: { deviceId: "qa-only", deviceName: "QA Mac" }, item: {
    ref: { collectionId: "plugins", kind: "plugin", id: "qa-notice" }, revision: "qa", display: { title: "QA Plugin · Synthetic" }, links: [],
    actions: [{ id: enabled ? "disable" : "enable", label: "QA toggle" }],
  } };
  const resource: RemoteResource = { ...row.item, blocks: [{ id: "capabilities", primitive: "plugin-capabilities", fallbackMarkdown: "", data: { usage, details: [{ key: "author", title: "Author", value: "QA fixture" }] } }] };
  const model = pluginDetailModel(row, resource, online, loading, failed);
  const outcome: PluginManagementState["outcome"] = current.includes("managementRunning") ? "running" : current.includes("managementUnknown") ? "unknown" : current.includes("managementFailed") ? "failed" : current === "confirmation" ? "confirmation" : current === "managementCancelled" ? "cancelled" : current.startsWith("managementSucceeded") ? "succeeded" : "idle";
  const state: PluginManagementState = { outcome, capability: current === "managementUnsupported" || current === "managementUnknownUnsupported" ? "unsupported" : "supported", online, busy: false,
    operationId: "qa-operation", snapshot: null, receipt: current === "confirmation" ? { operationId: "qa-operation", phase: "confirmation", consent: {
      requestId: "qa-consent", origin: "local-file", originLabel: "QA only", initiator: "user", facts: { kind: "install", ghostId: "qa-notice", name: "QA Plugin", version: "1.0.0", permissions: [{ key: "qa-network", kind: "network", labelKey: "networkHost", labelArgs: { host: "api.example.com" }, detail: "QA fixture · api.example.com" }] },
    } } as PluginManagementState["receipt"] : null,
    errorCode: current === "managementReadFailed" || current === "managementSucceededReadFailed" ? "QA_READ_FAILED" : null,
  };
  const stateRef = useRef(state); stateRef.current = state;
  const recover = (action: string) => { setFeedback(`QA · ${action} · local only`); setResolved(true); };
  const controller = { getState: () => stateRef.current, refresh: async () => recover("refresh"), reconcile: async () => recover("check result"), cancel: async () => { recover("cancel"); }, answer: async (accepted: boolean) => recover(accepted ? "allow" : "reject") } as unknown as PluginManagementController;
  useEffect(() => { if (outcome === "failed") Alert.alert("QA · " + t("plugins.notice.title.managementFailed")); }, [outcome, t]);
  const errorKind = current === "settingsLoadFailed" || current === "settingsReadFailed" ? "readFailed" : current === "settingsOperationFailed" ? "writeFailed" : current === "settingsResultUnknown" ? "resultUnknown" : current.startsWith("settings") ? "authorization" : undefined;
  const errorDetail = current === "settingsResultUnknown" ? "plugins.management.settingsResultUnknown" : current === "settingsOperationFailed" ? "plugins.management.settingsOperationFailed" : current === "settingsReadFailed" || current === "settingsLoadFailed" ? "plugins.management.settingsUnavailable" : current === "settingsComputerCallback" ? "plugins.computerAuthorizationHint" : current === "settingsUpdateRequired" ? "plugins.oauthUpdateRequired" : "plugins.authorizationCheckHint";
  const hasForm = current === "setupRequired" || expired || unknown || (!!errorKind && current !== "settingsLoadFailed");
  const settingsContent = hasForm || errorKind ? <View style={{ gap: spacing.md }}>
    {errorKind ? <PluginNotice compact unavailable={current === "settingsLoadFailed"} testID="plugins.settingsError" title={t("plugins.notice.title." + errorKind)} detail={errorKind === "readFailed" ? undefined : t(errorDetail)} icon="warning" actions={errorKind === "authorization" ? undefined : [{ label: t("plugins.management.settingsReload"), testID: "plugins.settingsReload", onPress: () => recover("reload settings, no write replay") }]} /> : null}
    {hasForm ? <PluginSettingsCard {...settingsOptions} active generation="qa-notice" onConfirm={async () => false} onDirectory={async () => null} onNotice={setToast} /> : null}
  </View> : undefined;
  return <View style={{ flex: 1 }}>
    <PluginDetailView row={row} enabled={enabled} online={online} busy={loading || state.busy || ["running", "confirmation", "unknown"].includes(outcome)} statusRecoveryBusy={loading || state.busy} model={model} settingsOpen={false}
      managementNotice={outcome === "unknown" ? { testID: "plugins.managementUnknown", title: t("plugins.notice.title.resultUnknown"), icon: "warning", actions: [{ label: t("plugins.management.checkResult"), testID: "plugins.checkManagementResult", disabled: !online || state.busy, onPress: () => { void controller.reconcile(); } }] } : undefined}
      previewLabel={`QA fixture · ${scenario}${errorKind ? " · bridge-only failure; no page reply" : ""}${feedback ? " · " + feedback : ""}`} settingsContent={settingsContent}
      onEnabledChange={(value) => { setEnabled(value); setFeedback("QA · local switch"); }}
      onOpen={() => Alert.alert("QA only", "No Host was opened")}
      onResolveStatus={() => recover(online ? "retry" : "connect")}
      onNewTask={() => Alert.alert("QA only", "New task selected; no task created")}
      onChooseTask={() => Alert.alert("QA only", "Choose task selected; no navigation")}
    />
    {toast ? <View pointerEvents="none" style={{ position: "absolute", top: spacing.md, left: spacing.lg + spacing.xs, right: spacing.lg + spacing.xs }}><PluginNotice testID="plugins.transientNotice" title={toast} /></View> : null}
    {current === "confirmation" ? <PluginManagementConfirmation state={state} controller={controller} deviceName="QA Mac" active /> : null}
  </View>;
}
