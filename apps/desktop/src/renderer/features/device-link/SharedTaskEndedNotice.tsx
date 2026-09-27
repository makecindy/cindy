import { useEffect, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { CircleStop, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { isSharedTaskPeer } from '@cindy/device-link';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/contexts/AuthContext';
import { getDataOwnerGeneration, isDataOwnerGenerationCurrent, type DataOwnerGeneration } from '@/contexts/dataOwnerGeneration';

const endedEvent = 'cindy:shared-task-access-ended';

/** Presentation only, after the existing remote-session exit decision has revoked the view. */
export function notifySharedTaskEnded(peer: string | undefined): boolean {
  if (!peer || !isSharedTaskPeer(peer)) return false;
  window.dispatchEvent(new CustomEvent(endedEvent, { detail: getDataOwnerGeneration() }));
  return true;
}

/** Lives in the window menu so leaving the revoked task cannot unmount the ending screen. */
export function SharedTaskEndedNotice({ onJoin }: { onJoin(): void }) {
  const { t } = useTranslation();
  const { dataOwnerId } = useAuth();
  const [owner, setOwner] = useState<DataOwnerGeneration | null>(null);
  useEffect(() => {
    const receive = (event: Event) => {
      const stamp = (event as CustomEvent<DataOwnerGeneration>).detail;
      if (stamp && isDataOwnerGenerationCurrent(stamp)) setOwner(stamp);
    };
    window.addEventListener(endedEvent, receive);
    return () => window.removeEventListener(endedEvent, receive);
  }, []);
  const open = !!owner && owner.dataOwnerId === dataOwnerId && isDataOwnerGenerationCurrent(owner);
  return <Dialog.Root open={open} onOpenChange={(next) => { if (!next) setOwner(null); }}>
    <Dialog.Portal>
      <Dialog.Overlay className="fixed inset-0 z-[10000] bg-[var(--overlay-modal)]" />
      <Dialog.Content onPointerDownOutside={(event) => event.preventDefault()} className="fixed left-1/2 top-1/2 z-[10001] max-h-[calc(100dvh-32px)] w-[min(440px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] p-4 text-[var(--text-primary)]">
        <div className="mb-4 flex items-center justify-between gap-2">
          <Dialog.Title className="text-18 font-medium">{t('sharedTask.ended')}</Dialog.Title>
          <Dialog.Close asChild><Button variant="secondary" size="lg" className="w-9 border-transparent bg-transparent p-0" aria-label={t('sharedTask.dismiss')}><X size={18} aria-hidden /></Button></Dialog.Close>
        </div>
        <div className="px-1 py-6 text-center">
          <span className="mb-4 inline-flex size-11 items-center justify-center rounded-full border border-[var(--border-default)]"><CircleStop size={18} aria-hidden /></span>
          <h3 className="text-14 font-medium">{t('sharedTask.ended')}</h3>
          <Dialog.Description className="mx-auto mb-5 mt-2 max-w-[280px] text-12 text-[var(--text-secondary)]">{t('sharedTask.accessEndedBody')}</Dialog.Description>
          <Button variant="cta" size="lg" onClick={() => { setOwner(null); onJoin(); }}>{t('sharedTask.rejoin')}</Button>
        </div>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}
