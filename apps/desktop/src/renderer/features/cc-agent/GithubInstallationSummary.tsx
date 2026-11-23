import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import type { GithubAppAccess } from '../../../shared/githubSetup';

const key = 'ccAgent.gitContext.pr.setup.access.';

export function GithubInstallationSummary({ connect, disabled }: { connect?: () => void; disabled: boolean }) {
  const { t } = useTranslation();
  const [access, setAccess] = useState<GithubAppAccess>();
  const request = useRef<Promise<GithubAppAccess> | null>(null);
  useEffect(() => {
    let current = true;
    request.current ??= window.electronAPI.gitContext.githubAppAccess()
      .catch((): GithubAppAccess => ({ status: 'unavailable' }));
    void request.current.then(result => { if (current) setAccess(result); });
    return () => { current = false; };
  }, []);
  const installations = access?.status === 'ready' ? access.installations : [];
  const total = installations.length > 1 && installations.every(item => item.visibleRepositories !== null)
    ? installations.reduce((sum, item) => sum + (item.visibleRepositories ?? 0), 0) : null;
  return <section className="mt-3 space-y-2 border-t border-[var(--border-default)] pt-3 text-12 text-[var(--text-secondary)]">
    <h3 className="text-13 font-medium text-[var(--text-primary)]">{t(key + 'title')}</h3>
    {total !== null && <p>{t(key + 'visible', { count: total })}</p>}
    {access?.status === 'ready' ? (
      access.installations.length === 0 ? <p>{t(key + 'empty')}</p> :
        access.installations.map(item => <div key={item.id} className="space-y-1 break-words">
          <p className="font-medium text-[var(--text-primary)]">{item.owner} · {t(key + item.selection)}</p>
          <p>{item.app} · {item.suspended ? t(key + 'suspended')
            : item.visibleRepositories === null ? t(key + 'unknownCount')
            : t(key + 'visible', { count: item.visibleRepositories })}</p>
          <details>
            <summary className="cursor-pointer">{t(key + 'permissions')}</summary>
            <dl className="mt-1 space-y-1">
              {Object.entries(item.permissions).sort(([a], [b]) => a.localeCompare(b)).map(([name, level]) =>
                <div key={name} className="flex flex-wrap justify-between gap-x-2">
                  <dt>{t(key + 'names.' + name, { defaultValue: name.replaceAll('_', ' ') })}</dt>
                  <dd>{t(key + level, { defaultValue: level })}</dd>
                </div>)}
            </dl>
          </details>
        </div>)
    ) : <p>{t(key + (access?.status ?? 'loading'))}</p>}
    {access?.status === 'missing' && connect &&
      <Button variant="secondary" disabled={disabled} onClick={connect}>{t('ccAgent.gitContext.pr.setup.connection.connect')}</Button>}
  </section>;
}
