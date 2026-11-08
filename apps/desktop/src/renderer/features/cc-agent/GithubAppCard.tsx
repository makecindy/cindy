import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ErrorNotice } from '@/components/ui/error-notice';
import { Button } from '@/components/ui/button';
import type { GithubAppConnectionState } from '../../../shared/githubSetup';

/** Trusted account controls alongside the plugin's existing GitHub login card. */
export function GithubAppCard() {
  const { t } = useTranslation();
  const [state, setState] = useState<GithubAppConnectionState>();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const generation = useRef(0);
  const key = 'ccAgent.gitContext.pr.setup.app.';
  const refresh = useCallback(async () => {
    const current = ++generation.current;
    try {
      const result = await window.electronAPI.gitContext.githubAppStatus();
      if (current === generation.current) { setState(result); setFailed(false); }
    } catch { if (current === generation.current) setFailed(true); }
  }, []);
  useEffect(() => {
    void refresh();
    const onFocus = () => void refresh();
    window.addEventListener('focus', onFocus);
    return () => { generation.current++; window.removeEventListener('focus', onFocus); };
  }, [refresh]);
  const act = async (action: () => Promise<void>) => {
    setBusy(true);
    try { await action(); await refresh(); } catch { setFailed(true); }
    finally { setBusy(false); }
  };
  if (!failed && !state?.available) return null;
  return (
    <div className="mt-3 flex flex-col gap-2 border-t border-[var(--border-default)] pt-3" aria-live="polite">
      <p className="text-13 text-[var(--text-primary)]">{t(key + 'title')}</p>
      <p className="text-12 text-[var(--text-secondary)]">
        {state?.login ? t(key + 'connected', { login: state.login, count: state.repositories?.length ?? 0 }) : t(key + 'description')}
      </p>
      {Boolean(state?.unavailable?.length) && <p className="break-words text-12 text-[var(--text-secondary)]">{t(key + 'missing', { repositories: state?.unavailable?.join(', ') })}</p>}
      {failed && <ErrorNotice role="alert" message={t(key + 'error')} />}
      <div className="flex flex-wrap gap-2">
        {state?.available && (state.login ? <>
          <Button variant="secondary" disabled={busy} onClick={() => void act(() => window.electronAPI.gitContext.installGithubApp())}>{t(key + 'repositories')}</Button>
          <Button variant="secondary" disabled={busy} onClick={() => void act(() => window.electronAPI.gitContext.disconnectGithubApp())}>{t(key + 'disconnect')}</Button>
        </> : <Button variant="secondary" disabled={busy} onClick={() => void act(() => window.electronAPI.gitContext.connectGithubApp())}>{t(key + 'connect')}</Button>)}
        {failed && <Button variant="secondary" disabled={busy} onClick={() => void refresh()}>{t('ccAgent.gitContext.pr.setup.account.recheck')}</Button>}
      </div>
    </div>
  );
}
