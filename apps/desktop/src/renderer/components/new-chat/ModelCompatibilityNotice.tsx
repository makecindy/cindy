import { useState } from 'react';
import { CircleAlert } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Tooltip } from '@/components/ui/tooltip';

/** Shared wording and interaction for compatibility choices in settings and the picker. */
export function ModelCompatibilityNotice() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const label = t('settings.providers.models.advanced.protocol.compatibility');
  return (
    <span className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap text-[var(--text-tertiary)]">
      <span>{label}</span>
      <Tooltip.Provider>
        <Tooltip.Root open={open} onOpenChange={setOpen}>
          <Tooltip.Trigger asChild>
            <button
              type="button"
              aria-label={label}
              onClick={() => setOpen(true)}
              data-compatibility-notice
              className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-sm text-[var(--warning-accent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--model-dropdown-border)]"
            >
              <CircleAlert size={12} aria-hidden />
            </button>
          </Tooltip.Trigger>
          <Tooltip.Content className="z-[10002] max-w-[240px] break-normal">
            {t('settings.providers.models.advanced.protocol.compatibilityHint')}
          </Tooltip.Content>
        </Tooltip.Root>
      </Tooltip.Provider>
    </span>
  );
}
