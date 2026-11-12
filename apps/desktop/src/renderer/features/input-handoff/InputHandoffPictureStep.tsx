/**
 * A 代输入 step answered on a screenshot of the target window: the owner taps
 * a spot, and may type into the field that has focus there. It is mounted only
 * while the owner has the dialog open, so the picture is fetched only when
 * asked for. It lives only in this component's state for the current revision;
 * it comes from Main on the executing computer or from the sealed offer for a
 * task on another computer, and is dropped as soon as the step changes.
 */

import { useCallback, useEffect, useRef, useState, type FormEvent, type MouseEvent } from 'react';
import { useTranslation } from 'react-i18next';

import {
  INPUT_HANDOFF_PICTURE_TEXT_ID,
  inputHandoffPresentation,
  type InputHandoffAction,
  type InputHandoffControl,
  type InputHandoffSnapshot,
} from '@cindy/device-link';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { openInputHandoffPicture, type InputHandoffPictureSession } from '@/lib/makerTransport';
import { InputHandoffTextField } from './InputHandoffStepForm';

type Decision = 'done' | 'refresh';

export interface InputHandoffPictureStepProps {
  sessionId: string;
  snapshot: InputHandoffSnapshot;
  busy: boolean;
  inputBlocked: boolean;
  onDecide: (action: Decision) => void;
  onError: (message: string | null) => void;
}

export function InputHandoffPictureStep({
  sessionId,
  snapshot,
  busy,
  inputBlocked,
  onDecide,
  onError,
}: InputHandoffPictureStepProps) {
  const { t } = useTranslation();
  const [state, setState] = useState<'idle' | 'loading' | 'shown' | 'failed'>('idle');
  const [sending, setSending] = useState(false);
  const [typed, setTyped] = useState('');
  const opened = useRef<InputHandoffPictureSession | null>(null);
  const alive = useRef(true);
  const [src, setSrc] = useState<string | null>(null);
  const image = useRef<HTMLImageElement>(null);
  const field = snapshot.controls.find(
    (control): control is Extract<InputHandoffControl, { kind: 'text' }> =>
      control.kind === 'text' && control.id === INPUT_HANDOFF_PICTURE_TEXT_ID,
  );
  const disabled = busy || sending || inputBlocked || state !== 'shown';

  const load = useCallback(async () => {
    setState('loading');
    onError(null);
    try {
      const session = await openInputHandoffPicture(sessionId, inputHandoffPresentation(snapshot));
      // Closed while it loaded: end the exchange instead of leaving it open on the computer.
      if (!alive.current) {
        session.close();
        return;
      }
      opened.current = session;
      setSrc(`data:${session.picture.mime};base64,${session.picture.data}`);
      setState('shown');
    } catch {
      setState('failed');
    }
  }, [onError, sessionId, snapshot]);

  // Each revision is one picture: open it once, and close the exchange when the step changes.
  useEffect(() => {
    alive.current = true;
    if (!inputBlocked) void load();
    return () => {
      alive.current = false;
      opened.current?.close();
      opened.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mounted once per revision by the card
  }, []);

  // Each exchange answers once: after a failed answer, open a fresh one so the picture works again.
  const retry = (message: string) => {
    if (!alive.current) return;
    void load();
    onError(message);
  };

  const answer = async (action: InputHandoffAction, values: Record<string, string> = {}) => {
    const session = opened.current;
    if (!session || disabled) return;
    opened.current = null;
    setSending(true);
    onError(null);
    try {
      const result = await session.answer({ expectedRevision: snapshot.revision, values, action });
      if (result.accepted) setTyped('');
      else retry(t('inputHandoff.error.stale'));
    } catch {
      retry(t('inputHandoff.error.submit'));
    } finally {
      setSending(false);
    }
  };

  const tap = (event: MouseEvent<HTMLButtonElement>) => {
    const rect = image.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0 || rect.height <= 0) return;
    const clamp = (n: number) => Math.min(1, Math.max(0, n));
    void answer({
      kind: 'tap',
      x: clamp((event.clientX - rect.left) / rect.width),
      y: clamp((event.clientY - rect.top) / rect.height),
    });
  };

  const type = (submit: boolean) => {
    if (!field) return;
    if (!submit && !typed) return;
    void answer({ kind: submit ? 'submit' : 'fill' }, typed ? { [field.id]: typed } : {});
  };

  const onFormSubmit = (event: FormEvent) => {
    event.preventDefault();
    type(true);
  };

  return (
    <div>
      {state === 'shown' && src ? (
        <>
          <p className="mb-2 text-12 text-[var(--text-tertiary)]">{t('inputHandoff.picture.hint')}</p>
          <div className="max-h-[60vh] overflow-auto rounded-[8px] border border-[var(--border-default)] bg-[var(--surface-sunken)]">
            <button
              type="button"
              className="block w-full cursor-crosshair disabled:cursor-default disabled:opacity-60"
              disabled={disabled}
              aria-label={t('inputHandoff.picture.alt')}
              onClick={tap}
            >
              <img
                ref={image}
                src={src}
                alt={t('inputHandoff.picture.alt')}
                draggable={false}
                className="block h-auto w-full select-none"
              />
            </button>
          </div>
        </>
      ) : state === 'loading' ? (
        <p className="flex items-center gap-2 text-13 text-[var(--text-secondary)]" role="status">
          <Spinner size={14} />
          {t('inputHandoff.picture.loading')}
        </p>
      ) : state === 'failed' ? (
        <div className="flex flex-col items-start gap-2">
          <p className="text-13 text-[var(--text-secondary)]">{t('inputHandoff.picture.error')}</p>
          <Button type="button" size="sm" variant="secondary" disabled={busy || inputBlocked} onClick={() => void load()}>
            {t('inputHandoff.picture.open')}
          </Button>
        </div>
      ) : null}
      {field && state === 'shown' && (
        <form className="mt-3" onSubmit={onFormSubmit} autoComplete="on" noValidate>
          <InputHandoffTextField
            control={{ ...field, label: field.contentType === 'password' ? '' : t('inputHandoff.picture.field') }}
            value={typed}
            disabled={disabled}
            onChange={setTyped}
          />
          <div className="mt-2 flex flex-wrap justify-end gap-2">
            <Button type="button" size="sm" variant="secondary" disabled={disabled || !typed} onClick={() => type(false)}>
              {t('inputHandoff.picture.type')}
            </Button>
            <Button type="submit" size="sm" variant="primary" disabled={disabled}>
              {t('inputHandoff.picture.typeEnter')}
            </Button>
          </div>
        </form>
      )}
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Button type="button" size="sm" variant="secondary" tone="quiet" disabled={busy} onClick={() => onDecide('refresh')}>
          {t('inputHandoff.action.backToForm')}
        </Button>
        <div className="ml-auto">
          <Button type="button" size="sm" variant="secondary" disabled={busy} onClick={() => onDecide('done')}>
            {t('inputHandoff.action.done')}
          </Button>
        </div>
      </div>
    </div>
  );
}
