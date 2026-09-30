import { useEffect, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { FormField } from '@/components/ui/form-field';
import { Textarea } from '@/components/ui/input';
import {
  getDataOwnerGeneration,
  isDataOwnerGenerationCurrent,
} from '@/contexts/dataOwnerGeneration';
import { isSelectableVendor } from '@/lib/agentVendors';
import { CindyMakePreflightDialog, type CindyMakePreflightProps } from './CindyMakePreflightDialog';

const MAX_REQUEST_LENGTH = 4000;

export function CindyMakeCreateDialog({ onOpenChange }: { onOpenChange: (open: boolean) => void }) {
  const { t } = useTranslation();
  const [preflight, setPreflight] = useState<Omit<CindyMakePreflightProps, 'onOpenChange'> | null>(
    null,
  );
  const [request, setRequest] = useState('');
  const [starting, setStarting] = useState(false);
  const [failed, setFailed] = useState(false);
  const submitting = useRef(false);
  const mounted = useRef(true);
  const owner = useRef(getDataOwnerGeneration());
  const returnFocusRef = useRef(
    document.activeElement instanceof HTMLElement ? document.activeElement : null,
  );
  const valid = request.trim().length > 0 && request.length <= MAX_REQUEST_LENGTH;

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
        request,
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
        <Dialog.Overlay className="fixed inset-0 z-[10000] bg-[var(--overlay-modal)]" />
        <Dialog.Content
          onPointerDownOutside={(event) => event.preventDefault()}
          className="fixed left-1/2 top-1/2 z-[10001] flex max-h-[85vh] w-[min(460px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-y-auto rounded-xl bg-[var(--confirm-bg)] p-4 shadow-[var(--confirm-shadow)] outline-none"
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            if (returnFocusRef.current?.isConnected) returnFocusRef.current.focus();
          }}
          onEscapeKeyDown={(event) => {
            if (event.isComposing || event.keyCode === 229) event.preventDefault();
          }}
        >
          <Dialog.Title className="text-16 font-semibold text-[var(--confirm-title)]">
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
                <Textarea
                  {...control}
                  value={request}
                  onChange={(value) => {
                    setRequest(value);
                    setFailed(false);
                  }}
                  placeholder={t('settings.cindyMake.create.placeholder')}
                  rows={5}
                  maxLength={MAX_REQUEST_LENGTH}
                  disabled={starting}
                  className="min-h-[120px] resize-y placeholder:opacity-55"
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
              )}
            </FormField>
            {failed && (
              <p role="alert" className="text-13 text-[var(--error-fg)]">
                {t('settings.cindyMake.create.failed')}
              </p>
            )}
            <div className="flex flex-wrap justify-end gap-2">
              <Dialog.Close asChild>
                <Button
                  type="button"
                  variant="secondary"
                  size="lg"
                  disabled={starting}
                  palette="confirmation"
                >
                  {t('settings.cindyMake.create.cancel')}
                </Button>
              </Dialog.Close>
              <Button
                type="submit"
                size="lg"
                disabled={!valid}
                loading={starting}
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
