import { ErrorNotice } from '@/components/ui/error-notice';
import { useEffect, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { FormField } from '@/components/ui/form-field';
import { cn } from '@/lib/utils';
import {
  getDataOwnerGeneration,
  isDataOwnerGenerationCurrent,
} from '@/contexts/dataOwnerGeneration';
import { isSelectableVendor } from '@/lib/agentVendors';
import { FieldVoiceInputNotice } from '@/voice-input/FieldVoiceInputNotice';
import { useFieldVoiceInput } from '@/voice-input/useFieldVoiceInput';
import { VoiceInputButton } from '@/voice-input/VoiceInputButton';
import { CindyMakePreflightDialog, type CindyMakePreflightProps } from './CindyMakePreflightDialog';

const MAX_REQUEST_LENGTH = 4000;

export function CindyMakeCreateDialog({ onOpenChange }: { onOpenChange: (open: boolean) => void }) {
  const { t } = useTranslation();
  const [preflight, setPreflight] = useState<Omit<CindyMakePreflightProps, 'onOpenChange'> | null>(
    null,
  );
  const [request, setRequest] = useState('');
  const [starting, setStarting] = useState(false);
  const [stoppingVoice, setStoppingVoice] = useState(false);
  const [failed, setFailed] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const submitting = useRef(false);
  const mounted = useRef(true);
  const owner = useRef(getDataOwnerGeneration());
  const returnFocusRef = useRef(
    document.activeElement instanceof HTMLElement ? document.activeElement : null,
  );

  const voice = useFieldVoiceInput({
    draftKey: 'cindy-make-create',
    inputRef: textareaRef,
    value: request,
    onChange: (next) => {
      setRequest(next);
      setFailed(false);
    },
    maxLength: MAX_REQUEST_LENGTH,
    active: !preflight,
    disabled: starting,
  });

  const busy = starting || stoppingVoice;
  const valid = voice.displayText.trim().length > 0 && voice.displayText.length <= MAX_REQUEST_LENGTH;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const submit = async () => {
    const isCurrent = () => isDataOwnerGenerationCurrent(owner.current);
    if (!valid || submitting.current) return;
    if (!isCurrent()) {
      onOpenChange(false);
      return;
    }
    submitting.current = true;
    let finalRequest = request;
    if (voice.isBusy) {
      setStoppingVoice(true);
      try {
        finalRequest = await voice.stop();
      } finally {
        if (mounted.current) setStoppingVoice(false);
      }
      if (!mounted.current || !isCurrent()) {
        submitting.current = false;
        if (mounted.current && !isCurrent()) onOpenChange(false);
        return;
      }
      if (!finalRequest.trim() || finalRequest.length > MAX_REQUEST_LENGTH) {
        submitting.current = false;
        return;
      }
    }
    setStarting(true);
    setFailed(false);
    try {
      const draftState = await import('@/state/newMakerDraft');
      if (!isCurrent()) return;
      const draft = draftState.getDraft();
      const vendor = isSelectableVendor(draft.vendor) ? draft.vendor : 'cc';
      const prefs = draft.lastByVendor[vendor];
      if (!mounted.current) return;
      setPreflight({
        request: finalRequest,
        createOptions: {
          agentKind: vendor,
          model: prefs.model,
          effort: prefs.effort,
          permissionMode: prefs.permissionMode,
          providerId: prefs.providerId,
          fastMode: draftState.getFastModeForModel(prefs.model),
          planModeEnabled: prefs.planMode,
        },
      });
    } catch {
      if (mounted.current && isCurrent()) setFailed(true);
    } finally {
      submitting.current = false;
      if (mounted.current) {
        setStarting(false);
        if (!isCurrent()) onOpenChange(false);
      }
    }
  };

  if (preflight) return <CindyMakePreflightDialog {...preflight} onOpenChange={onOpenChange} />;

  return (
    <Dialog.Root open onOpenChange={(open) => !submitting.current && onOpenChange(open)}>
      <Dialog.Portal>
        <Dialog.Overlay className="modal-scrim fixed inset-0 z-modal" />
        <Dialog.Content
          onPointerDownOutside={(event) => event.preventDefault()}
          className="modal-panel fixed left-1/2 top-1/2 z-modal-raised flex max-h-[85vh] w-[min(460px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-y-auto p-4 outline-none"
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            if (returnFocusRef.current?.isConnected) returnFocusRef.current.focus();
          }}
          onEscapeKeyDown={(event) => {
            if (event.isComposing || event.keyCode === 229 || voice.isBusy || submitting.current) {
              event.preventDefault();
            }
          }}
        >
          <Dialog.Title className="text-16 font-medium text-[var(--confirm-title)]">
            {t('settings.cindyMake.create.title')}
          </Dialog.Title>
          <Dialog.Description className="mt-2 text-13 leading-relaxed text-[var(--confirm-desc)]">
            {t('settings.cindyMake.create.description')}
          </Dialog.Description>
          <form
            className="mt-4 flex flex-col gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <FormField
              label={t('settings.cindyMake.create.requestLabel')}
              required
              hint={t('settings.cindyMake.create.requestHint', { max: MAX_REQUEST_LENGTH })}
            >
              {(control) => (
                <div className="flex flex-col gap-1.5">
                  <div
                    className={cn(
                      'flex flex-col rounded-lg border border-[var(--border-default)] bg-[var(--surface-elevated)] transition-colors',
                      'focus-within:border-[var(--text-tertiary-stone)] focus-within:ring-2 focus-within:ring-[var(--focus-ring-soft)]',
                      starting && 'opacity-60',
                    )}
                  >
                    <textarea
                      {...control}
                      ref={textareaRef}
                      value={voice.displayText}
                      readOnly={voice.isBusy}
                      onChange={(event) => {
                        setRequest(event.target.value);
                        setFailed(false);
                      }}
                      placeholder={t('settings.cindyMake.create.placeholder')}
                      rows={4}
                      maxLength={MAX_REQUEST_LENGTH}
                      disabled={starting}
                      className="min-h-[96px] w-full resize-y bg-transparent px-3 pt-2 pb-1 text-13 text-[var(--text-primary)] placeholder:text-[var(--text-placeholder)] outline-none disabled:cursor-not-allowed"
                      style={{ userSelect: 'text', WebkitUserSelect: 'text' }}
                      onKeyDown={(event) => {
                        if (
                          event.key === 'Enter' &&
                          (event.metaKey || event.ctrlKey) &&
                          !event.nativeEvent.isComposing
                        ) {
                          event.preventDefault();
                          void submit();
                        }
                      }}
                    />
                    <div className="flex items-center justify-end px-2 pb-2 pt-1">
                      <VoiceInputButton {...voice.buttonProps} testId="cindy-make-create-voice" tipSide="top" />
                    </div>
                  </div>
                  <FieldVoiceInputNotice error={voice.lastError} speakerFiltered={voice.speakerFiltered} />
                </div>
              )}
            </FormField>
            {failed && (
              <ErrorNotice role="alert" message={t('settings.cindyMake.create.failed')} />
            )}
            <div className="flex flex-wrap justify-end gap-2">
              <Dialog.Close asChild>
                <Button
                  type="button"
                  variant="secondary"
                  size="lg"
                  disabled={busy}
                  palette="confirmation"
                >
                  {t('settings.cindyMake.create.cancel')}
                </Button>
              </Dialog.Close>
              <Button
                type="submit"
                size="lg"
                disabled={!valid || busy}
                loading={busy}
                palette="confirmation"
              >
                {t('settings.cindyMake.create.continue')}
              </Button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
