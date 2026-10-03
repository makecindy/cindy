import { useCallback, useEffect, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { FormField } from '@/components/ui/form-field';
import { Input, Textarea } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import {
  getDataOwnerGeneration,
  isDataOwnerGenerationCurrent,
} from '@/contexts/dataOwnerGeneration';
import { toast } from '@/lib/toast';
import { extractIpcError } from '@/utils/ipcError';
import {
  CINDY_MAKE_CONTRIBUTION_ERRORS,
  CONTRIBUTION_LIMITS,
  isContributionEmail,
  type CindyMakeContributionDraft,
  type CindyMakeContributionError,
  type CindyMakeContributionView,
} from '../../../shared/cindyMakeContribution';

const key = 'cindyMake.contribution';

function contributionError(error: unknown): CindyMakeContributionError {
  const reason = extractIpcError(error)
    ?.message?.replace(/^\[PRECONDITION_FAILED\]\s*/, '')
    .trim();
  return (CINDY_MAKE_CONTRIBUTION_ERRORS as readonly string[]).includes(reason ?? '')
    ? (reason as CindyMakeContributionError)
    : 'failed';
}

/** Pull requests already opened for history entries; states come from GitHub through Main. */
export function useCindyMakeContributions(active: boolean) {
  const [snapshot, setSnapshot] = useState<{
    owner: ReturnType<typeof getDataOwnerGeneration>;
    views: Record<string, CindyMakeContributionView>;
  }>();
  const request = useRef(0);
  const refresh = useCallback(async () => {
    const invoke = window.electronAPI.cindyMakeContribution;
    if (!invoke) return;
    const owner = getDataOwnerGeneration();
    const generation = ++request.current;
    try {
      const views = await invoke({ action: 'status' });
      if (generation === request.current && isDataOwnerGenerationCurrent(owner))
        setSnapshot({ owner, views: Object.fromEntries(views.map((view) => [view.runId, view])) });
    } catch {
      // Without states the history still works; nothing is shown for the PR.
    }
  }, []);
  useEffect(() => {
    if (active) void refresh();
  }, [active, refresh]);
  const record = useCallback((view: CindyMakeContributionView) => {
    request.current += 1;
    const owner = getDataOwnerGeneration();
    setSnapshot((previous) => ({
      owner,
      views: {
        ...(previous && isDataOwnerGenerationCurrent(previous.owner) ? previous.views : {}),
        [view.runId]: view,
      },
    }));
  }, []);
  const views = snapshot && isDataOwnerGenerationCurrent(snapshot.owner) ? snapshot.views : {};
  return { views, refresh, record };
}

/** One line under the history entry: where its pull request stands. */
export function CindyMakeContributionStatus({ view }: { view: CindyMakeContributionView }) {
  const { t } = useTranslation();
  return (
    <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-12 text-[var(--text-secondary)]">
      <span>{t(`${key}.state.${view.state ?? 'submitted'}`, { number: view.number })}</span>
      <Button
        variant="secondary"
        tone="quiet"
        size="sm"
        compact
        onClick={() => void window.electronAPI.openExternal(view.url)}
      >
        {t(`${key}.view`)}
      </Button>
    </p>
  );
}

/** The action-bar label for a history entry, given its existing pull request. */
export function contributionActionKey(view?: CindyMakeContributionView): string | undefined {
  if (!view) return `${key}.action`;
  if (view.state === 'merged') return undefined;
  return view.state === 'closed' ? `${key}.resubmit` : `${key}.update`;
}

/**
 * Reviews the prefilled pull request before anything leaves this computer. The
 * author confirms the public title, body and DCO identity; Main validates again.
 */
export function CindyMakeContributionDialog({
  runId,
  onOpenChange,
  onSubmitted,
}: {
  runId: string;
  onOpenChange(open: boolean): void;
  onSubmitted(view: CindyMakeContributionView): void;
}) {
  const { t } = useTranslation();
  const owner = useRef(getDataOwnerGeneration());
  const [draft, setDraft] = useState<CindyMakeContributionDraft>();
  const [loadError, setLoadError] = useState<CindyMakeContributionError>();
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [signed, setSigned] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<CindyMakeContributionError>();
  const busy = useRef(false);
  const mounted = useRef(true);
  const returnFocusRef = useRef(
    document.activeElement instanceof HTMLElement ? document.activeElement : null,
  );

  useEffect(() => {
    mounted.current = true;
    const invoke = window.electronAPI.cindyMakeContribution;
    if (!invoke) {
      setLoadError('failed');
      return;
    }
    void invoke({ action: 'draft', runId }).then(
      (next) => {
        if (!mounted.current || !isDataOwnerGenerationCurrent(owner.current)) return;
        setDraft(next);
        setTitle(next.title);
        setBody(next.body);
        setName(next.name);
        setEmail(next.email);
      },
      (error: unknown) => {
        if (mounted.current) setLoadError(contributionError(error));
      },
    );
    return () => {
      mounted.current = false;
    };
  }, [runId]);

  const titleValid =
    !!title.trim() && title.length <= CONTRIBUTION_LIMITS.title && !/[\r\n]/.test(title);
  const nameValid =
    !!name.trim() && name.length <= CONTRIBUTION_LIMITS.name && !/[<>\r\n]/.test(name);
  const emailValid = isContributionEmail(email.trim());
  const valid = !!draft && titleValid && nameValid && emailValid && signed;
  // An open (or unconfirmed) pull request is updated; a closed or merged one stays as it is.
  const update =
    !!draft?.existing && draft.existing.state !== 'closed' && draft.existing.state !== 'merged';

  const submit = async () => {
    const invoke = window.electronAPI.cindyMakeContribution;
    if (!valid || busy.current || !invoke) return;
    if (!isDataOwnerGenerationCurrent(owner.current)) {
      onOpenChange(false);
      return;
    }
    busy.current = true;
    setSubmitting(true);
    setSubmitError(undefined);
    try {
      const view = await invoke({ action: 'submit', runId, title, body, name, email });
      if (!isDataOwnerGenerationCurrent(owner.current)) return;
      toast.success(t(`${key}.submitted`, { number: view.number }));
      onSubmitted(view);
      onOpenChange(false);
    } catch (error) {
      if (mounted.current) setSubmitError(contributionError(error));
    } finally {
      busy.current = false;
      if (mounted.current) setSubmitting(false);
    }
  };

  return (
    <Dialog.Root open onOpenChange={(open) => !busy.current && onOpenChange(open)}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[10000] bg-[var(--overlay-modal)]" />
        <Dialog.Content
          onPointerDownOutside={(event) => event.preventDefault()}
          className="fixed left-1/2 top-1/2 z-[10001] flex max-h-[85vh] w-[min(560px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-y-auto rounded-xl bg-[var(--confirm-bg)] p-4 shadow-[var(--confirm-shadow)] outline-none"
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            if (returnFocusRef.current?.isConnected) returnFocusRef.current.focus();
          }}
          onEscapeKeyDown={(event) => {
            if (event.isComposing || event.keyCode === 229) event.preventDefault();
          }}
        >
          <Dialog.Title className="text-16 font-semibold text-[var(--confirm-title)]">
            {t(`${key}.dialog.title`)}
          </Dialog.Title>
          <Dialog.Description className="mt-2 text-13 leading-relaxed text-[var(--confirm-desc)]">
            {t(`${key}.dialog.description`)}
          </Dialog.Description>
          {!draft && !loadError && (
            <p
              role="status"
              className="mt-4 flex items-center gap-2 text-13 text-[var(--text-secondary)]"
            >
              <Spinner size={14} />
              {t(`${key}.dialog.loading`)}
            </p>
          )}
          {loadError && (
            <div className="mt-4 flex flex-col gap-4">
              <p role="alert" className="text-13 text-[var(--error-fg)]">
                {t(`${key}.errors.${loadError}`)}
              </p>
              <div className="flex justify-end">
                <Dialog.Close asChild>
                  <Button type="button" variant="secondary" size="lg" palette="confirmation">
                    {t(`${key}.dialog.close`)}
                  </Button>
                </Dialog.Close>
              </div>
            </div>
          )}
          {draft && (
            <form
              className="mt-4 flex flex-col gap-4"
              onSubmit={(event) => {
                event.preventDefault();
                void submit();
              }}
            >
              {draft.existing && (
                <p className="text-13 text-[var(--confirm-desc)]">
                  {t(`${key}.dialog.${update ? 'existing' : 'reopen'}`, {
                    number: draft.existing.number,
                  })}
                </p>
              )}
              <FormField
                label={t(`${key}.dialog.prTitle`)}
                hint={t(`${key}.dialog.prTitleHint`)}
                error={title && !titleValid ? t(`${key}.errors.invalid`) : undefined}
                required
              >
                {(control) => (
                  <Input
                    {...control}
                    value={title}
                    onChange={setTitle}
                    maxLength={CONTRIBUTION_LIMITS.title}
                    disabled={submitting}
                  />
                )}
              </FormField>
              <FormField label={t(`${key}.dialog.body`)} hint={t(`${key}.dialog.bodyHint`)}>
                {(control) => (
                  <Textarea
                    {...control}
                    value={body}
                    onChange={setBody}
                    rows={10}
                    maxLength={CONTRIBUTION_LIMITS.body}
                    disabled={submitting}
                    className="min-h-[180px] resize-y font-mono text-12"
                  />
                )}
              </FormField>
              <fieldset className="flex flex-col gap-2">
                <legend className="text-13 font-medium text-[var(--text-primary)]">
                  {t(`${key}.dialog.author`)}
                </legend>
                <div className="grid gap-3 sm:grid-cols-2">
                  <FormField
                    label={t(`${key}.dialog.name`)}
                    error={!nameValid ? t(`${key}.dialog.nameRequired`) : undefined}
                    required
                  >
                    {(control) => (
                      <Input
                        {...control}
                        value={name}
                        onChange={(value) => {
                          setName(value);
                          // The sign-off was confirmed for the previous identity.
                          setSigned(false);
                        }}
                        maxLength={CONTRIBUTION_LIMITS.name}
                        disabled={submitting}
                        autoComplete="name"
                      />
                    )}
                  </FormField>
                  <FormField
                    label={t(`${key}.dialog.email`)}
                    error={!emailValid ? t(`${key}.dialog.emailRequired`) : undefined}
                    required
                  >
                    {(control) => (
                      <Input
                        {...control}
                        type="email"
                        value={email}
                        onChange={(value) => {
                          setEmail(value);
                          setSigned(false);
                        }}
                        maxLength={CONTRIBUTION_LIMITS.email}
                        disabled={submitting}
                        autoComplete="email"
                      />
                    )}
                  </FormField>
                </div>
                <p className="text-12 text-[var(--text-secondary)]">
                  {t(`${key}.dialog.authorHint`)}
                </p>
              </fieldset>
              <details className="text-12 text-[var(--text-secondary)]">
                <summary className="min-h-8 cursor-pointer py-2">
                  {t(`${key}.dialog.files`, { count: draft.files.length })}
                </summary>
                <ul className="mt-1 max-h-40 space-y-1 overflow-y-auto font-mono">
                  {draft.files.map((file) => (
                    <li key={file} className="break-all">
                      {file}
                    </li>
                  ))}
                </ul>
              </details>
              <ul className="list-disc space-y-1 pl-5 text-12 text-[var(--text-secondary)]">
                <li>{t(`${key}.dialog.onlyThis`)}</li>
                <li>{t(`${key}.dialog.public`, { repository: draft.repository })}</li>
                {draft.touchesUi && <li>{t(`${key}.dialog.uiNote`)}</li>}
              </ul>
              <label className="flex min-h-8 cursor-pointer items-start gap-2 text-13 text-[var(--text-primary)]">
                <input
                  type="checkbox"
                  checked={signed}
                  disabled={submitting}
                  onChange={(event) => setSigned(event.target.checked)}
                  className="mt-0.5 size-4 shrink-0 accent-[var(--confirm-btn-primary-bg)]"
                />
                <span>{t(`${key}.dialog.dco`, { name: name.trim(), email: email.trim() })}</span>
              </label>
              {submitError && (
                <p role="alert" className="text-13 text-[var(--error-fg)]">
                  {t(`${key}.errors.${submitError}`)}
                </p>
              )}
              <div className="flex flex-wrap justify-end gap-2">
                <Dialog.Close asChild>
                  <Button
                    type="button"
                    variant="secondary"
                    size="lg"
                    disabled={submitting}
                    palette="confirmation"
                  >
                    {t(`${key}.dialog.cancel`)}
                  </Button>
                </Dialog.Close>
                <Button
                  type="submit"
                  size="lg"
                  disabled={!valid}
                  loading={submitting}
                  palette="confirmation"
                >
                  {t(`${key}.dialog.${update ? 'update' : 'submit'}`)}
                </Button>
              </div>
            </form>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
