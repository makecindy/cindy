import { builtinToolsSettings } from './BuiltinToolsSection.settings-search';
/**
 * BuiltinToolsSection — Settings → Connections 下的内置工具管理面板。
 * ---------------------------------------------------------------------------
 * 列出可选的 builtin 工具（非 essential），每个工具有 toggle 开关。
 * 支持用户默认与项目覆盖两个作用域。项目覆盖优先于用户默认，清除覆盖后
 * 自动回落到下一层来源。
 *
 * 作用域有两条来源:
 *   1. props.workingDir — 来自 lastWorkingDir store, 反映当前 active session
 *      的工作目录。打开 Settings 时默认 honor 这个 (用户的"我刚才在的项目")。
 *   2. 标题行右侧的 scope picker dropdown — 首项为新对话默认值，其后列出
 *      recentWorkdirs, 让用户
 *      手动切换到任意最近项目, 不必先返回 chat 切 session 再回 Settings。
 *      用户选择会 sticky 到本次 BuiltinToolsSection 实例生命周期。
 *
 * 数据流:
 *   - mount → window.electronAPI.maker.plugins.list(effectiveWorkingDir) 拉列表
 *   - effectiveWorkingDir 变化 → 自动 reload (project 切换 = 重读那个项目的
 *     .claude/settings.json)
 *   - 首次渲染空白，数据到后一次性渲染（无 loading 闪屏）
 */

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { Puzzle, ChevronDown, Check, Folder, UserRound } from 'lucide-react';

import { basename, cn } from '@/lib/utils';
import { toast } from '@/lib/toast';
import { Switch } from '@/components/ui/switch';
import { SettingsCard, SettingsSection } from '@/components/ui/settings-rows';
import { createLogger } from '@/lib/logger';
import { extractIpcError } from '@/utils/ipcError';
import { recentWorkdirsStore, type RecentWorkdirEntry } from '@/lib/recentWorkdirsStore';
import { normalizeWorkingDirForProjectSettings } from '../../../shared/workingDir';
import { Button } from '@/components/ui/button';
import { SelectParts, SELECT_WIDTHS } from '@/components/ui/select';
import { DefaultOverrideControls } from './DefaultOverrideControls';

const log = createLogger('BuiltinToolsSection');

export interface BuiltinToolListItem {
  id: string;
  name: string;
  description: string;
  effectiveEnabled: boolean;
  projectOverride?: { enabled: boolean; workingDir: string } | null;
  userOverride?: { enabled: boolean } | null;
}

interface PluginListItem extends BuiltinToolListItem {
  source: 'builtin' | 'hub' | 'local';
  essential: boolean;
  productDefaultEnabled: boolean;
  globalOverride?: { enabled: boolean } | null;
}

interface BuiltinToolsSectionProps {
  /** lastWorkingDir snapshot — used as the initial pick for the project dropdown. */
  workingDir?: string;
}

/** Resolve a plugin id to its localized display name + description, falling
 *  back to the english strings emitted by builtin-plugins.ts when the i18n
 *  bundle is missing the key (defensive — should not happen in production). */
function useLocalizedPlugin(plugin: Pick<BuiltinToolListItem, 'id' | 'name' | 'description'>) {
  const { t } = useTranslation();
  return useMemo(
    () => ({
      name: t(`settings.builtinTools.plugins.${plugin.id}.name`, {
        defaultValue: plugin.name,
      }),
      description: t(`settings.builtinTools.plugins.${plugin.id}.description`, {
        defaultValue: plugin.description,
      }),
    }),
    [t, plugin.id, plugin.name, plugin.description],
  );
}

function useRecentWorkdirs(): RecentWorkdirEntry[] {
  // recentWorkdirsStore exposes a snapshot via .get(); .ensure() loads it on
  // first read. useSyncExternalStore handles the re-render when the snapshot
  // flips from null → array, and again whenever main pushes a new session.
  const snapshot = useSyncExternalStore(recentWorkdirsStore.subscribe, recentWorkdirsStore.get);
  useEffect(() => {
    void recentWorkdirsStore.ensure().catch(() => {
      /* silent — empty dropdown is an acceptable fallback */
    });
  }, []);
  return snapshot ?? [];
}

