import { useEffect, useRef, useState, type ReactNode } from 'react';
import { LoaderCircle, Monitor, MonitorOff } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { SIDEBAR_RAIL_ICON_BUTTON_CLASS } from '@/components/sidebar/SidebarIconButton';
import { Tip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { toast } from '@/lib/toast';
import { useRemoteDesktopAvailability } from '@/features/remote-desktop/useRemoteDesktopAvailability';

function RemoteDesktopShortcut({
  deviceId,
  name,
  active,
}: {
  deviceId: string;
  name: string;
  active: boolean;
}) {
  const { t } = useTranslation();
  const availability = useRemoteDesktopAvailability(deviceId, active);
  const [opening, setOpening] = useState(false);
  const openingRef = useRef(false);
  const generation = useRef(0);
  useEffect(() => {
    generation.current++;
    openingRef.current = false;
    setOpening(false);
    return () => {
      generation.current++;
    };
  }, [deviceId]);
  const busy = opening || availability.checking;
  const Icon = busy ? LoaderCircle : availability.available ? Monitor : MonitorOff;
  const label = busy
    ? t(opening ? 'remoteDesktop.shortcut.opening' : 'remoteDesktop.shortcut.checking')
    : availability.available
      ? t('remoteDesktop.shortcut.open')
      : t('remoteDesktop.shortcut.unavailable', {
          reason: t(availability.reason ?? 'remoteDesktop.shortcut.checkFailed'),
        });
  return (
    <div
      className={cn(
        'shrink-0 pointer-events-none opacity-0 transition-opacity duration-150 motion-reduce:transition-none',
        'group-hover/device-header:pointer-events-auto group-hover/device-header:opacity-100',
        'has-[:focus-visible]:pointer-events-auto has-[:focus-visible]:opacity-100',
      )}
    >
      <Tip
        text={label}
        side="right"
        contentClassName="max-w-[min(320px,var(--radix-tooltip-content-available-width))] whitespace-normal"
      >
        <button
          type="button"
          aria-label={label}
          aria-disabled={!availability.available || opening}
          aria-busy={busy || undefined}
          className={cn(
            SIDEBAR_RAIL_ICON_BUTTON_CLASS,
            'h-6 w-6 aria-disabled:opacity-50 aria-disabled:hover:bg-transparent',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]',
            active && busy && 'motion-safe:[&_svg]:animate-spin',
          )}
          onClick={(event) => {
            event.stopPropagation();
            if (!availability.available || openingRef.current) return;
            const current = generation.current;
            openingRef.current = true;
            setOpening(true);
            void window.electronAPI
              .openRemoteDesktop({ deviceId, name })
              .catch((error: unknown) => {
                if (current !== generation.current) return;
                availability.markUnavailable(error);
                toast.error(t('remoteDesktop.connectionError'));
              })
              .finally(() => {
                if (current !== generation.current) return;
                openingRef.current = false;
                setOpening(false);
              });
          }}
        >
          <Icon size={14} aria-hidden />
        </button>
      </Tip>
    </div>
  );
}

export function DeviceSectionHeader({
  deviceId,
  name,
  children,
}: {
  deviceId: string | null;
  name: string;
  children: ReactNode;
}) {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  return (
    <div
      className="group/device-header flex min-w-0 items-center gap-1"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocusCapture={(event) => setFocused(event.target.matches(':focus-visible'))}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocused(false);
      }}
    >
      {children}
      {deviceId && (
        <RemoteDesktopShortcut deviceId={deviceId} name={name} active={hovered || focused} />
      )}
    </div>
  );
}
