import { useEffect } from 'react';
import { Smartphone, Tablet, Tv } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { RemoteLiveScreen } from '@cindy/device-link';

import { WINDOW_NO_DRAG_STYLE } from '@/components/layout/windowDrag';
import { Tip } from '@/components/ui/tooltip';
import { openLiveScreenTab } from '@/features/right-sidebar/lib/openLiveScreenTab';
import { publishTaskLiveScreens } from './taskLiveScreensStore';
import type { TaskLiveScreens } from './useTaskLiveScreens';
import { cn } from '@/lib/utils';

/** Entries shown at once; a task rarely runs more than one or two devices. */
export const TASK_LIVE_SCREEN_LIMIT = 3;

const screenKey = (screen: RemoteLiveScreen) => `${screen.plugin}|${screen.id}`;
const tabState = (screen: RemoteLiveScreen) => ({
  plugin: screen.plugin,
  id: screen.id,
  name: screen.name,
  pluginName: screen.pluginName,
});

/** Devices already opened once, per task, for as long as this window lives. */
const opened = new Map<string, Set<string>>();
const OPENED_TASKS = 200;

/**
 * A device of this task appeared on its computer: open its sidebar tab, as the
 * same plugin does for a task on this computer. Once per appearance — coming
 * back to the task, or closing the tab, does not open it again until the
 * device goes away and returns. An unread list says nothing either way.
 */
export function useAutoOpenTaskLiveScreens(
  sessionId: string | null,
  { screens, loaded }: TaskLiveScreens,
): void {
  useEffect(() => {
    if (!sessionId || !loaded) return;
    publishTaskLiveScreens(sessionId, screens);
    let known = opened.get(sessionId);
    if (!known) {
      if (opened.size >= OPENED_TASKS) opened.delete(opened.keys().next().value as string);
      opened.set(sessionId, (known = new Set()));
    }
    const current = new Set(screens.map(screenKey));
    for (const key of [...known]) if (!current.has(key)) known.delete(key);
    const appeared = screens.find((screen) => !known.has(screenKey(screen)));
    for (const key of current) known.add(key);
    if (appeared)
      void openLiveScreenTab(sessionId, tabState(appeared), { userInitiated: false }).catch(
        () => {},
      );
  }, [sessionId, screens, loaded]);
}

/** Test seam: forget which devices were already opened. */
export function resetAutoOpenedTaskLiveScreens(): void {
  opened.clear();
}

/**
 * 当前任务在同账号另一台电脑上、且那台电脑的插件为这个任务开着设备画面（例如模拟器）时，
 * 放在远程桌面入口旁的「设备画面」入口：每台设备一个按钮，点它在右侧栏打开（或切到）
 * 这台设备的页签。设备出现时页签会自动打开；按钮用于关掉页签后再找回，或在多台设备间切换。
 *
 * 与 TaskRemoteDesktopButton 共用 28px 胶囊按钮与摆位（由 MainLayout 决定）。
 */
export function TaskLiveScreenButtons({
  sessionId,
  screens,
  className,
}: {
  sessionId: string;
  screens: readonly RemoteLiveScreen[];
  className?: string;
}) {
  const { t } = useTranslation();
  return (
    <>
      {screens.slice(0, TASK_LIVE_SCREEN_LIMIT).map((screen) => {
        const label = `${t('remoteDesktop.liveScreenTitle')} · ${screen.name}`;
        const Icon =
          screen.platform === 'ipados' ? Tablet : screen.platform === 'tvos' ? Tv : Smartphone;
        return (
          <Tip
            key={screenKey(screen)}
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
              onClick={() => void openLiveScreenTab(sessionId, tabState(screen)).catch(() => {})}
            >
              <Icon size={15} aria-hidden />
            </button>
          </Tip>
        );
      })}
    </>
  );
}
