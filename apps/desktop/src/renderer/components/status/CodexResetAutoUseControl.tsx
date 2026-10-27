import { useEffect, useId, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { CodexResetAutoUseSettings, CodexResetAutoUseState } from '@cindy/maker-shared/device-link-contract';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Select } from '@/components/ui/select';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';

/** The closed state occupies one small row; rules stay in a popover. */
export function CodexResetAutoUseControl({ state, providerId, onChanged }: {
  state: CodexResetAutoUseState; providerId: string; onChanged: () => void;
}) {
  const { t } = useTranslation();
  const labelId = useId();
  const [current, setCurrent] = useState(state);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [custom, setCustom] = useState(![0, 1, 2, 3].includes(state.settings.minimumDays));
  const [days, setDays] = useState(String(state.settings.minimumDays));
  const saving = useRef(false);
  const account = useRef(`${providerId}:${state.accountKey}`);
  account.current = `${providerId}:${state.accountKey}`;
  useEffect(() => { setCurrent(state); setDays(String(state.settings.minimumDays)); }, [state]);
  const s = current.settings;
  const label = (key: string, values?: Record<string, unknown>) => t(`codexResets.autoUse.${key}`, values);
  const save = async (patch: Partial<CodexResetAutoUseSettings> | null) => {
    if (saving.current) return;
    saving.current = true;
    const key = state.accountKey;
    setBusy(true); setError(false);
    try {
      const next = await window.electronAPI.maker.usage.setCodexResetAutoUse(patch, key, providerId);
      if (account.current === `${providerId}:${key}` && next.autoUse?.accountKey === key) {
        setCurrent(next.autoUse); setDays(String(next.autoUse.settings.minimumDays));
        onChanged();
      }
    } catch { if (account.current === `${providerId}:${key}`) setError(true); }
    finally { saving.current = false; setBusy(false); }
  };
  const condition = (field: 'lowQuota' | 'expiring', checked: boolean) => {
    // Clearing the final condition also turns automatic use off, without silently enabling another rule.
    void save({ [field]: checked, ...(!checked && !s[field === 'lowQuota' ? 'expiring' : 'lowQuota'] ? { enabled: false } : {}) });
  };
  return (
    <Popover>
      <div className="flex shrink-0 items-center gap-2">
        <label id={labelId} className="text-12 text-[var(--text-secondary)]">{label('label')}</label>
        <Switch aria-labelledby={labelId} checked={s.enabled} disabled={busy || !state.accountKey}
          onCheckedChange={enabled => void save({ enabled, ...(enabled && !s.lowQuota && !s.expiring ? { lowQuota: true } : {}) })} />
        <PopoverTrigger asChild>
          <Button variant="secondary" tone="quiet" size="md" compact aria-label={label('rules')}><ChevronDown className="h-3.5 w-3.5" /></Button>
        </PopoverTrigger>
      </div>
      {/* The usage dialog is at 10000; keep rules above it and below Select's 10010. */}
      <PopoverContent align="end" className="z-[10001] w-80 max-w-[calc(100vw-32px)] space-y-4 text-13">
        <div className="text-14 font-medium text-[var(--text-primary)]">{label('rules')}</div>
        <div className="space-y-2">
          <label className="flex items-start gap-2 text-[var(--text-primary)]">
            <input type="checkbox" className="mt-0.5 accent-[var(--text-primary)]" checked={s.lowQuota} disabled={busy} onChange={e => condition('lowQuota', e.target.checked)} />
            {label('lowQuota')}
          </label>
          <div className="ml-5 space-y-2">
            <div className="text-12 text-[var(--text-secondary)]">{label('resetDistance')}</div>
            <Select label={label('resetDistance')} value={custom || ![0, 1, 2, 3].includes(s.minimumDays) ? 'custom' : String(s.minimumDays)}
              disabled={busy || !s.lowQuota} className="min-h-8 text-13"
              options={[3, 2, 1, 0].map(n => ({ value: String(n), label: n ? label('days', { count: n }) : label('unlimited') })).concat({ value: 'custom', label: label('custom') })}
              onValueChange={value => { setCustom(value === 'custom'); if (value !== 'custom') void save({ minimumDays: Number(value) }); }} />
            {(custom || ![0, 1, 2, 3].includes(s.minimumDays)) && <form className="flex items-center gap-2" onSubmit={e => { e.preventDefault(); if (/^\d+$/.test(days) && Number(days) <= 365) void save({ minimumDays: Number(days) }); }}>
              <input aria-label={label('customDays')} type="number" min="0" max="365" step="1" required value={days} disabled={busy || !s.lowQuota}
                onChange={e => setDays(e.target.value)} className="h-8 w-20 rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] px-2 text-13 text-[var(--text-primary)]" />
              <span className="text-12 text-[var(--text-secondary)]">{label('dayUnit')}</span>
              <Button type="submit" size="sm" compact variant="secondary" disabled={busy || !s.lowQuota}>{label('apply')}</Button>
            </form>}
          </div>
        </div>
        <div className="space-y-2">
          <label className="flex items-start gap-2 text-[var(--text-primary)]">
            <input type="checkbox" className="mt-0.5 accent-[var(--text-primary)]" checked={s.expiring} disabled={busy} onChange={e => condition('expiring', e.target.checked)} />
            {label('expiring')}
          </label>
          <div className="ml-5"><Select label={label('leadTime')} value={String(s.expiryMinutes)} disabled={busy || !s.expiring} className="min-h-8 text-13"
            options={[30, 60, 360, 1440].map(n => ({ value: String(n), label: label(n === 30 ? 'minutes' : 'hours', { count: n === 30 ? 30 : n / 60 }) }))}
            onValueChange={value => void save({ expiryMinutes: Number(value) })} /></div>
        </div>
        <div className="border-t border-[var(--border-default)] pt-3 text-12 leading-relaxed text-[var(--text-secondary)]">{label('hint')}</div>
        {current.customized && <Button size="sm" compact variant="secondary" tone="quiet" disabled={busy} onClick={() => { setCustom(false); void save(null); }}>{label('restore')}</Button>}
      </PopoverContent>
      {error && <span role="alert" className="text-12 text-[var(--text-secondary)]">{label('failed')}</span>}
    </Popover>
  );
}
