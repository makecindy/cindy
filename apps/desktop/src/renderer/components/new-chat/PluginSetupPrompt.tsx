import { AlertCircle, Check, Circle, ExternalLink, LoaderCircle } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { InteractionPromptCardShell } from '@/components/interaction-portal';
import { GhostPluginIcon } from '@/features/plugin/GhostPluginIcon';
import { cn } from '@/lib/utils';
import type {
  PendingPluginSetup,
  PluginSetupCommandInFlight,
  PluginSetupInlineFormValues,
  PluginSetupViewerState,
} from '@/lib/makerChatStore';
import type { GhostSetupStepPhase } from '../../../shared/ghost';

interface PluginSetupPromptProps {
  pending: PendingPluginSetup;
  viewerState: PluginSetupViewerState;
  commandInFlight: PluginSetupCommandInFlight | null;
  remote: boolean;
  onViewerStateChange: (next: PluginSetupViewerState) => void;
  onCommand: (
    requestId: string,
    action: 'run_action' | 'submit_form' | 'cancel',
    actionId?: string,
    values?: PluginSetupInlineFormValues,
  ) => void;
}

const RUNNING_PHASES = new Set<GhostSetupStepPhase>([
  'action_running',
  'verifying',
]);

function isTerminalPhase(phase: GhostSetupStepPhase): boolean {
  return phase === 'satisfied' || phase === 'cancelled';
}

function normalizedCopy(value: string | undefined): string {
  return (value ?? '').trim().replace(/\s+/g, ' ').toLocaleLowerCase();
}

export function PluginSetupPrompt({ pending, ...props }: PluginSetupPromptProps) {
  return (
    <PluginSetupPromptStateful
      key={`${pending.requestId}:${pending.revision}`}
      pending={pending}
      {...props}
    />
  );
}

