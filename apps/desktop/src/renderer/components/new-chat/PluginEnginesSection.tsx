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
import { quotaLevelFromRemaining } from '@cindy/maker-shared/quota-level';
import type { GhostHarnessUsage } from '@cindy/plugin-protocol';
import { SlidersHorizontal } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { EffortSlider } from '@/components/ui/effort-slider';
import { PluginEngineIcon } from '@/components/icons/PluginEngineIcon';
import { Tip } from '@/components/ui/tooltip';
import { getDataOwnerGeneration, isDataOwnerGenerationCurrent } from '@/contexts/dataOwnerGeneration';
import { readPluginEngineUsage } from '@/hooks/pluginEngineUsage';
import { requestPluginEnginesRefresh } from '@/hooks/usePluginEngines';
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
import { cn } from '@/lib/utils';

import type { PluginEngineEffort } from '../../../shared/pluginEngines';
import { UnifiedFlyoutHost } from './UnifiedFlyoutHost';

/**
 * New-task drafts: every engine on this computer plus the ones other computers of the same account
 * opened for remote use (`deviceId`), the draft's current choice and how to change it.
 */
export interface PluginEnginesPickerProps {
  engines: readonly PluginEngineChoice[];
  /** Current engine choice (already resolved against the list); null = a built-in model is used. */
  active: PluginEngineSelection | null;
  /** Existing tasks wait for the host to accept the choice. False leaves the panel open. */
  onSelect(selection: PluginEngineSelection): void | boolean | Promise<boolean>;
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

interface EngineBlockProps {
  engine: PluginEngineChoice;
  rows: readonly PluginEngineModelRow[];
  activeModelId: string | null;
  onChoose(modelId: string): void;
  /** The level a row runs with if picked (null = none shown). */
  effortOf(row: PluginEngineModelRow): PluginEngineEffort | null;
  /** Picks the row's model with this level; the picker stays open. */
  onChooseEffort(modelId: string, effort: PluginEngineEffort): void;
}

function pluginGroupQuotaTimeKey(
  usage: GhostHarnessUsage,
  now: number,
  t: ReturnType<typeof useTranslation>['t'],
): string {
  return (usage.windows ?? [])
    .filter((row) => !row.resetsAt || row.resetsAt > now)
    .map((row) => [
      row.label,
      Math.round(row.remainingPercent),
      row.resetsAt ? formatQuotaResetDuration(row.resetsAt / 1000, now, t) : null,
    ])
    .map((parts) => parts.join(':'))
    .join('|');
}

/** Compact quota/balance readout on a plugin engine group header; reuses the 1-minute shared reader. */
function PluginEngineGroupQuota({ engine }: { engine: PluginEngineChoice }) {
  const { t, i18n } = useTranslation();
  const targetKey = `${engine.deviceId ?? ''}:${engine.key}`;
  const [reading, setReading] = useState<{ targetKey: string; usage: GhostHarnessUsage } | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const owner = getDataOwnerGeneration();
    let active = true;
    void readPluginEngineUsage(owner, engine.deviceId ?? null, engine.key).result.then((usage) => {
      if (!active || !isDataOwnerGenerationCurrent(owner)) return;
      setReading(usage ? { targetKey, usage } : null);
      setNow(Date.now());
    });
    return () => { active = false; };
  }, [engine.key, engine.deviceId, targetKey]);
  const activeUsage = reading?.targetKey === targetKey ? reading.usage : null;
  const hasTimedWindow = !!activeUsage?.windows?.some(
    (row) => typeof row.resetsAt === 'number' && row.resetsAt > now,
  );
  const clockSnapshot = useRef({ usage: activeUsage, now, t });
  clockSnapshot.current = { usage: activeUsage, now, t };
  useEffect(() => {
    if (!hasTimedWindow) return;
    const syncClock = () => {
      if (typeof document !== 'undefined' && document.hidden) return;
      const { usage: currentUsage, now: prevNow, t: translate } = clockSnapshot.current;
      if (!currentUsage) return;
      const nextNow = Date.now();
      if (
        pluginGroupQuotaTimeKey(currentUsage, prevNow, translate) !==
        pluginGroupQuotaTimeKey(currentUsage, nextNow, translate)
      ) {
        setNow(nextNow);
      }
    };
    const timer = window.setInterval(syncClock, 1000);
    const onVisibility = () => {
      if (!document.hidden) syncClock();
    };
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVisibility);
    }
    return () => {
      window.clearInterval(timer);
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisibility);
      }
    };
  }, [hasTimedWindow]);
  if (!activeUsage) return null;
  const usage = activeUsage;
  const current = (usage.windows ?? []).filter((row) => !row.resetsAt || row.resetsAt > now);
  const balances = pluginEngineUsageBalances(usage, i18n.language, t);
  const first = current.reduce<(typeof current)[number] | undefined>((lowest, row) =>
    !lowest || row.remainingPercent < lowest.remainingPercent ? row : lowest, undefined);
  if (!first && !balances.length) return null;
  const reset = first?.resetsAt ? formatQuotaResetDuration(first.resetsAt / 1000, now, t) : null;
  const value = first ? `${Math.round(first.remainingPercent)}%` : balances[0]!;
  const firstBalance = (usage.balances ?? []).find((row) => Number.isFinite(Number(row.amount)));
  const level = first
    ? quotaLevelFromRemaining(first.remainingPercent)
    : firstBalance && Number(firstBalance.amount) <= 0 ? 'crit' : 'normal';
  const details = (
    <div className="space-y-1">
      {current.map((row, index) => {
        const rowReset = row.resetsAt ? formatQuotaResetDuration(row.resetsAt / 1000, now, t) : null;
        return (
          <div key={index}>
            {[row.label, t('quotaCard.remainingPercent', { percent: Math.round(row.remainingPercent) }), rowReset].filter(Boolean).join(' · ')}
          </div>
        );
      })}
      {balances.map((line, index) => <div key={`b:${index}`}>{line}</div>)}
    </div>
  );
  return (
    <Tip text={details} side="bottom" contentClassName="max-w-[320px] break-words">
      <span
        data-plugin-engine-quota={engine.providerId}
        aria-label={[first?.label, value, reset].filter(Boolean).join(' · ')}
        className="ml-auto flex shrink-0 items-center gap-1 text-12 font-normal tabular-nums text-[var(--text-secondary)]"
      >
        <span className={QUOTA_TEXT_COLOR_CLASSES[level]}>{value}</span>
        {reset && <span className="text-[var(--text-tertiary)]">· {reset}</span>}
      </span>
    </Tip>
  );
}

