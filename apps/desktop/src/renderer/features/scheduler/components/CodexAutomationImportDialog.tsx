import { useEffect, useMemo, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { AlertTriangle, Check, Loader2, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';
import { toast } from '@/lib/toast';
import { useConfirmDialog } from '@/components/ui/confirm-dialog-provider';

type CodexAutomationPreviewItem = {
  id: string;
  name: string;
  prompt: string;
  status: string;
  rrule: string;
  model?: string;
  reasoningEffort?: string;
  executionEnvironment?: string;
  cwds: string[];
  diagnostics: string[];
  canImport: boolean;
  duplicate?: boolean;
  selectedByDefault?: boolean;
};

type CodexAutomationPreview = {
  items: CodexAutomationPreviewItem[];
};

type CodexAutomationImportResult = {
  created: Array<{ sourceId: string; scheduleId?: string; name?: string }>;
  skipped: Array<{ sourceId: string; reason: string; name?: string }>;
  failed: Array<{ sourceId: string; error: string; name?: string }>;
};

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onImported: () => void;
}

function asPreview(value: unknown): CodexAutomationPreview {
  if (!value || typeof value !== 'object') return { items: [] };
  const items = (value as { items?: unknown }).items;
  if (!Array.isArray(items)) return { items: [] };
  return {
    items: items
      .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
      .map((item) => ({
        id: typeof item.id === 'string' ? item.id : '',
        name: typeof item.name === 'string' ? item.name : '',
        prompt: typeof item.prompt === 'string' ? item.prompt : '',
        status: typeof item.status === 'string' ? item.status : 'UNKNOWN',
        rrule: typeof item.rrule === 'string' ? item.rrule : '',
        model: typeof item.model === 'string' ? item.model : undefined,
        reasoningEffort:
          typeof item.reasoningEffort === 'string' ? item.reasoningEffort : undefined,
        executionEnvironment:
          typeof item.executionEnvironment === 'string' ? item.executionEnvironment : undefined,
        cwds: Array.isArray(item.cwds)
          ? item.cwds.filter((cwd): cwd is string => typeof cwd === 'string')
          : [],
        diagnostics: Array.isArray(item.diagnostics)
          ? item.diagnostics.filter(
              (diagnostic): diagnostic is string => typeof diagnostic === 'string',
            )
          : [],
        canImport: item.canImport === true,
        duplicate: item.duplicate === true,
        selectedByDefault: item.selectedByDefault === true,
      })),
  };
}

function asImportResult(value: unknown): CodexAutomationImportResult {
  if (!value || typeof value !== 'object') return { created: [], skipped: [], failed: [] };
  const result = value as Partial<CodexAutomationImportResult>;
  return {
    created: Array.isArray(result.created) ? result.created : [],
    skipped: Array.isArray(result.skipped) ? result.skipped : [],
    failed: Array.isArray(result.failed) ? result.failed : [],
  };
}

export function CodexAutomationImportDialog({ open, onOpenChange, onImported }: Props) {
  const { t } = useTranslation();
  const { confirm } = useConfirmDialog();
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [items, setItems] = useState<CodexAutomationPreviewItem[]>([]);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [result, setResult] = useState<CodexAutomationImportResult | null>(null);

  const reset = () => {
    setLoading(false);
    setImporting(false);
    setLoadError(null);
    setItems([]);
    setChecked(new Set());
    setExpanded(new Set());
    setResult(null);
  };

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    setResult(null);
    void window.electronAPI.maker.schedule
      .codexAutomationPreview()
      .then((value) => {
        if (cancelled) return;
        const preview = asPreview(value);
        setItems(preview.items);
        setChecked(
          new Set(
            preview.items
              .filter((item) => item.selectedByDefault && item.canImport && !item.duplicate)
              .map((item) => item.id),
          ),
        );
      })
      .catch((error) => {
        if (!cancelled) {
          const message = error instanceof Error ? error.message : String(error);
          setLoadError(message);
          toast.error(message);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const selectedCount = checked.size;
  const importableCount = useMemo(
    () => items.filter((item) => item.canImport && !item.duplicate).length,
    [items],
  );

  const toggle = (id: string, enabled: boolean) => {
    setChecked((current) => {
      const next = new Set(current);
      if (enabled) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  const runImport = async () => {
    if (selectedCount === 0 || importing) return;
    const selectedNames = items
      .filter((item) => checked.has(item.id))
      .map((item) => item.name)
      .join('、');
    const confirmed = await confirm({
      title: t('scheduler.codexImport.confirmTitle'),
      description: t('scheduler.codexImport.confirmDescription', {
        count: selectedCount,
        names: selectedNames,
      }),
      confirmText: t('scheduler.codexImport.confirm'),
      cancelText: t('scheduler.button.close'),
    });
    if (!confirmed) return;
    setImporting(true);
    try {
      const imported = asImportResult(
        await window.electronAPI.maker.schedule.codexAutomationImport([...checked]),
      );
      setResult(imported);
      onImported();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setImporting(false);
    }
  };

  const toggleAll = () => {
    const eligible = items
      .filter((item) => item.canImport && !item.duplicate)
      .map((item) => item.id);
    setChecked((current) => (current.size === eligible.length ? new Set() : new Set(eligible)));
  };

  const handleOpenChange = (value: boolean) => {
    if (!value) reset();
    onOpenChange(value);
  };

  return (
    <Dialog.Root open={open} onOpenChange={handleOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay
          className="fixed inset-0 z-[10001] bg-[var(--overlay-modal)]"
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        />
        <Dialog.Content
          aria-describedby={undefined}
          onPointerDownOutside={(event) => event.preventDefault()}
          className={cn(
            'fixed left-1/2 top-1/2 z-[10001] -translate-x-1/2 -translate-y-1/2',
            'flex max-h-[82vh] w-[720px] max-w-[94vw] flex-col overflow-hidden rounded-xl border border-[var(--cmd-palette-border)] bg-[var(--cmd-palette-bg)]',
          )}
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        >
          <header className="flex shrink-0 items-center justify-between border-b border-[var(--cmd-palette-border)] px-5 py-3.5">
            <div>
              <Dialog.Title className="text-15 font-medium text-[var(--settings-section-title)]">
                {t('scheduler.codexImport.title')}
              </Dialog.Title>
              <p className="mt-1 text-11 text-[var(--settings-section-desc)]">
                {t('scheduler.codexImport.description')}
              </p>
            </div>
            <Dialog.Close asChild>
              <button
                type="button"
                aria-label={t('scheduler.button.close')}
                className="flex h-7 w-7 items-center justify-center rounded-lg text-[var(--settings-section-desc)] hover:bg-[var(--settings-input-bg)]"
              >
                <X size={15} />
              </button>
            </Dialog.Close>
          </header>

          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
            {loading && (
              <div className="flex items-center justify-center gap-2 py-12 text-sm text-[var(--settings-section-desc)]">
                <Loader2 size={16} className="animate-spin" />
                {t('scheduler.codexImport.loading')}
              </div>
            )}
            {!loading && items.length === 0 && (
              <div className="py-12 text-center text-sm text-[var(--settings-section-desc)]">
                <p>
                  {loadError
                    ? t('scheduler.codexImport.loadFailed', { error: loadError })
                    : t('scheduler.codexImport.empty')}
                </p>
                {loadError && (
                  <button
                    type="button"
                    className="mt-2 underline"
                    onClick={() => onOpenChange(false)}
                  >
                    {t('scheduler.button.close')}
                  </button>
                )}
              </div>
            )}
            {!loading && items.length > 0 && (
              <div className="flex flex-col gap-2">
                <div className="flex items-center justify-between px-1 pb-1 text-11 text-[var(--settings-section-desc)]">
                  <span>{t('scheduler.codexImport.available', { count: importableCount })}</span>
                  <button
                    type="button"
                    onClick={toggleAll}
                    disabled={importing || importableCount === 0}
                    className="text-[var(--settings-section-title)] underline decoration-dotted underline-offset-2 disabled:opacity-50"
                  >
                    {checked.size === importableCount
                      ? t('scheduler.codexImport.clearAll')
                      : t('scheduler.codexImport.selectAll')}
                  </button>
                </div>
                {items.map((item) => {
                  const blocked = !item.canImport || Boolean(item.duplicate);
                  const isExpanded = expanded.has(item.id);
                  return (
                    <div
                      key={item.id}
                      className={cn(
                        'rounded-lg border p-3',
                        blocked
                          ? 'border-[var(--cmd-palette-border)] opacity-75'
                          : 'border-[var(--settings-theme-card-border)]',
                      )}
                    >
                      <div className="flex items-start gap-3">
                        <input
                          type="checkbox"
                          aria-label={item.name}
                          className="mt-1 h-4 w-4 accent-[var(--lightbox-cta-bg)]"
                          checked={checked.has(item.id)}
                          disabled={blocked || importing}
                          onChange={(event) => toggle(item.id, event.target.checked)}
                        />
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="truncate text-13 font-medium text-[var(--settings-section-title)]">
                              {item.name}
                            </span>
                            <span className="rounded bg-[var(--chat-input-chip-bg)] px-1.5 py-0.5 text-10 text-[var(--cmd-palette-item-meta)]">
                              {item.rrule || 'RRULE ?'}
                            </span>
                            {item.duplicate && (
                              <span className="text-10 text-amber-500">
                                {t('scheduler.codexImport.duplicate')}
                              </span>
                            )}
                            {!item.duplicate && item.canImport && (
                              <span className="text-10 text-emerald-500">
                                {t('scheduler.codexImport.importable')}
                              </span>
                            )}
                            {!item.canImport && (
                              <span className="text-10 text-amber-500">
                                {t('scheduler.codexImport.manualRequired')}
                              </span>
                            )}
                          </div>
                          <div className="mt-1 grid grid-cols-1 gap-x-4 gap-y-0.5 text-11 text-[var(--settings-section-desc)] md:grid-cols-2">
                            <span>
                              {t('scheduler.codexImport.status')}: {item.status}
                            </span>
                            <span>
                              {t('scheduler.codexImport.model')}: {item.model || '—'}
                              {item.reasoningEffort ? ` · ${item.reasoningEffort}` : ''}
                            </span>
                            <span className="truncate">
                              {t('scheduler.codexImport.workingDir')}: {item.cwds[0] || '—'}
                            </span>
                          </div>
                          <button
                            type="button"
                            className="mt-1 text-left text-11 text-[var(--cmd-palette-item-meta)] underline decoration-dotted underline-offset-2"
                            onClick={() =>
                              setExpanded((current) => {
                                const next = new Set(current);
                                if (next.has(item.id)) next.delete(item.id);
                                else next.add(item.id);
                                return next;
                              })
                            }
                          >
                            {isExpanded
                              ? t('scheduler.codexImport.collapsePrompt')
                              : t('scheduler.codexImport.expandPrompt')}
                          </button>
                          {isExpanded && (
                            <pre className="mt-2 max-h-36 overflow-auto whitespace-pre-wrap rounded bg-[var(--settings-input-bg)] p-2 text-11 text-[var(--settings-section-title)]">
                              {item.prompt || '—'}
                            </pre>
                          )}
                          {item.diagnostics.length > 0 && (
                            <div className="mt-2 flex gap-1.5 text-11 text-amber-500">
                              <AlertTriangle size={13} className="mt-0.5 shrink-0" />
                              <div>{item.diagnostics.join('；')}</div>
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
            {result && (
              <div className="mt-4 rounded-lg border border-[var(--settings-theme-card-border)] bg-[var(--settings-input-bg)] p-3 text-12 text-[var(--settings-section-title)]">
                <div className="flex items-center gap-1.5 font-medium">
                  <Check size={14} className="text-emerald-500" />
                  {t('scheduler.codexImport.resultTitle')}
                </div>
                <p className="mt-1 text-[var(--settings-section-desc)]">
                  {t('scheduler.codexImport.resultSummary', {
                    created: result.created.length,
                    skipped: result.skipped.length,
                    failed: result.failed.length,
                  })}
                </p>
              </div>
            )}
          </div>

          <footer className="flex shrink-0 items-center justify-between border-t border-[var(--cmd-palette-border)] px-5 py-3">
            <span className="text-11 text-[var(--settings-section-desc)]">
              {t('scheduler.codexImport.selectionSummary', {
                selected: selectedCount,
                total: importableCount,
              })}
            </span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => handleOpenChange(false)}
                className="rounded-lg px-3 py-1.5 text-12 text-[var(--settings-section-desc)] hover:bg-[var(--settings-input-bg)]"
              >
                {t('scheduler.button.close')}
              </button>
              <button
                type="button"
                disabled={selectedCount === 0 || importing || loading}
                onClick={() => void runImport()}
                className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--lightbox-cta-bg)] px-3.5 py-1.5 text-12 font-medium text-[var(--lightbox-cta-fg)] disabled:cursor-not-allowed disabled:opacity-50"
              >
                {importing && <Loader2 size={13} className="animate-spin" />}
                {t('scheduler.codexImport.importSelected', { count: selectedCount })}
              </button>
            </div>
          </footer>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
