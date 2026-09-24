import { useRef, useState } from 'react';
import { Users } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { WINDOW_NO_DRAG_STYLE } from '@/components/layout/windowDrag';
import type { Session } from '@/lib/ccAgent.types';
import { SharedTaskDialog } from './SharedTaskDialog';

export function SharedTaskButton({ session, dialogControl }: {
  session: Session;
  dialogControl?: { onDismiss(): void; returnFocus(): void };
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(Boolean(dialogControl));
  const trigger = useRef<HTMLButtonElement>(null);
  return <>
    {!dialogControl && <Button ref={trigger} variant="secondary" tone="quiet" size="lg" style={WINDOW_NO_DRAG_STYLE}
      className="ml-2 w-9 p-0" aria-label={t('sharedTask.title')} title={t('sharedTask.title')} onClick={() => setOpen(true)}><Users size={18} aria-hidden /></Button>}
    <SharedTaskDialog open={open} session={session} onOpenChange={next => {
      setOpen(next);
      if (!next) dialogControl?.onDismiss();
    }} returnFocus={() => dialogControl ? dialogControl.returnFocus() : trigger.current?.focus()} />
  </>;
}
