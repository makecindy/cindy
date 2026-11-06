import { Button } from '@/components/ui/button';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { AlertTriangle, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { AgentKind, ProviderView } from '@cindy/model-providers';

import { SegmentedControl } from '@/components/ui/segmented-control';
import { cn } from '@/lib/utils';
import { toast } from '@/lib/toast';

import type {
  ModelPriceOverrideDesiredQuote,
  ModelPriceOverrideView,
} from '../../../shared/modelPriceOverride';
import type { UnionModelRow } from './UnifiedModelList';
import { providersSettings } from './ProvidersSection.settings-search';
import { useSettingDefinition } from './useSettingDefinition';

const AGENT_LABEL: Record<AgentKind, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  pi: 'Pi',
};

interface Props {
  provider: ProviderView;
  row: UnionModelRow;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  presentation?: 'dialog' | 'inline';
  referenceDetails?: ReactNode | ((agent: AgentKind) => ReactNode);
  onPendingChange?: (pending: boolean) => void;
}

interface FormState {
  currency: 'USD' | 'CNY';
  input: string;
  output: string;
  cacheRead: string;
  cacheCreate: string;
}

const EMPTY_FORM: FormState = {
  currency: 'USD',
  input: '',
  output: '',
  cacheRead: '',
  cacheCreate: '',
};

function formFromView(view: ModelPriceOverrideView): FormState {
  const quote = view.effective ?? view.reference;
  return quote
    ? {
        currency: quote.currency,
        input: String(quote.inputPerMtok),
        output: String(quote.outputPerMtok),
        cacheRead: quote.cacheReadPerMtok === undefined ? '' : String(quote.cacheReadPerMtok),
        cacheCreate: quote.cacheCreatePerMtok === undefined ? '' : String(quote.cacheCreatePerMtok),
      }
    : EMPTY_FORM;
}

