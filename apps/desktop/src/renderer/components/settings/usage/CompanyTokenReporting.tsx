import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '@/contexts/AuthContext';
import { Switch } from '@/components/ui/switch';
import { toast } from '@/lib/toast';

type View = Awaited<ReturnType<Window['electronAPI']['companyTokenView']>>;
function useCompanyTokenView() {
  const { user, mode, isAuthenticated, dataOwnerGeneration } = useAuth();
  const [view, setView] = useState<View>(null);
  const org = isAuthenticated && mode === 'cloud' && user?.membershipKind === 'org' && user.orgId;
  useEffect(() => {
    setView(null);
    if (!org) return;
    let active = true;
    const read = async () => {
      try {
        const result = await window.electronAPI.companyTokenView();
        if (active) setView(result?.generation === dataOwnerGeneration ? result : null);
      } catch {
        if (active) setView(null);
      }
    };
    void read();
    const timer = window.setInterval(read, 15000);
    window.addEventListener('company-token-preference', read);
    return () => {
      active = false;
      clearInterval(timer);
      window.removeEventListener('company-token-preference', read);
    };
  }, [org, dataOwnerGeneration]);
  return org && view?.generation === dataOwnerGeneration ? view : null;
}

export function CompanyTokenSettings() {
  const view = useCompanyTokenView();
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  if (!view) return null;
  const toggle = async () => {
    setBusy(true);
    try {
      await window.electronAPI.companyTokenParticipation(!view.participating, view.generation);
    } catch {
      toast.error(t('companyTokens.syncFailed'));
    } finally {
      setBusy(false);
      window.dispatchEvent(new Event('company-token-preference'));
    }
  };
  return (
    <div className="mb-5 flex items-center justify-between gap-4 border-b border-[var(--border-default)] pb-4">
      <div>
        <div className="text-14 font-medium">{t('companyTokens.title')}</div>
        <div className="mt-1 text-12 text-[var(--text-secondary)]">
          {t(view.participating ? 'companyTokens.notice' : 'companyTokens.off')}
        </div>
      </div>
      <Switch
        aria-label={t('companyTokens.title')}
        checked={view.participating}
        disabled={busy}
        onCheckedChange={() => void toggle()}
      />
    </div>
  );
}
