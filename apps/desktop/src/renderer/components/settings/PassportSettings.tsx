import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, Bluetooth, ChevronRight, IdCard, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Tip } from '@/components/ui/tooltip';
import { InputDeviceConnectionStatus } from './InputDeviceConnectionStatus';
import type { PassportState } from '../../../shared/passport';

const cardClassName = 'rounded-xl border border-[var(--settings-theme-card-border)] bg-[var(--settings-theme-card-bg)] p-5';

function usePassportState() {
  const [state, setState] = useState<PassportState | null>(null);
  const [error, setError] = useState(false);
  const api = window.electronAPI.passport;
  useEffect(() => {
    let disposed = false, refreshing = false;
    const refresh = async () => {
      if (refreshing) return;
      refreshing = true;
      try {
        const next = await api.getState();
        if (!disposed) { setState(next); setError(false); }
      }
      catch { if (!disposed) setError(true); }
      finally { refreshing = false; }
    };
    void refresh();
    const timer = setInterval(() => { void refresh(); }, 1000);
    return () => { disposed = true; clearInterval(timer); };
  }, [api]);
  return { state, setState, error };
}

function PassportConnectionStatus({ state, error, compact = false }: {
  state: PassportState | null; error: boolean; compact?: boolean;
}) {
  const { t } = useTranslation();
  const label = error ? t('settings.shortcuts.workLouderCodex.connection.status.error')
    : !state ? t('settings.passport.loading') : !state.supported ? t('settings.passport.unsupported')
      : !state.enabled ? t('settings.shortcuts.workLouderCodex.connection.status.disabled')
        : t(`settings.passport.${state.connected ? 'connected' : 'disconnected'}`);
  return <InputDeviceConnectionStatus label={label} compact={compact}
    tone={error || state?.supported === false ? 'error' : state?.connected ? 'connected' : 'neutral'} />;
}

export function PassportEntry({ onOpen }: { onOpen(): void }) {
  const { t } = useTranslation();
  const { state, error } = usePassportState();
  return (
    <button type="button" onClick={onOpen} aria-label={t('settings.passport.title')}
      data-testid="settings-passport-entry"
      className="flex w-full items-center gap-3 rounded-none border-0 bg-transparent px-4 py-[14px] text-left outline-none transition-colors hover:bg-[var(--settings-menu-bg-hover)] focus-visible:ring-2 focus-visible:ring-[var(--focus-ring-soft)]">
      <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-[var(--surface-chip)] text-[var(--text-secondary)]">
        <IdCard size={18} aria-hidden="true" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="truncate text-13 font-medium text-[var(--text-primary)]">{t('settings.passport.title')}</span>
        <span className="text-12 leading-[1.4] text-[var(--text-secondary)]">{t('settings.passport.entryDescription')}</span>
      </span>
      <span className="flex shrink-0 items-center gap-2">
        <PassportConnectionStatus state={state} error={error} compact />
        <ChevronRight size={16} className="text-[var(--text-tertiary)]" aria-hidden="true" />
      </span>
    </button>
  );
}

export function PassportSettings({ onBack }: { onBack(): void }) {
  const { t } = useTranslation();
  const { state, setState, error: readError } = usePassportState();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const api = window.electronAPI.passport;
  const run = async (action: () => Promise<void>) => {
    setBusy(true); setError(false);
    try { await action(); setState(await api.getState()); }
    catch { setError(true); }
    finally { setBusy(false); }
  };
  return <div className="flex flex-col gap-[14px]" data-testid="settings-passport-detail">
    <div className="flex items-center justify-between gap-3">
      <div className="flex min-w-0 items-center gap-2">
        <Tip text={t('settings.passport.back')} side="bottom">
          <button type="button" onClick={onBack} aria-label={t('settings.passport.back')}
            className="flex size-8 shrink-0 items-center justify-center rounded-full text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-chip)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring-soft)]">
            <ArrowLeft size={17} aria-hidden="true" />
          </button>
        </Tip>
        <h2 className="truncate text-16 font-medium leading-[1.2] text-[var(--settings-section-title)]">{t('settings.passport.title')}</h2>
      </div>
      <button type="button" disabled={busy || !state?.supported} onClick={() => { void run(() => api.setEnabled(null)); }}
        className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full border border-[var(--settings-input-border)] bg-[var(--settings-input-bg)] px-3 text-12 font-medium text-[var(--settings-input-text)] transition-colors hover:bg-[var(--settings-menu-bg-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring-soft)] disabled:cursor-not-allowed disabled:opacity-50">
        <RotateCcw size={13} aria-hidden="true" />{t('settings.passport.reset')}
      </button>
    </div>
    <div className={cardClassName}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-13 font-medium text-[var(--text-primary)]">{t('settings.passport.enabled')}</p>
        <div className="flex items-center gap-2">
          <Switch checked={state?.enabled ?? false} disabled={busy || !state?.supported}
            aria-label={t('settings.passport.enabled')}
            onCheckedChange={(enabled) => { void run(() => api.setEnabled(enabled)); }} />
          <PassportConnectionStatus state={state} error={readError} />
        </div>
      </div>
      <p className="mt-2 text-12 leading-[1.45] text-[var(--text-secondary)]">{t('settings.passport.description')}</p>
      {state?.enabled && !state.connected && <p role="status" className="mt-2 text-12 leading-[1.45] text-[var(--text-secondary)]">
        {t(`settings.passport.${!state.supported ? 'unsupported' : state.bluetooth === 5 ? 'scanning' : 'bluetooth'}`)}
      </p>}
    </div>
    {state?.enabled && <>
      <section className="flex flex-col gap-2">
        <h3 className="px-1 text-13 font-medium text-[var(--settings-section-title)]">{t('settings.passport.devices')}</h3>
        <div className={cardClassName}>
          <div className="flex flex-col gap-4">
            {state.devices.map((id) => <div key={id} className="flex items-center justify-between gap-3">
              <div className="flex min-w-0 items-center gap-3">
                <Bluetooth size={18} className="shrink-0 text-[var(--text-secondary)]" aria-hidden="true" />
                <div className="min-w-0">
                  <p className="truncate text-13 font-medium text-[var(--text-primary)]">{t('settings.passport.title')}</p>
                  <p className="text-12 text-[var(--text-secondary)]">{id.slice(0, 8)}</p>
                </div>
              </div>
              <Button variant="secondary" disabled={busy} onClick={() => { void run(() => api.connect(id)); }}>{t('settings.passport.connect')}</Button>
            </div>)}
            <div>
              <Button variant="secondary" disabled={busy} onClick={() => { void run(() => api.disconnect()); }}>{t('settings.passport.disconnect')}</Button>
            </div>
          </div>
        </div>
      </section>
      <section className="flex flex-col gap-2">
        <h3 className="px-1 text-13 font-medium text-[var(--settings-section-title)]">{t('settings.passport.voiceTitle')}</h3>
        <div className={cardClassName}>
          <p role="status" className="text-12 leading-[1.45] text-[var(--text-secondary)]">{t(`settings.passport.voice.${state.voice}`)}</p>
        </div>
      </section>
    </>}
    {(error || readError) && <p role="alert" className="rounded-xl border border-[var(--error-border)] bg-[var(--error-bg)] px-4 py-3 text-12 text-[var(--error-fg)]">{t('settings.passport.error')}</p>}
  </div>;
}
