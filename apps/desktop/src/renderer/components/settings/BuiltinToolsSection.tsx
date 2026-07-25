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
import { createLogger } from '@/lib/logger';
import { extractIpcError } from '@/utils/ipcError';
import { recentWorkdirsStore, type RecentWorkdirEntry } from '@/lib/recentWorkdirsStore';
import { normalizeWorkingDirForProjectSettings } from '../../../shared/workingDir';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { DefaultOverrideControls } from './DefaultOverrideControls';

const log = createLogger('BuiltinToolsSection');

interface PluginListItem {
  id: string;
  name: string;
  description: string;
  source: 'builtin' | 'hub' | 'local';
  essential: boolean;
  effectiveEnabled: boolean;
  productDefaultEnabled: boolean;
  projectOverride?: { enabled: boolean; workingDir: string } | null;
  userOverride?: { enabled: boolean } | null;
  globalOverride?: { enabled: boolean } | null;
}

interface BuiltinToolsSectionProps {
  /** lastWorkingDir snapshot — used as the initial pick for the project dropdown. */
  workingDir?: string;
}

/** Resolve a plugin id to its localized display name + description, falling
 *  back to the english strings emitted by builtin-plugins.ts when the i18n
 *  bundle is missing the key (defensive — should not happen in production). */
