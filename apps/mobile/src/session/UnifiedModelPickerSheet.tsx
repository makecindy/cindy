import { mobileCostMarks, quotaCountdown } from "./mobileModelRowPresentation";
import { useMobileModelQuotas } from "./useMobileModelQuotas";
import { useEffect, useMemo, useRef, useState } from "react";
import * as ExpoCrypto from "expo-crypto";
import { useTranslation } from "react-i18next";
import type { MobileProviderMarkProps } from "./MobileProviderMark";
import type { AgentKind } from "@cindy/model-providers/types";
import type { UnifiedModelEntry } from "@cindy/model-providers";
import type { MobileAgentCapabilities } from "./agentCapabilities";
import type { ModelPickerSheetProps } from "./ModelPickerSheet";
import { buildMobileModelSections } from "./providerModelSections";
import { useMobileModelPreferences } from "./mobileModelPreferences";
import {
  addModelFavorite,
  matchesEntry,
  mobileUnifiedEntries,
  modelKey,
  resolveMobileModelConfig,
  sameConfiguration,
  type MobileModelConfiguration,
  type MobileModelFavorite,
} from "./unifiedMobileModels";
import { useDraftModelMemoryVersion } from "./draftModelMemory";
import { useSessionModelMirrorVersion } from "./sessionModelMirror";
import { UnifiedModelPickerView } from "./UnifiedModelPickerView";
import { budgetRowDisabled, presentPickerPrice } from "./modelPickerRows";
import { mobileWeeklyQuota } from "./mobileModelRowPresentation";

