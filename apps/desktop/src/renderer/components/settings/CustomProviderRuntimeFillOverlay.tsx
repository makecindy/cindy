import * as Dialog from '@radix-ui/react-dialog';
import { useRef, type RefObject } from 'react';
import { Check } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';
import {
  RUNTIME_FILL_ENDPOINT_FIELDS,
  runtimeFillFieldHasValue,
  runtimeFillFieldsForToggle,
  runtimeFillHeaderCount,
  runtimeFillModelCount,
  type RuntimeFillDraft,
  type RuntimeFillField,
  type RuntimeFillFieldDiff,
  type RuntimeFillAgent,
  type RuntimeFillTargetState,
} from '@/lib/customProviderRuntimeFill';

export interface RuntimeFillTargetPlan {
  agent: RuntimeFillAgent;
  draft: RuntimeFillDraft;
  diffs: RuntimeFillFieldDiff[];
}

export interface RuntimeFillDialogState {
  source: RuntimeFillAgent;
  sourceDraft: RuntimeFillDraft;
  includeApiKey: boolean;
  oauthPiUnavailable: boolean;
  stage: 'review' | 'confirm';
  targets: RuntimeFillTargetPlan[];
  selected: Partial<Record<RuntimeFillAgent, RuntimeFillField[]>>;
}

interface RuntimeFillSelectionRow {
  key: RuntimeFillField | 'endpointBundle';
  fields: RuntimeFillField[];
  targetState: Exclude<RuntimeFillTargetState, 'same' | 'incompatible'>;
}

const FOCUS_RING =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]';

function runtimeFillUrlSummary(value: string, fallback: string): string {
  const trimmed = value.trim();
  if (!trimmed) return fallback;
  try {
    const url = new URL(trimmed);
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString().replace(/\/$/, '') || fallback;
  } catch {
    // Avoid echoing an unfinished string that may contain token-like URL material.
    return fallback;
  }
}

function runtimeFillRequestPathSummary(value: string, fallback: string): string {
  const trimmed = value.trim();
  if (!trimmed) return fallback;
  try {
    return new URL(trimmed, 'https://runtime.invalid').pathname || fallback;
  } catch {
    // An invalid draft may still contain a query token. Never reflect it into the DOM.
    return fallback;
  }
}

function selectionRows(diffs: RuntimeFillFieldDiff[]): RuntimeFillSelectionRow[] {
  const actionable = diffs.filter(
    (diff): diff is RuntimeFillFieldDiff & { targetState: 'empty' | 'conflict' } =>
      diff.targetState === 'empty' || diff.targetState === 'conflict',
  );
  const endpointDiffs = actionable.filter((diff) =>
    (RUNTIME_FILL_ENDPOINT_FIELDS as readonly RuntimeFillField[]).includes(diff.field),
  );
  const implicitClearDiffs = actionable.filter((diff) => diff.implicitClear === true);
  const rows: RuntimeFillSelectionRow[] = [];
  if (endpointDiffs.length > 0 || implicitClearDiffs.length > 0) {
    const anchor = endpointDiffs[0]?.field ?? implicitClearDiffs[0].field;
    rows.push({
      key: 'endpointBundle',
      fields: runtimeFillFieldsForToggle(anchor, diffs),
      targetState: [...endpointDiffs, ...implicitClearDiffs].some(
        (diff) => diff.targetState === 'conflict',
      )
        ? 'conflict'
        : 'empty',
    });
  }
  for (const diff of actionable) {
    if ((RUNTIME_FILL_ENDPOINT_FIELDS as readonly RuntimeFillField[]).includes(diff.field))
      continue;
    if (diff.implicitClear === true) continue;
    rows.push({ key: diff.field, fields: [diff.field], targetState: diff.targetState });
  }
  return rows;
}

