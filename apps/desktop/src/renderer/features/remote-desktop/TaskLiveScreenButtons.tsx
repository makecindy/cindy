import { useCallback, useEffect, useMemo } from 'react';
import { Smartphone, Tablet, Tv } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import type { RemoteLiveScreen } from '@cindy/device-link';

import { useInstalledGhosts } from '@/cindy-brain/useInstalledGhosts';
import { WINDOW_NO_DRAG_STYLE } from '@/components/layout/windowDrag';
import { useConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import { Tip } from '@/components/ui/tooltip';
import { pluginSetupRoute } from '@/features/cc-agent/pluginSkillSetup';
import { openPluginTaskTab } from '@/features/right-sidebar/lib/openPluginTaskTab';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import type { InstalledGhost } from '../../../shared/ghost';
import {
  installedGhostLogicalIdentity,
  installedGhostStoragePart,
  parsePluginStoragePart,
} from '../../../shared/pluginIdentity';
import type { TaskLiveScreens } from './useTaskLiveScreens';

/** Entries shown at once; a task rarely uses more than one device plugin. */
export const TASK_LIVE_SCREEN_LIMIT = 3;

/**
 * What this computer still needs before it can show a device: the plugin that
 * provides it must be installed here, turned on, and new enough to draw
 * another computer's device in its own task page.
 */
export type TaskLiveScreenNeed = 'install' | 'enable' | 'update';

/** One plugin's devices for the task, and whether this computer can show them. */
export interface TaskLiveScreenEntry {
  plugin: string;
  pluginName: string;
  pluginIdentity?: string;
  screens: RemoteLiveScreen[];
  ghost: InstalledGhost | null;
  need: TaskLiveScreenNeed | null;
}

/**
 * The task's devices grouped by the plugin that provides them. The picture and
 * every control belong to that plugin's own page, so an entry is usable only
 * with the same plugin here. A computer with two copies of one plugin lists a
 * device twice: copies this computer cannot show are left out as long as one
 * it can show exists, and otherwise a single entry asks for the plugin.
 */
export function taskLiveScreenEntries(
  screens: readonly RemoteLiveScreen[],
  installed: readonly InstalledGhost[],
): TaskLiveScreenEntry[] {
  const entries: TaskLiveScreenEntry[] = [];
  for (const screen of screens) {
    if (!screen.pluginIdentity) continue;
    let entry = entries.find((item) => item.plugin === screen.plugin);
    if (!entry) {
      // The same plugin here: same id from the same source. Its install key
      // may differ between two computers (an older install keeps its place).
      const identity = parsePluginStoragePart(screen.pluginIdentity ?? '');
      const ghost =
        (identity &&
          installed.find((item) => {
            const local = installedGhostLogicalIdentity(item);
            return local.ghostId === identity.ghostId && local.namespace === identity.namespace;
          })) ||
        null;
      entry = {
        plugin: screen.plugin,
        pluginIdentity: screen.pluginIdentity,
        pluginName: screen.pluginName,
        screens: [],
        ghost,
        need: !ghost
          ? 'install'
          : ghost.enabled === false
            ? 'enable'
            : ghost.manifest.taskView?.remote !== true
              ? 'update'
              : null,
      };
      entries.push(entry);
    }
    entry.screens.push(screen);
  }
  const groups = new Map<string, TaskLiveScreenEntry>();
  for (const entry of entries) {
    const identity = parsePluginStoragePart(entry.pluginIdentity ?? '');
    const key = identity ? JSON.stringify([identity.namespace, identity.ghostId]) : entry.plugin;
    const previous = groups.get(key);
    if (!previous || (previous.need && !entry.need)) groups.set(key, entry);
    else if (previous.ghost === entry.ghost) {
      for (const screen of entry.screens)
        if (!previous.screens.some((known) => known.id === screen.id))
          previous.screens.push(screen);
    }
  }
  return [...groups.values()];
}

/** Where the user makes the plugin usable: its own page here, else its market listing. */
async function setupRoute(entry: TaskLiveScreenEntry): Promise<string> {
  const identity = parsePluginStoragePart(entry.pluginIdentity ?? '');
  if (!identity) return '/plugins';
  try {
    return (await pluginSetupRoute(entry.ghost ?? undefined, identity.ghostId, identity)) ?? '/plugins';
  } catch {
    return '/plugins';
  }
}

/** The words for what this computer needs, and the way to the place that provides it. */
function useEntrySetup() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const copy = useCallback(
    (entry: TaskLiveScreenEntry, part: 'title' | 'body' | 'action') =>
      t(`remoteDesktop.liveScreenPlugin.${entry.need ?? 'install'}.${part}`, {
        plugin: entry.pluginName,
        device: entry.screens[0]?.name ?? '',
      }),
    [t],
  );
  const setUp = useCallback(
    (entry: TaskLiveScreenEntry) => void setupRoute(entry).then((route) => navigate(route)),
    [navigate],
  );
  return { copy, setUp };
}