/**
 * One engine, laid out like a provider in the built-in list: the engine name as the group label
 * (same shared menu group label as 「Anthropic」 etc.), its availability hint when it cannot run,
 * then one row per model with the engine's mark, the model name and a second line.
 */
function EngineBlock({ engine, rows, activeModelId, onChoose, effortOf, onChooseEffort }: EngineBlockProps) {
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
  const hint = selectable
    ? undefined
    : engine.availability.message?.trim() || t('newChat.pluginEngines.unavailable');
  return (
    <div
      role="group"
      aria-label={engineLabel}
      data-plugin-engine={engine.providerId}
      {...(engine.deviceId ? { 'data-plugin-engine-device': engine.deviceId } : {})}
    >
      {/* Shared menu group label (DESIGN §4 Menu text): 12px / 500 meta, like the provider headings. */}
      <div className="flex items-center gap-1.5 px-2.5 pb-1 pt-2 text-12 font-medium leading-[1.33] text-[var(--cmd-palette-item-meta,var(--text-tertiary))]">
        <span title={engineLabel} className="truncate">{engineLabel}</span>
        {selectable && engine.reportsUsage && <PluginEngineGroupQuota engine={engine} />}
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
        const choose = () => {
          if (!selectable) return;
          onChoose(row.id);
        };
        const rowEffort = selectable ? effortOf(row) : null;
        // Like a built-in row: the slider only exists when the model really offers ≥2 levels.
        const adjustable = selectable && row.efforts.length > 1;
        const open = flyout?.rowId === row.id;
        const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
          if (event.target !== event.currentTarget) return;
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
            aria-disabled={selectable ? undefined : true}
            aria-keyshortcuts={adjustable ? 'ArrowLeft' : undefined}
            tabIndex={selectable ? 0 : -1}
            title={selectable ? undefined : hint}
            data-plugin-engine-model={`${engine.providerId}#${row.id}`}
            {...menuRowAttrs({ checked: selected, disabled: !selectable })}
            {...(open ? { 'data-state': 'open' } : {})}
            onClick={choose}
            onContextMenu={(event) => {
              if (!adjustable) return;
              event.preventDefault();
              openFlyout(row.id, event.currentTarget);
            }}
            onKeyDown={onKeyDown}
            className={cn(
              COMPOSER_MENU_ROW,
              // Same box as UnifiedModelRow: px-3 py-2, 4px between consecutive rows.
              '[&+[data-plugin-engine-model]]:mt-1 group/row flex w-full flex-col px-3 py-2',
              selectable ? 'cursor-pointer' : 'cursor-not-allowed opacity-50',
              selected && 'bg-sidebar-item-hover data-[menu-active]:bg-transparent',
            )}
          >
            <div className="flex items-center gap-2">
              {/* 18×18 mark box, so the second line's 26px indent lines up with the name. */}
              <span className="flex h-[18px] w-[18px] shrink-0 items-center justify-center">
                <PluginEngineIcon size={15} iconDataUrl={engine.iconDataUrl} />
              </span>
              <span title={label} className="min-w-0 truncate font-medium leading-5">{label}</span>
              {adjustable && (
                <button
                  type="button"
                  data-row-customize
                  aria-expanded={open}
                  aria-haspopup="dialog"
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
              {rowEffort && (
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
            <span
              title={description}
              className="min-w-0 max-w-[36ch] truncate pl-[26px] pt-px text-12 font-normal leading-[1.4] text-[var(--text-secondary)]"
            >
              {description}
            </span>
          </div>
        );
      })}
      {flyout && flyoutRow && (
        <UnifiedFlyoutHost
          anchorEl={flyout.anchor}
          panelElement={null}
          flyoutRef={flyoutRef}
          repositionKey={rows}
          onDismiss={() => setFlyout(null)}
        >
          <PluginEngineModelConfig
            engine={engine}
            row={flyoutRow}
            label={labelOf(flyoutRow)}
            effort={effortOf(flyoutRow)}
            effortLabel={effortLabel}
            onChange={(effort) => onChooseEffort(flyoutRow.id, effort)}
          />
        </UnifiedFlyoutHost>
      )}
    </div>
  );
}

