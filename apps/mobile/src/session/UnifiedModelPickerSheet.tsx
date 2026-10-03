import { modelNeedsReselection } from './modelReselection';
import { mobileProviderAccountTitle } from "./mobileModelRowPresentation";
import { mobileCostMarks } from "./mobileModelRowPresentation";
import { formatQuotaResetCountdown } from "./sessionUsagePresentation";
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
import { mobileAgentLabel } from "./sessionAgentSwitch";

function createFavoriteUid(): string {
  const cryptoWithUuid = globalThis.crypto as Crypto | undefined;
  if (typeof cryptoWithUuid?.randomUUID === "function")
    return cryptoWithUuid.randomUUID();
  const expoWithUuid = ExpoCrypto as typeof ExpoCrypto & {
    randomUUID?: () => string;
  };
  if (typeof expoWithUuid.randomUUID === "function")
    return expoWithUuid.randomUUID();
  const bytes = ExpoCrypto.getRandomBytes(16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
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
  onClosed?(): void;
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
    isFavorite?: boolean;
    canReset?: boolean;
    configurationSummary?: string;
    notice?: string | null;
    editingFavorite?: boolean;
    onEditFavorite?(): void;
    onCancelEdit?(): void;
    onSaveEdit?(): void;
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
    config?: MobileModelConfiguration;
  } | null>(null);
  const [favoriteEdit, setFavoriteEdit] = useState<{
    original: MobileModelFavorite;
    config: MobileModelConfiguration;
  } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [caps, setCaps] = useState<
    Partial<Record<AgentKind, MobileAgentCapabilities>>
  >({});
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const opening = useRef(0);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!p.visible) return;
    opening.current += 1;
    setQuery("");
    setFilter("all");
    setTarget(null);
    setFavoriteEdit(null);
    setNotice(null);
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
      opening.current += 1;
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
  // The visible selection may belong to a pending next-message engine switch.
  // Resolve the running configuration separately when editing its favorite.
  const current = p.unified.currentSelection;
  const live: MobileModelConfiguration = current
    ? {
        providerId:
          buildMobileModelSections({
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
      }
    : selection;
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
        const modelQuota = q
          ? mobileWeeklyQuota(q.source, q.raw, now, entry.modelId)
          : null;
        return modelQuota
          ? [
              modelQuota.resetsAt
                ? formatQuotaResetCountdown(
                    modelQuota.resetsAt,
                    now,
                    t,
                    modelQuota.windowMinutes,
                  )
                : null,
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
    return mobileProviderAccountTitle(provider);
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
  const sourceRow = target
    ? rows.find(
        (row) =>
          row.entry.providerId === target.providerId &&
          row.entry.modelId === target.modelId,
      )
    : undefined;
  const originFavorite = target?.uid
    ? prefs.value.favorites.find((item) => item.uid === target.uid)
    : undefined;
  // Opening a favorite copies its parameters into the detail view. Ordinary
  // adjustments always edit model preferences, never the stored shortcut.
  const row = sourceRow && {
    ...sourceRow,
    key: target?.uid ?? sourceRow.key,
    config: favoriteEdit?.config ?? target?.config ?? sourceRow.config,
    favorite: originFavorite,
  };
  // A source model can have several saved configurations. Match the complete
  // configuration without applying capability fallbacks to the saved values.
  const matchingFavorite =
    row &&
    prefs.value.favorites.find(
      (item) =>
        matchesEntry(row.entry, item.modelId) &&
        sameConfiguration({ ...item, modelId: row.config.modelId }, row.config),
    );
  const recommendedConfig =
    row &&
    resolveMobileModelConfig(row.entry, {
      pinned: p.existingSessionRoute ? p.agentKind : undefined,
      fastCapable,
    });
  const resetAgents = row
    ? [...new Set([row.config.agent, recommendedConfig!.agent])]
    : [];
  const canReset =
    !!row &&
    (!sameConfiguration(row.config, recommendedConfig!) ||
      prefs.value.engines[modelKey(row.entry.providerId, row.entry.modelId)] !==
        undefined ||
      resetAgents.some((agent) => {
        const capability = row.entry.capabilities[agent];
        if (!capability) return false;
        const effort = p.modelMemory?.getEffort(
          agent,
          row.entry.providerId,
          capability.wireModelId,
        );
        const fast = p.modelMemory?.getFast(
          agent,
          row.entry.providerId,
          capability.wireModelId,
        );
        // Session mirrors cannot delete remote preferences. Like Desktop, those
        // accessors restore values; their default-valued echoes are not overrides.
        return (
          (effort !== undefined &&
            (!!p.modelMemory?.clearEffort ||
              effort !==
                (capability.defaultEffort ?? capability.efforts[0] ?? ""))) ||
          (fast !== undefined && (!!p.modelMemory?.clearFast || fast))
        );
      }));
  useEffect(() => {
    if (target && !row) {
      setTarget(null);
      setFavoriteEdit(null);
    }
  }, [target, row]);
  const transact = async (
    action: (isCurrent: () => boolean) => Promise<void>,
  ) => {
    if (lock.current || p.disabled || !prefs.ready) return;
    lock.current = true;
    const generation = opening.current;
    const isCurrent = () => generation === opening.current;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await action(isCurrent);
    } catch {
      if (isCurrent()) setError(t("models.unified.saveFailed"));
    } finally {
      // Keep writes serialized across close/reopen until persistence settles.
      // No newer transaction can be unlocked by this completion.
      lock.current = false;
      setBusy(false);
    }
  };
  const select = (row: UnifiedMobileRow) => {
    if (row.disabled) return;
    void transact(async (isCurrent) => {
      if ((await p.unified.onSelect(row.config)) && isCurrent()) p.onClose();
    });
  };
  const change = (config: MobileModelConfiguration, reset = false) => {
    if (!row) return;
    if (favoriteEdit) {
      if (!lock.current && !p.disabled)
        setFavoriteEdit({ ...favoriteEdit, config });
      return;
    }
    void transact(async (isCurrent) => {
      const previousConfig =
        row.favorite && sameConfiguration(row.config, live)
          ? live
          : row.selected
            ? selection
            : undefined;
      if (previousConfig && !(await p.unified.onSelect(config))) return;
      // Selection can await remote work or a confirmation. Do not begin another
      // write for a panel that closed or changed its binding while waiting.
      if (!isCurrent()) return;
      try {
        const engines = { ...prefs.value.engines };
        const key = modelKey(row.entry.providerId, row.entry.modelId);
        if (reset) delete engines[key];
        else engines[key] = config.agent;
        await prefs.save({ ...prefs.value, engines });
        if (reset) {
          // Reset the model's overrides, including the previous engine's
          // parameters. Other models and saved favorite copies stay intact.
          for (const agent of resetAgents) {
            const capability = row.entry.capabilities[agent];
            if (!capability) continue;
            const modelId = capability.wireModelId;
            const effort =
              capability.defaultEffort ?? capability.efforts[0] ?? "";
            if (p.modelMemory?.clearEffort)
              p.modelMemory.clearEffort(agent, config.providerId, modelId);
            else if (effort)
              p.modelMemory?.setEffort(
                agent,
                config.providerId,
                modelId,
                effort,
              );
            if (p.modelMemory?.clearFast)
              p.modelMemory.clearFast(agent, config.providerId, modelId);
            else
              p.modelMemory?.setFast(agent, config.providerId, modelId, false);
          }
        } else {
          if (config.effort)
            p.modelMemory?.setEffort(
              config.agent,
              config.providerId,
              config.modelId,
              config.effort,
            );
          p.modelMemory?.setFast(
            config.agent,
            config.providerId,
            config.modelId,
            config.fast,
          );
        }
        if (!isCurrent()) return;
        if (target?.config) setTarget({ ...target, config });
        setNotice(
          t(
            reset
              ? "models.unified.restoredHint"
              : matchingFavorite
                ? "models.unified.originalFavoriteKept"
                : "models.unified.parametersSaved",
          ),
        );
      } catch (error) {
        if (previousConfig && isCurrent())
          await p.unified.onSelect(previousConfig);
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
      onClosed={p.onClosed}
      onBack={
        row
          ? () => {
              if (lock.current) return;
              if (favoriteEdit) setFavoriteEdit(null);
              else setTarget(null);
              setError(null);
              setNotice(null);
            }
          : undefined
      }
      title={
        favoriteEdit
          ? t("models.unified.editFavorite")
          : (row?.entry.displayName ?? t("models.picker.title"))
      }
      testID={p.testID ?? "modelSheet"}
      query={query}
      onQuery={setQuery}
      filter={filter}
      onFilter={setFilter}
      filters={[
        { id: "all", label: t("models.unified.all") },
        ...(prefs.favoritesReady
          ? [{ id: "favorites", label: t("models.unified.favorites") }]
          : []),
        ...p.providers
          .filter((provider) =>
            entries.some((e) => e.providerId === provider.id),
          )
          .map((provider) => ({
            id: provider.id,
            label: providerName(provider.id),
            quota:
              quotas[provider.id]?.remaining !== undefined
                ? {
                    remaining: quotas[provider.id]!.remaining!,
                    label: [
                      (quotas[provider.id]!.resetsAt
                        ? formatQuotaResetCountdown(
                            quotas[provider.id]!.resetsAt!,
                            now,
                            t,
                            quotas[provider.id]!.windowMinutes ?? null,
                          )
                        : null) ?? t("session.menu.usage.week"),
                      t("session.menu.usage.remaining", {
                        percent: quotas[provider.id]!.remaining,
                      }),
                    ].join(" · "),
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
      error={error ?? (p.providersReady && modelNeedsReselection(p.modelVisibilityOverrides, p.agentKind, p.activeModelId, p.selectedProviderId)
        ? t('session.common.modelHiddenReselect', { model: p.activeModelId }) : null)}
      loading={!!p.loading}
      emptyHint={p.emptyHint ?? t("models.picker.noResults")}
      onSelect={select}
      onOptions={(row) => {
        if (lock.current) return;
        setFavoriteEdit(null);
        setNotice(null);
        setError(null);
        setTarget({
          providerId: row.entry.providerId,
          modelId: row.entry.modelId,
          uid: row.favorite?.uid,
          config: row.favorite ? { ...row.config } : undefined,
        });
      }}
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
              isFavorite: !!matchingFavorite,
              canReset,
              configurationSummary: [
                mobileAgentLabel(row.config.agent),
                row.config.effort
                  ? t(`models.options.effortLevels.${row.config.effort}`, {
                      defaultValue: row.config.effort,
                    })
                  : null,
                row.config.fast ? "Fast" : null,
              ]
                .filter(Boolean)
                .join(" · "),
              notice,
              editingFavorite: !!favoriteEdit,
              onEditFavorite:
                originFavorite && !favoriteEdit
                  ? () => {
                      if (lock.current || p.disabled) return;
                      setFavoriteEdit({
                        original: { ...originFavorite },
                        config: resolveMobileModelConfig(row.entry, {
                          favorite: originFavorite,
                          fastCapable,
                        }),
                      });
                      setNotice(null);
                      setError(null);
                    }
                  : undefined,
              onCancelEdit: () => {
                if (lock.current) return;
                setFavoriteEdit(null);
                setError(null);
                setNotice(null);
              },
              onSaveEdit: () => {
                if (!favoriteEdit) return;
                void transact(async (isCurrent) => {
                  const original = prefs.value.favorites.find(
                    (item) => item.uid === favoriteEdit.original.uid,
                  );
                  if (
                    !original ||
                    !sameConfiguration(original, favoriteEdit.original)
                  ) {
                    setError(t("models.unified.favoriteChanged"));
                    return;
                  }
                  if (
                    matchingFavorite &&
                    matchingFavorite.uid !== original.uid
                  ) {
                    setError(t("models.unified.favoriteExists"));
                    return;
                  }
                  const config = favoriteEdit.config;
                  await prefs.save({
                    ...prefs.value,
                    favorites: prefs.value.favorites.map((item) =>
                      item.uid === original.uid
                        ? {
                            ...config,
                            modelId: row.entry.modelId,
                            uid: item.uid,
                          }
                        : item,
                    ),
                  });
                  if (!isCurrent()) return;
                  setFavoriteEdit(null);
                  if (target) setTarget({ ...target, config });
                  setNotice(t("models.unified.favoriteUpdated"));
                });
              },
              onFavorite: () => {
                if (!prefs.favoritesReady || favoriteEdit) return;
                void transact(async (isCurrent) => {
                  if (matchingFavorite) {
                    await prefs.save({
                      ...prefs.value,
                      favorites: prefs.value.favorites.filter(
                        (item) => item.uid !== matchingFavorite.uid,
                      ),
                    });
                    if (isCurrent())
                      setNotice(t("models.unified.favoriteRemoved"));
                  } else {
                    await prefs.save(
                      addModelFavorite(
                        prefs.value,
                        { ...row.config, modelId: row.entry.modelId },
                        createFavoriteUid(),
                      ),
                    );
                    if (isCurrent())
                      setNotice(t("models.unified.favoriteSaved"));
                  }
                });
              },
              onReset: () => change(recommendedConfig!, true),
            }
          : undefined
      }
    />
  );
}
