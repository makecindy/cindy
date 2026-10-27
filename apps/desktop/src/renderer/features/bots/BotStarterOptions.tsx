import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { useSessionQuickSend } from '@/components/chat/SessionQuickSendContext';

/**
 * Starter choices under a Market teammate's opening line. A choice is sent as the user's own message
 * through the session's normal send path; once the user has written anything in the task (including
 * a choice) the row disappears, and it never sends twice.
 */
export function BotStarterOptions({ options, locked }: { options: readonly string[]; locked: boolean }) {
  const { t } = useTranslation();
  const quickSend = useSessionQuickSend();
  const sending = useRef(false);
  const [sent, setSent] = useState(false);
  if (!options.length || locked || sent || !quickSend) return null;
  const choose = async (text: string) => {
    if (sending.current) return;
    sending.current = true;
    try { if (await quickSend.send(text)) setSent(true); }
    finally { sending.current = false; }
  };
  return (
    <div role="group" aria-label={t('bots.starterOptions')} className="mt-3 flex animate-fade-in flex-wrap gap-2">
      {options.map(option => (
        <Button key={option} type="button" variant="secondary" size="sm" onClick={() => void choose(option)}>{option}</Button>
      ))}
    </div>
  );
}
