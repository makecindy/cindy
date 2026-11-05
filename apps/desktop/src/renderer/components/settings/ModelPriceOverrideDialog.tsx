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
import { getModelPriceQuote } from '../../../shared/modelPriceQuote';
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

function sameFormValue(key: keyof FormState, left: string, right: string): boolean {
  if (left === right) return true;
  if (key === 'currency') return false;
  if (!left.trim() && !right.trim()) return true;
  const a = parseRequiredPrice(left);
  const b = parseRequiredPrice(right);
  return a !== null && b !== null && a === b;
}

function hasDraft(view: ModelPriceOverrideView | null, draft: FormState): boolean {
  if (!view) return false;
  const previous = formFromView(view);
  return FORM_FIELDS.some(key => !sameFormValue(key, draft[key], previous[key]));
}

function staysInQuoteFields(from: HTMLElement, next: EventTarget | null): boolean {
  return next instanceof HTMLElement && next.closest('section') === from.closest('section') &&
    (next.hasAttribute('data-model-price-input') ||
      (next instanceof HTMLSelectElement && next.hasAttribute('data-model-price-deferred-action')));
}

function mergeDraft(previous: FormState, draft: FormState, latest: FormState): FormState {
  const value = <K extends keyof FormState>(key: K) =>
    sameFormValue(key, draft[key], previous[key]) ? latest[key] : draft[key];
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
  const pricingSetting = useSettingDefinition(providersSettings.modelPricing, t);
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

  const primaryInputRef = useRef<HTMLInputElement | null>(null);
  const resetButtonRef = useRef<HTMLButtonElement | null>(null);
  const fallbackSignature = JSON.stringify(fallbackQuoteOf?.(agent) ?? null);

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
  const resolveView = async (next: ModelPriceOverrideView) => {
    if (next.effective || next.reference) return next;
    const readPricing = window.electronAPI.maker.usage?.getReferenceModelPricing;
    // Provider-only discovery/configuration broadcasts do not update the parent's
    // pricing cache. Read the existing authoritative projection for cost-only models.
    const fallback = readPricing
      ? getModelPriceQuote(await readPricing.call(window.electronAPI.maker.usage), next.target.providerId, next.target.modelId, next.target.agent)
      : fallbackQuoteOfRef.current?.(next.target.agent);
    const effective = !next.effective && !next.reference &&
      fallback?.source === 'provider-reference' &&
      fallback.providerId === next.target.providerId && fallback.modelId === next.target.modelId &&
      next.allowedCurrencies.includes(fallback.currency)
        ? fallback : next.effective;
    return effective === next.effective ? next : { ...next, effective };
  };
  const applyView = (next: ModelPriceOverrideView, preserveDraft = false) => {
    const resolved = next;
    const previous = viewRef.current && formFromView(viewRef.current);
    const latest = formFromView(resolved);
    const current = formRef.current;
    if (preserveDraft && previous && previous.currency !== latest.currency &&
        FORM_FIELDS.some(key => !sameFormValue(key, current[key], previous[key]))) {
      // Do not reinterpret an unsaved amount in another window's new currency.
      refreshQueuedRef.current = true;
      toast.error(t('settings.providers.models.priceOverride.loadFailed'));
      return false;
    }
    const nextForm = preserveDraft && previous ? mergeDraft(previous, current, latest) : latest;
    viewRef.current = resolved;
    setForm(nextForm);
    setView(resolved);
    // A completed reset can make its button unavailable. Move only its current
    // focus to the price field; never steal focus after the user has tabbed away.
    if (inline && resolved.editable && !resolved.override && resetButtonRef.current &&
        document.activeElement === resetButtonRef.current) primaryInputRef.current?.focus();
    return true;
  };

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
    if (sameTarget) refreshQueuedRef.current = true;
    if (!sameTarget) {
      setLoading(true);
      viewRef.current = null;
      setView(null);
      setForm(EMPTY_FORM);
    }
    void window.electronAPI.maker
      .getModelPriceOverride(target)
      .then(resolveView)
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
  }, [open, target, t, pricingRevision, fallbackSignature]);

  useEffect(() => {
    if (!inline || !open || !target) return;
    // Same-target quote broadcasts do not change target identity. Refresh when
    // idle; a mutation keeps its epoch/close guard and drains the refresh later.
    const changed = () => {
      refreshQueuedRef.current = true;
      const generation = ++refreshGenerationRef.current;
      if (!pendingMutationRef.current) setPricingRevision(generation);
    };
    const unsubscribers: (() => void)[] = [];
    // Each optional bridge is independent: an older/projected preload may expose
    // either channel. Both feed the same mutation-preserving refresh queue.
    try {
      const off = window.electronAPI.maker.usage?.onReferenceModelPricingChanged?.(changed);
      if (off) unsubscribers.push(off);
    } catch { /* Existing quote reads remain usable. */ }
    try {
      const off = window.electronAPI.maker.onProvidersChanged?.(changed);
      if (off) unsubscribers.push(off);
    } catch { /* Existing quote reads remain usable. */ }
    return () => { unsubscribers.forEach(off => off()); };
  }, [inline, open, target]);

  const applyCommittedView = async (next: ModelPriceOverrideView, epoch: number, message: 'saved' | 'resetDone') => {
    // The write receipt is authoritative even if its separate fallback read fails.
    applyView(next);
    toast.success(t(`settings.providers.models.priceOverride.${message}`));
    if (next.effective || next.reference) return;
    try {
      const resolved = await resolveView(next);
      if (mutationEpochRef.current === epoch) applyView(resolved);
    } catch {
      if (mutationEpochRef.current === epoch) toast.error(t('settings.providers.models.priceOverride.loadFailed'));
    }
  };

  const save = async (draft = formRef.current, allowIncomplete = false) => {
    const view = viewRef.current;
    if (!target || !view || loading || pendingMutationRef.current || (inline && !view.editable)) return;
    // Continue constructing a new quote within its fields. On actual exit, use
    // the owner's invalid-input contract: restore the previous default, not a close trap.
    if (inline && !view.effective && !view.reference && (!draft.input.trim() || !draft.output.trim())) {
      const entered = [draft.input, draft.output, draft.cacheRead, draft.cacheCreate].some(value => value.trim().length > 0);
      if (allowIncomplete || !entered) return;
      applyView(view);
      toast.error(t('settings.providers.models.priceOverride.invalid'));
      return;
    }
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
        const latest = await resolveView(await window.electronAPI.maker.getModelPriceOverride(target));
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
      await applyCommittedView(next, epoch, 'saved');
      if (mutationEpochRef.current !== epoch) return;
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
    if (!target || pendingMutationRef.current || (inline && (!view?.editable || (!view.override && !hasDraft(view, formRef.current))))) return;
    if (inline && view && !view.override) {
      // Resetting an unsaved draft needs no persistence operation or save toast.
      applyView(view);
      return;
    }
    setMutationPending(true);
    const epoch = mutationEpochRef.current;
    try {
      const next = await window.electronAPI.maker.resetModelPriceOverride(target);
      if (mutationEpochRef.current !== epoch) return;
      await applyCommittedView(next, epoch, 'resetDone');
      if (mutationEpochRef.current !== epoch) return;
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
    const details = typeof referenceDetails === 'function' ? referenceDetails(agent) : referenceDetails;
    return (
      <section {...pricingSetting.anchorProps} className="pt-5" aria-label={t('settings.providers.models.advanced.pricing')} aria-busy={saving}>
        <div className="flex min-h-8 items-center justify-between gap-2">
          <h4 className="text-12 font-medium text-[var(--text-secondary)]">
            {t('settings.providers.models.advanced.pricing')}
          </h4>
          <Button ref={resetButtonRef} variant="secondary" onClick={() => void reset()}
            data-settings-search-action="Restore the current model quote to its default"
            data-model-price-deferred-action onBlur={(event) => void save(undefined, staysInQuoteFields(event.currentTarget, event.relatedTarget))}
            disabled={inputUnavailable || (!view?.override && !hasDraft(view, form))} aria-disabled={saving || undefined} className="px-3 aria-disabled:opacity-60"
            title={t('settings.providers.models.priceOverride.reset')}>
            {t('settings.providers.models.priceOverride.resetShort')}
          </Button>
        </div>
        <div className="mt-1.5">
          {row.avail.length > 1 && (
            <SegmentedControl className="mb-2"
              data-settings-search-action="Choose which engine quote to edit"
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
              <select value={form.currency} disabled={inputUnavailable} aria-disabled={saving || undefined}
                {...pricingSetting.controlProps}
                data-model-price-deferred-action onBlur={(event) => void save(undefined, staysInQuoteFields(event.currentTarget, event.relatedTarget))}
                onKeyDown={(event) => {
                  if (pendingMutationRef.current && event.key !== 'Tab' && event.key !== 'Escape') event.preventDefault();
                }}
                onPointerDown={(event) => { if (pendingMutationRef.current) event.preventDefault(); }}
                onChange={(event) => {
                  if (pendingMutationRef.current) return;
                  const next = { ...formRef.current, currency: event.target.value as FormState['currency'] };
                  setForm(next);
                  void save(next, true);
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
                  <input ref={field === 'input' ? primaryInputRef : undefined} id={`price-${agent}-${field}`} data-model-price-input type="text" inputMode="decimal"
                    {...pricingSetting.controlProps}
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
                      void save(undefined, staysInQuoteFields(event.currentTarget, event.relatedTarget));
                    }}
                    onKeyDown={(event) => {
                      if (event.nativeEvent.isComposing) return;
                      if (event.key === 'Escape') {
                        if (event.repeat || event.ctrlKey || event.shiftKey || event.altKey || event.metaKey) return;
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
                data-settings-search-action="Close the model quote editor"
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
                    data-settings-search-action="Restore the current model quote to its default"
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
                  <Button data-settings-search-action="Cancel the model quote editor" variant="secondary" size="md" compact type="button">
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
