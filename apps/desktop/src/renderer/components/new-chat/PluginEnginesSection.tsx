/**
 * PluginEnginesSection — task engines provided by plugins, inside the model picker
 * (docs/plans/acp-plugin-bridge.md).
 * ---------------------------------------------------------------------------
 * Engines are their own group (「插件引擎」), never mixed into provider catalogs or the built-in
 * Harness list. Each engine is listed by the name the plugin declared; under it come the models
 * the engine reported the last time a task ran, or a single 「默认模型」 entry until then.
 * An engine the plugin reports as unavailable stays visible but cannot be picked, with the
 * plugin's own hint (for example how to install the CLI) underneath. 'unknown' is selectable:
 * the plugin never published a status, and a failing start is reported by the task itself.
 *
 * Row styling follows the plugin-model rows: 18px icon box, 14/500 name, 12px secondary text,
 * the chosen row keeps the model menu's whole-row fill (DESIGN.md §4 composer dropdown rows).
 * A model that offers reasoning levels shows its level at the row's end like a built-in row, and
 * its configuration flyout (customize button, right-click or ←) holds the same level slider.
 * Nothing here calls the plugin: the list is the main process's last known state. Opening a picker
 * only asks main to have the engine plugins republish their models (with a per-plugin cooldown).
 */
