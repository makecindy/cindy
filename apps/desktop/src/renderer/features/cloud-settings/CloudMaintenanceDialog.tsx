import { useMemo, useRef, useState, type RefObject } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { useTranslation } from 'react-i18next';
import {
  getDataOwnerGeneration,
  isDataOwnerGenerationCurrent,
} from '@/contexts/dataOwnerGeneration';
import { CloudInstanceSection, type CloudInstanceFeed } from './CloudInstanceSection';
import { createCloudSettingsClient } from './client';

/**
 * Updates and maintenance of one cloud instance, in a dialog opened from its device card: the
 * version state on top, the automatic updates saved as they change, and only Done in the footer.
 * DESIGN.md "Dialog & Modal": min(460px, 100vw-32px), no ×, the scrim does not close it, Esc is
 * Done, and focus returns to the card's button.
 */
export function CloudMaintenanceDialog({
  open,
  onOpenChange,
  deviceId,
  name,
  feed,
  opener,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  deviceId: string;
  name: string;
  feed: CloudInstanceFeed;
  /** Opened from a plain button, not a Dialog.Trigger: focus returns there on close (§14.2). */
  opener: RefObject<HTMLElement | null>;
}) {
  const { t } = useTranslation();
  const [footer, setFooter] = useState<HTMLDivElement | null>(null);
  const owner = useRef(getDataOwnerGeneration());
  // Instance operations only (upgrade, policy); no settings session is opened.
  const client = useMemo(
    () =>
      !open || !window.electronAPI?.cloudSettings
        ? null
        : createCloudSettingsClient(deviceId, window.electronAPI.cloudSettings, () => {
            if (!isDataOwnerGenerationCurrent(owner.current))
              throw new Error('CLOUD_SETTINGS_SCOPE_CHANGED');
          }),
    [open, deviceId],
  );
  // Changes are saved as they are made: closing never asks.
  const finish = () => onOpenChange(false);
  return (
    <Dialog.Root open={open} onOpenChange={(next) => (next ? onOpenChange(true) : finish())}>
      <Dialog.Portal>
        <Dialog.Overlay className="modal-scrim fixed inset-0 z-[10000]" />
        <Dialog.Content
          aria-describedby={undefined}
          onPointerDownOutside={(event) => event.preventDefault()}
          // The auto-update switch takes focus once the policy has loaded (autoFocus in the form).
          onOpenAutoFocus={(event) => event.preventDefault()}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            opener.current?.focus();
          }}
          className="modal-panel fixed left-1/2 top-1/2 z-[10000] flex max-h-[88vh] w-[min(460px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 flex-col p-4 focus:outline-none"
        >
          <Dialog.Title className="text-15 font-medium text-[var(--confirm-title)]">
            {t('cloudSettings.instance.updates')}
          </Dialog.Title>
          <p className="mt-1 truncate text-12 text-[var(--confirm-desc)]">{name}</p>
          <div className="-mx-4 mt-3 min-h-0 flex-1 overflow-y-auto px-4">
            {client && (
              <CloudInstanceSection
                client={client}
                name={name}
                active
                embedded
                feed={feed}
                changed={() => {}}
                dialog={{ footer, onCancel: finish }}
              />
            )}
          </div>
          {/* The form's rows sit in the section's inset box (px-3); the buttons line up with them. */}
          <div ref={setFooter} className="mt-4 flex flex-wrap justify-end gap-2 px-3" />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
