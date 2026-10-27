import { useCallback, useRef, useState } from 'react';
import { Share2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { ChromeIconButton } from '@/components/title-bar/ChromeIconButton';
import { ShareDialog } from '@/features/share/ShareDialog';
import { useAuth } from '@/contexts/AuthContext';
import type { ShareOptions } from '../../../shared/share';

export function PluginShareButton({ pluginId }: { pluginId: string }) {
  const { t } = useTranslation();
  const { isAuthenticated, dataOwnerGeneration, dataOwnerId } = useAuth();
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const restoringFocus = useRef(false);
  const load = useCallback(
    (options: ShareOptions) => window.electronAPI.pluginMarket.prepareShare(pluginId, options),
    [pluginId],
  );
  return (
    <>
      <ChromeIconButton
        aria-label={t('sharing.title')}
        tooltip={t('sharing.title')}
        tooltipSide="bottom"
        onFocus={(event) => {
          if (restoringFocus.current) event.preventDefault();
        }}
        onClick={(event) => {
          trigger.current = event.currentTarget;
          setOpen(true);
        }}
      >
        <Share2 size={14} aria-hidden />
      </ChromeIconButton>
      {open ? (
        <ShareDialog
          key={`${pluginId}:${dataOwnerId ?? ''}:${dataOwnerGeneration}`}
          load={load}
          allowAttribution={isAuthenticated}
          onClose={() => setOpen(false)}
          restoreFocus={() => {
            restoringFocus.current = true;
            trigger.current?.focus();
            restoringFocus.current = false;
          }}
        />
      ) : null}
    </>
  );
}
