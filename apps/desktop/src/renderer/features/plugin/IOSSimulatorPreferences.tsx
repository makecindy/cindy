/** Host-owned iOS Simulator presentation preference shown on the Plugin detail page. */

import { useCallback, useEffect, useState } from 'react';
import { PanelRightOpen } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Switch } from '@/components/ui/switch';
import { createLogger } from '@/lib/logger';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';

const log = createLogger('IOSSimulatorPreferences');

export function IOSSimulatorPreferences() {
  const { t } = useTranslation();
  const genericError = t('settings.ghosts.errors.generic');
  const [enabled, setEnabled] = useState(true);
  const [ready, setReady] = useState(false);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void window.electronAPI.maker.iosSimulator
      .getPreferences()
      .then((preferences) => {
        if (cancelled) return;
        setEnabled(preferences.autoOpenEmbeddedPanel);
        setReady(true);
      })
      .catch((error) => {
        if (cancelled) return;
        log.warn('Failed to load iOS Simulator preferences', error);
        toast.error(genericError);
      });
    return () => {
      cancelled = true;
    };
  }, [genericError]);

  const handleToggle = useCallback(
    async (next: boolean) => {
      const previous = enabled;
      setEnabled(next);
      setPending(true);
      try {
        const preferences =
          await window.electronAPI.maker.iosSimulator.setAutoOpenEmbeddedPanel(next);
        setEnabled(preferences.autoOpenEmbeddedPanel);
      } catch (error) {
        log.warn('Failed to update iOS Simulator preferences', error);
        setEnabled(previous);
        toast.error(genericError);
      } finally {
        setPending(false);
      }
    },
    [enabled, genericError],
  );

  return (
    <div
      className={cn(
        'flex min-h-20 items-center gap-3 rounded-xl border px-5 py-4',
        'border-[color-mix(in_srgb,var(--border-default)_72%,transparent)]',
        'bg-[color-mix(in_srgb,var(--surface-elevated)_82%,var(--surface))]',
      )}
    >
      <PanelRightOpen
        size={18}
        className="shrink-0 text-[var(--text-tertiary)]"
        aria-hidden="true"
      />
      <div className="min-w-0 flex-1">
        <p className="text-14 font-medium leading-[1.571] text-[var(--text-primary)]">
          {t('settings.ghosts.detail.iosSimulatorAutoOpenTitle')}
        </p>
        <p className="mt-0.5 text-13 leading-5 text-[var(--text-secondary)]">
          {t('settings.ghosts.detail.iosSimulatorAutoOpenDescription')}
        </p>
      </div>
      <Switch
        checked={enabled}
        disabled={!ready || pending}
        onCheckedChange={(value) => void handleToggle(value)}
        aria-label={t('settings.ghosts.detail.iosSimulatorAutoOpenTitle')}
      />
    </div>
  );
}
