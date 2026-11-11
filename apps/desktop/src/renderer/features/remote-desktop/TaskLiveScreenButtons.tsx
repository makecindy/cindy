import { deviceDisplayName } from '@/lib/deviceName';
import { useEffect, useRef, useState } from 'react';
import { LoaderCircle, Smartphone, Tablet, Tv } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { RemoteLiveScreen } from '@cindy/device-link';

import { WINDOW_NO_DRAG_STYLE } from '@/components/layout/windowDrag';
import { Tip } from '@/components/ui/tooltip';
import { useDeviceLinkDeviceList } from '@/features/device-link/useDeviceLinkDeviceList';
import { cn } from '@/lib/utils';
import { toast } from '@/lib/toast';

/** Entries shown at once; a task rarely runs more than one or two devices. */
export const TASK_LIVE_SCREEN_LIMIT = 3;

/**
 * 当前任务在同账号另一台电脑上、且那台电脑的插件为这个任务开着设备画面（例如模拟器）时，
 * 放在远程桌面入口旁的「设备画面」入口：每台设备一个按钮，点开只显示并操作那台设备，
 * 不打开电脑的其他内容。与手机任务页的入口同源（`screens` 列表里绑定到本任务、正在运行的设备）。
 *
 * 与 TaskRemoteDesktopButton 共用 28px 胶囊按钮与摆位（由 MainLayout 决定）。
 */
export function TaskLiveScreenButtons({
  deviceId,
  screens,
  className,
}: {
  deviceId: string;
  screens: readonly RemoteLiveScreen[];
  className?: string;
}) {
  const { t } = useTranslation();
  const devices = useDeviceLinkDeviceList();
  const name = deviceDisplayName(deviceId, undefined, devices ?? []);
  const [opening, setOpening] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  return (
    <>
      {screens.slice(0, TASK_LIVE_SCREEN_LIMIT).map((screen) => {
        const key = `${screen.plugin}|${screen.id}`;
        const busy = opening === key;
        const label = `${t('remoteDesktop.liveScreenTitle')} · ${screen.name}`;
        const Icon = busy
          ? LoaderCircle
          : screen.platform === 'ipados'
            ? Tablet
            : screen.platform === 'tvos'
              ? Tv
              : Smartphone;
        return (
          <Tip
            key={key}
            text={label}
            side="bottom"
            contentClassName="max-w-[min(320px,var(--radix-tooltip-content-available-width))] whitespace-normal"
          >
            <button
              type="button"
              aria-label={label}
              aria-disabled={busy}
              aria-busy={busy || undefined}
              className={cn(
                'pointer-events-auto flex h-7 w-7 shrink-0 items-center justify-center',
                'rounded-full',
                'text-titlebar-icon transition-colors hover:bg-titlebar-button-hover',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]',
                'aria-disabled:hover:bg-transparent',
                busy && 'motion-safe:[&_svg]:animate-spin',
                className,
              )}
              style={WINDOW_NO_DRAG_STYLE}
              onClick={() => {
                if (opening) return;
                setOpening(key);
                void window.electronAPI
                  .openRemoteDesktop({
                    deviceId,
                    name,
                    screen: { plugin: screen.plugin, id: screen.id, name: screen.name },
                  })
                  .catch(() => {
                    if (mounted.current) toast.error(t('remoteDesktop.connectionError'));
                  })
                  .finally(() => {
                    if (mounted.current) setOpening(null);
                  });
              }}
            >
              <Icon size={15} aria-hidden />
            </button>
          </Tip>
        );
      })}
    </>
  );
}
