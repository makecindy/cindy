import { useEffect, useMemo, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { AlertTriangle, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { AgentKind, ProviderView } from '@cindy/model-providers';

import { cn } from '@/lib/utils';
import { toast } from '@/lib/toast';

import type {
  ModelPriceOverrideDesiredQuote,
  ModelPriceOverrideView,
} from '../../../shared/modelPriceOverride';
import type { UnionModelRow } from './UnifiedModelList';

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

export function ModelPriceOverrideDialog({ provider, row, open, onOpenChange }: Props) {
  const { t } = useTranslation();
  const [agent, setAgent] = useState<AgentKind>(row.avail[0]);
  const [view, setView] = useState<ModelPriceOverrideView | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  const model = row.byAgent[agent];
  const target = useMemo(
    () => (model ? { providerId: provider.id, agent, modelId: model.id } : null),
    [agent, model, provider.id],
  );

  // DESIGN.md §4:弹窗打开时焦点落主输入,而不是 Radix 默认的首个可聚焦元素(关闭按钮)。
  const primaryInputRef = useRef<HTMLInputElement | null>(null);

  // 弹窗关闭或目标切换后,在途 save/reset 的迟到响应必须整体作废:旧实例捕获的
  // setView/onOpenChange(false) 会覆盖新目标的表单、甚至直接关掉刚打开的弹窗。
  const mutationEpochRef = useRef(0);
  useEffect(() => {
    mutationEpochRef.current += 1;
  }, [open, target]);
  // UnifiedModelList 按行条件渲染本弹窗:换行会卸载重挂、换新实例,但旧实例的
  // 在途 save/reset 闭包仍握着共享的 onOpenChange。卸载时同样作废 epoch,
  // 迟到响应不得关掉新实例的弹窗或触发任何副作用。
  useEffect(
    () => () => {
      mutationEpochRef.current += 1;
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
    if (!target || !view || loading) return;
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
      toast.error(t('settings.providers.models.priceOverride.invalid'));
      return;
    }
    const desired: ModelPriceOverrideDesiredQuote = {
      currency: form.currency,
      inputPerMtok,
      outputPerMtok,
      cacheReadPerMtok,
      cacheCreatePerMtok,
    };
    setSaving(true);
    const epoch = mutationEpochRef.current;
    try {
      const next = await window.electronAPI.maker.setModelPriceOverride(target, desired);
      if (mutationEpochRef.current !== epoch) return;
      setView(next);
      setForm(formFromView(next));
      toast.success(t('settings.providers.models.priceOverride.saved'));
      onOpenChange(false);
    } catch {
      if (mutationEpochRef.current !== epoch) return;
      toast.error(t('settings.providers.models.priceOverride.saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  const reset = async () => {
    if (!target) return;
    setSaving(true);
    const epoch = mutationEpochRef.current;
    try {
      const next = await window.electronAPI.maker.resetModelPriceOverride(target);
      if (mutationEpochRef.current !== epoch) return;
      setView(next);
      setForm(formFromView(next));
      toast.success(t('settings.providers.models.priceOverride.resetDone'));
    } catch {
      if (mutationEpochRef.current !== epoch) return;
      toast.error(t('settings.providers.models.priceOverride.saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  const fieldClass = cn(
    'h-9 w-full rounded-full border px-3 text-13 tabular-nums outline-none',
    'border-[var(--settings-input-border)] bg-[var(--settings-input-bg)]',
    'text-[var(--settings-section-title)] focus:border-[var(--focus-ring)]',
  );

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[10001] bg-[var(--overlay-modal)]" />
        <Dialog.Content
          className={cn(
            'fixed left-1/2 top-1/2 z-[10001] w-[520px] max-w-[92vw]',
            '-translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-xl',
            'border border-[var(--cmd-palette-border)] bg-[var(--cmd-palette-bg)]',
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
              <div className="flex rounded-full bg-[var(--surface-chip)] p-0.5">
                {row.avail.map((candidate) => (
                  <button
                    key={candidate}
                    type="button"
                    disabled={saving}
                    onClick={() => setAgent(candidate)}
                    className={cn(
                      'h-7 flex-1 rounded-full text-12 font-medium transition-colors disabled:cursor-default',
                      candidate === agent
                        ? 'bg-[var(--surface-elevated)] text-[var(--settings-section-title)]'
                        : 'text-[var(--text-secondary)]',
                    )}
                  >
                    {AGENT_LABEL[candidate]}
                  </button>
                ))}
              </div>
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
                  <button
                    type="button"
                    onClick={() => void reset()}
                    disabled={saving}
                    className="h-8 rounded-full px-3 text-12 font-medium text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] disabled:opacity-50"
                  >
                    {t('settings.providers.models.priceOverride.reset')}
                  </button>
                )}
              </div>
              <div className="flex gap-2">
                <Dialog.Close asChild>
                  <button
                    type="button"
                    className="h-8 rounded-full border border-[var(--settings-btn-secondary-border)] px-3.5 text-12 font-medium text-[var(--settings-btn-secondary-text)] hover:bg-[var(--surface-hover)]"
                  >
                    {t('settings.providers.models.priceOverride.cancel')}
                  </button>
                </Dialog.Close>
                <button
                  type="button"
                  onClick={() => void save()}
                  disabled={loading || saving || !view}
                  className="h-8 rounded-full bg-[var(--settings-btn-primary-bg)] px-3.5 text-12 font-medium text-[var(--settings-btn-primary-text)] disabled:opacity-50"
                >
                  {t('settings.providers.models.priceOverride.save')}
                </button>
              </div>
            </footer>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
