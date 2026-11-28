import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ExternalLink } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { toast } from '@/lib/toast';

/**
 * A setting this page leaves to the instance's own settings: one step to its remote desktop
 * instead of a dead end. Navigation only; the instance's own page makes the change.
 */
export function CloudDesktopFallback({
  deviceId,
  name,
  label,
  description,
  disabled = false,
}: {
  deviceId: string;
  /** The instance's display name. */
  name: string;
  label?: string;
  /** What to change there; defaults to a generic note. */
  description?: ReactNode;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const [opening, setOpening] = useState(false);
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );
  return (
    <section className="flex flex-col gap-2">
      {label && (
        <h3 className="text-13 font-medium text-[var(--settings-section-title)]">{label}</h3>
      )}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="min-w-0 flex-1 text-12 leading-[1.6] text-[var(--settings-section-desc)]">
          {/* As the client asks to finish on the other computer. */}
          {description ?? t('bots.remoteSettings.finishOnHost', { device: name })}
        </p>
        <Button
          variant="secondary"
          size="md"
          loading={opening}
          disabled={opening || disabled}
          onClick={() => {
            setOpening(true);
            void window.electronAPI
              .openRemoteDesktop({ deviceId, name })
              .catch(() => toast.error(t('remoteDesktop.connectionError')))
              .finally(() => {
                if (mounted.current) setOpening(false);
              });
          }}
        >
          <ExternalLink size={14} />
          {t('cloudSettings.openInCloudDesktop')}
        </Button>
      </div>
    </section>
  );
}