function parseRequiredPrice(value: string): number | null {
  if (!value.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function parseOptionalPrice(value: string): number | null | 'invalid' {
  if (!value.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 'invalid';
}

export function ModelPriceOverrideDialog({ provider, row, open, onOpenChange, presentation = 'dialog', referenceDetails, onPendingChange }: Props) {
  const inline = presentation === 'inline';
  const { t } = useTranslation();
  const pricingSetting = useSettingDefinition(providersSettings.modelPricing, t);
  const [agent, setAgent] = useState<AgentKind>(row.avail[0]);
  const [view, setView] = useState<ModelPriceOverrideView | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const pendingRef = useRef(false);
  const setPending = (pending: boolean) => {
    pendingRef.current = pending;
    setSaving(pending);
    onPendingChange?.(pending);
  };

  const model = row.byAgent[agent];
  const target = useMemo(
    () => (model ? { providerId: provider.id, agent, modelId: model.id } : null),
    [agent, model, provider.id],
  );

  // DESIGN.md §4:弹窗打开时焦点落主输入,而不是 Radix 默认的首个可聚焦元素(关闭按钮)。
  const primaryInputRef = useRef<HTMLInputElement | null>(null);
  const resetButtonRef = useRef<HTMLButtonElement | null>(null);
  const restoreResetFocus = () => {
    if (inline && document.activeElement === resetButtonRef.current) primaryInputRef.current?.focus();
  };

  // 弹窗关闭或目标切换后,在途 save/reset 的迟到响应必须整体作废:旧实例捕获的
  // setView/onOpenChange(false) 会覆盖新目标的表单、甚至直接关掉刚打开的弹窗。
  const mutationEpochRef = useRef(0);
  useEffect(() => {
    mutationEpochRef.current += 1;
    if (inline) setPending(false);
  }, [open, target]);
  // UnifiedModelList 按行条件渲染本弹窗:换行会卸载重挂、换新实例,但旧实例的
  // 在途 save/reset 闭包仍握着共享的 onOpenChange。卸载时同样作废 epoch,
  // 迟到响应不得关掉新实例的弹窗或触发任何副作用。
  useEffect(
    () => () => {
      mutationEpochRef.current += 1;
      onPendingChange?.(false);
    },
    [],
  );

  useEffect(() => {
    if (!open) return;
    if (!row.avail.includes(agent)) setAgent(row.avail[0]);
  }, [agent, open, row]);

  useEffect(() => {
    if (!open || !target) return;
    let cancelled = false;
    setLoading(true);
    setView(null);
    setForm(EMPTY_FORM);
    void window.electronAPI.maker
      .getModelPriceOverride(target)
      .then((next) => {
        if (cancelled) return;
        setView(next);
        setForm(formFromView(next));
      })
      .catch(() => {
        if (!cancelled) toast.error(t('settings.providers.models.priceOverride.loadFailed'));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, target, t]);

  const save = async () => {
    if (!target || !view || loading || (inline && (pendingRef.current || !view.editable))) return false;
    const inputPerMtok = parseRequiredPrice(form.input);
    const outputPerMtok = parseRequiredPrice(form.output);
    const cacheReadPerMtok = parseOptionalPrice(form.cacheRead);
    const cacheCreatePerMtok = parseOptionalPrice(form.cacheCreate);
    if (
      inputPerMtok === null ||
      outputPerMtok === null ||
      cacheReadPerMtok === 'invalid' ||
      cacheCreatePerMtok === 'invalid'
    ) {
      if (inline) setForm(formFromView(view));
      toast.error(t('settings.providers.models.priceOverride.invalid'));
      return false;
    }
    const desired: ModelPriceOverrideDesiredQuote = {
      currency: form.currency,
      inputPerMtok,
      outputPerMtok,
      cacheReadPerMtok,
      cacheCreatePerMtok,
    };
    if (inline) {
      const previous = formFromView(view);
      if (desired.currency === previous.currency && inputPerMtok === parseRequiredPrice(previous.input) &&
          outputPerMtok === parseRequiredPrice(previous.output) && cacheReadPerMtok === parseOptionalPrice(previous.cacheRead) &&
          cacheCreatePerMtok === parseOptionalPrice(previous.cacheCreate)) {
        setForm(previous);
        return true;
      }
    }
    setPending(true);
    const epoch = mutationEpochRef.current;
    try {
      const next = await window.electronAPI.maker.setModelPriceOverride(target, desired);
      if (mutationEpochRef.current !== epoch) return false;
      setView(next);
      setForm(formFromView(next));
      toast.success(t('settings.providers.models.priceOverride.saved'));
      if (!inline) onOpenChange(false);
      return true;
    } catch {
      if (mutationEpochRef.current !== epoch) return false;
      toast.error(t('settings.providers.models.priceOverride.saveFailed'));
      return false;
    } finally {
      if (!inline || mutationEpochRef.current === epoch) setPending(false);
    }
  };

  const reset = async () => {
    if (!target || (inline && (pendingRef.current || !view?.editable))) return;
    if (inline && view && !view.override) {
      restoreResetFocus();
      setForm(formFromView(view));
      return;
    }
    setPending(true);
    const epoch = mutationEpochRef.current;
    try {
      const next = await window.electronAPI.maker.resetModelPriceOverride(target);
      if (mutationEpochRef.current !== epoch) return;
      setView(next);
      setForm(formFromView(next));
      restoreResetFocus();
      toast.success(t('settings.providers.models.priceOverride.resetDone'));
    } catch {
      if (mutationEpochRef.current !== epoch) return;
      toast.error(t('settings.providers.models.priceOverride.saveFailed'));
    } finally {
      if (!inline || mutationEpochRef.current === epoch) setPending(false);
    }
  };

  const fieldClass = cn(
    'h-9 w-full rounded-full border px-3 text-13 tabular-nums outline-none',
    'border-[var(--settings-input-border)] bg-[var(--settings-input-bg)]',
    'text-[var(--settings-section-title)] focus:border-[var(--focus-ring)]',
  );

  if (inline) {
    const unavailable = loading || !view?.editable;
    const dirty = view && JSON.stringify(form) !== JSON.stringify(formFromView(view));
    const details = typeof referenceDetails === 'function' ? referenceDetails(agent) : referenceDetails;
    return (
      <section {...pricingSetting.anchorProps} data-model-price-editor className="pt-5" aria-busy={saving}
        aria-label={t('settings.providers.models.advanced.pricing')}
        onBlur={(event) => {
          if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
          if (dirty) void save();
        }}
        onKeyDown={(event) => {
          if (!(event.target instanceof HTMLElement)) return;
          if (event.nativeEvent.isComposing || event.repeat || event.ctrlKey || event.shiftKey || event.altKey || event.metaKey) return;
          if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            event.target.blur();
          } else if (event.key === 'Enter' && event.target instanceof HTMLInputElement) event.preventDefault();
        }}>
        <div className="flex min-h-8 items-center justify-between gap-2">
          <h4 className="text-12 font-medium text-[var(--text-secondary)]">{t('settings.providers.models.advanced.pricing')}</h4>
          <Button ref={resetButtonRef} variant="secondary" compact type="button" disabled={unavailable || (!view?.override && !dirty)}
            aria-disabled={saving || undefined} onClick={() => void reset()}
            data-settings-search-action="Reset this model quote using its existing reset API">
            {t('settings.providers.models.priceOverride.resetShort')}
          </Button>
        </div>
        {row.avail.length > 1 && <SegmentedControl className="mt-1.5" value={agent} disabled={saving || loading}
          aria-label={t('settings.providers.custom.fields.protocols')}
          data-settings-search-action="Choose which engine quote to edit"
          onValueChange={(next) => {
            if (!dirty) setAgent(next);
            else void save().then((saved) => { if (saved) setAgent(next); });
          }} options={row.avail.map(candidate => ({ value: candidate, label: AGENT_LABEL[candidate] }))} />}
        {(view?.allowedCurrencies.length ?? 0) > 1 && <label className="mt-2 flex items-center justify-between gap-4 text-12 text-[var(--text-secondary)]">
          {t('settings.providers.models.priceOverride.currency')}
          <select {...pricingSetting.controlProps} data-model-price-input value={form.currency} disabled={unavailable} aria-disabled={saving || undefined}
            onPointerDown={(event) => { if (pendingRef.current) event.preventDefault(); }}
            onKeyDown={(event) => { if (pendingRef.current && event.key !== 'Tab') event.preventDefault(); }}
            onChange={(event) => { if (!pendingRef.current) setForm(current => ({ ...current, currency: event.target.value as FormState['currency'] })); }}
            className={fieldClass + ' w-auto'}>
            {view?.allowedCurrencies.map(currency => <option key={currency}>{currency}</option>)}
          </select>
        </label>}
        {([['input', 'input'], ['output', 'output'], ['cacheRead', 'cacheRead'], ['cacheCreate', 'cacheWrite']] as const).map(([field, label]) => (
          <label key={field} className="flex min-h-[34px] items-center justify-between gap-4 border-b border-[var(--settings-theme-card-border)] py-2 last:border-b-0">
            <span className="shrink-0 text-13 text-[var(--text-secondary)]">{t('settings.providers.models.priceOverride.' + label)}</span>
            <span className="inline-flex min-w-0 items-center gap-1 text-13 text-[var(--text-primary)]">
              <span aria-hidden>{form.currency === 'CNY' ? '¥' : '$'}</span>
              <input ref={field === 'input' ? primaryInputRef : undefined} {...pricingSetting.controlProps} data-model-price-input type="number" min="0" step="any" inputMode="decimal"
                value={form[field]} placeholder="—" disabled={unavailable} readOnly={saving}
                aria-label={t('settings.providers.models.priceOverride.' + label)}
                onChange={(event) => setForm(current => ({ ...current, [field]: event.target.value }))}
                style={{ width: Math.max(3, form[field].length + 1) + 'ch', maxWidth: '12ch' }}
                className="h-8 min-w-0 rounded-full border border-transparent bg-transparent px-1 text-right text-13 tabular-nums text-[var(--text-primary)] outline-none hover:border-[var(--border-default)] focus:border-[var(--settings-input-border-focus)] focus:ring-2 focus:ring-[var(--focus-ring-soft)] placeholder:text-[var(--text-placeholder)] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none" />
              <span className="text-11 text-[var(--text-tertiary)]">{t('settings.providers.models.advanced.perMtok')}</span>
            </span>
          </label>
        ))}
        {details && <details className="mt-2 text-12 text-[var(--text-secondary)]">
          <summary className="cursor-pointer">{t('settings.providers.models.priceOverride.referenceDetails')}</summary>
          {details}
        </details>}
        {view?.conflict && <p className="mt-2 text-12 text-[var(--warning-fg)]">{t('settings.providers.models.priceOverride.conflict')}</p>}
        <p className="mt-2 text-11 text-[var(--text-tertiary)]">{t('settings.providers.models.priceOverride.description')}</p>
        {view?.registryUpdatedAt && <p className="mt-1 text-11 text-[var(--text-tertiary)]">
          {t('settings.providers.models.priceOverride.registryDate', { date: view.registryUpdatedAt.slice(0, 10) })}
        </p>}
      </section>
    );
  }

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="modal-scrim fixed inset-0 z-[10001]" />
        <Dialog.Content
          onPointerDownOutside={(event) => event.preventDefault()}
          className={cn(
            'modal-panel fixed left-1/2 top-1/2 z-[10001] w-[520px] max-w-[92vw]',
            '-translate-x-1/2 -translate-y-1/2 overflow-hidden',
          )}
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            primaryInputRef.current?.focus();
          }}
        >
          <header className="flex items-start justify-between gap-4 px-5 pb-3 pt-4">
            <div className="min-w-0">
              <Dialog.Title className="truncate text-15 font-medium text-[var(--settings-section-title)]">
                {t('settings.providers.models.priceOverride.title', { model: row.name })}
              </Dialog.Title>
              <Dialog.Description className="mt-1 text-12 leading-[1.45] text-[var(--settings-section-desc)]">
                {t('settings.providers.models.priceOverride.description')}
              </Dialog.Description>
            </div>
            <Dialog.Close asChild>
              <button
                data-settings-search-action="Close the model price editor"
                type="button"
                aria-label={t('settings.providers.models.priceOverride.close')}
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-[var(--text-tertiary)] hover:bg-[var(--surface-hover)]"
              >
                <X size={15} />
              </button>
            </Dialog.Close>
          </header>

          <div className="flex flex-col gap-4 px-5 pb-5">
            {row.avail.length > 1 && (
              <SegmentedControl
                data-settings-search-action="Choose which engine quote to edit"
                aria-label={t('settings.providers.custom.fields.protocols')}
                value={agent}
                onValueChange={setAgent}
                disabled={saving}
                fullWidth
                options={row.avail.map((candidate) => ({
                  value: candidate,
                  label: AGENT_LABEL[candidate],
                }))}
              />
            )}

            {view?.conflict && (
              <div className="flex gap-2 rounded-lg bg-[var(--warning-bg-soft)] px-3 py-2.5">
                <AlertTriangle size={15} className="mt-0.5 shrink-0 text-[var(--warning-fg)]" />
                <span className="text-12 leading-[1.45] text-[var(--text-secondary)]">
                  {t('settings.providers.models.priceOverride.conflict')}
                </span>
              </div>
            )}

            <div
              {...pricingSetting.anchorProps}
              className={cn('grid grid-cols-2 gap-3', loading && 'pointer-events-none opacity-60')}
            >
              <label className="col-span-2 flex flex-col gap-1.5">
                <span className="text-12 font-medium text-[var(--text-secondary)]">
                  {t('settings.providers.models.priceOverride.currency')}
                </span>
                <select
                  {...pricingSetting.controlProps}
                  value={form.currency}
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      currency: event.target.value as 'USD' | 'CNY',
                    }))
                  }
                  className={fieldClass}
                >
                  {(view?.allowedCurrencies ?? ['USD']).map((currency) => (
                    <option key={currency} value={currency}>
                      {currency}
                    </option>
                  ))}
                </select>
              </label>
              {(
                [
                  ['input', 'input'],
                  ['output', 'output'],
                  ['cacheRead', 'cacheRead'],
                  ['cacheCreate', 'cacheWrite'],
                ] as const
              ).map(([field, label]) => (
                <label key={field} className="flex flex-col gap-1.5">
                  <span className="text-12 font-medium text-[var(--text-secondary)]">
                    {t(`settings.providers.models.priceOverride.${label}`)}
                  </span>
                  <input
                    {...pricingSetting.controlProps}
                    ref={field === 'input' ? primaryInputRef : undefined}
                    type="number"
                    min="0"
                    step="any"
                    value={form[field]}
                    placeholder={field.startsWith('cache') ? '—' : '0'}
                    onChange={(event) =>
                      setForm((current) => ({ ...current, [field]: event.target.value }))
                    }
                    className={fieldClass}
                  />
                </label>
              ))}
            </div>

            <p className="text-11 leading-[1.45] text-[var(--text-tertiary)]">
              {t('settings.providers.models.priceOverride.unit')}
              {view?.registryUpdatedAt
                ? ` · ${t('settings.providers.models.priceOverride.registryDate', {
                    date: view.registryUpdatedAt.slice(0, 10),
                  })}`
                : ''}
            </p>

            <footer className="flex items-center justify-between border-t border-[var(--border-default)] pt-3">
              <div>
                {view?.override && (
                  <Button
                    data-settings-search-action="Reset this model quote using its existing reset API"
                    variant="secondary"
                    size="md"
                    tone="quiet"
                    compact
                    type="button"
                    onClick={() => void reset()}
                    disabled={saving}
                  >
                    {t('settings.providers.models.priceOverride.reset')}
                  </Button>
                )}
              </div>
              <div className="flex gap-2">
                <Dialog.Close asChild>
                  <Button data-settings-search-action="Cancel editing the model quote" variant="secondary" size="md" compact type="button">
                    {t('settings.providers.models.priceOverride.cancel')}
                  </Button>
                </Dialog.Close>
                <Button
                  data-settings-search-action="Save the entered model quote"
                  variant="cta"
                  size="md"
                  compact
                  loading={saving}
                  type="button"
                  onClick={() => void save()}
                  disabled={loading || saving || !view}
                >
                  {t('settings.providers.models.priceOverride.save')}
                </Button>
              </div>
            </footer>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
