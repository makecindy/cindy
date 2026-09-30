import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { GithubConnectButton } from './GithubConnectButton';
import type { GithubConnectionState } from '../../../shared/githubSetup';

/** Account verification belongs to the trusted host, not the plugin webview. */
export function GithubAccountCard({ onConnected }: { onConnected(): void }) {
  const { t } = useTranslation();
  const [state, setState] = useState<GithubConnectionState>();
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  const refresh = useCallback(async () => {
    const current = ++generation.current;
    setBusy(true);
    try {
      const result = await window.electronAPI.gitContext.githubConnection();
      if (current === generation.current) setState(result);
    } catch {
      if (current === generation.current) setState({ status: 'network' });
    } finally {
      if (current === generation.current) setBusy(false);
    }
  }, []);
  useEffect(() => {
    void refresh();
    const onFocus = () => void refresh();
    window.addEventListener('focus', onFocus);
    const unsubscribe = window.electronAPI.gitContext.onGithubConnected(onFocus);
    return () => {
      generation.current++;
      unsubscribe();
      window.removeEventListener('focus', onFocus);
    };
  }, [refresh]);
  const key = 'ccAgent.gitContext.pr.setup.account.';
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2" aria-live="polite">
      <div className="text-13 text-[var(--text-primary)]">
        {t(key + (state?.status ?? 'checking'), {
          login: state?.status === 'connected' ? state.login : '',
        })}
      </div>
      {state?.source && (
        <p className="text-12 text-[var(--text-secondary)]">{t(key + state.source)}</p>
      )}
      <div className="flex gap-2">
        <GithubConnectButton
          visible={state?.status === 'missing' || state?.status === 'auth'}
          onConnected={() => {
            void refresh();
            onConnected();
          }}
        />
        {state && state.status !== 'missing' && state.status !== 'connected' && (
          <Button variant="secondary" disabled={busy} onClick={() => void refresh()}>
            {t(key + 'recheck')}
          </Button>
        )}
      </div>
    </div>
  );
}
