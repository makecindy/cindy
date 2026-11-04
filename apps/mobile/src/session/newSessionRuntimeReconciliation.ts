import type { Dispatch, SetStateAction } from "react";
import type { DeviceProvidersPayload } from "@/device-link/deviceProvidersCache";
import { isCindyAutoModelId } from "@cindy/model-providers/provider-identity";
import { modelNeedsReselection } from "./modelReselection";
import {
  assertSubmitModelResolved,
  reconcileEffortAfterFallback,
  resolveRecentModelAndProvider,
  type NewSessionDraft,
  type SubmitGuardCatalog,
} from "./newSession";
import {
  buildMobileModelSections,
  flattenProviderSections,
  isFastRestorable,
  type ProviderModelRow,
} from "./providerModelSections";
import type { draftModelMemoryFor } from "./draftModelMemory";

type HiddenModelText = (key: string, options: { model: string }) => string;

/** Background catalog refresh preserves an untouched selection unless its source moved. */
export function reconcileNewSessionCatalogDraft(
  current: NewSessionDraft,
  modelRows: readonly ProviderModelRow[],
  deviceProviders: DeviceProvidersPayload,
): NewSessionDraft {
  if (
    !current.providerId &&
    !(current.agentKind === "pi" && isCindyAutoModelId(current.model))
  )
    return current;
  const resolved = resolveRecentModelAndProvider(
    modelRows,
    { model: current.model, providerId: current.providerId },
    current.agentKind,
    true,
    deviceProviders.providers,
    deviceProviders.modelVisibilityOverrides,
  );
  const pairChanged =
    resolved.model !== current.model ||
    resolved.providerId !== current.providerId;
  if (!pairChanged) return current;
  // 组合变化时同步校准 effort(codex review P2)、fastMode 保守置 false(可手动重开)。
  return {
    ...current,
    model: resolved.model,
    providerId: resolved.providerId,
    effort: reconcileEffortAfterFallback(modelRows, resolved, current.effort),
    ...(current.fastMode ? { fastMode: false } : {}),
  };
}

/** Normal and goal creation use the same final source/model/runtime decision. */
export function reconcileNewSessionSubmitDraft(
  effectiveDraft: NewSessionDraft,
  g: SubmitGuardCatalog,
  hasFast: () => boolean,
  t: HiddenModelText,
): NewSessionDraft {
  if (
    g.catalogKnown &&
    modelNeedsReselection(
      g.visibilityOverrides,
      effectiveDraft.agentKind,
      effectiveDraft.model,
      effectiveDraft.providerId,
    )
  ) {
    throw new Error(
      t("session.common.modelHiddenReselect", { model: effectiveDraft.model }),
    );
  }
  const resolved = resolveRecentModelAndProvider(
    g.rows,
    { model: effectiveDraft.model, providerId: effectiveDraft.providerId },
    effectiveDraft.agentKind,
    g.catalogKnown,
    g.providers,
    g.visibilityOverrides,
  );
  assertSubmitModelResolved(resolved, effectiveDraft.model);
  const pairChanged =
    resolved.model !== effectiveDraft.model ||
    resolved.providerId !== effectiveDraft.providerId;
  // 目录就绪时**始终**按 fresh 精确行校准(codex review P2:来源未变时也按
  // 新目录校准运行选项)——provider revision 可能只改能力不删行(撤销 effort
  // 档位 / Fast 支持),组合不变沿用旧 effort/fastMode 会发送目录已不支持的
  // 参数被被控端拒绝。fail-open(catalogKnown=false)时 rows 不可信,保持
  // 信任语义(不校准,仅组合变化保守关 fast)。
  return {
    ...effectiveDraft,
    ...resolved,
    ...(g.catalogKnown
      ? {
          effort: reconcileEffortAfterFallback(
            g.rows,
            resolved,
            effectiveDraft.effort,
          ),
          ...(effectiveDraft.fastMode &&
          (pairChanged ||
            !resolved.providerId ||
            !isFastRestorable(
              effectiveDraft.agentKind,
              resolved.providerId,
              resolved.model,
              g.rows,
              hasFast(),
              effectiveDraft.fastMode,
            ))
            ? { fastMode: false }
            : {}),
        }
      : pairChanged
        ? {
            ...(effectiveDraft.fastMode ? { fastMode: false } : {}),
          }
        : {}),
  };
}