import {
  buildPluginEngineUsagePresentation,
  matchPluginEngineQuotaGroup,
  splitPluginUsageWindowLabel,
  type PluginEngineUsagePresentation,
} from '@cindy/maker-shared/plugin-engine-usage';
import { quotaLevelFromRemaining } from '@cindy/maker-shared/quota-level';
import type { GhostHarnessUsage } from '@cindy/plugin-protocol';
import { SlidersHorizontal, Star } from 'lucide-react';
import { Fragment, useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { EffortSlider } from '@/components/ui/effort-slider';
import { PluginEngineIcon } from '@/components/icons/PluginEngineIcon';
import { Tip } from '@/components/ui/tooltip';
import { usePluginEngineUsage } from '@/hooks/usePluginEngineUsage';
import { requestPluginEnginesRefresh } from '@/hooks/usePluginEngines';
import { formatCompactTimeUntilReset } from '@/lib/compactQuotaCountdown';
import { toast } from '@/lib/toast';
import { LOCAL_MODEL_FAVORITE_STORE } from '@/state/agentDeviceFavorites';
import { useProviderShareFavoriteKeysByDevice } from '@/state/providerShareFavorites';
import { useRemoteModelFavorites } from '@/state/useRemoteModelFavorites';
import { QUOTA_TEXT_COLOR_CLASSES } from '../status/QuotaBar';
import { pluginEngineUsageBalances } from '../status/pluginEngineUsageAccount';
import { formatQuotaResetDuration } from '../status/usageCardModel';

import {
  COMPOSER_MENU_ROW,
  MenuHighlightLayer,
  menuPanelAttrs,
  menuRowAttrs,
  useMenuPanel,
} from '@/components/ui/menu-row';
import {
  isPluginEngineSelectable,
  isSamePluginEngineChoice,
  pluginEngineChoiceKey,
  pluginEngineModelRows,
  resolvePluginEngineEffort,
  type PluginEngineChoice,
  type PluginEngineModelRow,
  type PluginEngineSelection,
} from '@/lib/pluginEngineSelection';
import {
  pluginEngineFavoriteConfig,
  pluginEngineFavoriteProviderId,
  pluginEngineModelFlashKey,
  type ResolvedPluginEngineFavorite,
} from '@/lib/pluginEngineFavorites';
import { cn } from '@/lib/utils';

import type { PluginEngineEffort } from '../../../shared/pluginEngines';
import { anchorKey, type UnifiedAnchor } from './unifiedModelSelection';
import { UnifiedFlyoutHost } from './UnifiedFlyoutHost';

/**
 * New-task drafts: every engine on this computer plus the ones other computers of the same account
 * opened for remote use (`deviceId`), the draft's current choice and how to change it.
 */
export interface PluginEnginesPickerProps {
  engines: readonly PluginEngineChoice[];
  /** Current engine choice (already resolved against the list); null = a built-in model is used. */
  active: PluginEngineSelection | null;
  /** The task's current engine and effort, even when the picker highlights a pending switch. */
  running?: PluginEngineSelection | null;
  /** Existing tasks wait for the host to accept the choice. False leaves the panel open. */
  onSelect(selection: PluginEngineSelection): void | boolean | Promise<boolean>;
  /**
   * Optional handler for reasoning-level adjustments (the panel stays open).
   * When omitted, falls back to `onSelect` (immediate apply for ordinary drafts/tasks).
   */
  onSelectEffort?(selection: PluginEngineSelection): void | boolean | Promise<boolean>;
  /** Device Link picker reloads its own computer's list when opened. */
  readCatalogue?(): void;
}

/** A task already running on a plugin engine: only that engine's models are offered. */
export interface PluginEngineSessionPickerProps {
  providerId: string;
  /**
   * null when the plugin was turned off or removed; the task keeps its stored model. For a task
   * whose agent runs on another computer of this account the engine comes from that computer's
   * list and carries its `deviceId` / `deviceName`.
   */
  engine: PluginEngineChoice | null;
  /** Engine name, or the generic 「插件引擎」 label when the plugin is gone. */
  engineName: string;
  modelId: string;
  /** The task's stored reasoning level ('' / null = the engine's own). */
  effort?: string | null;
  readCatalogue?(): void;
  /** The remote computer has yet to answer with an authoritative catalogue. */
  catalogueUnknown?: boolean;
  /**
   * Applies a model of this engine (and a level it offers) to the task; false = not applied
   * (picker stays open). Without a level the engine keeps its own.
   */
  onSelectModel(modelId: string, effort?: PluginEngineEffort): void | boolean | Promise<void | boolean>;
}

/** A plugin engine chosen for an existing task's next message; the switch applies when it is sent. */
export interface PluginEnginePendingSelection {
  providerId: string;
  /** null when the plugin was turned off or removed meanwhile. */
  engine: PluginEngineChoice | null;
  engineName: string;
  modelId: string;
  effort?: string | null;
}

/** Localized name of a reasoning level, the same strings the built-in rows use. */
export function usePluginEngineEffortLabel(): (effort: PluginEngineEffort) => string {
  const { t } = useTranslation();
  return (effort) => t(`effortLevels.${effort}`, { defaultValue: effort });
}

/** Localized label of a model row. */
export function usePluginEngineModelLabel(): (row: Pick<PluginEngineModelRow, 'isDefault' | 'name' | 'id'>) => string {
  const { t } = useTranslation();
  return (row) => (row.isDefault ? t('newChat.pluginEngines.defaultModel') : row.name ?? row.id);
}

/** The model the picker's current choice has on this engine, or null when another engine is chosen. */
export function activePluginEngineModelId(
  active: PluginEngineSelection | null | undefined,
  engine: PluginEngineChoice,
): string | null {
  return isSamePluginEngineChoice(active, engine) ? active!.modelId : null;
}

/**
 * Group label of an engine: its name, followed by the computer it is on when that is another one
 * (the same 「来源 · 电脑」 wording as a provider of another computer). The returned function is
 * stable per language, so callers may keep it in hook dependencies.
 */
export function usePluginEngineChoiceLabel(): (engine: Pick<PluginEngineChoice, 'name' | 'deviceId' | 'deviceName'>) => string {
  const { t } = useTranslation();
  return useCallback((engine) => (engine.deviceId
    ? t('newChat.modelSelector.unified.railRemoteProvider', { provider: engine.name, device: engine.deviceName || engine.deviceId })
    : engine.name), [t]);
}

function engineMatches(
  engine: PluginEngineChoice,
  rows: readonly PluginEngineModelRow[],
  needle: string,
  defaultLabel: string,
): PluginEngineModelRow[] {
  if (!needle) return [...rows];
  if (engine.name.toLowerCase().includes(needle) || engine.deviceName?.toLowerCase().includes(needle)) return [...rows];
  return rows.filter((row) =>
    [row.isDefault ? defaultLabel : row.name, row.description].some((text) => text?.toLowerCase().includes(needle)));
}

/** How many rows match the picker's search; the panel uses it to decide whether the search is empty. */
export function matchPluginEngineRows(
  engines: readonly PluginEngineChoice[],
  query: string,
  activeModelIdFor: (engine: PluginEngineChoice) => string | null,
  defaultLabel: string,
): number {
  const needle = query.trim().toLowerCase();
  return engines.reduce(
    (count, engine) =>
      count + engineMatches(engine, pluginEngineModelRows(engine, activeModelIdFor(engine)), needle, defaultLabel).length,
    0,
  );
}

/** Favorites actions injected by UnifiedModelPanel (or PluginEngineSessionPanel). */
export interface PluginEngineFavoritesController {
  canFavorite(engine: PluginEngineChoice): boolean;
  addFavorite(
    engine: PluginEngineChoice,
    modelId: string,
    effort: PluginEngineEffort | null,
    flashKey: string,
  ): void;
  removeFavorite(uid: string): void;
  updateFavoriteEffort(resolved: ResolvedPluginEngineFavorite, effort: PluginEngineEffort): void;
  justFavoritedKey: string | null;
  configurationEnabled: boolean;
  interactionDisabled: boolean;
}

interface EngineBlockProps {
  engine: PluginEngineChoice;
  rows: readonly PluginEngineModelRow[];
  activeModelId: string | null;
  onChoose(modelId: string): void;
  /** The level a row runs with if picked (null = none shown). */
  effortOf(row: PluginEngineModelRow): PluginEngineEffort | null;
  /** Picks the row's model with this level; the picker stays open. */
  onChooseEffort(modelId: string, effort: PluginEngineEffort): void;
  /** Task host computer when controlling a remote device; null/undefined = this computer. */
  hostDeviceId?: string | null;
  favorites?: PluginEngineFavoritesController;
  panelElement?: HTMLElement | null;
  overlayClassName?: string;
}

/** Inline quota/balance readout on the plugin engine group heading, matching ModelPoolQuotaSummary. */
function PluginEngineGroupQuota({
  engine,
  presentation,
  usage,
  now,
}: {
  engine: PluginEngineChoice;
  presentation: PluginEngineUsagePresentation;
  usage: GhostHarnessUsage;
  now: number;
}) {
  const { t, i18n } = useTranslation();
  const [open, setOpen] = useState(false);
  const balances = pluginEngineUsageBalances(usage, i18n.language, t);
  if (presentation.groups.length === 0 && balances.length === 0) return null;

  const details = (
    <div className="space-y-2">
      {presentation.groups.map((group) => (
        <div key={group.id} className="space-y-0.5">
          {presentation.isMultiGroup && group.rawName && (
            <div className="font-medium">{group.rawName}</div>
          )}
          {group.windows.map((row, index) => {
            const rowReset = row.resetsAt
              ? formatQuotaResetDuration(row.resetsAt / 1000, now, t)
              : null;
            const label = presentation.isMultiGroup && group.rawName
              ? splitPluginUsageWindowLabel(row.label).period
              : row.label;
            const rowLevel = quotaLevelFromRemaining(row.remainingPercent);
            return (
              <div key={index} className={QUOTA_TEXT_COLOR_CLASSES[rowLevel]}>
                {[
                  label,
                  t('quotaCard.remainingPercent', { percent: Math.round(row.remainingPercent) }),
                  rowReset,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </div>
            );
          })}
        </div>
      ))}
      {balances.map((line, index) => <div key={`b:${index}`}>{line}</div>)}
    </div>
  );

  if (presentation.isMultiGroup && presentation.groups.length > 0) {
    const items = presentation.groups.map((group) => {
      const label = group.shortLabel ?? group.primary.label;
      const value = `${group.remainingPercent}%`;
      const reset = group.primary.resetsAt
        ? formatQuotaResetDuration(group.primary.resetsAt / 1000, now, t)
        : null;
      return {
        id: group.id,
        label,
        value,
        level: group.level,
        aria: [label, value, reset].filter(Boolean).join(' · '),
      };
    });
    return (
      <Tip
        text={details}
        side="bottom"
        controlledOpen={open || undefined}
        onOpenChange={setOpen}
        contentClassName="max-w-[320px] break-words"
      >
        <button
          type="button"
          data-plugin-engine-quota={engine.providerId}
          aria-expanded={open}
          aria-label={items.map((item) => item.aria).join(' · ')}
          onClick={() => setOpen((value) => !value)}
          className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-x-1.5 gap-y-0.5 text-12 font-normal tabular-nums text-[var(--text-secondary)]"
        >
          {items.map((item, index) => (
            <Fragment key={item.id}>
              {index > 0 && <span aria-hidden className="text-[var(--text-tertiary)]">·</span>}
              <span data-plugin-engine-quota-group={item.id} className="inline-flex items-center gap-1 whitespace-nowrap">
                <span className="text-[var(--text-tertiary)]">{item.label}</span>
                <span className={QUOTA_TEXT_COLOR_CLASSES[item.level]}>{item.value}</span>
              </span>
            </Fragment>
          ))}
        </button>
      </Tip>
    );
  }

  const group = presentation.groups[0];
  const reset = group?.primary.resetsAt
    ? formatQuotaResetDuration(group.primary.resetsAt / 1000, now, t)
    : null;
  const value = group ? `${group.remainingPercent}%` : balances[0]!;
  const level = group ? group.level : presentation.level;
  return (
    <Tip
      text={details}
      side="bottom"
      controlledOpen={open || undefined}
      onOpenChange={setOpen}
      contentClassName="max-w-[320px] break-words"
    >
      <button
        type="button"
        data-plugin-engine-quota={engine.providerId}
        aria-expanded={open}
        aria-label={[group?.primary.label, value, reset].filter(Boolean).join(' · ')}
        onClick={() => setOpen((current) => !current)}
        className="ml-auto flex shrink-0 items-center gap-1 text-12 font-normal tabular-nums text-[var(--text-secondary)]"
      >
        <span className={QUOTA_TEXT_COLOR_CLASSES[level]}>{value}</span>
        {reset && <span className="text-[var(--text-tertiary)]">· {reset}</span>}
      </button>
    </Tip>
  );
}

/**
 * One engine, laid out like a provider in the built-in list: the engine name as the group label
 * (same shared menu group label as 「Anthropic」 etc.), its availability hint when it cannot run,
 * then one row per model with the engine's mark, the model name and a second line.
 */
function EngineBlock({
  engine,
  rows,
  activeModelId,
  onChoose,
  effortOf,
  onChooseEffort,
  hostDeviceId = null,
  favorites,
  panelElement = null,
  overlayClassName,
}: EngineBlockProps) {
  const { t } = useTranslation();
  const labelOf = usePluginEngineModelLabel();
  const effortLabel = usePluginEngineEffortLabel();
  // An engine of another computer carries that computer's name, like a provider of another computer.
  const engineLabel = usePluginEngineChoiceLabel()(engine);
  // The configuration flyout of one row (reasoning level), placed like a built-in row's flyout.
  const [flyout, setFlyout] = useState<{ rowId: string; anchor: HTMLElement } | null>(null);
  const flyoutRef = useRef<HTMLDivElement>(null);
  const openFlyout = (rowId: string, anchor: HTMLElement, toggle = false) =>
    setFlyout((current) => (toggle && current?.rowId === rowId ? null : { rowId, anchor }));
  const flyoutRow = flyout ? rows.find((row) => row.id === flyout.rowId) : undefined;
  const selectable = isPluginEngineSelectable(engine);
  const canFavoriteEngine = selectable && !!favorites?.canFavorite(engine);
  const configurationEnabled = favorites?.configurationEnabled ?? true;
  const interactionDisabled = favorites?.interactionDisabled ?? false;
  const hint = selectable
    ? undefined
    : engine.availability.message?.trim() || t('newChat.pluginEngines.unavailable');
  const { usage, now } = usePluginEngineUsage({
    engineKey: engine.key,
    deviceId: engine.deviceId ?? hostDeviceId,
    enabled: selectable && engine.reportsUsage === true,
  });
  const usagePresentation = usage ? buildPluginEngineUsagePresentation(usage, now) : null;
  return (
    <div
      role="group"
      aria-label={engineLabel}
      data-plugin-engine={engine.providerId}
      {...(engine.deviceId ? { 'data-plugin-engine-device': engine.deviceId } : {})}
    >
      {/* Shared menu group label (DESIGN §4 Menu text): 12px / 500 meta, like the provider headings. */}
      <div className="flex flex-wrap items-center gap-1.5 px-2.5 pb-1 pt-2 text-12 font-medium leading-[1.33] text-[var(--cmd-palette-item-meta,var(--text-tertiary))]">
        <span title={engineLabel} className="truncate">{engineLabel}</span>
        {usage && usagePresentation && (
          <PluginEngineGroupQuota
            engine={engine}
            presentation={usagePresentation}
            usage={usage}
            now={now}
          />
        )}
      </div>
      {hint && (
        <div
          title={hint}
          data-plugin-engine-unavailable
          className="w-0 min-w-full px-2.5 pb-1 text-12 leading-[1.4] text-[var(--text-tertiary)] [overflow-wrap:anywhere] line-clamp-2"
        >
          {hint}
        </div>
      )}
      {rows.map((row) => {
        const selected = selectable && activeModelId === row.id;
        const label = labelOf(row);
        // Second line like a built-in row's source line: the default entry explains itself; a model
        // shows its own description, else the engine it runs on.
        const description = row.isDefault
          ? t('newChat.pluginEngines.defaultModelHint')
          : row.description || engineLabel;
        const matchedGroup = !row.isDefault
          ? matchPluginEngineQuotaGroup(usagePresentation, { id: row.id, name: row.name })
          : null;
        const rowQuota = matchedGroup
          ? {
              groupId: matchedGroup.id,
              countdown: matchedGroup.primary.resetsAt
                ? formatCompactTimeUntilReset(
                    matchedGroup.primary.resetsAt / 1000,
                    now,
                    t,
                    matchedGroup.primary.windowMinutes ?? null,
                  )
                : null,
              percentage: `${matchedGroup.remainingPercent}%`,
              level: matchedGroup.level,
              title: matchedGroup.windows
                .map((windowRow) =>
                  [
                    windowRow.label,
                    t('quotaCard.remainingPercent', { percent: Math.round(windowRow.remainingPercent) }),
                    windowRow.resetsAt
                      ? formatCompactTimeUntilReset(
                          windowRow.resetsAt / 1000,
                          now,
                          t,
                          windowRow.windowMinutes ?? null,
                        )
                      : null,
                  ]
                    .filter(Boolean)
                    .join(' · '),
                )
                .join(' · '),
            }
          : null;
        const choose = () => {
          if (!selectable || interactionDisabled) return;
          onChoose(row.id);
        };
        const rowEffort = selectable ? effortOf(row) : null;
        // Like a built-in row: the slider only exists when the model really offers ≥2 levels.
        const adjustable = selectable && configurationEnabled && row.efforts.length > 1;
        const open = flyout?.rowId === row.id;
        const flashKey = pluginEngineModelFlashKey(engine, row.id);
        const flashed = favorites?.justFavoritedKey === flashKey;
        const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
          if (event.target !== event.currentTarget || interactionDisabled) return;
          if (event.key === 'ArrowLeft' && adjustable) {
            event.preventDefault();
            openFlyout(row.id, event.currentTarget);
            // Keyboard opening moves focus into the configuration, like a built-in row.
            requestAnimationFrame(() => flyoutRef.current?.querySelector<HTMLElement>('[role="slider"]')?.focus());
            return;
          }
          if (event.key !== 'Enter' && event.key !== ' ') return;
          event.preventDefault();
          choose();
        };
        return (
          <div
            key={row.id}
            role="option"
            aria-selected={selected}
            aria-disabled={selectable && !interactionDisabled ? undefined : true}
            aria-keyshortcuts={adjustable ? 'ArrowLeft' : undefined}
            tabIndex={selectable && !interactionDisabled ? 0 : -1}
            title={selectable ? undefined : hint}
            data-plugin-engine-model={`${engine.providerId}#${row.id}`}
            {...menuRowAttrs({ checked: selected, disabled: !selectable || interactionDisabled })}
            {...(open ? { 'data-state': 'open' } : {})}
            onClick={choose}
            onContextMenu={(event) => {
              if (!adjustable || interactionDisabled) return;
              event.preventDefault();
              openFlyout(row.id, event.currentTarget);
            }}
            onKeyDown={onKeyDown}
            className={cn(
              COMPOSER_MENU_ROW,
              // Same box as UnifiedModelRow: px-3 py-2, 4px between consecutive rows.
              '[&+[data-plugin-engine-model]]:mt-1 group/row flex w-full flex-col px-3 py-2',
              selectable && !interactionDisabled ? 'cursor-pointer' : 'cursor-not-allowed opacity-50',
              selected && 'bg-sidebar-item-hover data-[menu-active]:bg-transparent',
            )}
          >
            <div className="flex items-center gap-2">
              {/* 18×18 mark box, so the second line's 26px indent lines up with the name. */}
              <span className="flex h-[18px] w-[18px] shrink-0 items-center justify-center">
                <PluginEngineIcon size={15} iconDataUrl={engine.iconDataUrl} />
              </span>
              <span title={label} className="min-w-0 truncate font-medium leading-5">{label}</span>
              {canFavoriteEngine && favorites && (
                <button
                  type="button"
                  disabled={interactionDisabled}
                  onClick={(event) => {
                    event.stopPropagation();
                    favorites.addFavorite(engine, row.id, rowEffort, flashKey);
                  }}
                  onKeyDown={(event) => event.stopPropagation()}
                  title={t('newChat.modelSelector.unified.addFavorite')}
                  aria-label={t('newChat.modelSelector.unified.addFavorite')}
                  className={cn(
                    'flex h-5 w-5 shrink-0 items-center justify-center rounded-lg transition-opacity',
                    flashed
                      ? 'text-[var(--favorite-star)] opacity-100'
                      : 'text-[var(--text-tertiary)] opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100 hover:text-[var(--favorite-star)]',
                  )}
                >
                  <Star size={14} fill={flashed ? 'currentColor' : 'none'} />
                </button>
              )}
              {adjustable && (
                <button
                  type="button"
                  data-row-customize
                  aria-expanded={open}
                  aria-haspopup="dialog"
                  disabled={interactionDisabled}
                  onClick={(event) => {
                    event.stopPropagation();
                    const anchor = event.currentTarget.closest('[data-plugin-engine-model]');
                    if (anchor instanceof HTMLElement) openFlyout(row.id, anchor, true);
                  }}
                  title={t('newChat.modelSelector.unified.customize')}
                  aria-label={t('newChat.modelSelector.unified.customize')}
                  className={cn(
                    'flex h-5 w-5 shrink-0 items-center justify-center rounded-lg transition-opacity',
                    open
                      ? 'text-[var(--text-secondary)] opacity-100'
                      : 'text-[var(--text-tertiary)] opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100 hover:text-[var(--text-secondary)]',
                  )}
                >
                  <SlidersHorizontal size={14} />
                </button>
              )}
              {configurationEnabled && rowEffort && (
                // Same place and tone as a built-in row's level (UnifiedModelRow data-unified-triple).
                <span data-model-row-meta className="ml-auto flex shrink-0 items-center gap-2">
                  <span
                    data-plugin-engine-effort={rowEffort}
                    title={effortLabel(rowEffort)}
                    className="max-w-[118px] shrink-0 truncate text-12 font-normal text-[var(--text-tertiary)]"
                  >
                    {effortLabel(rowEffort)}
                  </span>
                </span>
              )}
            </div>
            {rowQuota ? (
              <div
                title={[description, rowQuota.title].filter(Boolean).join(' · ')}
                className="flex w-0 min-w-full items-center gap-1 whitespace-nowrap pl-[26px] pt-px text-12 font-normal leading-[1.4] text-[var(--text-secondary)]"
              >
                <span className="min-w-0 truncate">{description}</span>
                <span aria-hidden className="shrink-0">·</span>
                <span
                  data-plugin-model-quota={rowQuota.groupId}
                  className="min-w-0 max-w-[70%] truncate tabular-nums"
                >
                  {rowQuota.countdown && <>{rowQuota.countdown}{' '}</>}
                  <span className={QUOTA_TEXT_COLOR_CLASSES[rowQuota.level]}>
                    {rowQuota.percentage}
                  </span>
                </span>
              </div>
            ) : (
              <span
                title={description}
                className="min-w-0 max-w-[36ch] truncate pl-[26px] pt-px text-12 font-normal leading-[1.4] text-[var(--text-secondary)]"
              >
                {description}
              </span>
            )}
          </div>
        );
      })}
      {flyout && flyoutRow && (
        <UnifiedFlyoutHost
          anchorEl={flyout.anchor}
          panelElement={panelElement}
          flyoutRef={flyoutRef}
          repositionKey={rows}
          {...(overlayClassName !== undefined ? { className: overlayClassName } : {})}
          onDismiss={() => setFlyout(null)}
        >
          {(() => {
            const currentEffort = effortOf(flyoutRow);
            const customized =
              currentEffort !== null &&
              flyoutRow.defaultEffort != null &&
              currentEffort !== flyoutRow.defaultEffort;
            const flashKey = pluginEngineModelFlashKey(engine, flyoutRow.id);
            return (
              <PluginEngineModelConfig
                engine={engine}
                row={flyoutRow}
                label={labelOf(flyoutRow)}
                effort={currentEffort}
                effortLabel={effortLabel}
                state={customized ? 'customized' : 'recommended'}
                canFavorite={canFavoriteEngine}
                justFavorited={favorites?.justFavoritedKey === flashKey}
                disabled={interactionDisabled}
                onChange={(effort) => onChooseEffort(flyoutRow.id, effort)}
                {...(canFavoriteEngine && favorites
                  ? {
                      onAddFavorite: () =>
                        favorites.addFavorite(engine, flyoutRow.id, currentEffort, flashKey),
                    }
                  : {})}
                {...(customized && flyoutRow.defaultEffort
                  ? { onResetToRecommended: () => onChooseEffort(flyoutRow.id, flyoutRow.defaultEffort!) }
                  : {})}
              />
            );
          })()}
        </UnifiedFlyoutHost>
      )}
    </div>
  );
}

/**
 * Configuration flyout of a plugin engine model: title (+ favorite star), the engine as its source,
 * level slider and status footer — matching ModelConfigFlyout (engines have no Fast or price).
 */
export function PluginEngineModelConfig({
  engine,
  row,
  label,
  effort,
  effortLabel,
  onChange,
  state = 'recommended',
  canFavorite = false,
  justFavorited = false,
  disabled = false,
  onAddFavorite,
  onRemoveFavorite,
  onResetToRecommended,
}: {
  engine: PluginEngineChoice;
  row: PluginEngineModelRow;
  label: string;
  effort: PluginEngineEffort | null;
  effortLabel: (effort: PluginEngineEffort) => string;
  onChange(effort: PluginEngineEffort): void;
  state?: 'recommended' | 'customized' | 'favorite';
  canFavorite?: boolean;
  justFavorited?: boolean;
  disabled?: boolean;
  onAddFavorite?: () => void;
  onRemoveFavorite?: () => void;
  onResetToRecommended?: () => void;
}) {
  const { t } = useTranslation();
  const engineLabel = usePluginEngineChoiceLabel()(engine);
  const starred = state === 'favorite' || justFavorited;
  const showStar = state === 'favorite' ? !!onRemoveFavorite : canFavorite && !!onAddFavorite;
  const showFooter = state === 'favorite' || canFavorite || !!onResetToRecommended;
  return (
    <div role="group" aria-label={`${label} ${t('newChat.modelSelector.options')}`} data-plugin-engine-config className="flex flex-col">
      <div className="flex items-start gap-2">
        <span title={label} className="line-clamp-2 min-w-0 flex-1 text-14 font-semibold leading-[1.35] text-[var(--model-item-text)]">
          {label}
        </span>
        {showStar && (
          <button
            type="button"
            disabled={disabled}
            onClick={() => (state === 'favorite' ? onRemoveFavorite?.() : onAddFavorite?.())}
            title={
              state === 'favorite'
                ? t('newChat.modelSelector.unified.removeFavorite')
                : t('newChat.modelSelector.unified.addFavorite')
            }
            aria-label={
              state === 'favorite'
                ? t('newChat.modelSelector.unified.removeFavorite')
                : t('newChat.modelSelector.unified.addFavorite')
            }
            className={cn(
              'mt-[1px] flex h-5 w-5 shrink-0 items-center justify-center rounded-lg transition-colors',
              starred
                ? 'text-[var(--favorite-star)]'
                : 'text-[var(--text-tertiary)] hover:text-[var(--favorite-star)]',
              disabled && 'cursor-not-allowed opacity-50',
            )}
          >
            <Star size={14} fill={starred ? 'currentColor' : 'none'} />
          </button>
        )}
      </div>
      <div className="truncate border-b border-[var(--model-dropdown-border)] pb-2.5 pt-1 text-12 text-[var(--text-tertiary)]">
        {engineLabel}
      </div>
      {row.efforts.length > 1 && (
        <div className="flex items-center gap-2 pt-3.5">
          <EffortSlider
            stops={row.efforts}
            value={effort}
            recommended={row.defaultEffort ?? null}
            labelOf={(level) => effortLabel(level as PluginEngineEffort)}
            onChange={(next) => onChange(next as PluginEngineEffort)}
            disabled={disabled}
          />
        </div>
      )}
      {showFooter && (
        <div className="mt-2 flex min-h-[22px] items-center justify-between border-t border-[var(--model-dropdown-border)] pt-2 text-11">
          <span
            className={
              state === 'recommended' ? 'text-[var(--text-tertiary)]' : 'text-[var(--text-secondary)]'
            }
          >
            {state === 'favorite'
              ? t('newChat.modelSelector.unified.favoriteConfig')
              : state === 'customized'
                ? t('newChat.modelSelector.unified.customized')
                : t('newChat.modelSelector.unified.recommendedConfig')}
          </span>
          {state === 'favorite' && onRemoveFavorite ? (
            <button
              type="button"
              disabled={disabled}
              onClick={onRemoveFavorite}
              className="shrink-0 text-[var(--text-secondary)] underline underline-offset-2 transition-colors hover:text-[var(--text-primary)] disabled:cursor-not-allowed disabled:opacity-50"
            >
              {t('newChat.modelSelector.unified.removeFavorite')}
            </button>
          ) : state === 'customized' && onResetToRecommended ? (
            <button
              type="button"
              disabled={disabled}
              onClick={onResetToRecommended}
              className="shrink-0 text-[var(--text-secondary)] underline underline-offset-2 transition-colors hover:text-[var(--text-primary)] disabled:cursor-not-allowed disabled:opacity-50"
            >
              {t('newChat.modelSelector.unified.reset')}
            </button>
          ) : null}
        </div>
      )}
    </div>
  );
}

/** Favorite row for a plugin engine model inside UnifiedModelPanel's 「收藏」 section. */
export function PluginEngineFavoriteRow({
  resolved,
  anchor,
  active,
  configurationEnabled = true,
  interactionDisabled = false,
  readable = false,
  measurementOnly = false,
  tabIndex = 0,
  position,
  onSelect,
  onRemove,
  onReveal,
  onRevealForKeyboard,
}: {
  resolved: ResolvedPluginEngineFavorite;
  anchor: UnifiedAnchor;
  active: boolean;
  configurationEnabled?: boolean;
  interactionDisabled?: boolean;
  readable?: boolean;
  measurementOnly?: boolean;
  tabIndex?: number | undefined;
  position?: { index: number; total: number } | undefined;
  onSelect(): void;
  onRemove?: () => void;
  onReveal(anchor: UnifiedAnchor, element: HTMLElement, toggle?: boolean): void;
  onRevealForKeyboard(anchor: UnifiedAnchor, element: HTMLElement): void;
}) {
  const { t } = useTranslation();
  const labelOf = usePluginEngineModelLabel();
  const effortLabel = usePluginEngineEffortLabel();
  const engineLabel = usePluginEngineChoiceLabel()(resolved.engine);
  const label = labelOf(resolved.row);
  const adjustable = configurationEnabled && resolved.row.efforts.length > 1;
  const rootProps = measurementOnly
    ? {}
    : {
        role: 'option' as const,
        'aria-selected': false,
        'aria-disabled': interactionDisabled ? true : undefined,
        'aria-keyshortcuts': adjustable ? 'ArrowLeft' : undefined,
        tabIndex: interactionDisabled ? -1 : tabIndex,
        'aria-posinset': position?.index,
        'aria-setsize': position?.total,
        ...menuRowAttrs({ disabled: interactionDisabled }),
        'data-state': active ? 'open' : undefined,
        'data-unified-anchor': anchorKey(anchor),
        'data-plugin-engine-favorite': resolved.favorite.uid,
        'data-plugin-engine-model': `${resolved.engine.providerId}#${resolved.row.id}`,
        onClick: () => {
          if (!interactionDisabled) onSelect();
        },
        onContextMenu: (event: React.MouseEvent<HTMLDivElement>) => {
          if (interactionDisabled || !adjustable) return;
          event.preventDefault();
          onReveal(anchor, event.currentTarget);
        },
        onKeyDown: (event: ReactKeyboardEvent<HTMLDivElement>) => {
          if (event.target !== event.currentTarget || interactionDisabled) return;
          if (event.key === 'ArrowLeft' && adjustable) {
            event.preventDefault();
            onRevealForKeyboard(anchor, event.currentTarget);
            return;
          }
          if (event.key !== 'Enter' && event.key !== ' ') return;
          event.preventDefault();
          onSelect();
        },
      };
  return (
    <div
      {...rootProps}
      className={cn(
        COMPOSER_MENU_ROW,
        '[&+[data-unified-anchor]]:mt-1 group/row flex w-full cursor-pointer flex-col px-3 py-2',
        readable && 'min-w-0',
        interactionDisabled && 'cursor-not-allowed opacity-50',
      )}
    >
      <div className={cn('flex gap-2', readable ? 'min-w-0 items-start' : 'items-center')}>
        <span className="flex h-[18px] w-[18px] shrink-0 items-center justify-center">
          {!measurementOnly && (
            <PluginEngineIcon size={15} iconDataUrl={resolved.engine.iconDataUrl} />
          )}
        </span>
        <span
          title={label}
          className={cn(
            'min-w-0 font-medium leading-5',
            readable ? 'flex-1 [overflow-wrap:anywhere]' : 'truncate',
          )}
        >
          {label}
        </span>
        {onRemove && (
          measurementOnly ? (
            <span className="h-5 w-5 shrink-0" />
          ) : (
            <button
              type="button"
              tabIndex={tabIndex}
              disabled={interactionDisabled}
              onClick={(event) => {
                event.stopPropagation();
                onRemove();
              }}
              onKeyDown={(event) => event.stopPropagation()}
              title={t('newChat.modelSelector.unified.removeFavorite')}
              aria-label={t('newChat.modelSelector.unified.removeFavorite')}
              className="flex h-5 w-5 shrink-0 items-center justify-center rounded-lg text-[var(--favorite-star)] opacity-100 transition-opacity"
            >
              <Star size={14} fill="currentColor" />
            </button>
          )
        )}
        {adjustable && (
          measurementOnly ? (
            <span className="h-5 w-5 shrink-0" />
          ) : (
            <button
              type="button"
              tabIndex={tabIndex}
              data-row-customize
              aria-expanded={active}
              aria-haspopup="dialog"
              disabled={interactionDisabled}
              onClick={(event) => {
                event.stopPropagation();
                const row = event.currentTarget.closest('[data-unified-anchor]');
                if (row instanceof HTMLElement) onReveal(anchor, row, true);
              }}
              title={t('newChat.modelSelector.unified.customize')}
              aria-label={t('newChat.modelSelector.unified.customize')}
              className={cn(
                'flex h-5 w-5 shrink-0 items-center justify-center rounded-lg transition-opacity',
                active
                  ? 'text-[var(--text-secondary)] opacity-100'
                  : 'text-[var(--text-tertiary)] opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100 hover:text-[var(--text-secondary)]',
              )}
            >
              <SlidersHorizontal size={14} />
            </button>
          )
        )}
        {configurationEnabled && resolved.effort && (
          <span data-model-row-meta className={cn('flex shrink-0 items-center gap-2', !readable && 'ml-auto')}>
            <span
              data-plugin-engine-effort={resolved.effort}
              title={effortLabel(resolved.effort)}
              className="max-w-[118px] shrink-0 truncate text-12 font-normal text-[var(--text-tertiary)]"
            >
              {effortLabel(resolved.effort)}
            </span>
          </span>
        )}
      </div>
      <span
        title={engineLabel}
        className={cn(
          'min-w-0 max-w-[36ch] truncate text-12 font-normal leading-[1.4] text-[var(--text-secondary)]',
          !readable && 'pl-[26px] pt-px',
        )}
      >
        {engineLabel}
      </span>
    </div>
  );
}

/** The 「插件引擎」 group of a new-task picker; renders nothing when no engine (or no search hit) is left. */
export function PluginEnginesSection({
  picker,
  query,
  onPicked,
  hostDeviceId = null,
  favorites,
  panelElement,
  overlayClassName,
}: {
  picker: PluginEnginesPickerProps;
  query: string;
  onPicked(): void;
  hostDeviceId?: string | null;
  favorites?: PluginEngineFavoritesController;
  panelElement?: HTMLElement | null;
  overlayClassName?: string;
}) {
  const { t } = useTranslation();
  const sectionRef = useRef<HTMLDivElement>(null);
  const selectionInFlight = useRef(false);
  const choose = async (selection: PluginEngineSelection, dismiss: boolean) => {
    if (selectionInFlight.current) return;
    selectionInFlight.current = true;
    try {
      const handler = !dismiss && picker.onSelectEffort ? picker.onSelectEffort : picker.onSelect;
      const selectionResult = handler(selection);
      const applied = typeof selectionResult === 'object' ? await selectionResult : selectionResult;
      if (applied !== false && dismiss && sectionRef.current) onPicked();
    } catch {
      // Selection failures leave the panel open. The task's selection handler reports the error.
    } finally {
      selectionInFlight.current = false;
    }
  };
  const needle = query.trim().toLowerCase();
  const defaultLabel = t('newChat.pluginEngines.defaultModel').toLowerCase();
  const blocks = picker.engines
    .map((engine) => {
      const activeModelId = activePluginEngineModelId(picker.active, engine);
      const running = isSamePluginEngineChoice(picker.running, engine) ? picker.running : null;
      const effort = running ? running.effort : activeModelId !== null ? picker.active?.effort : undefined;
      const purpose = running ? 'session' as const : 'new-task' as const;
      return {
        engine,
        activeModelId,
        purpose,
        effort,
        rows: engineMatches(engine, pluginEngineModelRows(engine, activeModelId, purpose), needle, defaultLabel),
      };
    })
    .filter((block) => block.rows.length > 0);
  if (blocks.length === 0) return null;
  const label = t('newChat.pluginEngines.group');
  return (
    // Each engine carries its own group label (like a provider), so the section has no visible
    // heading of its own; the 「插件引擎」 name stays for assistive technology and the rail tab.
    <div ref={sectionRef} role="group" aria-label={label} data-plugin-engines-section>
      {blocks.map(({ engine, rows, activeModelId, purpose, effort }) => (
        <EngineBlock
          key={pluginEngineChoiceKey(engine)}
          engine={engine}
          rows={rows}
          activeModelId={activeModelId}
          onChoose={(modelId) => { void choose({
            providerId: engine.providerId, modelId, ...(engine.deviceId ? { deviceId: engine.deviceId } : {}),
          }, true); }}
          // A row shows the level it would run with: the chosen one where it is offered, else its own.
          effortOf={(row) => resolvePluginEngineEffort(
            engine, row.id, effort, purpose)}
          onChooseEffort={(modelId, effort) => { void choose({
            providerId: engine.providerId, modelId, effort, ...(engine.deviceId ? { deviceId: engine.deviceId } : {}),
          }, false); }}
          hostDeviceId={hostDeviceId}
          {...(favorites ? { favorites } : {})}
          panelElement={panelElement ?? null}
          {...(overlayClassName !== undefined ? { overlayClassName } : {})}
        />
      ))}
    </div>
  );
}

/**
 * Picker panel of a task that runs on a plugin engine: that engine's models only, with the level
 * of each model in its configuration flyout. Engine switching and Fast do not exist for these
 * tasks, so none of the unified panel is shown.
 */
export function PluginEngineSessionPanel({
  picker,
  disabled,
  deviceId,
  selectionPolicy = 'personalized',
  onPicked,
}: {
  picker: PluginEngineSessionPickerProps;
  disabled?: boolean;
  deviceId?: string;
  selectionPolicy?: 'personalized' | 'official';
  onPicked(): void;
}) {
  const { t } = useTranslation();
  // One glide highlight for the panel, like every composer menu (DESIGN.md §4).
  const listRef = useMenuPanel<HTMLDivElement>(undefined, { lockWidth: false });
  // A level change shows at once and stays until the task reports it (or the change fails).
  const [pending, setPending] = useState<{ modelId: string; effort: PluginEngineEffort } | null>(null);
  const [justFavoritedKey, setJustFavoritedKey] = useState<string | null>(null);
  const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const remoteFavorites = useRemoteModelFavorites(deviceId);
  const shareFavoriteKeys = useProviderShareFavoriteKeysByDevice(undefined, !!deviceId);
  const favoriteStore = deviceId ? remoteFavorites.store : LOCAL_MODEL_FAVORITE_STORE;
  useEffect(() => () => {
    if (flashTimerRef.current !== null) clearTimeout(flashTimerRef.current);
  }, []);
  useEffect(() => setPending(null), [picker.modelId, picker.effort]);
  const listLabel = t('newChat.modelSelector.modelListAria');
  // Opening the task's model menu refreshes the engine's models like a provider's (cooldown in main).
  useEffect(() => {
    (picker.readCatalogue ?? requestPluginEnginesRefresh)();
  }, [picker.readCatalogue]);
  if (!picker.engine) {
    return (
      <div role="status" data-plugin-engine-missing className="w-[280px] max-w-full px-3 py-3 text-13 leading-[1.5] text-[var(--text-secondary)]">
        <div className="flex items-center gap-2 pb-1 font-medium text-[var(--text-primary)]">
          <PluginEngineIcon size={15} />
          <span className="min-w-0 truncate">{picker.engineName}</span>
        </div>
        {t(picker.catalogueUnknown ? 'newChat.pluginEngines.unavailable' : 'newChat.pluginEngines.engineMissing')}
      </div>
    );
  }
  const engine = picker.engine;
  const encodeOpts = { shareFavoriteKeys, wireLimit: !!deviceId };
  const favoritesController: PluginEngineFavoritesController | undefined =
    selectionPolicy === 'personalized'
      ? {
          canFavorite: (target) => pluginEngineFavoriteProviderId(target, encodeOpts) !== null,
          addFavorite: (target, modelId, effort, flashKey) => {
            const config = pluginEngineFavoriteConfig(target, modelId, effort, encodeOpts);
            if (!config) return;
            void Promise.resolve(favoriteStore.add(config)).then(
              () => {
                setJustFavoritedKey(flashKey);
                if (flashTimerRef.current !== null) clearTimeout(flashTimerRef.current);
                flashTimerRef.current = setTimeout(() => {
                  flashTimerRef.current = null;
                  setJustFavoritedKey(null);
                }, 700);
              },
              () => {
                toast.error(t('newChat.modelSelector.unified.favoritesSaveFailed'));
              },
            );
          },
          removeFavorite: () => {},
          updateFavoriteEffort: () => {},
          justFavoritedKey,
          configurationEnabled: true,
          interactionDisabled: !!disabled,
        }
      : undefined;
  return (
    <div
      ref={listRef}
      role="listbox"
      aria-label={listLabel}
      aria-disabled={disabled || undefined}
      {...menuPanelAttrs}
      className={cn('relative w-[280px] max-w-full overflow-y-auto p-1', 'max-h-[min(420px,calc(100vh-120px))]',
        disabled && 'pointer-events-none opacity-50')}
    >
      <MenuHighlightLayer />
      <EngineBlock
        engine={engine}
        rows={pluginEngineModelRows(engine, pending?.modelId ?? picker.modelId, 'session')}
        activeModelId={pending?.modelId ?? picker.modelId}
        onChoose={(modelId) => {
          if (modelId === picker.modelId) {
            onPicked();
            return;
          }
          // Another model keeps the task's level where it offers it, else runs with its own default.
          const effort = resolvePluginEngineEffort(engine, modelId, picker.effort, 'session') ?? undefined;
          void Promise.resolve(effort ? picker.onSelectModel(modelId, effort) : picker.onSelectModel(modelId)).then((applied) => {
            if (applied !== false) onPicked();
          });
        }}
        effortOf={(row) => resolvePluginEngineEffort(engine, row.id, pending?.effort ?? picker.effort, 'session')}
        onChooseEffort={(modelId, effort) => {
          setPending({ modelId, effort });
          void Promise.resolve(picker.onSelectModel(modelId, effort)).then((applied) => {
            if (applied === false) setPending(null);
          }, () => setPending(null));
        }}
        hostDeviceId={deviceId ?? null}
        {...(favoritesController ? { favorites: favoritesController } : {})}
      />
    </div>
  );
}
