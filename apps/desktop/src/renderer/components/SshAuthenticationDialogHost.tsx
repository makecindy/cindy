import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import * as Dialog from '@radix-ui/react-dialog';
import type { SshAuthenticationRequest } from '../../shared/sshAuthentication';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { FormField } from './ui/form-field';
import { toast } from '@/lib/toast';

/** Only public challenges are queued. Answers live in the mounted form. */
export function SshAuthenticationDialogHost() {
  const [requests, setRequests] = useState<SshAuthenticationRequest[]>([]);
  const queued = useRef(new Set<string>());
  const { t } = useTranslation();
  useEffect(() => {
    const api = window.electronAPI.remoteSsh;
    const dismissed = new Set<string>();
    let active = true;
    const add = (request: SshAuthenticationRequest) => {
      if (!active || dismissed.has(request.requestId) || queued.current.has(request.requestId)
        || request.expiresAt <= Date.now()) return;
      queued.current.add(request.requestId);
      setRequests(previous => [...previous, request]);
    };
    const offDismiss = api.onAuthenticationDismissed(id => {
      dismissed.add(id);
      queued.current.delete(id);
      setRequests(previous => previous.filter(request => request.requestId !== id));
    });
    const offRequest = api.onAuthenticationRequest(add);
    void api.getPendingAuthentication().then(pending => pending.forEach(add)).catch(() => {});
    return () => {
      active = false;
      offRequest(); offDismiss();
      for (const id of queued.current) void api.answerAuthentication(id, null).catch(() => {});
      queued.current.clear();
    };
  }, []);

  const answer = useCallback(async (id: string, answers: string[] | null) => {
    queued.current.delete(id);
    setRequests(previous => previous.filter(request => request.requestId !== id));
    try {
      const result = await window.electronAPI.remoteSsh.answerAuthentication(id, answers);
      if (!result.accepted) toast.error(t('settings.remote.authentication.expired'));
    } catch {
      toast.error(t('settings.remote.authentication.deliveryFailed'));
    } finally { answers?.fill(''); }
  }, [t]);

  const request = requests[0];
  return request ? <SshAuthenticationForm key={request.requestId} request={request} onAnswer={answer} /> : null;
}

export function SshAuthenticationForm({ request, onAnswer }: {
  request: SshAuthenticationRequest;
  onAnswer(id: string, answers: string[] | null): Promise<void>;
}) {
  const { t } = useTranslation();
  const [values, setValues] = useState(() => request.prompts.map(() => ''));
  const valuesRef = useRef(values);
  const firstInput = useRef<HTMLInputElement>(null);
  const submitted = useRef(false);
  const composing = useRef(false);
  const finish = useCallback((cancel: boolean) => {
    if (submitted.current) return;
    submitted.current = true;
    const answers = cancel ? null : [...valuesRef.current];
    valuesRef.current.fill('');
    valuesRef.current = request.prompts.map(() => '');
    setValues(valuesRef.current);
    void onAnswer(request.requestId, answers).finally(() => answers?.fill(''));
  }, [onAnswer, request]);

  useEffect(() => {
    const timer = setTimeout(() => finish(true), Math.max(0, request.expiresAt - Date.now()));
    return () => { clearTimeout(timer); };
  }, [finish, request.expiresAt]);
  useEffect(() => () => { valuesRef.current.fill(''); }, []);

  return <Dialog.Root open onOpenChange={open => { if (!open) finish(true); }}>
    <Dialog.Portal>
      <Dialog.Overlay className="modal-scrim fixed inset-0 z-[10000]" />
      <Dialog.Content
        className="modal-panel fixed left-1/2 top-1/2 z-[10000] flex max-h-[88vh] w-[440px] max-w-[92vw] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden p-5"
        onPointerDownOutside={event => event.preventDefault()}
        onInteractOutside={event => event.preventDefault()}
        onEscapeKeyDown={event => { if (composing.current) event.preventDefault(); }}
        onOpenAutoFocus={event => { event.preventDefault(); firstInput.current?.focus(); }}
      >
        <Dialog.Title className="shrink-0 text-15 font-medium text-[var(--text-primary)]">
          {t('settings.remote.authentication.title')}
        </Dialog.Title>
        <Dialog.Description className="mt-2 shrink-0 text-13 leading-normal text-[var(--text-secondary)]">
          {t('settings.remote.authentication.description')}
        </Dialog.Description>
        <p className="mt-3 shrink-0 break-all font-mono text-12 text-[var(--text-primary)]">
          {request.host.id} · {request.host.user}@{request.host.hostname}:{request.host.port}
        </p>
        <form className="mt-4 flex min-h-0 flex-col gap-4" onSubmit={event => {
          event.preventDefault();
          if (!composing.current) finish(false);
        }} onKeyDown={event => {
          if (event.key === 'Enter' && (composing.current || event.nativeEvent.isComposing || event.keyCode === 229)) event.preventDefault();
        }} onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }}>
          <div className="min-h-0 space-y-4 overflow-y-auto">
            {(request.name || request.instructions) && <div className="text-12 text-[var(--text-secondary)]">
              <p>{t('settings.remote.authentication.serverPrompt')}</p>
              <p className="mt-1 whitespace-pre-wrap [overflow-wrap:anywhere]">{request.name}</p>
              <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">{request.instructions}</p>
            </div>}
          {/* Authentication answers are private even when a server requests echo. */}
          {request.prompts.map((prompt, index) => <FormField key={index}
            label={prompt.prompt || t('settings.remote.authentication.response', { number: index + 1 })}>
            {control => <Input {...control} size="md" type="password"
              secretTipContentClassName="z-[10001]"
              autoComplete="off" spellCheck={false} autoCapitalize="none" maxLength={4096}
              inputRef={index === 0 ? firstInput : undefined} value={values[index] ?? ''}
              onChange={value => {
                const next = [...valuesRef.current]; next[index] = value;
                valuesRef.current = next; setValues(next);
              }} />}
          </FormField>)}
          </div>
          <div className="flex shrink-0 flex-wrap justify-end gap-2">
            <Button type="button" variant="secondary" onClick={() => finish(true)}>{t('logic.confirm.cancel')}</Button>
            <Button type="submit">{t('settings.remote.authentication.submit')}</Button>
          </div>
        </form>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}
