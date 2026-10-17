import { useEffect, useRef, useState } from 'react';
import { LoaderCircle, Monitor, MonitorOff } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { WINDOW_NO_DRAG_STYLE } from '@/components/layout/windowDrag';
import { Tip } from '@/components/ui/tooltip';
import { useDeviceLinkDeviceList } from '@/features/device-link/useDeviceLinkDeviceList';
import { cn } from '@/lib/utils';
import { toast } from '@/lib/toast';
import { useRemoteDesktopAvailability } from './useRemoteDesktopAvailability';

/**
 * 当前任务在同账号另一台电脑上时，放在右栏开关旁的远程桌面入口（由 MainLayout 摆位：
 * mac 在顶栏右端、Windows 在内容区右上角的浮动 chip 栈）。
 *
 * 状态口径与侧栏电脑分组上的入口一致：可连 → 打开；检查中 → 转圈；暂时不能连 →
 * 置灰，悬停 / 点击说明原因；被打断的检查在再次悬停或聚焦时重查。这台电脑本身或
 * 手机不是远程桌面目标，不显示。调用方按 deviceId 加 key，换电脑即重建。
 *
 * 两端共用 28px 胶囊按钮；Windows chip 栈容器 pointer-events-none，按钮自带 auto。
 */
export function TaskRemoteDesktopButton({
  deviceId,
  className,
}: {
  deviceId: string;
  className?: string;
}) {
  const { t } = useTranslation();
  const devices = useDeviceLinkDeviceList();
  const name = devices?.find((device) => device.deviceId === deviceId)?.name || deviceId;
  const availability = useRemoteDesktopAvailability(deviceId);
  const [opening, setOpening] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  if (availability.reason === 'remoteDesktop.shortcut.unsupported') return null;
  const busy = opening || availability.checking;
  const Icon = busy ? LoaderCircle : availability.available ? Monitor : MonitorOff;
  const label = busy
    ? t(opening ? 'remoteDesktop.shortcut.opening' : 'remoteDesktop.shortcut.checking')
    : availability.available
      ? t('remoteDesktop.shortcut.open')
      : t('remoteDesktop.shortcut.unavailable', {
          reason: t(availability.reason ?? 'remoteDesktop.shortcut.checkFailed'),
        });
  // 侧栏同款：被打断的检查在用户再次看向入口时重查。
  const reveal = () => {
    if (availability.retryable) availability.retry();
  };
  return (
    <Tip
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
          !availability.available && !opening && 'opacity-50',
          busy && 'motion-safe:[&_svg]:animate-spin',
          className,
        )}
        style={WINDOW_NO_DRAG_STYLE}
        onMouseEnter={reveal}
        onFocus={reveal}
        onClick={() => {
          if (busy) return;
          if (!availability.available) {
            toast.info(label, { duration: 8000 });
            return;
          }
          setOpening(true);
          void window.electronAPI
            .openRemoteDesktop({ deviceId, name })
            .catch((error: unknown) => {
              if (!mounted.current) return;
              availability.markUnavailable(error);
              toast.error(t('remoteDesktop.connectionError'));
            })
            .finally(() => {
              if (mounted.current) setOpening(false);
            });
        }}
      >
        <Icon size={15} aria-hidden />
      </button>
    </Tip>
  );
}
