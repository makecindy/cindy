import { useTranslation } from 'react-i18next';
import { unifiedModelKeyId } from '@cindy/model-providers';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { ProviderShareBudgetRule, ProviderShareBudgetStatus, ProviderShareMemberBudget } from '../../../shared/providerShareBudget';

const key = 'providerShare.memberBudget.';
const empty: ProviderShareMemberBudget = { basis: 'member-input-output-7d', enabled: false, recommendedModel: null, rules: [] };
const selectClass = 'min-h-9 max-w-full rounded-full border border-[var(--border-default)] bg-[var(--surface-elevated)] px-3 text-13 text-[var(--text-primary)]';

export function MemberBudgetEditor({ value, onChange, models, budgetModelIds, recommendationModelIds, disabled, canAddRules, status }: {
  value: ProviderShareMemberBudget | null;
  onChange(value: ProviderShareMemberBudget): void;
  models: Array<{ id: string; name: string }>;
  budgetModelIds?: string[];
  recommendationModelIds?: string[];
  disabled: boolean;
  canAddRules: boolean;
  status?: ProviderShareBudgetStatus;
}) {
  const { t } = useTranslation();
  const policy = value ?? empty;
  const budgetModels = models.filter(model => !budgetModelIds || budgetModelIds.includes(model.id));
  const recommendations = models.filter(model => !recommendationModelIds || recommendationModelIds.includes(model.id));
  const patch = (next: Partial<ProviderShareMemberBudget>) => onChange({ ...policy, ...next });
  const hasRule = (model: string) => policy.rules.some(rule => rule.models.some(id => unifiedModelKeyId(id) === unifiedModelKeyId(model)));
  const updateRule = (id: string, next: Partial<ProviderShareBudgetRule>) =>
    patch({ rules: policy.rules.map(rule => rule.id === id ? { ...rule, ...next } : rule) });
  return <section className="mt-5 shrink-0 space-y-4 border-t border-[var(--border-default)] pt-4">
    <label className="flex flex-wrap items-center justify-between gap-3 text-13 text-[var(--text-primary)]">
      <span>{t(key + 'recommended')}</span>
      <select className={selectClass} value={policy.recommendedModel ?? ''} disabled={disabled}
        onChange={event => patch({ recommendedModel: event.target.value || null })}>
        <option value="">{t(key + 'none')}</option>
        {recommendations.map(model => <option key={model.id} value={model.id}>{model.name}</option>)}
        {policy.recommendedModel && !recommendations.some(model => model.id === policy.recommendedModel)
          && <option value={policy.recommendedModel}>{policy.recommendedModel} · {t(key + 'modelUnavailable')}</option>}
      </select>
    </label>
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h3 className="text-13 font-medium text-[var(--text-primary)]">{t(key + 'title')}</h3>
      <span className="text-12 text-[var(--text-secondary)]">{t(key + (policy.enabled ? 'active' : 'draft'))}</span>
    </div>
    <p className="text-12 text-[var(--text-secondary)]">{t(key + 'basis')}</p>
    {status && <p className="text-12 text-[var(--text-secondary)]">{t(key + 'window', { start: status.windowStart, end: status.windowEnd })}</p>}
    {!canAddRules && <p className="text-12 text-[var(--text-secondary)]">{t(key + 'unsupported')}</p>}
    {policy.rules.map((rule, index) => {
      const selected = rule.models[0] ?? '';
      const used = status?.rules.find(item => item.id === rule.id && item.models[0] === selected);
      const usedPercent = status?.modelUsage && status.state === 'recorded' && status.totalTokens
        ? (status.modelUsage.find(item => item.model === unifiedModelKeyId(selected))?.tokens ?? 0) / status.totalTokens * 100
        : used?.usedPercent;
      return <div key={rule.id} className="space-y-3 rounded-xl border border-[var(--border-default)] p-4">
        <select className={`${selectClass} w-full`} value={selected} disabled={disabled}
          aria-label={t(key + 'chooseModels')}
          onChange={event => updateRule(rule.id, { models: [event.target.value] })}>
          <option value="" disabled>{t(key + 'chooseModels')}</option>
          {budgetModels.map(model => <option key={model.id} value={model.id}
            disabled={policy.rules.some(other => other.id !== rule.id && other.models.some(id => unifiedModelKeyId(id) === unifiedModelKeyId(model.id)))}>{model.name}</option>)}
          {selected && !budgetModels.some(model => model.id === selected)
            && <option value={selected}>{selected} · {t(key + 'modelUnavailable')}</option>}
        </select>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <label htmlFor={`budget-percent-${rule.id}`} className="text-13 text-[var(--text-primary)]">{t(key + 'maxPercent')}</label>
          <div className="w-24">
            <Input id={`budget-percent-${rule.id}`} type="number" min={1} max={100} step={1}
              value={Number.isFinite(rule.maxPercent) ? String(rule.maxPercent) : ''} disabled={disabled}
              onChange={text => updateRule(rule.id, { maxPercent: text === '' ? NaN : Number(text) })} size="md" trailing={<span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-12 text-[var(--text-secondary)]">%</span>} />
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span role="status" className="text-12 text-[var(--text-secondary)]">
            {usedPercent != null
              ? t(key + 'used', { percent: usedPercent.toFixed(2) })
              : t(key + (status?.state === 'empty' ? 'empty' : 'unavailable'))}
          </span>
          <Button variant="secondary" size="sm" disabled={disabled} aria-label={t(key + 'removeGroup', { index: index + 1 })}
            onClick={() => patch({ rules: policy.rules.filter(item => item.id !== rule.id), ...(policy.rules.length === 1 ? { enabled: false } : {}) })}>{t(key + 'remove')}</Button>
        </div>
        {usedPercent != null && Number.isFinite(rule.maxPercent) && rule.maxPercent < 100 && usedPercent >= rule.maxPercent
          && <p className="text-12 text-[var(--text-secondary)]">{t(key + (policy.enabled ? 'pausedOnSave' : 'draftExceeded'))}</p>}
      </div>;
    })}
    <Button variant="secondary" size="sm" disabled={disabled || !canAddRules || policy.rules.length >= 32 || budgetModels.every(model => hasRule(model.id))}
      onClick={() => {
        const next = budgetModels.find(model => !hasRule(model.id));
        if (next) patch({ rules: [...policy.rules, { id: crypto.randomUUID(), models: [next.id], maxPercent: 30 }] });
      }}>{t(key + 'addGroup')}</Button>
    <label className="flex min-h-9 items-center gap-2 text-13 text-[var(--text-primary)]">
      <input type="checkbox" checked={policy.enabled} disabled={disabled || !canAddRules || !policy.rules.length}
        className="h-4 w-4 accent-[var(--text-primary)]"
        onChange={event => patch({ enabled: event.target.checked })} />
      {t(key + 'enable')}
    </label>
    <p className="text-12 text-[var(--text-secondary)]">{t(key + 'enforcement')}</p>
  </section>;
}