export function CustomProviderRuntimeFillOverlay({
  state,
  runtimeNames,
  returnFocusRef,
  onClose,
  onContinue,
  onBack,
  onToggleField,
  onApply,
}: {
  state: RuntimeFillDialogState;
  runtimeNames: Record<RuntimeFillAgent, string>;
  returnFocusRef?: RefObject<HTMLButtonElement | null>;
  onClose: () => void;
  onContinue: () => void;
  onBack: () => void;
  onToggleField: (agent: RuntimeFillAgent, field: RuntimeFillField) => void;
  onApply: () => void;
}) {
  const { t } = useTranslation();
  const primaryButtonRef = useRef<HTMLButtonElement>(null);
  const sourceName = runtimeNames[state.source];
  const sourceDraft = state.sourceDraft;
  const hasSelectedOverwrite = state.targets.some((target) =>
    target.diffs.some(
      (diff) =>
        diff.targetState === 'conflict' &&
        (state.selected[target.agent]?.includes(diff.field) ?? false),
    ),
  );
  const hasSelection = state.targets.some(
    (target) => (state.selected[target.agent]?.length ?? 0) > 0,
  );

  const summaryFor = (
    field: RuntimeFillField,
    draft: RuntimeFillDraft,
    agent: RuntimeFillAgent,
  ): string => {
    switch (field) {
      case 'baseUrl':
      case 'modelsUrl':
        return runtimeFillUrlSummary(
          field === 'baseUrl' ? draft.baseUrl : draft.modelsUrl,
          runtimeFillFieldHasValue(field, draft, agent)
            ? t('settings.providers.custom.runtimeFill.values.configured')
            : t('settings.providers.custom.runtimeFill.values.default'),
        );
      case 'requestPath':
        return runtimeFillRequestPathSummary(
          draft.requestPath,
          t('settings.providers.custom.runtimeFill.values.default'),
        );
      case 'wireProtocol':
        return draft.wireProtocol;
      case 'apiKey':
        return runtimeFillFieldHasValue(field, draft, agent)
          ? t('settings.providers.custom.runtimeFill.values.secretSet')
          : t('settings.providers.custom.runtimeFill.values.empty');
      case 'models': {
        const count = runtimeFillModelCount(draft);
        return count > 0
          ? t('settings.providers.custom.runtimeFill.values.models', { count })
          : t('settings.providers.custom.runtimeFill.values.empty');
      }
      case 'headers': {
        const count = runtimeFillHeaderCount(draft);
        return count > 0
          ? t('settings.providers.custom.runtimeFill.values.headers', { count })
          : draft.headersState != null
            ? t('settings.providers.custom.runtimeFill.values.secretSet')
          : t('settings.providers.custom.runtimeFill.values.empty');
      }
    }
  };

  const fieldLabel = (field: RuntimeFillField): string =>
    t(`settings.providers.custom.runtimeFill.fields.${field}`);

  const incompatibleSummary = (
    diff: RuntimeFillFieldDiff,
    targetName: string,
  ): string =>
    t(
      diff.incompatibilityReason === 'protocol'
        ? 'settings.providers.custom.runtimeFill.incompatibleProtocol'
        : diff.incompatibilityReason === 'headers'
          ? 'settings.providers.custom.runtimeFill.incompatibleHeaders'
          : 'settings.providers.custom.runtimeFill.incompatibleEndpoint',
      { target: targetName },
    );

  return (
    <Dialog.Root open onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay
          className={cn(
            'fixed inset-0 z-[10001] bg-[var(--overlay-modal)]',
            'data-[state=open]:animate-confirm-overlay-in data-[state=closed]:animate-confirm-overlay-out',
          )}
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        />
        <Dialog.Content
          aria-describedby="custom-provider-runtime-fill-description"
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            primaryButtonRef.current?.focus();
          }}
          onCloseAutoFocus={(event) => {
            if (!returnFocusRef?.current) return;
            event.preventDefault();
            returnFocusRef.current.focus();
          }}
          className={cn(
            'fixed left-1/2 top-1/2 z-[10001] -translate-x-1/2 -translate-y-1/2',
            'flex max-h-[78vh] w-[520px] max-w-[calc(100vw-2rem)] flex-col rounded-xl',
            'border border-[var(--border-default)] bg-[var(--confirm-bg)]',
            'shadow-[var(--confirm-shadow)] outline-none',
            'data-[state=open]:animate-confirm-content-in data-[state=closed]:animate-confirm-content-out',
          )}
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        >
          <div className="px-5 pb-2 pt-4">
            <Dialog.Title className="text-15 font-semibold text-[var(--settings-section-title)]">
              {state.stage === 'review'
                ? t('settings.providers.custom.runtimeFill.reviewTitle')
                : t('settings.providers.custom.runtimeFill.confirmTitle')}
            </Dialog.Title>
            <Dialog.Description
              id="custom-provider-runtime-fill-description"
              className="mt-0.5 text-12 leading-snug text-[var(--text-tertiary)]"
            >
              {state.stage === 'review'
                ? t('settings.providers.custom.runtimeFill.reviewSubtitle')
                : t('settings.providers.custom.runtimeFill.confirmSubtitle', {
                    source: sourceName,
                  })}
            </Dialog.Description>
          </div>

          <div className="flex-1 overflow-y-auto px-5 pb-2 pt-2">
            <div
              className="mb-3 flex items-center justify-between gap-3 rounded-[10px] px-3 py-2.5"
              style={{ backgroundColor: 'var(--surface)' }}
            >
              <span className="text-12 text-[var(--text-tertiary)]">
                {t('settings.providers.custom.runtimeFill.source')}
              </span>
              <span className="text-13 font-medium text-[var(--settings-section-title)]">
                {sourceName}
              </span>
            </div>

            {state.oauthPiUnavailable && (
              <p className="mb-3 rounded-[10px] border border-[var(--border-default)] px-3 py-2.5 text-11 leading-[1.5] text-[var(--text-tertiary)]">
                {t('settings.providers.custom.runtimeFill.oauthPiUnavailable')}
              </p>
            )}

            <div className="flex flex-col gap-4">
              {state.targets.map((target) => {
                const targetName = runtimeNames[target.agent];
                const conflictCount = target.diffs.filter(
                  (diff) => diff.targetState === 'conflict',
                ).length;
                const actionableCount = target.diffs.filter(
                  (diff) => diff.targetState === 'empty' || diff.targetState === 'conflict',
                ).length;
                const incompatibleCount = target.diffs.filter(
                  (diff) => diff.targetState === 'incompatible',
                ).length;
                const rows = selectionRows(target.diffs);
                return (
                  <section key={target.agent} className="flex flex-col gap-2.5">
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <h4 className="truncate text-13 font-medium text-[var(--settings-section-title)]">
                          {targetName}
                        </h4>
                        <p className="mt-0.5 text-11 text-[var(--text-tertiary)]">
                          {actionableCount === 0 && incompatibleCount > 0
                            ? t('settings.providers.custom.runtimeFill.targetIncompatible', {
                                count: incompatibleCount,
                              })
                            : conflictCount > 0
                              ? t('settings.providers.custom.runtimeFill.targetConflict', {
                                  count: conflictCount,
                                })
                              : t('settings.providers.custom.runtimeFill.targetReady', {
                                  count: actionableCount,
                                })}
                        </p>
                      </div>
                      <span className="shrink-0 text-11 font-medium text-[var(--text-secondary)]">
                        {actionableCount === 0 && incompatibleCount > 0
                          ? t('settings.providers.custom.runtimeFill.status.incompatible')
                          : conflictCount > 0
                            ? t('settings.providers.custom.runtimeFill.status.needsConfirm')
                            : t('settings.providers.custom.runtimeFill.status.ready')}
                      </span>
                    </div>

                    {state.stage === 'review' ? (
                      <div className="overflow-hidden rounded-[10px] border border-[var(--border-default)]">
                        <div
                          className="grid grid-cols-[0.8fr_1fr_1fr] gap-2 px-3 py-2 text-10 text-[var(--text-tertiary)]"
                          style={{ backgroundColor: 'var(--surface)' }}
                        >
                          <span>{t('settings.providers.custom.runtimeFill.columns.field')}</span>
                          <span>{t('settings.providers.custom.runtimeFill.columns.source')}</span>
                          <span>{t('settings.providers.custom.runtimeFill.columns.target')}</span>
                        </div>
                        {target.diffs.map((diff) => {
                          const sourceSummary = summaryFor(diff.field, sourceDraft, state.source);
                          const targetSummary = summaryFor(diff.field, target.draft, target.agent);
                          return (
                            <div
                              key={diff.field}
                              className="grid grid-cols-[0.8fr_1fr_1fr] items-center gap-2 border-t border-[var(--border-default)] px-3 py-2.5 text-11"
                            >
                              <span className="font-medium text-[var(--settings-section-title)]">
                                {fieldLabel(diff.field)}
                              </span>
                              <span
                                className="truncate text-[var(--text-secondary)]"
                                title={sourceSummary}
                              >
                                {sourceSummary}
                              </span>
                              <span
                                className={cn(
                                  'truncate',
                                  diff.targetState === 'same' || diff.targetState === 'incompatible'
                                    ? 'text-[var(--text-tertiary)]'
                                    : 'font-medium text-[var(--settings-section-title)]',
                                )}
                                title={
                                  diff.targetState === 'incompatible'
                                    ? incompatibleSummary(diff, targetName)
                                    : targetSummary
                                }
                              >
                                {diff.targetState === 'incompatible'
                                  ? incompatibleSummary(diff, targetName)
                                  : targetSummary}
                              </span>
                            </div>
                          );
                        })}
                      </div>
                    ) : rows.length > 0 ? (
                      <div className="flex flex-col gap-1.5">
                        {rows.map((row) => {
                          const selected = row.fields.every((field) =>
                            state.selected[target.agent]?.includes(field),
                          );
                          return (
                            <button
                              key={row.key}
                              type="button"
                              role="checkbox"
                              aria-checked={selected}
                              onClick={() => onToggleField(target.agent, row.fields[0])}
                              className={cn(
                                'flex w-full items-center gap-2.5 rounded-[9px] border border-[var(--border-default)] px-3 py-2.5 text-left transition-colors hover:bg-[var(--surface-hover)] active:scale-[0.98]',
                                FOCUS_RING,
                              )}
                            >
                              <span
                                className={cn(
                                  'flex h-4 w-4 shrink-0 items-center justify-center rounded-[4px] border transition-colors',
                                  selected
                                    ? 'border-[var(--settings-input-border-focus)] bg-[var(--surface-elevated)] text-[var(--settings-section-title)]'
                                    : 'border-[var(--settings-input-border)] text-transparent',
                                )}
                              >
                                <Check size={12} strokeWidth={3} />
                              </span>
                              <span className="min-w-0 flex-1">
                                <span className="block text-12 font-medium text-[var(--settings-section-title)]">
                                  {row.key === 'endpointBundle'
                                    ? t(
                                        'settings.providers.custom.runtimeFill.fields.endpointBundle',
                                      )
                                    : fieldLabel(row.key)}
                                </span>
                                <span className="mt-0.5 block truncate text-11 text-[var(--text-tertiary)]">
                                  {row.key === 'apiKey'
                                    ? t('settings.providers.custom.runtimeFill.secretIndependent', {
                                        target: targetName,
                                      })
                                    : row.targetState === 'conflict'
                                      ? t('settings.providers.custom.runtimeFill.overwriteCurrent')
                                      : t('settings.providers.custom.runtimeFill.fillEmpty')}
                                </span>
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    ) : (
                      <p className="text-11 leading-[1.5] text-[var(--text-tertiary)]">
                        {t('settings.providers.custom.runtimeFill.noSelectableFields')}
                      </p>
                    )}

                    <p className="text-11 leading-[1.5] text-[var(--text-tertiary)]">
                      {t('settings.providers.custom.runtimeFill.endpointBundleNote', {
                        target: targetName,
                      })}
                    </p>
                  </section>
                );
              })}
            </div>

            <p className="mt-4 text-11 leading-[1.5] text-[var(--text-tertiary)]">
              {t('settings.providers.custom.runtimeFill.independentNote')}
            </p>
          </div>

          <div className="flex justify-end gap-2.5 px-5 py-3.5">
            <button
              type="button"
              onClick={state.stage === 'review' ? onClose : onBack}
              className={cn(
                'inline-flex items-center justify-center rounded-full border bg-transparent px-5 py-2 text-13 font-medium transition-colors active:scale-[0.98]',
                'border-[var(--confirm-btn-secondary-border)] text-[var(--confirm-btn-secondary-text)] hover:bg-[var(--confirm-btn-secondary-hover)]',
                FOCUS_RING,
              )}
            >
              {state.stage === 'review'
                ? t('settings.providers.custom.cancel')
                : t('settings.providers.custom.runtimeFill.back')}
            </button>
            <button
              ref={primaryButtonRef}
              type="button"
              onClick={state.stage === 'review' ? onContinue : onApply}
              disabled={!hasSelection}
              className={cn(
                'inline-flex items-center justify-center rounded-full px-5 py-2 text-13 font-medium transition-colors active:scale-[0.98]',
                'bg-[var(--confirm-btn-primary-bg)] text-[var(--confirm-btn-primary-text)] hover:bg-[var(--confirm-btn-primary-hover)]',
                FOCUS_RING,
                !hasSelection && 'cursor-not-allowed opacity-50',
              )}
            >
              {state.stage === 'review'
                ? hasSelectedOverwrite
                  ? t('settings.providers.custom.runtimeFill.continue')
                  : t('settings.providers.custom.runtimeFill.apply')
                : t('settings.providers.custom.runtimeFill.applyOverwrite')}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
