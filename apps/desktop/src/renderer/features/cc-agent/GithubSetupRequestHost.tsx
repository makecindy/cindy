import { useEffect, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { GithubAccountCard } from './GithubAccountCard';

/**
 * Opens Cindy's GitHub sign-in dialog when main asks this window to (a task requested to connect a
 * plugin that signs in through this computer's GitHub login, and nothing is signed in). Main sends the
 * request to one window only, so whichever window receives it shows the dialog.
 */
export function GithubSetupRequestHost() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  useEffect(() => window.electronAPI.gitContext?.onGithubSetupOpen?.(() => setOpen(true)), []);
  return open ? <Dialog.Root open onOpenChange={setOpen}>
    <Dialog.Portal>
      <Dialog.Overlay className="modal-scrim fixed inset-0 z-modal" />
      <Dialog.Content aria-describedby={undefined} onPointerDownOutside={(e) => e.preventDefault()}
        className="modal-panel fixed left-1/2 top-1/2 z-modal-raised flex max-h-[85vh] w-[min(440px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 flex-col gap-4 overflow-y-auto p-4 outline-none">
        <Dialog.Title className="text-16 font-medium text-[var(--confirm-title)]">GitHub</Dialog.Title>
        <GithubAccountCard includeEvents onConnected={() => {}} />
        <Dialog.Close asChild><Button variant="secondary">{t('ccAgent.gitContext.pr.setup.connection.close')}</Button></Dialog.Close>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root> : null;
}
