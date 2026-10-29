import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from '@/lib/toast';

import { Button } from '@/components/ui/button';
import { FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import { getDataOwnerGeneration, isDataOwnerGenerationCurrent } from '@/contexts/dataOwnerGeneration';
import {
  isRemoteAgentLimits,
  isRemoteAgentLimitsPatch,
  REMOTE_AGENT_IDLE_MINUTES_MAX,
  REMOTE_AGENT_LIMIT_MAX,
  type RemoteAgentLimitsView,
} from '../../../shared/remoteAgentLimits';
import { providerManagementErrorKey, providerShareManagementCommand } from '../provider-group/providerManagement';

type LimitKey = 'perDevice' | 'total' | 'idleMinutes';

/** 各供应商管理页共用同一份提供方额度与闲置收回时长；只展示提供方自己的占用合计。 */
export function RemoteAgentLimitsSection({ deviceId }: { deviceId?: string }) {
  const { t } = useTranslation();
  const [view, setView] = useState<RemoteAgentLimitsView | null>(null);
  const [draft, setDraft] = useState<Partial<Record<LimitKey, string>> | null>(null);
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const saving = useRef(false);
  const reading = useRef<number | null>(null);
  const sequence = useRef(0);

  const load = useCallback(async () => {
    if (saving.current || reading.current !== null) return;
    const seq = ++sequence.current;
    reading.current = seq;
    const owner = getDataOwnerGeneration();
    try {
      const next = await providerShareManagementCommand({ action: 'get-run-limits' }, deviceId);
      if (seq !== sequence.current || !isDataOwnerGenerationCurrent(owner)) return;
      setView(next);
      setErrorKey(null);
    } catch (error) {
      if (seq !== sequence.current || !isDataOwnerGenerationCurrent(owner)) return;
      setErrorKey(providerManagementErrorKey(error, Boolean(deviceId)));
    } finally {
      if (reading.current === seq) reading.current = null;
    }
  }, [deviceId]);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => {
      if (document.visibilityState !== 'hidden') void load();
    }, 5_000);
    return () => { sequence.current += 1; reading.current = null; window.clearInterval(timer); };
  }, [load]);

  // 远程管理旧版电脑时它的设置里没有闲置收回：不显示这一项，也不提交(旧版会拒绝不认识的字段)。
  const idleSupported = typeof view?.value.idleMinutes === 'number';
  const keys: LimitKey[] = idleSupported ? ['perDevice', 'total', 'idleMinutes'] : ['perDevice', 'total'];
  const values: Record<LimitKey, string> = {
    perDevice: String(view?.value.perDevice ?? ''),
    total: String(view?.value.total ?? ''),
    idleMinutes: String(view?.value.idleMinutes ?? ''),
    ...draft,
  };
  const limits: Record<LimitKey, number> = {
    perDevice: Number(values.perDevice), total: Number(values.total), idleMinutes: Number(values.idleMinutes),
  };
  const countsValid = isRemoteAgentLimits({ perDevice: limits.perDevice, total: limits.total });
  const idleValid = !idleSupported || (values.idleMinutes.trim() !== '' && isRemoteAgentLimitsPatch({ idleMinutes: limits.idleMinutes }));
  const valid = countsValid && idleValid;
  const changed = view && keys.some(key =>
    draft?.[key] !== undefined && (limits[key] !== view.value[key] || !view.customizedKeys.includes(key)));

  const save = async (reset: boolean) => {
    if (saving.current || (!reset && !valid)) return;
    saving.current = true;
    setBusy(true);
    const seq = ++sequence.current;
    const owner = getDataOwnerGeneration();
    try {
      const next = await providerShareManagementCommand(reset
        ? { action: 'reset-run-limits' } : { action: 'set-run-limits', limits: Object.fromEntries(
          keys.filter(key => draft?.[key] !== undefined).map(key => [key, limits[key]]),
        ) }, deviceId);
      if (seq !== sequence.current || !isDataOwnerGenerationCurrent(owner)) return;
      setView(next);
      setDraft(null);
      setErrorKey(null);
      toast.success(t('providerShare.runLimits.saved'));
    } catch (error) {
      if (seq !== sequence.current || !isDataOwnerGenerationCurrent(owner)) return;
      toast.error(t(providerManagementErrorKey(error, Boolean(deviceId))));
    } finally {
      saving.current = false;
      if (seq === sequence.current) setBusy(false);
    }
  };

  return (
    <section className="mt-8 shrink-0" data-testid="remote-agent-limits" aria-labelledby="remote-agent-limits-title">
      <h3 id="remote-agent-limits-title" className="text-13 font-medium text-[var(--settings-section-title)]">
        {t('providerShare.runLimits.title')}
      </h3>
      <p className="mt-1 text-12 leading-[1.5] text-[var(--settings-section-desc)]">{t('providerShare.runLimits.description')}</p>
      {errorKey && <p role="alert" className="mt-3 text-12 leading-[1.5] text-[var(--text-danger)]">{t(errorKey)}</p>}
      {!view ? (
        <Button variant="secondary" size="sm" onClick={() => void load()}>{t(errorKey ? 'providerShare.runLimits.retry' : 'providerShare.runLimits.loading')}</Button>
      ) : (
        <form className="mt-4 flex flex-col gap-3" onSubmit={event => { event.preventDefault(); void save(false); }}>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {(['perDevice', 'total'] as const).map(key => (
              <FormField key={key} label={t(`providerShare.runLimits.${key}`)}>
                {control => <Input {...control} type="number" min={1} max={REMOTE_AGENT_LIMIT_MAX} step={1}
                  disabled={busy || Boolean(errorKey)} value={values[key]} data-testid={`remote-agent-limit-${key}`}
                  onChange={value => setDraft(previous => ({ ...previous, [key]: value }))} />}
              </FormField>
            ))}
          </div>
          {(draft?.perDevice !== undefined || draft?.total !== undefined) && !countsValid && <p role="alert" className="text-12 leading-[1.5] text-[var(--text-danger)]">{t('providerShare.runLimits.invalid', { max: REMOTE_AGENT_LIMIT_MAX })}</p>}
          <p className="text-12 leading-[1.5] text-[var(--settings-section-desc)]" aria-live="polite">
            {t('providerShare.runLimits.usage', { used: view.usage.total, total: view.value.total, devices: view.usage.devices, largest: view.usage.largestDevice })}
          </p>
          {idleSupported && (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <FormField label={t('providerShare.runLimits.idleMinutes')} hint={t('providerShare.runLimits.idleHint')}
                error={draft?.idleMinutes !== undefined && !idleValid
                  ? t('providerShare.runLimits.idleInvalid', { max: REMOTE_AGENT_IDLE_MINUTES_MAX }) : undefined}>
                {control => <Input {...control} type="number" min={0} max={REMOTE_AGENT_IDLE_MINUTES_MAX} step={1}
                  disabled={busy || Boolean(errorKey)} value={values.idleMinutes} data-testid="remote-agent-limit-idleMinutes"
                  onChange={value => setDraft(previous => ({ ...previous, idleMinutes: value }))} />}
              </FormField>
            </div>
          )}
          <p className="text-12 leading-[1.5] text-[var(--settings-section-desc)]">{t('providerShare.runLimits.applyHint')}</p>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" variant="cta" size="sm" disabled={busy || !valid || !changed || Boolean(errorKey)}>{t('providerShare.runLimits.save')}</Button>
            <Button type="button" variant="secondary" size="sm" disabled={busy || !view.isCustomized || Boolean(errorKey)} onClick={() => void save(true)}>{t('providerShare.runLimits.reset')}</Button>
          </div>
        </form>
      )}
    </section>
  );
}
