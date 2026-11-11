import type { ComponentProps } from 'react';
import { useTranslation } from 'react-i18next';

import { Button, type ButtonProps } from '@/components/ui/button';
import { ErrorNotice } from '@/components/ui/error-notice';

type ImConnectionErrorProps = Partial<
  Pick<
    ComponentProps<typeof ErrorNotice>,
    'message' | 'description' | 'details' | 'actions' | 'role'
  >
>;

/** All bot settings use the same quiet error surface and redacted, collapsed details. */
export function ImConnectionError({ message, role = 'alert', ...props }: ImConnectionErrorProps) {
  const { t } = useTranslation();
  return (
    <ErrorNotice
      {...props}
      role={role}
      message={message ?? t('settings.imConnection.failed')}
      className="border-0 bg-transparent p-0"
    />
  );
}

type ImReconnectButtonProps = Omit<ButtonProps, 'onClick'> & {
  onReconnect: () => unknown;
};

/** Credential lookup and channel-specific recovery remain with each hook. */
export function ImReconnectButton({
  onReconnect,
  loading,
  disabled,
  children,
  ...props
}: ImReconnectButtonProps) {
  const { t } = useTranslation();
  return (
    <Button
      variant="secondary"
      type="button"
      {...props}
      loading={loading}
      disabled={disabled || loading}
      onClick={() => void onReconnect()}
    >
      {children ?? t('settings.imConnection.reconnect')}
    </Button>
  );
}

export function ImSavedConnectionRecovery(props: ImReconnectButtonProps) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <p className="text-12 text-[var(--settings-section-desc)]">
        {t('settings.imConnection.savedNote')}
      </p>
      <ImReconnectButton {...props} />
    </div>
  );
}