export function BuiltinToolsSection({ workingDir }: BuiltinToolsSectionProps) {
  const { t } = useTranslation();
  const [plugins, setPlugins] = useState<PluginListItem[] | null>(null);
  const [pendingIds, setPendingIds] = useState<Set<string>>(new Set());
  // undefined means the user has not picked a scope yet, so follow workingDir
  // as it loads or changes. null is an explicit user-default selection.
  const [selectedScope, setSelectedScope] = useState<string | null | undefined>();

  const recentWorkdirs = useRecentWorkdirs();
  const activeProjectWorkingDir = normalizeWorkingDirForProjectSettings(workingDir) ?? undefined;
  const effectiveWorkingDir =
    normalizeWorkingDirForProjectSettings(
      selectedScope === undefined ? workingDir : selectedScope,
    ) ?? undefined;

  const reload = useCallback(async () => {
    try {
      const list = await window.electronAPI.maker.plugins.list(effectiveWorkingDir);
      setPlugins(list);
    } catch (err) {
      log.warn('plugins.list failed', err);
      toast.error(t('settings.builtinTools.loadFailed'));
    }
  }, [t, effectiveWorkingDir]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const handleToggle = useCallback(
    async (id: string, next: boolean, label: string) => {
      setPendingIds((prev) => new Set(prev).add(id));
      try {
        if (effectiveWorkingDir) {
          await window.electronAPI.maker.plugins.setProjectEnabled(effectiveWorkingDir, id, next);
        } else {
          await window.electronAPI.maker.plugins.setEnabled(id, next);
        }
        await reload();
        window.dispatchEvent(new Event('cindy:project-plugin-state-changed'));
        toast.success(
          next
            ? t('settings.builtinTools.toast.enabled', { name: label })
            : t('settings.builtinTools.toast.disabled', { name: label }),
        );
      } catch (err) {
        log.warn(`plugins.setEnabled(${id}) failed`, err);
        // Decode the [CODE] prefix that throwIpcError encodes on main side. We
        // only translate known business codes (PERMISSION_DENIED for essential
        // plugins; INVALID_PARAMS would only fire on a renderer bug, no need
        // to translate); everything else falls through to the generic toast.
        const ipcError = extractIpcError(err);
        const message =
          ipcError?.code === 'PERMISSION_DENIED'
            ? t('settings.builtinTools.toast.cannotModifyEssential', { name: label })
            : t('settings.builtinTools.toast.toggleFailed');
        toast.error(message);
      } finally {
        setPendingIds((prev) => {
          const next2 = new Set(prev);
          next2.delete(id);
          return next2;
        });
      }
    },
    [t, effectiveWorkingDir, reload],
  );

  const handleClearOverride = useCallback(
    async (id: string, label: string) => {
      setPendingIds((prev) => new Set(prev).add(id));
      try {
        if (effectiveWorkingDir) {
          await window.electronAPI.maker.plugins.clearProjectEnabled(effectiveWorkingDir, id);
        } else {
          await window.electronAPI.maker.plugins.clearEnabled(id);
        }
        await reload();
        window.dispatchEvent(new Event('cindy:project-plugin-state-changed'));
        toast.success(t('settings.defaults.restored'));
      } catch (err) {
        log.warn(`plugins.clearEnabled(${id}) failed`, err);
        const ipcError = extractIpcError(err);
        const message =
          ipcError?.code === 'PERMISSION_DENIED'
            ? t('settings.builtinTools.toast.cannotModifyEssential', { name: label })
            : t('settings.defaults.restoreFailed');
        toast.error(message);
      } finally {
        setPendingIds((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      }
    },
    [effectiveWorkingDir, reload, t],
  );

  // First render: null → blank (no flash). After data arrives: render list.
  if (!plugins) return null;

  return (
    <SettingsSection
      titleId={builtinToolsSettings.title.targetId}
      title={t(builtinToolsSettings.title.titleKey)}
      description={t(builtinToolsSettings.title.descriptionKey)}
      action={
        <ScopePicker
          effectiveWorkingDir={effectiveWorkingDir}
          activeSessionWorkingDir={activeProjectWorkingDir}
          recentWorkdirs={recentWorkdirs}
          onPick={setSelectedScope}
        />
      }
      caption={t('settings.builtinTools.toggleHint')}
    >
      {/* 工具列表自带图标与来源标签，行样式保留 */}
      <SettingsCard className="flex flex-col">
        {plugins.map((plugin, index) => (
          <BuiltinToolRow
            key={plugin.id}
            plugin={plugin}
            divider={index > 0}
            disabled={pendingIds.has(plugin.id)}
            projectScope={effectiveWorkingDir != null}
            onToggle={handleToggle}
            onClearOverride={handleClearOverride}
          />
        ))}

        {plugins.length === 0 && (
          <div className="flex items-center justify-center px-4 py-10">
            <p className="text-13 text-[var(--settings-section-desc)]">
              {t('settings.builtinTools.empty')}
            </p>
          </div>
        )}
      </SettingsCard>
    </SettingsSection>
  );
}

/** Plugin 行 — 抽出来好让 useLocalizedPlugin hook 在子组件 scope 里调用,
 *  避免在父循环里直接调 hook (违反 rules of hooks)。 */
export function BuiltinToolRow({
  plugin,
  divider,
  disabled,
  projectScope,
  checked,
  showSource = true,
  badge,
  onToggle,
  onClearOverride,
}: {
  plugin: BuiltinToolListItem;
  divider: boolean;
  disabled: boolean;
  projectScope: boolean;
  checked?: boolean;
  showSource?: boolean;
  badge?: string;
  onToggle: (id: string, next: boolean, label: string) => void;
  onClearOverride?: (id: string, label: string) => void;
}) {
  const { t } = useTranslation();
  const { name, description } = useLocalizedPlugin(plugin);
  const hasProjectOverride = plugin.projectOverride != null;
  const isCustomized = projectScope ? hasProjectOverride : plugin.userOverride != null;
  const sourceKey =
    projectScope && hasProjectOverride
      ? 'project'
      : plugin.userOverride != null
        ? 'user'
        : 'product';

  return (
    <div
      className={cn(
        'flex items-center justify-between gap-3 px-4 py-[14px]',
        divider && 'border-t border-[var(--settings-theme-card-border)]',
      )}
    >
      <div className="flex items-center gap-3 min-w-0">
        <div
          className={cn(
            'flex h-9 w-9 shrink-0 items-center justify-center rounded-lg',
            'bg-[var(--settings-input-bg)]',
          )}
        >
          <Puzzle size={16} className="text-[var(--settings-section-title)]" />
        </div>
        <div className="flex flex-col gap-[8px] min-w-0">
          <div className="flex items-center gap-2">
            <p className="text-14 font-medium leading-[1.25] text-[var(--settings-section-title)] truncate">
              {name}
            </p>
            {showSource || badge ? (
              <span
                className="shrink-0 text-11 leading-none px-1.5 py-0.5 rounded-full
                  bg-[var(--settings-input-bg)] text-[var(--settings-section-desc)]"
                title={
                  showSource
                    ? t(`settings.builtinTools.source.${sourceKey}Tooltip`, {
                        dir: plugin.projectOverride?.workingDir,
                      })
                    : undefined
                }
              >
                {badge ?? t(`settings.builtinTools.source.${sourceKey}`)}
              </span>
            ) : null}
          </div>
          <p className="text-12 leading-[1.35] text-[var(--settings-section-desc)] truncate">
            {description}
          </p>
        </div>
      </div>

      <div className="flex items-center gap-2 shrink-0">
        {onClearOverride ? (
          <DefaultOverrideControls
            isCustomized={isCustomized}
            disabled={disabled}
            onReset={() => onClearOverride(plugin.id, name)}
          />
        ) : null}
        <Switch data-setting-id={builtinToolsSettings.title.id}
          checked={checked ?? plugin.effectiveEnabled}
          disabled={disabled}
          onCheckedChange={(v) => onToggle(plugin.id, v, name)}
          aria-label={t('settings.builtinTools.toggleAria', { name })}
        />
      </div>
    </div>
  );
}

const USER_DEFAULT_SCOPE = '__user-default';
const SCOPE_ITEM_CLASS =
  'relative flex min-h-8 w-full cursor-pointer select-none items-center rounded-lg py-1.5 pl-2 pr-6 text-left outline-none';

/** Scope picker — switches between user defaults and a project's overrides. */
function ScopePicker({
  effectiveWorkingDir,
  activeSessionWorkingDir,
  recentWorkdirs,
  onPick,
}: {
  effectiveWorkingDir: string | undefined;
  /** lastWorkingDir from active session — gets a "current" badge in the list. */
  activeSessionWorkingDir: string | undefined;
  recentWorkdirs: RecentWorkdirEntry[];
  onPick: (dir: string | null) => void;
}) {
  const { t } = useTranslation();

  // Merge active session dir into the picker even if it predates the recent
  // workdirs cache (rare race where lastWorkingDir is set but main hasn't
  // pushed a sessions.created event yet). De-dupe by path.
  const candidates = useMemo<string[]>(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    const push = (p: string | undefined) => {
      const projectScope = normalizeWorkingDirForProjectSettings(p) ?? undefined;
      if (!projectScope || seen.has(projectScope)) return;
      seen.add(projectScope);
      out.push(projectScope);
    };
    push(effectiveWorkingDir);
    push(activeSessionWorkingDir);
    for (const r of recentWorkdirs) push(r.path);
    return out;
  }, [effectiveWorkingDir, activeSessionWorkingDir, recentWorkdirs]);

  // A single-value field (DESIGN.md §4): shared Select trigger and equal-width panel.
  // SelectParts keeps the two-line rows (name + description / full path).
  return (
    <SelectParts.Root
      value={effectiveWorkingDir ?? USER_DEFAULT_SCOPE}
      onValueChange={(value) => onPick(value === USER_DEFAULT_SCOPE ? null : value)}
    >
      <SelectParts.Trigger asChild>
        <Button
          data-setting-id={builtinToolsSettings.title.id}
          pressFeedback={false}
          variant="secondary"
          size="md"
          aria-label={t('settings.builtinTools.scopePicker.ariaLabel')}
          title={effectiveWorkingDir ?? undefined}
          className={cn(SELECT_WIDTHS.sm, 'min-w-0 max-w-full shrink-0 justify-between gap-1.5 px-3 font-normal')}
        >
          {effectiveWorkingDir ? (
            <Folder size={14} className="shrink-0" aria-hidden />
          ) : (
            <UserRound size={14} className="shrink-0" aria-hidden />
          )}
          <span className="min-w-0 flex-1 truncate text-left">
            <SelectParts.Value />
          </span>
          <SelectParts.Icon asChild>
            <ChevronDown size={14} className="shrink-0" aria-hidden="true" />
          </SelectParts.Icon>
        </Button>
      </SelectParts.Trigger>
      <SelectParts.Portal>
        <SelectParts.Content
          side="bottom"
          align="end"
          className="border border-[var(--border-default)] bg-[var(--surface-elevated)] text-13 text-[var(--text-primary)]"
        >
          <SelectParts.Viewport className="max-h-64 min-w-0">
            <SelectParts.Item value={USER_DEFAULT_SCOPE} className={SCOPE_ITEM_CLASS}>
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="truncate">
                  <SelectParts.ItemText>{t('settings.builtinTools.scopePicker.userDefault')}</SelectParts.ItemText>
                </span>
                <span className="whitespace-normal break-words text-12 leading-[1.33] text-[var(--cmd-palette-item-meta)]">
                  {t('settings.builtinTools.scopePicker.userDefaultDescription')}
                </span>
              </span>
              <SelectParts.ItemIndicator className="absolute right-1 flex">
                <Check size={14} aria-hidden="true" />
              </SelectParts.ItemIndicator>
            </SelectParts.Item>
            {candidates.map((dir) => (
              <SelectParts.Item key={dir} value={dir} title={dir} className={SCOPE_ITEM_CLASS}>
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="truncate">
                    <SelectParts.ItemText>{basename(dir)}</SelectParts.ItemText>
                  </span>
                  <span className="truncate text-12 leading-[1.33] text-[var(--cmd-palette-item-meta)]">
                    {dir}
                  </span>
                </span>
                <SelectParts.ItemIndicator className="absolute right-1 flex">
                  <Check size={14} aria-hidden="true" />
                </SelectParts.ItemIndicator>
              </SelectParts.Item>
            ))}
          </SelectParts.Viewport>
        </SelectParts.Content>
      </SelectParts.Portal>
    </SelectParts.Root>
  );
}