function useLocalizedPlugin(plugin: PluginListItem) {
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
  const snapshot = useSyncExternalStore(
    recentWorkdirsStore.subscribe,
    recentWorkdirsStore.get,
  );
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
  const activeProjectWorkingDir =
    normalizeWorkingDirForProjectSettings(workingDir) ?? undefined;
  const effectiveWorkingDir =
    normalizeWorkingDirForProjectSettings(
      selectedScope === undefined ? workingDir : selectedScope,
    ) ??
    undefined;

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
        const message = ipcError?.code === 'PERMISSION_DENIED'
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
        const message = ipcError?.code === 'PERMISSION_DENIED'
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
    <div className="flex flex-col gap-[14px]">
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-col gap-1 min-w-0">
          <h2 className="text-16 font-medium leading-[1.2] text-[var(--settings-section-title)]">
            {t('settings.builtinTools.title')}
          </h2>
          <p className="text-13 leading-[1.5] text-[var(--settings-section-desc)]">
            {t('settings.builtinTools.description')}
          </p>
        </div>
        <ScopePicker
          effectiveWorkingDir={effectiveWorkingDir}
          activeSessionWorkingDir={activeProjectWorkingDir}
          recentWorkdirs={recentWorkdirs}
          onPick={setSelectedScope}
        />
      </div>

      <div
        className={cn(
          'flex flex-col overflow-hidden rounded-xl',
          'bg-[var(--settings-theme-card-bg)]',
          'border border-[var(--settings-theme-card-border)]',
        )}
      >
        {plugins.map((plugin, index) => (
          <PluginRow
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
      </div>

      <p className="text-12 leading-[1.5] text-[var(--settings-section-desc)]">
        {t('settings.builtinTools.toggleHint')}
      </p>
    </div>
  );
}

/** Plugin 行 — 抽出来好让 useLocalizedPlugin hook 在子组件 scope 里调用,
 *  避免在父循环里直接调 hook (违反 rules of hooks)。 */
function PluginRow({
  plugin,
  divider,
  disabled,
  projectScope,
  onToggle,
  onClearOverride,
}: {
  plugin: PluginListItem;
  divider: boolean;
  disabled: boolean;
  projectScope: boolean;
  onToggle: (id: string, next: boolean, label: string) => void;
  onClearOverride: (id: string, label: string) => void;
}) {
  const { t } = useTranslation();
  const { name, description } = useLocalizedPlugin(plugin);
  const hasProjectOverride = plugin.projectOverride != null;
  const isCustomized = projectScope ? hasProjectOverride : plugin.userOverride != null;
  const sourceKey = projectScope && hasProjectOverride
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
            <span
              className="shrink-0 text-11 leading-none px-1.5 py-0.5 rounded-full
                bg-[var(--settings-input-bg)] text-[var(--settings-section-desc)]"
              title={t(`settings.builtinTools.source.${sourceKey}Tooltip`, {
                dir: plugin.projectOverride?.workingDir,
              })}
            >
              {t(`settings.builtinTools.source.${sourceKey}`)}
            </span>
          </div>
          <p className="text-12 leading-[1.35] text-[var(--settings-section-desc)] truncate">
            {description}
          </p>
        </div>
      </div>

      <div className="flex items-center gap-2 shrink-0">
        <DefaultOverrideControls
          isCustomized={isCustomized}
          disabled={disabled}
          onReset={() => onClearOverride(plugin.id, name)}
        />
        <Switch
          checked={plugin.effectiveEnabled}
          disabled={disabled}
          onCheckedChange={(v) => onToggle(plugin.id, v, name)}
          aria-label={t('settings.builtinTools.toggleAria', { name })}
        />
      </div>
    </div>
  );
}

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

  const triggerLabel = effectiveWorkingDir
    ? basename(effectiveWorkingDir)
    : t('settings.builtinTools.scopePicker.userDefault');

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={t('settings.builtinTools.scopePicker.ariaLabel')}
          title={effectiveWorkingDir ?? undefined}
          className={cn(
            'flex items-center gap-1.5 shrink-0 max-w-[200px]',
            'h-7 px-2.5 rounded-full',
            'bg-[var(--settings-input-bg)] text-[var(--settings-section-title)]',
            'text-12 font-medium',
            'hover:bg-[var(--surface-chip)]',
            'focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]',
            'transition-colors',
          )}
        >
          {effectiveWorkingDir
            ? <Folder size={12} className="shrink-0" />
            : <UserRound size={12} className="shrink-0" />}
          <span className="truncate">{triggerLabel}</span>
          <ChevronDown size={12} className="shrink-0 opacity-60" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-max min-w-0 max-w-[calc(100vw-32px)]">
        <DropdownMenuItem
          onClick={() => onPick(null)}
          className="grid w-full grid-cols-[14px_max-content] items-center gap-x-2.5 pr-4 cursor-pointer"
        >
          <Check size={14} className={cn('shrink-0', !effectiveWorkingDir ? 'opacity-100' : 'opacity-0')} />
          <div className="flex flex-col gap-0.5">
            <span className="whitespace-nowrap text-13 font-medium">
              {t('settings.builtinTools.scopePicker.userDefault')}
            </span>
            <span className="whitespace-nowrap text-11 text-[var(--settings-section-desc)]">
              {t('settings.builtinTools.scopePicker.userDefaultDescription')}
            </span>
          </div>
        </DropdownMenuItem>
        {candidates.map((dir) => {
            const isCurrent = dir === effectiveWorkingDir;
            return (
              <DropdownMenuItem
                key={dir}
                onClick={() => onPick(dir)}
                // minmax(0,max-content):菜单仍按内容自适应宽,但路径超过菜单
                // max-w 上限时列可收缩、由 truncate 出省略号,不再水平溢出。
                className="grid w-full grid-cols-[14px_minmax(0,max-content)] items-center gap-x-2.5 pr-4 cursor-pointer"
              >
                <Check
                  size={14}
                  className={cn('shrink-0', isCurrent ? 'opacity-100' : 'opacity-0')}
                />
                <div className="flex min-w-0 flex-col gap-0.5">
                  <div className="flex items-center gap-1.5">
                    <span className="truncate text-13 font-medium">
                      {basename(dir)}
                    </span>
                  </div>
                  <span title={dir} className="truncate text-11 text-[var(--settings-section-desc)]">
                    {dir}
                  </span>
                </div>
              </DropdownMenuItem>
            );
          })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
