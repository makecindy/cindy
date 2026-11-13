import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ErrorNotice } from '@/components/ui/error-notice';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import type { GithubAppConnectionState } from '../../../shared/githubSetup';

/** Trusted account controls alongside the plugin's existing GitHub login card. */
export function GithubAppCard() {
  const { t } = useTranslation();
  const [state, setState] = useState<GithubAppConnectionState>();
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(true);
  const [failed, setFailed] = useState(false);
  const generation = useRef(0);
  const pending = useRef<Promise<void> | null>(null);
  const acting = useRef(false);
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
  useEffect(() => {
    void refresh();
    const onFocus = () => { if (!acting.current) void refresh(); };
    window.addEventListener('focus', onFocus);
    return () => { generation.current++; pending.current = null; window.removeEventListener('focus', onFocus); };
  }, [refresh]);
  const act = async (action: () => Promise<void>) => {
    if (acting.current || pending.current) return;
    acting.current = true;
    const current = generation.current;
    setBusy(true);
    try {
      await action();
      if (current === generation.current) await refresh();
    } catch { if (current === generation.current) setFailed(true); }
    finally { acting.current = false; setBusy(false); }
  };
  if (!failed && state?.available === false) return null;
  const disabled = busy || checking;
  return (
    <div className="mt-3 flex flex-col gap-2 border-t border-[var(--border-default)] pt-3" aria-live="polite" aria-busy={disabled}>
      <p className="text-13 text-[var(--text-primary)]">{t(key + 'title')}</p>
      <p className="text-12 text-[var(--text-secondary)]">
        {state?.login ? t(key + 'connected', { login: state.login, count: state.repositories?.length ?? 0 }) : t(key + 'description')}
      </p>
      {Boolean(state?.unavailable?.length) && <p className="break-words text-12 text-[var(--text-secondary)]">{t(key + 'missing', { repositories: state?.unavailable?.join(', ') })}</p>}
      {checking && <p role="status" className="flex items-center gap-2 text-12 text-[var(--text-secondary)]">
        <Spinner size={14} />{t('ccAgent.gitContext.pr.setup.account.checking')}
      </p>}
      {failed && !checking && <ErrorNotice role="alert" message={t(key + 'error')} />}
      <div className="flex flex-wrap gap-2">
        {state?.available && (state.login ? <>
          <Button variant="secondary" disabled={disabled || failed} onClick={() => void act(() => window.electronAPI.gitContext.installGithubApp())}>{t(key + 'repositories')}</Button>
          <Button variant="secondary" disabled={disabled || failed} onClick={() => void act(() => window.electronAPI.gitContext.disconnectGithubApp())}>{t(key + 'disconnect')}</Button>
        </> : !failed && <Button variant="secondary" disabled={disabled} onClick={() => void act(() => window.electronAPI.gitContext.connectGithubApp())}>{t(key + 'connect')}</Button>)}
        {failed && <Button variant="secondary" disabled={disabled} onClick={() => void refresh()}>{t('ccAgent.gitContext.pr.setup.account.recheck')}</Button>}
      </div>
    </div>
  );
}
