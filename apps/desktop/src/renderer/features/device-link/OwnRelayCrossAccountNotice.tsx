import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';

const NOTE_KEY = {
  sharedTask: 'sharedTask.officialRelayNote',
  providerShare: 'providerShare.officialRelayNote',
} as const;

/** Sharing follows its invitation's V2 relay; legacy sharing keeps its original official route. */
export function OwnRelayCrossAccountNotice({ feature, className }: {
  feature: keyof typeof NOTE_KEY;
  className?: string;
}) {
  const { t } = useTranslation();
  const [ownRelay, setOwnRelay] = useState(false);
  useEffect(() => {
    const api = window.electronAPI?.selfHostedRelay;
    if (!api) return;
    let active = true;
    void api.command({ type: 'state' })
      .then((result) => { if (active) setOwnRelay(result.state.mode === 'self-hosted'); })
      .catch(() => undefined);
    const off = api.onChanged((next) => { if (active) setOwnRelay(next.mode === 'self-hosted'); });
    return () => {
      active = false;
      off();
    };
  }, []);
  if (!ownRelay) return null;
  return <p className={cn('text-12 leading-[1.5] text-[var(--text-secondary)]', className)}>{t(NOTE_KEY[feature])}</p>;
}