/** What was already opened or asked for, per task, for as long as this window lives. */
const handled = new Map<string, Set<string>>();
const HANDLED_TASKS = 200;
const entryKey = (entry: TaskLiveScreenEntry) => `${entry.plugin}|${entry.need ?? 'ready'}`;

/**
 * A device of this task appeared on its computer. With the plugin usable here,
 * its task page opens in the sidebar, as the plugin does for a task on this
 * computer; without it, a notice says what to install (or turn on, or update)
 * and leads there. Once per appearance: coming back to the task or closing the
 * tab does not repeat it until the device goes away and returns, or until the
 * plugin becomes usable. An unread list says nothing either way.
 */
export function useAutoOpenTaskLiveScreens(
  sessionId: string | null,
  { screens, loaded }: TaskLiveScreens,
): TaskLiveScreenEntry[] {
  const installed = useInstalledGhosts();
  const entries = useMemo(() => taskLiveScreenEntries(screens, installed), [screens, installed]);
  const { copy, setUp } = useEntrySetup();
  useEffect(() => {
    if (!sessionId || !loaded) return;
    let known = handled.get(sessionId);
    if (!known) {
      if (handled.size >= HANDLED_TASKS) handled.delete(handled.keys().next().value as string);
      handled.set(sessionId, (known = new Set()));
    }
    const current = new Set(entries.map(entryKey));
    for (const key of [...known]) if (!current.has(key)) known.delete(key);
    for (const entry of entries) {
      const key = entryKey(entry);
      if (known.has(key)) continue;
      known.add(key);
      if (!entry.need && entry.ghost)
        void openPluginTaskTab(sessionId, installedGhostStoragePart(entry.ghost), {
          userInitiated: false,
        }).catch(() => {});
      else
        toast.info(copy(entry, 'body'), {
          title: copy(entry, 'title'),
          duration: 12_000,
          action: { label: copy(entry, 'action'), emphasis: 'cta', onClick: () => setUp(entry) },
        });
    }
  }, [sessionId, entries, loaded, copy, setUp]);
  return entries;
}

/** Test seam: forget what was already opened or asked for. */
export function resetAutoOpenedTaskLiveScreens(): void {
  handled.clear();
}

/**
 * 当前任务在同账号另一台电脑上、且那台电脑的插件为这个任务开着设备（例如模拟器）时，
 * 放在远程桌面入口旁的入口：每个提供设备的插件一个按钮。画面和操作都在该插件自己的
 * 任务页里（与任务在本机时同一个页面），所以这台电脑也要装着同一个插件：装好了，点按钮
 * 在右侧栏打开（或切到）它的任务页；没装、没开启或版本太旧，点按钮说明原因并带用户去处理。
 *
 * 与 TaskRemoteDesktopButton 共用 28px 胶囊按钮与摆位（由 MainLayout 决定）。
 */
export function TaskLiveScreenButtons({
  sessionId,
  entries,
  className,
}: {
  sessionId: string;
  entries: readonly TaskLiveScreenEntry[];
  className?: string;
}) {
  const { copy, setUp } = useEntrySetup();
  const { confirm } = useConfirmDialog();
  const open = async (entry: TaskLiveScreenEntry) => {
    if (!entry.need && entry.ghost) {
      await openPluginTaskTab(sessionId, installedGhostStoragePart(entry.ghost)).catch(() => {});
      return;
    }
    const go = await confirm({
      title: copy(entry, 'title'),
      description: copy(entry, 'body'),
      confirmText: copy(entry, 'action'),
      autoFocusConfirm: true,
    });
    if (go) setUp(entry);
  };
  return (
    <>
      {entries.slice(0, TASK_LIVE_SCREEN_LIMIT).map((entry) => {
        const first = entry.screens[0];
        const label = entry.need
          ? copy(entry, 'title')
          : `${entry.pluginName} · ${entry.screens.map((screen) => screen.name).join(', ')}`;
        const Icon =
          first?.platform === 'ipados' ? Tablet : first?.platform === 'tvos' ? Tv : Smartphone;
        return (
          <Tip
            key={entry.plugin}
            text={label}
            side="bottom"
            contentClassName="max-w-[min(320px,var(--radix-tooltip-content-available-width))] whitespace-normal"
          >
            <button
              type="button"
              aria-label={label}
              className={cn(
                'pointer-events-auto flex h-7 w-7 shrink-0 items-center justify-center',
                'rounded-full',
                'text-titlebar-icon transition-colors hover:bg-titlebar-button-hover',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]',
                className,
              )}
              style={WINDOW_NO_DRAG_STYLE}
              onClick={() => void open(entry)}
            >
              <Icon size={15} aria-hidden />
            </button>
          </Tip>
        );
      })}
    </>
  );
}