function createFavoriteUid(): string {
  const cryptoWithUuid = globalThis.crypto as Crypto | undefined;
  if (typeof cryptoWithUuid?.randomUUID === "function") return cryptoWithUuid.randomUUID();
  const expoWithUuid = ExpoCrypto as typeof ExpoCrypto & { randomUUID?: () => string };
  if (typeof expoWithUuid.randomUUID === "function") return expoWithUuid.randomUUID();
  const bytes = ExpoCrypto.getRandomBytes(16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export interface UnifiedMobilePickerOptions {
  currentSelection?: Pick<
    ModelPickerSheetProps,
    | "agentKind"
    | "activeModelId"
    | "selectedProviderId"
    | "selectedEffort"
    | "selectedFastMode"
  >;
  scope: string;
  agents: readonly AgentKind[];
  loadCapabilities(agent: AgentKind): Promise<MobileAgentCapabilities>;
  onSelect(configuration: MobileModelConfiguration): Promise<boolean>;
}
export interface UnifiedMobileRow {
  key: string;
  entry: UnifiedModelEntry;
  config: MobileModelConfiguration;
  favorite?: MobileModelFavorite;
  selected: boolean;
  disabled: boolean;
  subtitle: string;
  costMarks: string | null;
  effortLabel: string;
  quotaLabel: string | null;
  providerMark: MobileProviderMarkProps;
}
export interface UnifiedMobileGroup {
  key: string;
  title: string;
  rows: UnifiedMobileRow[];
}
export interface UnifiedMobilePickerViewProps {
  visible: boolean;
  onClose(): void;
  onBack?: () => void;
  title: string;
  testID: string;
  query: string;
  onQuery(value: string): void;
  filter: string;
  onFilter(value: string): void;
  filters: {
    id: string;
    label: string;
    providerMark?: MobileProviderMarkProps;
    quota?: { remaining: number; label: string };
  }[];
  groups: UnifiedMobileGroup[];
  busy: boolean;
  error: string | null;
  loading: boolean;
  emptyHint: string;
  onSelect(row: UnifiedMobileRow): void;
  onOptions(row: UnifiedMobileRow): void;
  options?: {
    row: UnifiedMobileRow;
    agents: AgentKind[];
    fastCapable: boolean;
    onChange(config: MobileModelConfiguration): void;
    favoritesDisabled: boolean;
    onFavorite(): void;
    onReset(): void;
    context: string;
    price: string | null;
  };
}
const ALL_AGENTS: readonly AgentKind[] = ["claude-code", "codex", "pi"];
export function UnifiedModelPickerSheet(
  p: ModelPickerSheetProps & { unified: UnifiedMobilePickerOptions },
) {
  const { t } = useTranslation();
  const countdown = (reset: number, now: number) => quotaCountdown(reset, now, unit => t(`models.unified.timeUnit.${unit}`));
  const { quotas, now } = useMobileModelQuotas(
    p.unified.scope,
    p.visible,
    p.providers,
  );
  const prefs = useMobileModelPreferences(p.unified.scope, p.visible);
  useDraftModelMemoryVersion();
  useSessionModelMirrorVersion();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [target, setTarget] = useState<{
    providerId: string;
    modelId: string;
    uid?: string;
  } | null>(null);
  const [caps, setCaps] = useState<
    Partial<Record<AgentKind, MobileAgentCapabilities>>
  >({});
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!p.visible) return;
    setQuery("");
    setFilter("all");
    setTarget(null);
    setError(null);
    let cancelled = false;
    setCaps({ [p.agentKind]: p.capabilities });
    for (const agent of p.unified.agents)
      void p.unified
        .loadCapabilities(agent)
        .then((value) => {
          if (!cancelled)
            setCaps((current) => ({ ...current, [agent]: value }));
        })
        .catch(() => {
          /* The catalog remains visible; selecting retries the authoritative read. */
        });
    return () => {
      cancelled = true;
    };
  }, [p.visible, p.unified.scope]);
  const entries = useMemo(
    () =>
      mobileUnifiedEntries(
        p.providers,
        p.unified.agents,
        p.modelVisibilityOverrides,
        !!p.existingSessionRoute,
        {
          providerId: p.selectedProviderId,
          modelId: p.activeModelId,
          agent: p.agentKind,
        },
      ),
    [
      p.providers,
      p.unified.agents,
      p.modelVisibilityOverrides,
      p.existingSessionRoute,
      p.selectedProviderId,
      p.activeModelId,
      p.agentKind,
    ],
  );
  const sourceId = buildMobileModelSections({
    providers: p.providers,
    agentKind: p.agentKind,
    selectedModelId: p.activeModelId,
    selectedProviderId: p.selectedProviderId,
    existingSessionRoute: p.existingSessionRoute,
    visibilityOverrides: p.modelVisibilityOverrides,
  }).activeSourceId;
  const selection: MobileModelConfiguration = {
    providerId: sourceId ?? "",
    modelId: p.activeModelId,
    agent: p.agentKind,
    effort: p.selectedEffort,
    fast: p.selectedFastMode,
  };
  // The visible selection may be a pending next-message engine switch. Keep
  // runtime truth separate, including its provider resolution and capabilities.
  const current = p.unified.currentSelection;
  const live: MobileModelConfiguration = current ? {
    providerId: buildMobileModelSections({
      providers: p.providers,
      agentKind: current.agentKind,
      selectedModelId: current.activeModelId,
      selectedProviderId: current.selectedProviderId,
      existingSessionRoute: p.existingSessionRoute,
      visibilityOverrides: p.modelVisibilityOverrides,
    }).activeSourceId ?? "",
    modelId: current.activeModelId,
    agent: current.agentKind,
    effort: current.selectedEffort,
    fast: current.selectedFastMode,
  } : selection;
  const fastCapable = (agent: AgentKind) => caps[agent]?.hasFastMode === true;
  const describe = (
    entry: UnifiedModelEntry,
    config: MobileModelConfiguration,
  ) => {
    const provider = p.providers.find((item) => item.id === entry.providerId);
    const identity =
      provider?.openAiAccount?.identity?.trim() ||
      provider?.subscriptionAccount?.identity?.trim();
    return [
      identity,
      config.effort
        ? t(`models.options.effortLevels.${config.effort}`, {
            defaultValue: config.effort,
          })
        : null,
    ]
      .filter(Boolean)
      .join(" · ");
  };
  const makeRow = (
    entry: UnifiedModelEntry,
    favorite?: MobileModelFavorite,
  ): UnifiedMobileRow => {
    const selected =
      entry.providerId === sourceId && matchesEntry(entry, p.activeModelId);
    const config = resolveMobileModelConfig(entry, {
      favorite,
      live: !favorite && selected ? selection : undefined,
      pinned: p.existingSessionRoute ? p.agentKind : undefined,
      override: prefs.value.engines[modelKey(entry.providerId, entry.modelId)],
      memory: p.modelMemory,
      fastCapable,
    });
    return {
      key: favorite?.uid ?? modelKey(entry.providerId, entry.modelId),
      entry,
      config,
      favorite,
      providerMark: (() => {
        const provider = p.providers.find(
          (item) => item.id === entry.providerId,
        );
        return {
          providerId: entry.providerId,
          name: provider?.name ?? entry.providerId,
          routing: provider?.routing,
          logoKind: provider?.logoKind,
        };
      })(),
      selected: !favorite && selected,
      disabled:
        !caps[config.agent] ||
        budgetRowDisabled(config.modelId, p.apiKeyStatus ?? "unknown"),
      subtitle: describe(entry, config),
      effortLabel: config.effort
        ? t(`models.options.effortLevels.${config.effort}`, {
            defaultValue: config.effort,
          })
        : "",
      costMarks: mobileCostMarks(
        p.providers.find((item) => item.id === entry.providerId),
        config.modelId,
        config.agent,
        p.pricing,
      ),
      quotaLabel: (() => {
        const q = quotas[entry.providerId];
        const modelQuota = q ? mobileWeeklyQuota(q.source, q.raw, now, entry.modelId) : null;
        return modelQuota
          ? [
              modelQuota.resetsAt ? countdown(modelQuota.resetsAt, now) : null,
              `${modelQuota.remaining}%`,
            ]
              .filter(Boolean)
              .join(" · ")
          : null;
      })(),
    };
  };
  const rows = entries.map((entry) => makeRow(entry));
  const favorites = prefs.value.favorites.flatMap((item) => {
    const entry = entries.find(
      (entry) =>
        entry.providerId === item.providerId &&
        matchesEntry(entry, item.modelId),
    );
    return entry ? [makeRow(entry, item)] : [];
  });
  const providerName = (id: string) => {
    const provider = p.providers.find((item) => item.id === id);
    if (!provider) return id;
    const identity =
      provider.openAiAccount?.identity?.trim() ||
      provider.subscriptionAccount?.identity?.trim();
    return [
      provider.name,
      identity && !provider.name.includes(identity) ? identity : null,
    ]
      .filter(Boolean)
      .join(" · ");
  };
  const matches = (row: UnifiedMobileRow) =>
    !query.trim() ||
    `${row.entry.displayName} ${row.entry.modelId} ${row.entry.description ?? ""} ${providerName(row.entry.providerId)}`
      .toLocaleLowerCase()
      .includes(query.trim().toLocaleLowerCase());
  const all = query.trim() || filter === "all";
  const filtered = rows.filter(
    (row) => matches(row) && (all || filter === row.entry.providerId),
  );
  const groups: UnifiedMobileGroup[] = [];
  const favoriteRows = favorites.filter(matches);
  if ((all || filter === "favorites") && favoriteRows.length)
    groups.push({
      key: "favorites",
      title: t("models.unified.favorites"),
      rows: favoriteRows,
    });
  const recommended =
    all && p.existingSessionRoute
      ? filtered
          .filter((row) => row.selected || row.config.agent === p.agentKind)
          .sort((a, b) => Number(b.selected) - Number(a.selected))
      : [];
  if (recommended.length)
    groups.push({
      key: "recommended",
      title: t("models.unified.recommended"),
      rows: recommended,
    });
  if (all || filter !== "favorites")
    for (const provider of p.providers) {
      const group = filtered.filter(
        (row) =>
          row.entry.providerId === provider.id && !recommended.includes(row),
      );
      if (group.length)
        groups.push({
          key: provider.id,
          title: providerName(provider.id),
          rows: group,
        });
    }
  const row = target
    ? target.uid
      ? favorites.find((row) => row.favorite?.uid === target.uid)
      : rows.find(
          (row) =>
            row.entry.providerId === target.providerId &&
            row.entry.modelId === target.modelId,
        )
    : undefined;
  useEffect(() => {
    if (target && !row) setTarget(null);
  }, [target, row]);
  const transact = async (action: () => Promise<void>) => {
    if (lock.current || p.disabled || !prefs.ready) return;
    lock.current = true;
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch {
      setError(t("models.unified.saveFailed"));
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };
  const select = (row: UnifiedMobileRow) => {
    if (row.disabled) return;
    void transact(async () => {
      if (await p.unified.onSelect(row.config)) p.onClose();
    });
  };
  const change = (config: MobileModelConfiguration, reset = false) => {
    if (!row) return;
    void transact(async () => {
      const appliesLive =
        row.selected || (!!row.favorite && sameConfiguration(row.config, live));
      if (appliesLive && !(await p.unified.onSelect(config))) return;
      try {
        if (row.favorite) {
          await prefs.save({
            ...prefs.value,
            favorites: prefs.value.favorites.map((item) =>
              item.uid === row.favorite!.uid
                ? { ...config, modelId: item.modelId, uid: item.uid }
                : item,
            ),
          });
        } else {
          const engines = { ...prefs.value.engines };
          const key = modelKey(row.entry.providerId, row.entry.modelId);
          if (reset) delete engines[key];
          else engines[key] = config.agent;
          await prefs.save({ ...prefs.value, engines });
          if (reset && p.modelMemory?.clearEffort)
            p.modelMemory.clearEffort(
              config.agent,
              config.providerId,
              config.modelId,
            );
          else if (config.effort)
            p.modelMemory?.setEffort(
              config.agent,
              config.providerId,
              config.modelId,
              config.effort,
            );
          if (reset && p.modelMemory?.clearFast)
            p.modelMemory.clearFast(
              config.agent,
              config.providerId,
              config.modelId,
            );
          else
            p.modelMemory?.setFast(
              config.agent,
              config.providerId,
              config.modelId,
              config.fast,
            );
        }
      } catch (error) {
        if (appliesLive) await p.unified.onSelect(row.selected ? selection : live);
        throw error;
      }
    });
  };
  const cap = row?.entry.capabilities[row.config.agent];
  const provider =
    row && p.providers.find((item) => item.id === row.entry.providerId);
  const price = row
    ? presentPickerPrice({
        pricing: p.pricing ?? null,
        provider: provider ?? null,
        modelId: row.config.modelId,
        agentKind: row.config.agent,
      })
    : null;
  return (
    <UnifiedModelPickerView
      visible={p.visible}
      onClose={p.onClose}
      onBack={
        row
          ? () => {
              setTarget(null);
              setError(null);
            }
          : undefined
      }
      title={row?.entry.displayName ?? t("models.picker.title")}
      testID={p.testID ?? "modelSheet"}
      query={query}
      onQuery={setQuery}
      filter={filter}
      onFilter={setFilter}
      filters={[
        { id: "all", label: t("models.unified.all") },
        ...(prefs.favoritesReady ? [{ id: "favorites", label: t("models.unified.favorites") }] : []),
        ...p.providers
          .filter((provider) =>
            entries.some((e) => e.providerId === provider.id),
          )
          .map((provider) => ({
            id: provider.id,
            label: providerName(provider.id),
            quota: quotas[provider.id]?.remaining !== undefined
              ? {
                  remaining: quotas[provider.id]!.remaining!,
                  label: [
                    t("session.menu.usage.week"),
                    t("session.menu.usage.remaining", {
                      percent: quotas[provider.id]!.remaining,
                    }),
                    quotas[provider.id]!.resetsAt
                      ? t("session.menu.usage.resets", {
                          time: countdown(
                            quotas[provider.id]!.resetsAt!,
                            now,
                          ),
                        })
                      : null,
                  ]
                    .filter(Boolean)
                    .join(" · "),
                }
              : undefined,
            providerMark: {
              providerId: provider.id,
              name: provider.name,
              routing: provider.routing,
              logoKind: provider.logoKind,
            },
          })),
      ]}
      groups={groups}
      busy={busy || !!p.disabled || !prefs.ready}
      error={error}
      loading={!!p.loading}
      emptyHint={p.emptyHint ?? t("models.picker.noResults")}
      onSelect={select}
      onOptions={(row) =>
        setTarget({
          providerId: row.entry.providerId,
          modelId: row.entry.modelId,
          uid: row.favorite?.uid,
        })
      }
      options={
        row
          ? {
              row,
              agents: row.entry.candidates.filter((agent) =>
                ALL_AGENTS.includes(agent),
              ),
              fastCapable:
                !!cap?.supportsFastMode && fastCapable(row.config.agent),
              onChange: change,
              context: [
                providerName(row.entry.providerId),
                cap?.contextWindow
                  ? t("models.picker.contextSuffix", {
                      size: `${Math.round(cap.contextWindow / 1000)}K`,
                    })
                  : null,
              ]
                .filter(Boolean)
                .join(" · "),
              price: price ? `${price.title}\n${price.amountsLine}` : null,
              favoritesDisabled: !prefs.favoritesReady,
              onFavorite: () => {
                if (!prefs.favoritesReady) return;
                void transact(async () => {
                  if (row.favorite) {
                    if (sameConfiguration(row.config, live)) {
                      const fallback = resolveMobileModelConfig(row.entry, {
                        fastCapable,
                      });
                      if (!(await p.unified.onSelect(fallback))) return;
                    }
                    try {
                      await prefs.save({
                        ...prefs.value,
                        favorites: prefs.value.favorites.filter(
                          (item) => item.uid !== row.favorite!.uid,
                        ),
                      });
                    } catch (error) {
                      if (sameConfiguration(row.config, live))
                        await p.unified.onSelect(live);
                      throw error;
                    }
                    setTarget(null);
                  } else
                    await prefs.save(
                      addModelFavorite(
                        prefs.value,
                        { ...row.config, modelId: row.entry.modelId },
                        createFavoriteUid(),
                      ),
                    );
                });
              },
              onReset: () =>
                change(
                  resolveMobileModelConfig(row.entry, { fastCapable }),
                  true,
                ),
            }
          : undefined
      }
    />
  );
}
