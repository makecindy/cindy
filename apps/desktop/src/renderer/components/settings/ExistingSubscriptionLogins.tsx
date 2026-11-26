import { ChevronDown } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { toast } from '@/lib/toast';
import type { ExistingLogin, ExistingLoginResult, SubscriptionProvider } from '../../../shared/subscriptionAccounts';

export function ExistingSubscriptionLogins({ provider, disabled, children }: {
  provider: SubscriptionProvider; disabled: boolean; children: ReactNode;
}) {
  const { t } = useTranslation();
  const [found, setFound] = useState<ExistingLoginResult | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const alive = useRef(false);
  const operation = useRef(0);
  const api = window.electronAPI.subscriptionAccounts.existingLogins;
  useEffect(() => {
    alive.current = true;
    let current = true;
    const generation = operation.current;
    // Only settings discovery. Ordinary account/usage refreshes never launch more profile probes.
    void api?.({ action: 'discover-logins', providerId: provider }).then(result => {
      if (current && generation === operation.current) setFound(result);
    }).catch(() => {});
    return () => { current = false; alive.current = false; operation.current++; };
  }, [api, provider]);
  async function pick() {
    if (!api || busy) return;
    const generation = ++operation.current;
    setBusy(true);
    try {
      const result = await api({ action: 'pick-login', providerId: provider });
      if (!alive.current || generation !== operation.current || result.canceled) return;
      setFound(result);
      setOpen(true);
    } catch {
      if (alive.current) toast.error(t('subscriptionAccounts.existing.unverified'));
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  async function attach(candidate: ExistingLogin) {
    if (!api || busy) return;
    setBusy(true);
    try {
      await api({ action: 'attach-login', providerId: provider, receipt: candidate.receipt });
      if (!alive.current) return;
      setFound(previous => previous && ({ ...previous, candidates: previous.candidates.filter(row => row.receipt !== candidate.receipt) }));
      setOpen(false);
    } catch {
      if (alive.current) {
        setFound(previous => previous && ({ ...previous, candidates: previous.candidates.filter(row => row.receipt !== candidate.receipt) }));
        toast.error(t('subscriptionAccounts.existing.unverified'));
      }
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  if (!api) return <>{children}</>;
  const candidates = found?.candidates ?? [];
  const available = candidates.filter(candidate => !candidate.connected).length;
  const review = () => candidates.length ? setOpen(true) : void pick();
  return <>
    {available > 0 && <Button variant="secondary" tone="quiet" size="sm" disabled={disabled || busy}
      data-settings-search-action="Review verified existing subscription logins" onClick={review}>
      <span aria-hidden className="size-1.5 rounded-full bg-[var(--status-success)]" />
      {t('subscriptionAccounts.existing.found', { count: available })}
    </Button>}
    <div className="inline-flex items-center gap-px [&>button:first-child]:rounded-r-none [&>button:last-child]:rounded-l-none">
      {children}
      <DropdownMenu><DropdownMenuTrigger asChild>
        <Button variant="secondary" size="sm" compact disabled={disabled || busy}
          data-settings-search-action="Choose how to add a subscription account"
          aria-label={t('subscriptionAccounts.existing.menu')}><ChevronDown size={14} /></Button>
      </DropdownMenuTrigger><DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={review}>{t('subscriptionAccounts.existing.connect')}</DropdownMenuItem>
      </DropdownMenuContent></DropdownMenu>
    </div>
    {open && found && <ConfirmDialog open title={t('subscriptionAccounts.existing.title', { device: found.computer })}
      description={t('subscriptionAccounts.existing.note')} showCancel={false}
      confirmText={t('common.dismiss')} onConfirm={() => setOpen(false)}
      onOpenChange={next => { if (!busy) setOpen(next); }}
      content={<div className="space-y-2">
        {candidates.map(candidate => <div key={candidate.receipt} className="flex items-center justify-between gap-3 border-b border-[var(--border-default)] py-2">
          <div className="min-w-0 text-13"><p className="break-all font-medium">{candidate.identity}</p>
            <p className="break-all text-12 text-[var(--text-secondary)]">{candidate.plan ? candidate.plan + ' · ' : ''}{candidate.directory}</p></div>
          {candidate.connected ? <span className="shrink-0 text-12 text-[var(--status-success)]">{t('subscriptionAccounts.ready')}</span>
            : <Button variant="secondary" size="sm" disabled={busy} onClick={() => void attach(candidate)}
            data-settings-search-action="Connect the verified subscription account">{t('subscriptionAccounts.existing.attach')}</Button>}
        </div>)}
        <Button variant="secondary" size="sm" tone="quiet" disabled={busy} onClick={() => void pick()}
          data-settings-search-action="Choose another subscription profile directory">{t('subscriptionAccounts.existing.choose')}</Button>
      </div>} />}
  </>;
}
