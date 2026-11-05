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
import type { ModelPriceQuote } from '../../../shared/regionalMoney';

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
  initialAgent?: AgentKind;
  referenceDetails?: ReactNode | ((agent: AgentKind) => ReactNode);
  onPendingChange?: (pending: boolean) => void;
  fallbackQuoteOf?: (agent: AgentKind) => ModelPriceQuote | null;
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

const FORM_FIELDS = ['currency', 'input', 'output', 'cacheRead', 'cacheCreate'] as const;

function mergeDraft(previous: FormState, draft: FormState, latest: FormState): FormState {
  const value = <K extends keyof FormState>(key: K) =>
    draft[key] === previous[key] ? latest[key] : draft[key];
  return { currency: value('currency'), input: value('input'), output: value('output'),
    cacheRead: value('cacheRead'), cacheCreate: value('cacheCreate') };
}

function parseRequiredPrice(value: string): number | null {
  if (!/^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value.trim())) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function parseOptionalPrice(value: string): number | null | 'invalid' {
  if (!value.trim()) return null;
  return parseRequiredPrice(value) ?? 'invalid';
}

export function ModelPriceOverrideDialog({
  provider, row, open, onOpenChange, presentation = 'dialog', initialAgent, referenceDetails, onPendingChange, fallbackQuoteOf,
}: Props) {
  const inline = presentation === 'inline';
  const { t } = useTranslation();
  const [agent, setAgent] = useState<AgentKind>(initialAgent ?? row.avail[0]);
  const [view, setView] = useState<ModelPriceOverrideView | null>(null);
  const [form, setFormState] = useState<FormState>(EMPTY_FORM);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [pricingRevision, setPricingRevision] = useState(0);
  const refreshQueuedRef = useRef(false);
  const refreshGenerationRef = useRef(0);
  const viewRef = useRef(view);
  const formRef = useRef(form);
  const setForm = (next: FormState | ((current: FormState) => FormState)) => {
    const resolved = typeof next === 'function' ? next(formRef.current) : next;
    formRef.current = resolved;
    setFormState(resolved);
  };

  const model = row.byAgent[agent];
  const modelId = model?.id;
  const target = useMemo(
    () => (modelId ? { providerId: provider.id, agent, modelId } : null),
    [agent, modelId, provider.id],
  );

  // The list already includes connection-local cost quotes. Use that same source
  // only when the override API has no quote, without changing its edit permissions.
  const fallbackQuoteOfRef = useRef(fallbackQuoteOf);
  fallbackQuoteOfRef.current = fallbackQuoteOf;
  const resolveView = (next: ModelPriceOverrideView) => {
    const fallback = fallbackQuoteOfRef.current?.(next.target.agent);
    const effective = !next.effective && !next.reference &&
      fallback?.source === 'provider-reference' &&
      fallback.providerId === next.target.providerId && fallback.modelId === next.target.modelId &&
      next.allowedCurrencies.includes(fallback.currency)
        ? fallback : next.effective;
    return effective === next.effective ? next : { ...next, effective };
  };
  const applyView = (next: ModelPriceOverrideView, preserveDraft = false) => {
    const resolved = resolveView(next);
    const previous = viewRef.current && formFromView(viewRef.current);
    const latest = formFromView(resolved);
    const current = formRef.current;
    if (preserveDraft && previous && previous.currency !== latest.currency &&
        FORM_FIELDS.some(key => current[key] !== previous[key])) {
      // Do not reinterpret an unsaved amount in another window's new currency.
      refreshQueuedRef.current = true;
      toast.error(t('settings.providers.models.priceOverride.loadFailed'));
      return false;
    }
    const nextForm = preserveDraft && previous ? mergeDraft(previous, current, latest) : latest;
    viewRef.current = resolved;
    setForm(nextForm);
    setView(resolved);
    return true;
  };

  // DESIGN.md §4:弹窗打开时焦点落主输入,而不是 Radix 默认的首个可聚焦元素(关闭按钮)。
  const primaryInputRef = useRef<HTMLInputElement | null>(null);

  // 弹窗关闭或目标切换后,在途 save/reset 的迟到响应必须整体作废:旧实例捕获的
  // setView/onOpenChange(false) 会覆盖新目标的表单、甚至直接关掉刚打开的弹窗。
  const mutationEpochRef = useRef(0);
  const pendingMutationRef = useRef(false);
  const requestedAgentRef = useRef<AgentKind | null>(null);
  const setMutationPending = (pending: boolean) => {
    pendingMutationRef.current = pending;
    setSaving(pending);
    onPendingChange?.(pending);
    if (!pending && refreshQueuedRef.current) setPricingRevision(++refreshGenerationRef.current);
  };
  useEffect(() => {
    mutationEpochRef.current += 1;
    requestedAgentRef.current = null;
    refreshQueuedRef.current = false;
    if (!open) {
      viewRef.current = null;
      setView(null);
      setForm(EMPTY_FORM);
    }
    setMutationPending(false);
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
    const generation = refreshGenerationRef.current;
    const current = viewRef.current?.target;
    const sameTarget = current?.providerId === target.providerId &&
      current.agent === target.agent && current.modelId === target.modelId;
    if (!sameTarget) {
      setLoading(true);
      viewRef.current = null;
      setView(null);
      setForm(EMPTY_FORM);
    }
    void window.electronAPI.maker
      .getModelPriceOverride(target)
      .then((next) => {
        if (cancelled || generation !== refreshGenerationRef.current) return;
        if (pendingMutationRef.current) { refreshQueuedRef.current = true; return; }
        if (applyView(next, sameTarget)) refreshQueuedRef.current = false;
      })
      .catch(() => {
        if (!cancelled && generation === refreshGenerationRef.current) toast.error(t('settings.providers.models.priceOverride.loadFailed'));
      })
      .finally(() => {
        if (!cancelled && generation === refreshGenerationRef.current) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, target, t, pricingRevision]);

  useEffect(() => {
    if (!inline || !open || !target) return;
    // Same-target quote broadcasts do not change target identity. Refresh when
    // idle; a mutation keeps its epoch/close guard and drains the refresh later.
    try {
      return window.electronAPI.maker.usage?.onReferenceModelPricingChanged?.(() => {
        refreshQueuedRef.current = true;
        const generation = ++refreshGenerationRef.current;
        if (!pendingMutationRef.current) setPricingRevision(generation);
      });
    } catch { /* Older/projected preload: the existing quote read remains usable. */ }
  }, [inline, open, target]);

  const save = async (draft = formRef.current) => {
    const view = viewRef.current;
    if (!target || !view || loading || pendingMutationRef.current || (inline && !view.editable)) return;
    // A new estimate has two required fields: tabbing to fill the second is not a validation error.
    if (inline && !view.effective && !view.reference && (!draft.input.trim() || !draft.output.trim())) return;
    const inputPerMtok = parseRequiredPrice(draft.input);
    const outputPerMtok = parseRequiredPrice(draft.output);
    const cacheReadPerMtok = parseOptionalPrice(draft.cacheRead);
    const cacheCreatePerMtok = parseOptionalPrice(draft.cacheCreate);
    if (
      inputPerMtok === null ||
      outputPerMtok === null ||
      cacheReadPerMtok === 'invalid' ||
      cacheCreatePerMtok === 'invalid'
    ) {
      if (inline) {
        const previous = formFromView(view);
        setForm((current) => ({
          ...current,
          input: inputPerMtok === null ? previous.input : current.input,
          output: outputPerMtok === null ? previous.output : current.output,
          cacheRead: cacheReadPerMtok === 'invalid' ? previous.cacheRead : current.cacheRead,
          cacheCreate: cacheCreatePerMtok === 'invalid' ? previous.cacheCreate : current.cacheCreate,
        }));
      }
      toast.error(t('settings.providers.models.priceOverride.invalid'));
      return;
    }
    let desired: ModelPriceOverrideDesiredQuote = {
      currency: draft.currency,
      inputPerMtok,
      outputPerMtok,
      cacheReadPerMtok,
      cacheCreatePerMtok,
    };
    if (inline) {
      const current = formFromView(view);
      if (draft.currency === current.currency &&
          inputPerMtok === parseRequiredPrice(current.input) &&
          outputPerMtok === parseRequiredPrice(current.output) &&
          cacheReadPerMtok === parseOptionalPrice(current.cacheRead) &&
          cacheCreatePerMtok === parseOptionalPrice(current.cacheCreate)) {
        // A no-op blur settles formatting too; it is no longer an unsaved draft.
        applyView(view);
        return;
      }
    }
    setMutationPending(true);
    const epoch = mutationEpochRef.current;
    try {
      if (inline && refreshQueuedRef.current) {
        const generation = refreshGenerationRef.current;
        const latest = resolveView(await window.electronAPI.maker.getModelPriceOverride(target));
        if (mutationEpochRef.current !== epoch) return;
        if (generation !== refreshGenerationRef.current) throw new Error('price changed while rereading');
        const previous = formFromView(view);
        const latestForm = formFromView(latest);
        if (!latest.editable || (latestForm.currency !== previous.currency && draft.currency === previous.currency)) {
          throw new Error('price changed while editing');
        }
        const rebased = mergeDraft(previous, draft, latestForm);
        const input = parseRequiredPrice(rebased.input);
        const output = parseRequiredPrice(rebased.output);
        const read = parseOptionalPrice(rebased.cacheRead);
        const create = parseOptionalPrice(rebased.cacheCreate);
        if (input === null || output === null || read === 'invalid' || create === 'invalid') {
          throw new Error('latest price is incomplete');
        }
        desired = { currency: rebased.currency, inputPerMtok: input, outputPerMtok: output,
          cacheReadPerMtok: read, cacheCreatePerMtok: create };
      }
      const next = await window.electronAPI.maker.setModelPriceOverride(target, desired);
      if (mutationEpochRef.current !== epoch) return;
      applyView(next);
      toast.success(t('settings.providers.models.priceOverride.saved'));
      if (requestedAgentRef.current) setAgent(requestedAgentRef.current);
      requestedAgentRef.current = null;
      if (!inline) onOpenChange(false);
    } catch {
      if (mutationEpochRef.current !== epoch) return;
      requestedAgentRef.current = null;
      toast.error(t('settings.providers.models.priceOverride.saveFailed'));
    } finally {
      if (mutationEpochRef.current === epoch) {
        setMutationPending(false);
      }
    }
  };

  const reset = async () => {
    const view = viewRef.current;
    if (!target || pendingMutationRef.current || (inline && (!view?.editable || !view.override))) return;
    setMutationPending(true);
    const epoch = mutationEpochRef.current;
    try {
      const next = await window.electronAPI.maker.resetModelPriceOverride(target);
      if (mutationEpochRef.current !== epoch) return;
      applyView(next);
      toast.success(t('settings.providers.models.priceOverride.resetDone'));
      if (requestedAgentRef.current) setAgent(requestedAgentRef.current);
      requestedAgentRef.current = null;
    } catch {
      if (mutationEpochRef.current !== epoch) return;
      requestedAgentRef.current = null;
      toast.error(t('settings.providers.models.priceOverride.saveFailed'));
    } finally {
      if (mutationEpochRef.current === epoch) {
        setMutationPending(false);
      }
    }
  };

  const fieldClass = cn(
    'h-9 w-full rounded-full border px-3 text-13 tabular-nums outline-none',
    'border-[var(--settings-input-border)] bg-[var(--settings-input-bg)]',
    'text-[var(--settings-section-title)] focus:border-[var(--focus-ring)]',
  );

  if (inline) {
    const inputUnavailable = loading || !view?.editable;
    const blocked = inputUnavailable || saving;
    const details = typeof referenceDetails === 'function' ? referenceDetails(agent) : referenceDetails;
    return (
      <section className="pt-5" aria-label={t('settings.providers.models.advanced.pricing')} aria-busy={saving}>
        <div className="flex min-h-8 items-center justify-between gap-2">
          <h4 className="text-12 font-medium text-[var(--text-secondary)]">
            {t('settings.providers.models.advanced.pricing')}
          </h4>
          <Button variant="secondary" onClick={() => void reset()}
            data-model-price-deferred-action onBlur={() => void save()}
            disabled={blocked || !view?.override} className="px-3"
            title={t('settings.providers.models.priceOverride.reset')}>
            {t('settings.providers.models.priceOverride.resetShort')}
          </Button>
        </div>
        <div className="mt-1.5">
          {row.avail.length > 1 && (
            <SegmentedControl className="mb-2"
              aria-label={t('settings.providers.custom.fields.protocols')}
              value={agent} onValueChange={(next) => {
                if (pendingMutationRef.current) requestedAgentRef.current = next;
                else setAgent(next);
              }}
              options={row.avail.map((candidate) => ({ value: candidate, label: AGENT_LABEL[candidate] }))}
            />
          )}
          {(view?.allowedCurrencies.length ?? 0) > 1 && (
            <label className="mb-2 flex items-center justify-between gap-4 text-12 text-[var(--text-secondary)]">
              {t('settings.providers.models.priceOverride.currency')}
              <select value={form.currency} disabled={blocked}
                data-model-price-deferred-action onBlur={() => void save()}
                onChange={(event) => {
                  const next = { ...formRef.current, currency: event.target.value as FormState['currency'] };
                  setForm(next);
                  void save(next);
                }}
                className="h-8 rounded-full border border-[var(--border-default)] bg-[var(--surface-elevated)] px-3 text-12">
                {view?.allowedCurrencies.map((currency) => <option key={currency}>{currency}</option>)}
              </select>
            </label>
          )}
          {!loading && view && !view.effective && !view.reference && (
            <p role="status" className="mb-2 text-12 text-[var(--text-secondary)]">
              {t(provider.access?.kind === 'subscription'
                ? 'settings.providers.models.subscription'
                : 'settings.providers.models.advanced.noPricing')}
            </p>
          )}
          {([
            ['input', 'input'], ['output', 'output'],
            ['cacheRead', 'cacheRead'], ['cacheCreate', 'cacheWrite'],
          ] as const).map(([field, label]) => (
            <div key={field} className="flex min-h-[34px] items-center justify-between gap-4 border-b border-[var(--settings-theme-card-border)] py-2 last:border-b-0">
              <label htmlFor={`price-${agent}-${field}`} className="shrink-0 text-13 text-[var(--text-secondary)]">
                {t(`settings.providers.models.priceOverride.${label}`)}
              </label>
              <span className="min-w-0 text-right text-13">
                <span className="-my-2 inline-flex h-8 items-center rounded-full border border-transparent px-1 text-[var(--text-primary)] hover:border-[var(--border-default)] focus-within:border-[var(--settings-input-border-focus)] focus-within:ring-2 focus-within:ring-[var(--focus-ring-soft)]">
                  <span aria-hidden>{form.currency === 'CNY' ? '¥' : '$'}</span>
                  <input id={`price-${agent}-${field}`} data-model-price-input type="text" inputMode="decimal"
                    value={form[field]} disabled={inputUnavailable} readOnly={saving}
                    placeholder="—"
                    aria-label={t(`settings.providers.models.priceOverride.${label}`)}
                    style={{ width: `${Math.max(2, form[field].length)}ch`, maxWidth: '12ch' }}
                    className="min-w-0 bg-transparent text-right text-13 tabular-nums text-[var(--text-primary)] outline-none placeholder:text-[var(--text-placeholder)] disabled:opacity-60"
                    onChange={(event) => setForm((current) => ({ ...current, [field]: event.target.value }))}
                    onBlur={(event) => {
                      // Reset/currency owns the next action. Do not disable it before its click/change.
                      if (event.relatedTarget instanceof HTMLElement &&
                          event.relatedTarget.closest('[data-model-price-deferred-action]')) return;
                      void save();
                    }}
                    onKeyDown={(event) => {
                      if (event.nativeEvent.isComposing) return;
                      if (event.key === 'Escape') {
                        event.preventDefault();
                        event.stopPropagation();
                        event.currentTarget.blur();
                      } else if (event.key === 'Enter') {
                        event.preventDefault();
                      }
                    }} />
                </span>
                <span className="ml-1 text-11 text-[var(--text-tertiary)]">
                  {t('settings.providers.models.advanced.perMtok')}
                </span>
              </span>
            </div>
          ))}
          {details && (
            <details className="mt-2 text-12 text-[var(--text-secondary)]">
              <summary className="cursor-pointer">{t('settings.providers.models.priceOverride.referenceDetails')}</summary>
              {details}
            </details>
          )}
          {view?.conflict && (
            <p className="mt-2 text-12 text-[var(--warning-fg)]">
              {t('settings.providers.models.priceOverride.conflict')}
            </p>
          )}
          <p className="mt-2 text-11 text-[var(--text-tertiary)]">
            {t('settings.providers.models.priceOverride.description')}
          </p>
          {view?.registryUpdatedAt && (
            <p className="mt-1 text-11 text-[var(--text-tertiary)]">
              {t('settings.providers.models.priceOverride.registryDate', {
                date: view.registryUpdatedAt.slice(0, 10),
              })}
            </p>
          )}
        </div>
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
              className={cn('grid grid-cols-2 gap-3', loading && 'pointer-events-none opacity-60')}
            >
              <label className="col-span-2 flex flex-col gap-1.5">
                <span className="text-12 font-medium text-[var(--text-secondary)]">
                  {t('settings.providers.models.priceOverride.currency')}
                </span>
                <select
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
                  <Button variant="secondary" size="md" compact type="button">
                    {t('settings.providers.models.priceOverride.cancel')}
                  </Button>
                </Dialog.Close>
                <Button
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