function PluginSetupPromptStateful({
  pending,
  viewerState,
  commandInFlight,
  remote,
  onViewerStateChange,
  onCommand,
}: PluginSetupPromptProps) {
  const { t } = useTranslation();
  const inputId = useId();
  const [formValues, setFormValues] = useState<Record<string, string>>({});
  const [formTouched, setFormTouched] = useState<Record<string, boolean>>({});
  const [linkOpenFailed, setLinkOpenFailed] = useState<Record<string, boolean>>({});
  const activeOperationStep = pending.steps.find((step) =>
    ['action_running', 'waiting_external', 'verifying'].includes(step.phase),
  );
  const fallbackStep =
    pending.steps.find((step) => step.phase === 'failed') ??
    pending.steps.find((step) => step.phase === 'pending');
  const currentGroupId =
    activeOperationStep?.groupId ??
    fallbackStep?.groupId ??
    pending.steps[pending.steps.length - 1]?.groupId;
  const currentGroupSteps = currentGroupId
    ? pending.steps.filter((step) => step.groupId === currentGroupId)
    : [];
  const currentStep =
    currentGroupSteps.find((step) =>
      ['action_running', 'waiting_external', 'verifying'].includes(step.phase),
    ) ??
    currentGroupSteps.find((step) => step.phase === 'failed') ??
    currentGroupSteps.find((step) => step.phase === 'pending') ??
    currentGroupSteps[currentGroupSteps.length - 1] ??
    pending.steps[pending.steps.length - 1];
  const allSatisfied =
    pending.steps.length > 0 && pending.steps.every((step) => step.phase === 'satisfied');
  const cancelledTerminal =
    pending.steps.some((step) => step.phase === 'cancelled') &&
    pending.steps.every((step) => isTerminalPhase(step.phase));
  const terminal = allSatisfied || cancelledTerminal;
  const busy = !!commandInFlight || (!!currentStep && RUNNING_PHASES.has(currentStep.phase));
  const title = t('newChat.pluginSetup.title', { name: pending.ghost.name });
  const inlineFormAction = currentStep?.action?.kind === 'inline_form' ? currentStep.action : null;
  const inlineFormField = inlineFormAction?.form.fields[0];
  const compactInlineForm = pending.steps.length === 1 && !!currentStep && !!inlineFormField;
  const hasCurrentGroupAlternatives = currentGroupSteps.length > 1;
  const groupStepCounts = pending.steps.reduce<Map<string, number>>((counts, step) => {
    counts.set(step.groupId, (counts.get(step.groupId) ?? 0) + 1);
    return counts;
  }, new Map());
  const isAlternativeStep = (step: PendingPluginSetup['steps'][number]): boolean =>
    step.groupMode === 'any_of' && (groupStepCounts.get(step.groupId) ?? 0) > 1;
  const flatStepList =
    pending.steps.length === 1 ||
    (pending.steps.length > 1 && pending.steps.every((step) => isAlternativeStep(step)));
  const inlineLead = compactInlineForm
    ? pending.intro?.trim() || currentStep.description.trim() || undefined
    : undefined;
  const currentFormValue = inlineFormAction ? (formValues[inlineFormAction.id] ?? '') : '';
  const normalizedFormValue = currentFormValue.trim();
  const formValueMissing = !!inlineFormField?.required && normalizedFormValue.length === 0;
  const formValueTooLong =
    !!inlineFormField && normalizedFormValue.length > inlineFormField.maxLength;

  useEffect(() => {
    if (!inlineFormAction) return;
    setFormTouched((touched) => ({ ...touched, [inlineFormAction.id]: false }));
    setLinkOpenFailed((failed) => ({ ...failed, [inlineFormAction.id]: false }));
  }, [inlineFormAction?.id]);

  const phaseLabel = (phase: GhostSetupStepPhase): string =>
    t(`newChat.pluginSetup.phase.${phase}`);
  const stepErrorMessage = (step: PendingPluginSetup['steps'][number]): string | undefined =>
    step.errorCode ? t(`newChat.pluginSetup.error.${step.errorCode}`) : step.errorMessage;
  const currentStepErrorMessage = currentStep ? stepErrorMessage(currentStep) : undefined;

  const actionLabel = (step = currentStep): string => {
    if (!step) return '';
    if (commandInFlight?.action === 'cancel') return t('newChat.pluginSetup.cancelling');
    if (commandInFlight?.action === 'submit_form' && commandInFlight.actionId === step.action?.id) {
      return t('newChat.pluginSetup.saving');
    }
    if (commandInFlight?.action === 'run_action' && commandInFlight.actionId === step.action?.id) {
      return t('newChat.pluginSetup.phase.action_running');
    }
    if (step.action?.kind === 'inline_form') {
      if (step.phase === 'action_running') return t('newChat.pluginSetup.saving');
      if (step.phase === 'verifying') return t('newChat.pluginSetup.phase.verifying');
      return t('newChat.pluginSetup.saveConfiguration');
    }
    if (step.phase === 'failed') return t('newChat.pluginSetup.retry');
    if (step.phase === 'waiting_external' && step.action) {
      return t(`newChat.pluginSetup.action.${step.action.kind}`);
    }
    if (step.phase !== 'pending') return phaseLabel(step.phase);
    if (!step.action) return phaseLabel(step.phase);
    return t(`newChat.pluginSetup.action.${step.action.kind}`);
  };

  const minimizedStatus = allSatisfied
    ? t('newChat.pluginSetup.phase.satisfied')
    : cancelledTerminal
      ? t('newChat.pluginSetup.phase.cancelled')
      : currentStep
        ? phaseLabel(currentStep.phase)
        : undefined;

  const inlineFormContext = (step: PendingPluginSetup['steps'][number]) => {
    const action = step.action?.kind === 'inline_form' ? step.action : null;
    const field = action?.form.fields[0];
    if (!action || !field) return null;
    const fieldInputId = `${inputId}-${step.id.replace(/[^a-zA-Z0-9_-]/g, '-')}`;
    const fieldHintId = `${fieldInputId}-hint`;
    const fieldErrorId = `${fieldInputId}-error`;
    const value = formValues[action.id] ?? '';
    const normalizedValue = value.trim();
    const missing = field.required && normalizedValue.length === 0;
    const tooLong = normalizedValue.length > field.maxLength;
    const error = formTouched[action.id]
      ? missing
        ? t('newChat.pluginSetup.form.required', { label: field.label })
        : tooLong
          ? t('newChat.pluginSetup.form.tooLong', { maxLength: field.maxLength })
          : null
      : null;
    const descriptionCandidates = isAlternativeStep(step)
      ? [step.description, field.description]
      : [field.description];
    const visibleDescription = descriptionCandidates
      .map((candidate) => candidate?.trim())
      .find(
        (candidate, index) =>
          candidate &&
          ![
            pending.intro,
            step.title,
            compactInlineForm ? inlineLead : undefined,
            index > 0 ? step.description : undefined,
          ].some(
            (duplicate) =>
              normalizedCopy(duplicate) !== '' &&
              normalizedCopy(duplicate) === normalizedCopy(candidate),
          ),
      );
    return {
      action,
      field,
      fieldInputId,
      fieldHintId,
      fieldErrorId,
      value,
      missing,
      tooLong,
      error,
      visibleDescription,
    };
  };

  const submitStepAction = (step: PendingPluginSetup['steps'][number]) => {
    if (!step.action || remote || busy || terminal) return;
    if (step.action.kind !== 'inline_form') {
      onCommand(pending.requestId, 'run_action', step.action.id);
      return;
    }
    const context = inlineFormContext(step);
    if (!context) return;
    setFormTouched((touched) => ({ ...touched, [context.action.id]: true }));
    if (context.missing || context.tooLong) return;
    onCommand(pending.requestId, 'submit_form', context.action.id, {
      value: context.value,
    });
    // Secret values live only in this component and are dropped immediately
    // after handoff to the local-only preload API.
    setFormValues((values) => {
      const next = { ...values };
      delete next[context.action.id];
      return next;
    });
    setFormTouched((touched) => ({ ...touched, [context.action.id]: false }));
  };

  const cancelSetup = () => {
    setFormValues({});
    setFormTouched({});
    onCommand(pending.requestId, 'cancel');
  };

  const openCredentialPage = async (step: PendingPluginSetup['steps'][number]) => {
    const context = inlineFormContext(step);
    const url = context?.field.externalLink?.url;
    if (!url || remote || busy || terminal) return;
    setLinkOpenFailed((failed) => ({ ...failed, [context.action.id]: false }));
    try {
      const result = await window.electronAPI.openExternal(url);
      if (!result.success) {
        setLinkOpenFailed((failed) => ({ ...failed, [context.action.id]: true }));
      }
    } catch {
      setLinkOpenFailed((failed) => ({ ...failed, [context.action.id]: true }));
    }
  };

  const renderInlineFormControl = (
    step: PendingPluginSetup['steps'][number],
    showLabel: boolean,
    showSubmit: boolean,
  ) => {
    const context = inlineFormContext(step);
    if (!context) return null;
    const { action, field } = context;
    return (
      <div className="flex flex-col gap-2">
        {showLabel ? (
          <label
            htmlFor={context.fieldInputId}
            className="text-13 font-medium text-[var(--ask-option-label)]"
          >
            {field.label}
          </label>
        ) : null}
        <div className="flex items-center gap-2">
          <input
            id={context.fieldInputId}
            type="password"
            autoComplete="new-password"
            spellCheck={false}
            autoFocus={!hasCurrentGroupAlternatives && !remote && !busy && !terminal}
            value={context.value}
            maxLength={field.maxLength}
            disabled={remote || busy || terminal}
            placeholder={
              field.placeholder ||
              t('newChat.pluginSetup.form.placeholder', {
                label: field.label,
              })
            }
            aria-describedby={
              [
                context.error
                  ? context.fieldErrorId
                  : context.visibleDescription
                    ? context.fieldHintId
                    : null,
                linkOpenFailed[action.id] ? `${context.fieldInputId}-link-error` : null,
              ]
                .filter(Boolean)
                .join(' ') || undefined
            }
            aria-invalid={context.error ? 'true' : undefined}
            onChange={(event) => {
              const value = event.target.value;
              setFormValues((values) => ({ ...values, [action.id]: value }));
            }}
            onBlur={() => setFormTouched((touched) => ({ ...touched, [action.id]: true }))}
            onKeyDown={(event) => {
              if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) {
                return;
              }
              event.preventDefault();
              submitStepAction(step);
            }}
            className={cn(
              'h-9 min-w-0 flex-1 rounded-[9999px] border bg-[var(--surface-elevated)] px-3',
              'text-14 text-[var(--text-primary)] placeholder:text-[var(--text-placeholder)]',
              'outline-none transition-colors focus-visible:border-[var(--focus-ring)] focus-visible:ring-2 focus-visible:ring-[var(--focus-ring-soft)]',
              context.error ? 'border-[var(--error-border)]' : 'border-[var(--border-default)]',
              (remote || busy || terminal) &&
                'cursor-not-allowed bg-[var(--surface-elevated-soft)] text-[var(--text-disabled)]',
            )}
          />
          {showSubmit ? (
            <button
              type="button"
              disabled={remote || busy || context.missing || context.tooLong}
              onClick={() => submitStepAction(step)}
              className={cn(
                'h-9 shrink-0 rounded-[9999px] px-4 text-13 font-medium transition-colors',
                remote || busy || context.missing || context.tooLong
                  ? 'cursor-not-allowed border border-[var(--border-default)] bg-transparent text-[var(--text-disabled-tertiary)] opacity-60'
                  : 'border border-transparent bg-[var(--confirm-btn-primary-bg)] text-[var(--confirm-btn-primary-text)] hover:bg-[var(--confirm-btn-primary-hover)]',
              )}
            >
              {actionLabel(step)}
            </button>
          ) : null}
        </div>
        {context.error || context.visibleDescription || (field.externalLink && !remote) ? (
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
            {context.error ? (
              <p
                id={context.fieldErrorId}
                className="min-w-0 text-12 leading-5 text-[var(--error-fg)]"
              >
                {context.error}
              </p>
            ) : context.visibleDescription ? (
              <p
                id={context.fieldHintId}
                className="min-w-0 text-12 leading-5 text-[var(--ask-option-desc)]"
              >
                {context.visibleDescription}
              </p>
            ) : (
              <span />
            )}
            {field.externalLink && !remote ? (
              <button
                type="button"
                disabled={busy || terminal}
                onClick={() => void openCredentialPage(step)}
                className={cn(
                  'inline-flex shrink-0 items-center gap-1 text-12 font-medium',
                  'text-[var(--ask-option-label)] underline-offset-4 transition-opacity hover:underline',
                  'focus-visible:rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring-soft)]',
                  (busy || terminal) && 'cursor-not-allowed opacity-40 hover:no-underline',
                )}
              >
                {t('newChat.pluginSetup.form.openLink', { label: field.label })}
                <ExternalLink aria-hidden="true" size={12} strokeWidth={1.75} />
              </button>
            ) : null}
          </div>
        ) : null}
        {linkOpenFailed[action.id] ? (
          <p
            id={`${context.fieldInputId}-link-error`}
            className="text-12 leading-5 text-[var(--error-fg)]"
          >
            {t('newChat.pluginSetup.form.openLinkFailed')}
          </p>
        ) : null}
      </div>
    );
  };

  const submitCurrentAction = () => {
    if (currentStep) submitStepAction(currentStep);
  };

  const footer = (
    <div className="flex items-center gap-2">
      {currentStep?.action && !terminal && !hasCurrentGroupAlternatives ? (
        <button
          type="button"
          disabled={
            remote || busy || (!!inlineFormAction && (formValueMissing || formValueTooLong))
          }
          onClick={submitCurrentAction}
          className={cn(
            'h-9 rounded-[9999px] px-[18px] text-13 font-medium transition-colors',
            remote || busy || (!!inlineFormAction && (formValueMissing || formValueTooLong))
              ? 'cursor-not-allowed border border-[var(--border-default)] bg-transparent text-[var(--text-disabled-tertiary)] opacity-60'
              : 'border border-transparent bg-[var(--confirm-btn-primary-bg)] text-[var(--confirm-btn-primary-text)] hover:bg-[var(--confirm-btn-primary-hover)]',
          )}
        >
          <span className="flex items-center gap-[7px]">
            {busy ? (
              <span className="inline-flex animate-spin motion-reduce:animate-none">
                <LoaderCircle aria-hidden="true" size={14} />
              </span>
            ) : null}
            {actionLabel()}
          </span>
        </button>
      ) : null}
      {!terminal ? (
        <button
          type="button"
          disabled={!!commandInFlight}
          onClick={cancelSetup}
          className={cn(
            'h-9 rounded-[9999px] border border-[var(--confirm-btn-secondary-border)] bg-transparent px-[18px] text-13 font-medium text-[var(--confirm-btn-secondary-text)] transition-colors',
            commandInFlight
              ? 'cursor-not-allowed opacity-50'
              : 'hover:bg-[var(--confirm-btn-secondary-hover)]',
          )}
        >
          {t('newChat.pluginSetup.cancel')}
        </button>
      ) : null}
    </div>
  );

  return (
    <InteractionPromptCardShell
      viewerState={viewerState}
      onViewerStateChange={onViewerStateChange}
      collapsible={false}
      minimizedTitle={title}
      minimizedMeta={minimizedStatus}
      restoreAriaLabel={t('newChat.pluginSetup.restoreAria', { name: pending.ghost.name })}
      minimizeAriaLabel={t('newChat.pluginSetup.minimizeAria', { name: pending.ghost.name })}
      headerLeading={
        <div className="flex min-w-0 items-center gap-[10px]">
          <span className="h-6 w-6 shrink-0">
            <GhostPluginIcon
              iconId={pending.ghost.id}
              iconName={pending.ghost.name}
              iconDataUrl={pending.ghost.iconDataUrl}
              size="mini"
            />
          </span>
          <span className="truncate text-14 font-semibold text-[var(--ask-header-text)]">
            {title}
          </span>
        </div>
      }
      footer={footer}
    >
      <div className="flex flex-col gap-[10px]" role="status" aria-live="polite" aria-label={title}>
        {!compactInlineForm && pending.intro ? (
          <p className="text-14 leading-5 text-[var(--ask-option-desc)]">{pending.intro}</p>
        ) : null}

        {remote && !terminal ? (
          <div className="rounded-[12px] border border-[var(--ask-option-border)] bg-[var(--ask-option-list-bg)] px-3 py-2.5 text-13 text-[var(--ask-option-desc)]">
            {t('newChat.pluginSetup.completeOnDesktop')}
          </div>
        ) : null}

        {compactInlineForm && currentStep && inlineFormField ? (
          <div className="flex flex-col gap-2">
            {inlineLead ? (
              <p className="text-14 leading-5 text-[var(--ask-option-desc)]">{inlineLead}</p>
            ) : null}
            <div>
              <div className="mb-[6px]">
                <label
                  htmlFor={inlineFormContext(currentStep)?.fieldInputId}
                  className="min-w-0 text-13 font-medium text-[var(--ask-option-label)]"
                >
                  {inlineFormField.label}
                </label>
              </div>
              {renderInlineFormControl(currentStep, false, false)}
              {currentStepErrorMessage ? (
                <p className="mt-2 text-13 leading-5 text-[var(--error-fg)]">
                  {currentStepErrorMessage}
                </p>
              ) : null}
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {hasCurrentGroupAlternatives && !pending.intro ? (
              <p className="text-13 leading-5 text-[var(--ask-option-desc)]">
                {t('newChat.pluginSetup.chooseOne')}
              </p>
            ) : null}
            <ol
              data-testid="plugin-setup-step-list"
              className={cn(
                flatStepList
                  ? 'overflow-hidden'
                  : 'overflow-hidden rounded-[12px] border border-[var(--ask-option-border)] bg-[var(--ask-option-list-bg)]',
              )}
            >
              {pending.steps.map((step, index) => {
                const running = RUNNING_PHASES.has(step.phase);
                const failed = step.phase === 'failed';
                const satisfied = step.phase === 'satisfied';
                const errorMessage = stepErrorMessage(step);
                const alternativeStep = isAlternativeStep(step);
                const currentGroupOption = step.groupId === currentGroupId;
                const inlineOption = currentGroupOption && step.action?.kind === 'inline_form';
                const directActionOption =
                  currentGroupOption &&
                  hasCurrentGroupAlternatives &&
                  step.action &&
                  step.action.kind !== 'inline_form' &&
                  (step.phase === 'pending' || step.phase === 'failed');
                return (
                  <li
                    key={step.id}
                    className={cn(
                      'flex py-2.5',
                      !flatStepList && 'gap-2.5 px-3',
                      flatStepList && !alternativeStep && 'gap-2.5',
                      index > 0 && 'border-t border-[var(--ask-option-divider)]',
                    )}
                  >
                    {!alternativeStep ? (
                      <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center text-[var(--ask-page-text)]">
                        {satisfied ? (
                          <Check aria-hidden="true" size={16} />
                        ) : failed ? (
                          <AlertCircle aria-hidden="true" size={16} />
                        ) : running ? (
                          <span className="inline-flex animate-spin motion-reduce:animate-none">
                            <LoaderCircle aria-hidden="true" size={16} />
                          </span>
                        ) : (
                          <Circle aria-hidden="true" size={14} />
                        )}
                      </span>
                    ) : null}
                    <div className="min-w-0 flex-1">
                      <div className="flex items-start justify-between gap-2.5">
                        {inlineOption ? (
                          <label
                            htmlFor={inlineFormContext(step)?.fieldInputId}
                            className="text-14 font-medium text-[var(--ask-option-label)]"
                          >
                            {step.title}
                          </label>
                        ) : (
                          <span className="text-14 font-medium text-[var(--ask-option-label)]">
                            {step.title}
                          </span>
                        )}
                        {!flatStepList ? (
                          <span className="shrink-0 text-12 text-[var(--ask-page-text)]">
                            {phaseLabel(step.phase)}
                          </span>
                        ) : null}
                      </div>
                      {step.description && !inlineOption ? (
                        <p className="mt-0.5 text-12 leading-4 text-[var(--ask-option-desc)]">
                          {step.description}
                        </p>
                      ) : null}
                      {inlineOption ? (
                        <div className="mt-2">
                          {renderInlineFormControl(step, false, hasCurrentGroupAlternatives)}
                        </div>
                      ) : null}
                      {directActionOption ? (
                        <button
                          type="button"
                          disabled={remote || busy || terminal}
                          onClick={() => submitStepAction(step)}
                          className={cn(
                            'mt-2 h-9 rounded-[9999px] px-4 text-13 font-medium transition-colors',
                            remote || busy || terminal
                              ? 'cursor-not-allowed border border-[var(--border-default)] bg-transparent text-[var(--text-disabled-tertiary)] opacity-60'
                              : 'border border-transparent bg-[var(--confirm-btn-primary-bg)] text-[var(--confirm-btn-primary-text)] hover:bg-[var(--confirm-btn-primary-hover)]',
                          )}
                        >
                          {actionLabel(step)}
                        </button>
                      ) : null}
                      {errorMessage ? (
                        <p className="mt-1 text-13 leading-5 text-[var(--error-fg)]">
                          {errorMessage}
                        </p>
                      ) : null}
                    </div>
                  </li>
                );
              })}
            </ol>
          </div>
        )}
      </div>
    </InteractionPromptCardShell>
  );
}
