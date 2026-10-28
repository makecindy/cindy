import { MemberBudgetEditor } from './MemberBudgetEditor';
import { isProviderShareMemberBudget, type ProviderShareMemberBudget } from '../../../shared/providerShareBudget';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ErrorNotice } from '@/components/ui/error-notice';
import { getDataOwnerGeneration, isDataOwnerGenerationCurrent } from '@/contexts/dataOwnerGeneration';
import { useOptionalAuthUser } from '@/contexts/AuthContext';
import { isProviderManagementOutdated, providerShareManagementCommand } from '../provider-group/providerManagement';
import type { RemoteModelAccessView, RemoteModelSelection } from '../../../shared/remoteModelAccess';
import { ProviderShareDialog, ProviderShareDialogFooter, ProviderShareDialogTitle } from './ProviderShareDialog';

const key = 'providerShare.modelAccess.';

export function RemoteModelAccessSection({ providerId, deviceId }: { providerId: string; deviceId?: string }) {
  const { t } = useTranslation();
  useOptionalAuthUser();
  const owner = getDataOwnerGeneration();
  const [view, setView] = useState<RemoteModelAccessView | null>(null);
  const [viewOwner, setViewOwner] = useState(owner);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    let active = true;
    let sequence = 0;
    setView(null);
    const load = async () => {
      const request = ++sequence;
      try {
        const next = await providerShareManagementCommand({ action: 'get-model-access', providerId }, deviceId);
        if (!active || request !== sequence || !isDataOwnerGenerationCurrent(owner)) return;
        if (next?.version !== 1) { setError(key + 'needsUpdate'); return; }
        setView(next); setViewOwner(owner); setError(null);
      } catch (reason) {
        if (active && request === sequence && isDataOwnerGenerationCurrent(owner)) {
          setView(null); setError(key + (isProviderManagementOutdated(reason) ? 'needsUpdate' : 'loadFailed'));
        }
      }
    };
    void load();
    const off = window.electronAPI.providerShare.onOwnedChanged(() => { void load(); });
    return () => { active = false; off(); };
  }, [providerId, deviceId, owner]);
  const currentView = isDataOwnerGenerationCurrent(viewOwner) ? view : null;
  return (
    <section className="mt-6 shrink-0" data-testid="remote-model-access">
      <h3 className="text-13 font-medium leading-[1.5] text-[var(--settings-section-title)]">{t(key + 'title')}</h3>
      <p className="mt-1 text-12 leading-[1.5] text-[var(--text-secondary)]">{t(key + 'description')}</p>
      <div className="mt-3 flex items-center justify-between gap-4 rounded-xl border border-[var(--settings-theme-card-border)] bg-[var(--settings-theme-card-bg)] px-4 py-3">
        <span className="text-13 leading-[1.5] text-[var(--text-primary)]">
          {currentView ? t(key + (currentView.models === null ? 'all' : 'selected'), { count: currentView.models?.length ?? 0 }) : t(key + 'loading')}
        </span>
        <Button ref={trigger} variant="secondary" size="sm" disabled={!currentView || Boolean(error)} onClick={() => setOpen(true)}>{t(key + 'choose')}</Button>
      </div>
      {error && <ErrorNotice role="alert" className="mt-2" message={t(error)} />}
      {open && currentView && <RemoteModelAccessDialog providerId={providerId} deviceId={deviceId} returnFocusTo={trigger.current}
        onClose={() => setOpen(false)} onSaved={(next) => { setView(next); setOpen(false); }} />}
    </section>
  );
}

