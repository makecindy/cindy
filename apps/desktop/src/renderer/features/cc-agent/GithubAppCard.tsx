import { useCallback, useEffect, useEffectEvent, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ErrorNotice } from '@/components/ui/error-notice';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import type { GithubAppConnectionState, GithubConnectionState } from '../../../shared/githubSetup';
import { GithubInstallationSummary } from './GithubInstallationSummary';

/** Trusted account controls alongside the plugin's existing GitHub login card. */
export function GithubAppCard({ account, accountBusy = false, children, alternative, pluginSettings = false, automation = false, repositories, timedPrCheck }: {
  pluginSettings?: boolean;
  timedPrCheck?: boolean;
  automation?: boolean;
  repositories?: string[];
  account?: GithubConnectionState;
  accountBusy?: boolean;
  children?: ReactNode;
  alternative?: ReactNode;
}) {
  const { t } = useTranslation();
  const [state, setState] = useState<GithubAppConnectionState>();
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(true);
  const [failed, setFailed] = useState(false);
  const [awaitingBrowser, setAwaitingBrowser] = useState(false);
  const [authorizationVersion, setAuthorizationVersion] = useState(0);
  const generation = useRef(0);
  const pending = useRef<Promise<void> | null>(null);
  const acting = useRef<'browser' | 'local' | null>(null);
  const key = 'ccAgent.gitContext.pr.setup.app.';
  const refresh = useCallback(() => {
    // Focus events may arrive while the initial request is still in flight.
    if (pending.current) return pending.current;
    const current = ++generation.current;
    setChecking(true);
    const request = (async () => {
      try {
        const result = await window.electronAPI.gitContext.githubAppStatus();
        if (current === generation.current) { setState(result); setFailed(false); }
      } catch { if (current === generation.current) setFailed(true); }
      finally {
        if (current === generation.current) { setChecking(false); pending.current = null; }
      }
    })();
    pending.current = request;
    return request;
  }, []);
  const onAuthorizationChanged = useEffectEvent(() => {
    // The OAuth callback redirects to repository installation. Read status and
    // access when the user returns, just as for a direct repository selection.
    if (awaitingBrowser || acting.current === 'browser') return;
    setAuthorizationVersion(version => version + 1);
    generation.current++;
    pending.current = null;
    void refresh();
  });
  useEffect(() => {
    void refresh();
    const onFocus = () => {
      if (acting.current) return;
      setAwaitingBrowser(false);
      void refresh();
    };
    window.addEventListener('focus', onFocus);
    const unsubscribe = window.electronAPI.gitContext.onGithubConnected?.(() => onAuthorizationChanged());
    return () => { unsubscribe?.(); generation.current++; pending.current = null; window.removeEventListener('focus', onFocus); };
  }, [refresh]);
  const act = async (action: () => Promise<void>, opensBrowser = false) => {
    if (acting.current || pending.current) return;
    acting.current = opensBrowser ? 'browser' : 'local';
    const current = generation.current;
    setBusy(true);
    try {
      await action();
      if (current === generation.current) {
        // openExternal resolves when the browser opens, not when setup finishes.
        if (opensBrowser) { setAwaitingBrowser(true); setFailed(false); }
        else await refresh();
      }
    } catch { if (current === generation.current) setFailed(true); }
    finally { acting.current = null; setBusy(false); }
  };
  const actor = account?.status === 'connected' ? account.login : undefined;
  const mismatch = actor && state?.login && actor.toLowerCase() !== state.login.toLowerCase();
  const summary = accountBusy || checking ? 'checking'
    : failed ? undefined
    : mismatch ? 'mismatch'
    : actor ? 'ready'
    : state?.login && (account?.status === 'missing' || account?.status === 'auth') ? 'incomplete'
    : undefined;
  if (!children && !failed && state?.available === false) return automation
    ? <p className="text-12 text-[var(--text-secondary)]">{t('scheduler.editor.webhook.appUnavailable')} {timedPrCheck && t('scheduler.prTrigger.fallback')}</p> : null;
  const disabled = busy || checking;
  const alreadyOffersConnection = account?.status === 'missing' || account?.status === 'auth' || mismatch;
  const eventLabel = checking || automation || pluginSettings
    ? 'ccAgent.gitContext.pr.setup.account.connected'
    : actor && !mismatch ? 'ccAgent.gitContext.pr.setup.connection.repositories' : key + 'connected';
  const unavailable = state?.unavailable?.filter(repo => !repositories || repositories.some(selected => selected.toLowerCase() === repo.toLowerCase()));
  return (
    <>
      {children && summary && <p className="mb-3 text-13 text-[var(--text-primary)]" role="status">
        {t('ccAgent.gitContext.pr.setup.connection.' + summary)}
      </p>}
      {children}
      {children && state?.userAuthorization && !failed && (account?.status === 'missing' || account?.status === 'auth' || (actor && !state.login) || mismatch) &&
        <Button className="mt-3" variant="secondary" disabled={disabled || accountBusy || awaitingBrowser}
          onClick={() => void act(() => window.electronAPI.gitContext.connectGithubApp(), true)}>
          {t('ccAgent.gitContext.pr.setup.connection.connect')}
        </Button>}
      {alternative && <details className="mt-3 text-12 text-[var(--text-secondary)]" open={state?.available === false || (state && !state.userAuthorization && !actor)}>
        <summary className="cursor-pointer">{t('ccAgent.gitContext.pr.setup.connection.alternative')}</summary>
        <p className="my-2">{t('ccAgent.gitContext.pr.setup.connection.cliDescription')}</p>
        {alternative}
      </details>}
      {pluginSettings && state?.login && !awaitingBrowser &&
        <GithubInstallationSummary key={state.login + ':' + authorizationVersion} disabled={disabled || failed}
          connect={state.userAuthorization && !alreadyOffersConnection
            ? () => void act(() => window.electronAPI.gitContext.connectGithubApp(), true) : undefined} />}
      {(failed || state?.available !== false) &&
    <div className="mt-3 flex flex-col gap-2 border-t border-[var(--border-default)] pt-3" aria-live="polite" aria-busy={disabled}>
      <p className="text-13 text-[var(--text-primary)]">{t(automation ? 'scheduler.editor.webhook.accountLabel' : key + 'title')}</p>
      <p className="text-12 text-[var(--text-secondary)]">
        {awaitingBrowser ? t(key + 'finishInBrowser') : state?.login
          ? t(eventLabel, { login: state.login, count: state.repositories?.length ?? 0 })
          : t(automation ? 'scheduler.editor.webhook.accountDisconnected' : key + 'description')}
      </p>
      {pluginSettings && state?.login && state.repositories && !checking && !awaitingBrowser && !failed &&
        <p className="text-12 text-[var(--text-secondary)]">{t('ccAgent.gitContext.pr.setup.access.events', { count: state.repositories.length })}</p>}
      {children && !checking && !failed && state?.login && (account?.status === 'missing' || account?.status === 'auth') && <p className="text-12 text-[var(--text-secondary)]">{t('ccAgent.gitContext.pr.setup.connection.eventsOnly')}</p>}
      {!checking && !awaitingBrowser && Boolean(unavailable?.length) && <p className="break-words text-12 text-[var(--text-secondary)]">{t(key + 'missing', { repositories: unavailable?.join(', ') })}</p>}
      {timedPrCheck && !checking && !failed && (!state?.login || Boolean(unavailable?.length)) &&
        <p className="text-12 text-[var(--text-secondary)]">{t('scheduler.prTrigger.fallback')}</p>}
      {checking && <p role="status" className="flex items-center gap-2 text-12 text-[var(--text-secondary)]">
        <Spinner size={14} />{t(state?.login ? key + 'syncing' : 'ccAgent.gitContext.pr.setup.account.checking')}
      </p>}
      {failed && !checking && <ErrorNotice role="alert" message={t(key + 'error')} />}
      <div className="flex flex-wrap gap-2">
        {state?.available && (state.login ? <>
          <Button variant="secondary" disabled={disabled || failed} onClick={() => void act(() => window.electronAPI.gitContext.installGithubApp(), true)}>{t(automation ? 'scheduler.editor.webhook.authorizeRepositories' : pluginSettings ? 'ccAgent.gitContext.pr.setup.access.manage' : key + 'repositories')}</Button>
          {!automation && <Button variant="secondary" disabled={disabled || failed} onClick={() => void act(() => window.electronAPI.gitContext.disconnectGithubApp())}>{t(children && state.userAuthorization ? 'ccAgent.gitContext.pr.setup.connection.disconnect' : key + 'disconnect')}</Button>}
        </> : !failed && !(children && state.userAuthorization) && <Button variant="secondary" disabled={disabled} onClick={() => void act(() => window.electronAPI.gitContext.connectGithubApp(), true)}>{t(automation ? 'scheduler.editor.webhook.connectAccount' : key + 'connect')}</Button>)}
        {failed && <Button variant="secondary" disabled={disabled} onClick={() => void refresh()}>{t('ccAgent.gitContext.pr.setup.account.recheck')}</Button>}
      </div>
    </div>
      }
    </>
  );
}