/**
 * Configuration flyout of a plugin engine model: title, the engine as its source, and the level
 * slider — the reasoning part of ModelConfigFlyout (engines have no Fast, price or favorites).
 */
function PluginEngineModelConfig({
  engine,
  row,
  label,
  effort,
  effortLabel,
  onChange,
}: {
  engine: PluginEngineChoice;
  row: PluginEngineModelRow;
  label: string;
  effort: PluginEngineEffort | null;
  effortLabel: (effort: PluginEngineEffort) => string;
  onChange(effort: PluginEngineEffort): void;
}) {
  const { t } = useTranslation();
  const engineLabel = usePluginEngineChoiceLabel()(engine);
  return (
    <div role="group" aria-label={`${label} ${t('newChat.modelSelector.options')}`} data-plugin-engine-config className="flex flex-col">
      <span title={label} className="line-clamp-2 min-w-0 text-14 font-semibold leading-[1.35] text-[var(--model-item-text)]">
        {label}
      </span>
      <div className="truncate border-b border-[var(--model-dropdown-border)] pb-2.5 pt-1 text-12 text-[var(--text-tertiary)]">
        {engineLabel}
      </div>
      <div className="flex items-center gap-2 pt-3.5">
        <EffortSlider
          stops={row.efforts}
          value={effort}
          recommended={row.defaultEffort ?? null}
          labelOf={(level) => effortLabel(level as PluginEngineEffort)}
          onChange={(next) => onChange(next as PluginEngineEffort)}
        />
      </div>
    </div>
  );
}

/** The 「插件引擎」 group of a new-task picker; renders nothing when no engine (or no search hit) is left. */
export function PluginEnginesSection({
  picker,
  query,
  onPicked,
}: {
  picker: PluginEnginesPickerProps;
  query: string;
  onPicked(): void;
}) {
  const { t } = useTranslation();
  const sectionRef = useRef<HTMLDivElement>(null);
  const selectionInFlight = useRef(false);
  const choose = async (selection: PluginEngineSelection, dismiss: boolean) => {
    if (selectionInFlight.current) return;
    selectionInFlight.current = true;
    try {
      const selectionResult = picker.onSelect(selection);
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
      return {
        engine,
        activeModelId,
        rows: engineMatches(engine, pluginEngineModelRows(engine, activeModelId), needle, defaultLabel),
      };
    })
    .filter((block) => block.rows.length > 0);
  if (blocks.length === 0) return null;
  const label = t('newChat.pluginEngines.group');
  return (
    // Each engine carries its own group label (like a provider), so the section has no visible
    // heading of its own; the 「插件引擎」 name stays for assistive technology and the rail tab.
    <div ref={sectionRef} role="group" aria-label={label} data-plugin-engines-section>
      {blocks.map(({ engine, rows, activeModelId }) => (
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
            engine, row.id, isSamePluginEngineChoice(picker.active, engine) ? picker.active?.effort : undefined)}
          onChooseEffort={(modelId, effort) => { void choose({
            providerId: engine.providerId, modelId, effort, ...(engine.deviceId ? { deviceId: engine.deviceId } : {}),
          }, false); }}
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
  onPicked,
}: {
  picker: PluginEngineSessionPickerProps;
  disabled?: boolean;
  onPicked(): void;
}) {
  const { t } = useTranslation();
  // One glide highlight for the panel, like every composer menu (DESIGN.md §4).
  const listRef = useMenuPanel<HTMLDivElement>(undefined, { lockWidth: false });
  // A level change shows at once and stays until the task reports it (or the change fails).
  const [pending, setPending] = useState<{ modelId: string; effort: PluginEngineEffort } | null>(null);
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
      />
    </div>
  );
}
