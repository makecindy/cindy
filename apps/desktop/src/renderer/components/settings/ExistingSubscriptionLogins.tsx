import { ChevronDown } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { toast } from '@/lib/toast';
import { EXISTING_LOGIN_REVIEW_TTL_MS, type ExistingLogin, type ExistingLoginResult, type SubscriptionProvider } from '../../../shared/subscriptionAccounts';

type ReviewAction = 'discover-logins' | 'pick-login';
type Review = ExistingLoginResult & { action: ReviewAction; validUntil: number };

export function ExistingSubscriptionLogins({ provider, disabled, children }: {
  provider: SubscriptionProvider; disabled: boolean; children: ReactNode;
}) {
  const { t } = useTranslation();
  const [found, setFound] = useState<Review | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const operation = useRef(0);
  const api = window.electronAPI.subscriptionAccounts.existingLogins;
  const requestReview = useCallback(async (action: ReviewAction): Promise<Review | null> => {
    if (!api) return null;
    const started = Date.now();
    const result = await api({ action, providerId: provider });
    if (result.canceled) return null;
    // Manual selection mints its receipt after the native picker closes. Discovery can
    // mint several while probing, so age those from the start and allow for transport.
    const reviewed = action === 'pick-login' ? Date.now() : started;
    return { ...result, action, validUntil: reviewed + EXISTING_LOGIN_REVIEW_TTL_MS - 5000 };
  }, [api, provider]);

  useEffect(() => {
    const generation = ++operation.current;
    void requestReview('discover-logins').then(result => {
      if (generation === operation.current) setFound(result);
    }).catch(() => {});
    return () => { operation.current++; };
  }, [requestReview]);

  async function load(action: ReviewAction) {
    if (busy) return;
    const generation = ++operation.current;
    setBusy(true);
    try {
      const result = await requestReview(action);
      if (generation !== operation.current || !result) return;
      setFound(result);
      setOpen(true);
    } catch {
      if (generation === operation.current) toast.error(t('subscriptionAccounts.existing.unverified'));
    } finally {
      if (generation === operation.current) setBusy(false);
    }
  }

  useEffect(() => {
    if (!found?.validUntil || !found.candidates.length) return;
    const timer = window.setTimeout(() => {
      setFound(current => current === found ? { ...found, validUntil: 0 } : current);
    }, Math.max(0, found.validUntil - Date.now()));
    return () => window.clearTimeout(timer);
  }, [found]);

  async function attach(candidate: ExistingLogin) {
    if (!api || !found || busy) return;
    // A suspended renderer may resume on a click before its expiry timer fires.
    if (found.validUntil <= Date.now()) return load(found.action);
    const generation = ++operation.current;
    setBusy(true);
    try {
      await api({ action: 'attach-login', providerId: provider, receipt: candidate.receipt });
      if (generation !== operation.current) return;
      setFound(previous => previous && ({ ...previous, candidates: previous.candidates.filter(row => row.receipt !== candidate.receipt) }));
      setOpen(false);
    } catch {
      if (generation === operation.current) {
        // The host can consume or invalidate a receipt before our local deadline.
        setFound(previous => previous && ({ ...previous, validUntil: 0 }));
        toast.error(t('subscriptionAccounts.existing.unverified'));
      }
    } finally {
      if (generation === operation.current) setBusy(false);
    }
  }
  if (!api) return <>{children}</>;
  const expired = !!found?.candidates.length && found.validUntil <= Date.now();
  const candidates = expired ? [] : found?.candidates ?? [];
  const available = candidates.filter(candidate => !candidate.connected).length;
  const review = () => {
    if (busy) return;
    if (found?.candidates.length && found.validUntil > Date.now()) setOpen(true);
    else void load(found?.candidates.length ? found.action : 'pick-login');
  };
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
        {expired && found.action === 'discover-logins' && <Button variant="secondary" size="sm" disabled={busy}
          data-settings-search-action="Review existing subscription logins again" onClick={review}>
          {t('subscriptionAccounts.existing.connect')}
        </Button>}
        <Button variant="secondary" size="sm" tone="quiet" disabled={busy} onClick={() => void load('pick-login')}
          data-settings-search-action="Choose another subscription profile directory">{t('subscriptionAccounts.existing.choose')}</Button>
      </div>} />}
  </>;
}