export function RemoteModelAccessDialog({ providerId, deviceId, memberId, memberName, returnFocusTo, onClose, onSaved }: {
  providerId: string; deviceId?: string; memberId?: string; memberName?: string;
  returnFocusTo?: HTMLElement | null; onClose(): void; onSaved?(view: RemoteModelAccessView): void;
}) {
  const { t } = useTranslation();
  const [storedView, setView] = useState<RemoteModelAccessView | null>(null);
  const loadedOwner = useRef<ReturnType<typeof getDataOwnerGeneration> | null>(null);
  const [models, setModels] = useState<RemoteModelSelection>(null);
  const [memberBudget, setMemberBudget] = useState<ProviderShareMemberBudget | null>(null);
  const [search, setSearch] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const inFlight = useRef(false);
  const sequence = useRef(0);
  const searchRef = useRef<HTMLInputElement>(null);
  useOptionalAuthUser();
  const owner = getDataOwnerGeneration();
  useEffect(() => {
    const request = ++sequence.current;
    setView(null);
    void providerShareManagementCommand({ action: 'get-model-access', providerId, memberId }, deviceId).then((next) => {
      if (request !== sequence.current || !isDataOwnerGenerationCurrent(owner)) return;
      if (next?.version !== 1) { setError(key + 'needsUpdate'); return; }
      loadedOwner.current = owner;
      setView(next); setModels(next.models); setMemberBudget(next.memberBudget ?? null); setError(null);
    }, (reason) => {
      if (request === sequence.current && isDataOwnerGenerationCurrent(owner)) setError(key + (isProviderManagementOutdated(reason) ? 'needsUpdate' : 'loadFailed'));
    });
    return () => { sequence.current++; };
  }, [providerId, memberId, deviceId, owner]);
  const view = loadedOwner.current && isDataOwnerGenerationCurrent(loadedOwner.current) ? storedView : null;
  const providerAllows = (id: string) => !memberId || view?.providerModels === null || view?.providerModels.includes(id) === true;
  const available = view?.availableModels ?? [];
  // Preserve explicit selections for temporarily missing models; users can remove them without silently expanding a grant.
  const missing = (view ? models ?? [] : []).filter((id) => !available.some((model) => model.id === id)).map((id) => ({ id, name: id }));
  const rows = [...available, ...missing].filter((model) => `${model.name} ${model.id}`.toLowerCase().includes(search.toLowerCase()));
  const save = async () => {
    if (inFlight.current || !view) return;
    if (memberBudget && !isProviderShareMemberBudget(memberBudget)) { setError('providerShare.memberBudget.invalid'); return; }
    inFlight.current = true; setSaving(true); setError(null);
    const request = ++sequence.current;
    try {
      const next = await providerShareManagementCommand({ action: 'set-model-access', providerId, memberId, models, ...(memberId && view.budgetSupported ? { memberBudget } : {}) }, deviceId);
      if (request === sequence.current && isDataOwnerGenerationCurrent(owner)) {
        if (next?.version !== 1) { setError(key + 'needsUpdate'); return; }
        if (onSaved) onSaved(next); else onClose();
      }
    } catch (reason) {
      if (request === sequence.current && isDataOwnerGenerationCurrent(owner)) setError(key + (isProviderManagementOutdated(reason) ? 'needsUpdate' : 'saveFailed'));
    } finally { inFlight.current = false; setSaving(false); }
  };
  return (
    <ProviderShareDialog open busy={saving} returnFocusTo={returnFocusTo} initialFocusRef={searchRef} onOpenChange={(next) => { if (!next) onClose(); }} maxWidth={520}>
      <ProviderShareDialogTitle className="shrink-0">{view?.providerName ? `${view.providerName} · ` : ''}{t(key + (memberId ? 'memberTitle' : 'choose'))}</ProviderShareDialogTitle>
      <div className="min-h-0 overflow-y-auto overscroll-contain">
      <p className="mt-2 text-13 leading-[1.5] text-[var(--confirm-desc)]">{t(key + (memberId ? 'memberDescription' : 'description'), { name: memberName })}</p>
      <label className="mt-4 flex min-h-8 items-center gap-2 text-13 leading-[1.5] text-[var(--text-primary)]">
        <input type="checkbox" className="h-4 w-4 shrink-0 accent-[var(--text-primary)]" checked={models === null} disabled={!view || saving} onChange={(event) => setModels(event.target.checked ? null : [])} />
        {t(key + (memberId ? 'inherit' : 'allFuture'))}
      </label>
      <div className="mt-3"><Input inputRef={searchRef} value={search} onChange={setSearch} placeholder={t(key + 'search')} aria-label={t(key + 'search')} disabled={!view || saving} /></div>
      <div className="mt-2 max-h-72 shrink-0 overflow-y-auto overscroll-contain rounded-lg border border-[var(--border-default)] p-2" aria-busy={!view}>
        {rows.map((model) => {
          const allowed = providerAllows(model.id);
          const checked = models === null ? allowed : models.includes(model.id);
          return <label key={model.id} className="flex min-h-9 items-center gap-3 rounded-lg px-2 py-2 text-13 leading-[1.5] text-[var(--text-primary)] hover:bg-[var(--surface-hover)]">
            <input type="checkbox" className="h-4 w-4 shrink-0 accent-[var(--text-primary)]" aria-label={model.name} checked={checked} disabled={!view || saving || (!allowed && !checked)} onChange={(event) => {
              const current = models ?? available.filter((entry) => providerAllows(entry.id)).map((entry) => entry.id);
              setModels(event.target.checked ? [...new Set([...current, model.id])] : current.filter((id) => id !== model.id));
            }} />
            <span className="min-w-0 flex-1 break-words">{model.name}{model.name !== model.id && <span className="block text-11 leading-[1.5] text-[var(--text-tertiary)]">{model.id}</span>}</span>
            {!allowed && <span className="text-11 leading-[1.5] text-[var(--text-secondary)]">{t(key + 'notOpen')}</span>}
          </label>;
        })}
        {rows.length === 0 && <p role="status" className="p-2 text-12 leading-[1.5] text-[var(--text-secondary)]">{t(key + (view ? 'empty' : 'loading'))}</p>}
      </div>
      {memberId && view?.budgetSupported && <MemberBudgetEditor value={memberBudget} onChange={setMemberBudget}
        budgetModelIds={view.budgetModelIds} recommendationModelIds={view.recommendationModelIds}
        models={available.filter(model => providerAllows(model.id) && (models === null || models.includes(model.id)))}
        disabled={saving} canAddRules={view.budgetAvailable === true} status={view.budgetStatus} />}
      {models?.length === 0 && <p className="mt-2 text-12 leading-[1.5] text-[var(--text-secondary)]">{t(key + 'none')}</p>}
      {error && <ErrorNotice role="alert" className="mt-3" message={t(error)} />}
      </div>
      <ProviderShareDialogFooter>
        <Button variant="secondary" disabled={saving} onClick={onClose}>{t('settings.providers.button.cancel')}</Button>
        <Button variant="primary" disabled={!view || saving} onClick={() => { void save(); }}>{t('settings.providers.custom.save')}</Button>
      </ProviderShareDialogFooter>
    </ProviderShareDialog>
  );
}
