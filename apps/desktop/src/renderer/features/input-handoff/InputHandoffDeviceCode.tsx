import { Copy, ExternalLink } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { isInputHandoffDeviceCode, type InputHandoffSnapshot } from '@cindy/device-link';
import { Button } from '@/components/ui/button';
import { toast } from '@/lib/toast';

/**
 * Device-code sign-in: the screen only shows a code and a link. The owner
 * copies the code and opens the link here, where their browser is already
 * signed in; nothing is typed into the window. The link is checked again
 * (https, shown origin) before it is opened.
 */
export function InputHandoffDeviceCode({ snapshot }: { snapshot: InputHandoffSnapshot }) {
  const { t } = useTranslation();
  const deviceCode = snapshot.deviceCode;
  if (!isInputHandoffDeviceCode(deviceCode)) return null;
  return (
    <div
      aria-live="polite"
      className="mb-4 flex flex-col gap-3 rounded-[10px] border border-[var(--border-default)] bg-[var(--surface-card-ivory)] p-3"
    >
      <span className="text-12 text-[var(--text-secondary)]">
        {t('inputHandoff.deviceCode.prompt')}
      </span>
      <code className="select-all text-20 font-semibold tracking-[0.16em] text-[var(--text-primary)]">
        {deviceCode.code}
      </code>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="secondary"
          size="sm"
          type="button"
          onClick={() => {
            void Promise.resolve()
              .then(() => navigator.clipboard.writeText(deviceCode.code))
              .then(() => toast.success(t('inputHandoff.deviceCode.copied')))
              .catch(() => toast.error(t('inputHandoff.deviceCode.copyFailed')));
          }}
        >
          <Copy size={13} aria-hidden />
          {t('inputHandoff.deviceCode.copy')}
        </Button>
        <Button
          variant="secondary"
          size="sm"
          type="button"
          onClick={() => {
            void window.electronAPI
              .openExternal(deviceCode.url)
              .then((result) => {
                if (!result.success) toast.error(t('inputHandoff.deviceCode.openFailed'));
              })
              .catch(() => toast.error(t('inputHandoff.deviceCode.openFailed')));
          }}
        >
          <ExternalLink size={13} aria-hidden />
          {t('inputHandoff.deviceCode.open')}
          <span className="font-mono font-normal text-[var(--text-tertiary)]">
            · {deviceCode.origin}
          </span>
        </Button>
      </div>
      <span className="text-12 text-[var(--text-tertiary)]">
        {t('inputHandoff.deviceCode.then')}
      </span>
    </div>
  );
}