/** Revalidate against the newly authenticated catalog before the background handoff. */
export function revalidateNewSessionDraftAfterAuth(
  effectiveDraft: NewSessionDraft,
  fresh: DeviceProvidersPayload,
  hasFast: () => boolean,
  t: HiddenModelText,
): Partial<NewSessionDraft> {
  const rows = flattenProviderSections(
    buildMobileModelSections({
      providers: fresh.providers,
      agentKind: effectiveDraft.agentKind,
      visibilityOverrides: fresh.modelVisibilityOverrides,
      selectedModelId: effectiveDraft.model,
      selectedProviderId: effectiveDraft.providerId,
    }).sections,
  );
  const next = reconcileNewSessionSubmitDraft(
    effectiveDraft,
    {
      rows,
      providers: fresh.providers,
      catalogKnown: true,
      visibilityOverrides: fresh.modelVisibilityOverrides,
      genAt: 0,
    },
    hasFast,
    t,
  );
  return {
    model: next.model,
    providerId: next.providerId,
    effort: next.effort,
    ...(next.fastMode !== effectiveDraft.fastMode
      ? { fastMode: next.fastMode }
      : {}),
  };
}

/** Restore a remembered speed only when the target Agent's current capabilities allow it. */
export function restoreNewSessionFastPreference({
  selectedDeviceId,
  draft,
  activeSourceId,
  capabilitiesKnown,
  catalogReady,
  modelRows,
  hasFast,
  draftMemory,
  setDraft,
}: {
  selectedDeviceId: string;
  draft: NewSessionDraft;
  activeSourceId: string | null;
  capabilitiesKnown: boolean;
  catalogReady: boolean;
  modelRows: readonly ProviderModelRow[];
  hasFast: () => boolean;
  draftMemory: Pick<ReturnType<typeof draftModelMemoryFor>, "getFast">;
  setDraft: Dispatch<SetStateAction<NewSessionDraft>>;
}): void {
  if (!selectedDeviceId) return;
  // 来源 id 与 changeSelectedFastMode 同口径:显式选了来源用 providerId,默认路由
  // (null)草稿可用推断来源(activeSourceIdRef)开启 Fast——撤销检查不得漏掉它
  // (codex review P2:目录 revision 改变默认来源/移除 Fast 支持时,null-provider
  // 草稿仍在发 fastMode:true)。
  const pid = draft.providerId ?? activeSourceId;
  if (!pid) return;
  const capsKnown = capabilitiesKnown;
  if (draft.fastMode) {
    if (
      capsKnown &&
      catalogReady &&
      !isFastRestorable(
        draft.agentKind,
        pid,
        draft.model,
        modelRows,
        hasFast(),
        draft.fastMode,
      )
    ) {
      setDraft((current) =>
        current.fastMode &&
        current.agentKind === draft.agentKind &&
        current.model === draft.model &&
        current.providerId === draft.providerId
          ? { ...current, fastMode: false }
          : current,
      );
    }
    return;
  }
  const rememberedFast =
    draftMemory.getFast(draft.agentKind, pid, draft.model) ?? false;
  if (!rememberedFast) return;
  if (
    !isFastRestorable(
      draft.agentKind,
      pid,
      draft.model,
      modelRows,
      hasFast(),
      rememberedFast,
    )
  )
    return;
  setDraft((current) =>
    !current.fastMode &&
    current.agentKind === draft.agentKind &&
    current.model === draft.model &&
    current.providerId === draft.providerId
      ? { ...current, fastMode: rememberedFast }
      : current,
  );
}
