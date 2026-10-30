import { useEffect, useRef, useState } from "react";
import { Alert, Platform } from "react-native";
import { useTranslation } from "react-i18next";
import type {
  PluginModelPickerRequest,
  PluginModelSelection,
} from "@cindy/device-link";
import { useDeviceProviders } from "@/device-link/useDeviceProviders";
import { useMobileMakerTransport } from "@/device-link/useMobileMakerTransport";
import {
  getMobileAuthOwner,
  isMobileAuthOwnerCurrent,
} from "@/auth/authOwnerGeneration";
import { ModelPickerSheet } from "@/session/ModelPickerSheet";
import type { MobileModelMemoryAccessors } from "@/session/draftModelMemory";
import type { MobileModelConfiguration } from "@/session/unifiedMobileModels";
import {
  normalizeMobileAgentCapabilities,
  type MobileAgentCapabilities,
} from "@/session/agentCapabilities";

/** Native selector reads the execution computer's catalog; no local defaults are written. */
export function PluginModelPicker({
  request,
  deviceId,
  onAnswer,
}: {
  request: PluginModelPickerRequest;
  deviceId: string;
  onAnswer(
    route: PluginModelSelection | null,
  ): Promise<{ handled: boolean; accepted: boolean }>;
}) {
  const { t } = useTranslation();
  const providers = useDeviceProviders(deviceId),
    maker = useMobileMakerTransport(deviceId);
  const [capabilities, setCapabilities] =
    useState<MobileAgentCapabilities | null>(null);
  const [busy, setBusy] = useState(false);
  const [selection, setSelection] = useState<MobileModelConfiguration | null>(() =>
    request.initial ? {
      agent: request.initial.agentKind === "cc" ? "claude-code" : request.initial.agentKind,
      providerId: request.initial.providerId,
      modelId: request.initial.model,
      effort: request.initial.effort,
      fast: request.initial.fastMode,
    } : null,
  );
  const modelMemory = useRequestModelMemory();
  const owner = useRef(getMobileAuthOwner()).current,
    alive = useRef(true),
    lock = useRef(false),
    finished = useRef(false);
  const current = () => alive.current && isMobileAuthOwnerCurrent(owner);
  const agent =
    selection?.agent ?? "codex";
  useEffect(() => {
    alive.current = true;
    void maker
      .getCapabilities(agent)
      .then((raw) => {
        if (current()) setCapabilities(normalizeMobileAgentCapabilities(raw));
      })
      .catch(() => {});
    return () => {
      alive.current = false;
    };
  }, [maker, agent]);
  const answer = async (route: PluginModelSelection | null) => {
    if (lock.current || finished.current || !current()) return false;
    lock.current = true;
    setBusy(true);
    try {
      const result = await onAnswer(route);
      if (result.accepted) {
        finished.current = true;
        return true;
      }
      if (current()) Alert.alert(t("plugins.modelsUnavailable"));
    } catch {
      if (current()) Alert.alert(t("plugins.modelsUnavailable"));
    } finally {
      lock.current = false;
      if (current()) setBusy(false);
    }
    return false;
  };
  return (
    <ModelPickerSheet
      visible
      title={`${request.ghostName} · ${t("models.picker.title")}`}
      onClose={() => {
        void answer(null);
      }}
      agentKind={agent}
      providers={providers.providers}
      providersReady={providers.ready}
      providersUnsupported={providers.unsupported}
      modelVisibilityOverrides={providers.modelVisibilityOverrides}
      flatOptions={[]}
      capabilities={capabilities}
      activeModelId={selection?.modelId ?? ""}
      selectedProviderId={selection?.providerId ?? null}
      selectedEffort={selection?.effort ?? ""}
      selectedFastMode={selection?.fast ?? false}
      modelMemory={modelMemory}
      loading={providers.loading}
      disabled={busy}
      hidePermissionTrigger
      activePermissionMode=""
      permissionOptions={[]}
      onSelectPermissionMode={() => {}}
      onSelectFlatModel={() => {}}
      onSelectProviderRow={() => {}}
      keyboardAvoidingBehavior={Platform.OS === "ios" ? "padding" : "height"}
      emptyHint={t("plugins.modelsUnavailable")}
      unified={{
        preferenceScope: "request",
        scope: JSON.stringify([owner.accountKey, deviceId]),
        agents: ["claude-code", "codex", "pi"],
        loadCapabilities: async (kind) => {
          const result = normalizeMobileAgentCapabilities(
            await maker.getCapabilities(kind),
          );
          if (!result || !current())
            throw new Error("CAPABILITIES_UNAVAILABLE");
          return result;
        },
        onConfigure: async (value) => {
          setSelection(value);
          return true;
        },
        onSelect: (value) =>
          answer({
            agentKind: value.agent === "claude-code" ? "cc" : value.agent,
            providerId: value.providerId,
            model: value.modelId,
            effort: value.effort ?? "",
            fastMode: value.fast,
          }),
      }}
    />
  );
}

function useRequestModelMemory(): MobileModelMemoryAccessors {
  const [memory, setMemory] = useState<Record<string, { effort?: string; fast?: boolean | "ultrafast" }>>({});
  const key = (...parts: string[]) => JSON.stringify(parts);
  const edit = (id: string, patch: { effort?: string; fast?: boolean | "ultrafast" }) =>
    setMemory((current) => ({ ...current, [id]: { ...current[id], ...patch } }));
  return {
    getEffort: (agent, provider, model) => memory[key(agent, provider, model)]?.effort,
    setEffort: (agent, provider, model, effort) => edit(key(agent, provider, model), { effort }),
    clearEffort: (agent, provider, model) => edit(key(agent, provider, model), { effort: undefined }),
    getFast: (agent, provider, model) => memory[key(agent, provider, model)]?.fast,
    setFast: (agent, provider, model, fast) => edit(key(agent, provider, model), { fast }),
    clearFast: (agent, provider, model) => edit(key(agent, provider, model), { fast: undefined }),
  };
}
