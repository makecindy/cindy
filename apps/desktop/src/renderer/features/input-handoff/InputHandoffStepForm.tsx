/**
 * One 代输入 step: only the fields the owner types into, in screen order, plus
 * what the page says is wrong with them. Return moves to the next field and,
 * on the last one, hands the answer over (the dialog's Continue does the
 * same); Cindy then confirms on the page itself. The draft lives only here;
 * the parent remounts this form for every new screen, and a successful submit
 * clears it immediately.
 */

import { useRef, useState, type FormEvent } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type {
  InputHandoffAction,
  InputHandoffControl,
  InputHandoffSnapshot,
  InputHandoffValues,
} from '@cindy/device-link';
import { FormField } from '@/components/ui/form-field';
import { Input, Textarea } from '@/components/ui/input';
import {
  autoCompleteFor,
  inputModeFor,
  inputTypeFor,
  textFields,
  type InputHandoffTextControl,
} from './inputHandoffModel';

export interface InputHandoffStepFormProps {
  /** The dialog's Continue button submits this form by id. */
  formId: string;
  snapshot: InputHandoffSnapshot;
  busy: boolean;
  inputBlocked: boolean;
  onSubmit: (draft: InputHandoffValues, action: InputHandoffAction) => Promise<boolean>;
  /** First edit on this screen: this device starts handling the handoff. */
  onStart?: () => void;
}

const FIELD_ATTR = 'data-input-handoff-field';
/** Marks the dialog's Continue button: it answers from any field, Return only from the last one. */
export const CONTINUE_ATTR = 'data-input-handoff-continue';

export function InputHandoffStepForm({
  formId,
  snapshot,
  busy,
  inputBlocked,
  onSubmit,
  onStart,
}: InputHandoffStepFormProps) {
  const [draft, setDraft] = useState<InputHandoffValues>({});
  const started = useRef(false);
  const set = (id: string, value: string) => {
    if (!started.current) {
      started.current = true;
      onStart?.();
    }
    setDraft((d) => ({ ...d, [id]: value }));
  };
  const disabled = busy || inputBlocked;
  const fields = textFields(snapshot);
  const lastField = fields.at(-1)?.id;

  const onFormSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    // Return in an earlier field moves on, like a sign-in form; only the last one (or Continue) answers.
    const inputs = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(`[${FIELD_ATTR}]`));
    const at = inputs.indexOf(document.activeElement as HTMLElement);
    const continued = (event.nativeEvent as SubmitEvent).submitter?.hasAttribute(CONTINUE_ATTR) === true;
    if (!continued && at >= 0 && at < inputs.length - 1) {
      inputs[at + 1].focus();
      return;
    }
    if (disabled || fields.length === 0) return;
    // Drop the typed values from memory as soon as the Host has them.
    if (await onSubmit(draft, { kind: 'submit' })) setDraft({});
  };

  return (
    <form id={formId} onSubmit={(event) => void onFormSubmit(event)} autoComplete="on" noValidate>
      <div className="flex flex-col gap-3">
        {snapshot.controls.map((control) =>
          control.kind === 'note' ? (
            <StepNote key={control.id} control={control} />
          ) : (
            <InputHandoffTextField
              key={control.id}
              control={control}
              value={draft[control.id] ?? ''}
              disabled={disabled}
              last={control.id === lastField}
              autoFocus={control.id === fields[0]?.id}
              onChange={(v) => set(control.id, v)}
            />
          ),
        )}
      </div>
      {/* Return submits the form; this button stays out of sight and out of the tab order. */}
      <button type="submit" className="sr-only" tabIndex={-1} aria-hidden disabled={disabled} />
    </form>
  );
}

function StepNote({ control }: { control: Extract<InputHandoffControl, { kind: 'note' }> }) {
  return (
    <p role="alert" className="text-13 text-[var(--error-fg)] [overflow-wrap:anywhere]">
      {control.text}
    </p>
  );
}

/** One standard platform text / password field; also used by the screenshot step. */
export function InputHandoffTextField({
  control,
  value,
  disabled,
  last = true,
  autoFocus,
  onChange,
}: {
  control: InputHandoffTextControl;
  value: string;
  disabled: boolean;
  /** Return on this field hands the answer over (otherwise it moves to the next field). */
  last?: boolean;
  autoFocus?: boolean;
  onChange: (value: string) => void;
}) {
  const { t } = useTranslation();
  // The eye only swaps the field kind; the autofill hint stays, so password managers still fill it.
  const [revealed, setRevealed] = useState(false);
  const password = control.contentType === 'password';
  const label = control.label || t(
    control.contentType === 'password' ? 'inputHandoff.passwordField'
      : control.contentType === 'one-time-code' ? 'inputHandoff.codeField'
      : 'inputHandoff.unnamedField',
  );
  const suggestions = control.suggestions ?? [];
  const listId = suggestions.length > 0 ? `input-handoff-${control.id}-options` : undefined;
  return (
    <FormField label={label} hint={control.filled ? t('inputHandoff.filledHint') : undefined}>
      {(field) =>
        control.multiline ? (
          <Textarea
            id={field.id}
            aria-describedby={field['aria-describedby']}
            data-input-handoff-field=""
            // Return moves on like in a one-line field; Shift + Return adds a line.
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                event.currentTarget.form?.requestSubmit();
              }
            }}
            value={value}
            placeholder={control.placeholder}
            disabled={disabled}
            rows={3}
            onChange={onChange}
          />
        ) : (
          <>
            {/* Standard platform field with its autofill hints; the eye never turns them off. */}
            <Input
              id={field.id}
              aria-describedby={field['aria-describedby']}
              data-input-handoff-field=""
              size="md"
              type={password && revealed ? 'text' : inputTypeFor(control)}
              autoFocus={autoFocus}
              name={control.contentType === 'text' ? control.id : control.contentType}
              autoComplete={autoCompleteFor(control)}
              inputMode={inputModeFor(control)}
              enterKeyHint={last ? 'go' : 'next'}
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              list={listId}
              value={value}
              placeholder={control.placeholder}
              disabled={disabled}
              onChange={onChange}
              trailing={
                password ? (
                  <button
                    type="button"
                    disabled={disabled}
                    aria-pressed={revealed}
                    aria-label={t(revealed ? 'inputHandoff.action.hidePassword' : 'inputHandoff.action.showPassword')}
                    onClick={() => setRevealed((v) => !v)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 rounded-full text-[var(--text-tertiary)] transition-colors enabled:hover:text-[var(--text-secondary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] disabled:opacity-60"
                  >
                    {revealed ? <EyeOff size={15} aria-hidden /> : <Eye size={15} aria-hidden />}
                  </button>
                ) : undefined
              }
            />
            {listId && (
              <datalist id={listId}>
                {suggestions.map((o) => (
                  <option key={o.id} value={o.label} />
                ))}
              </datalist>
            )}
          </>
        )
      }
    </FormField>
  );
}
