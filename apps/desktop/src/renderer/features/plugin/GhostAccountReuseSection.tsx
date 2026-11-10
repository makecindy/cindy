import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { SettingsCard, SettingsField, SettingsRow, SettingsSection, SettingsNotice } from '@/components/ui/settings-rows';
import { useOptionalDataOwnerGeneration } from '@/contexts/AuthContext';
import type { GhostAccountReuseAction, GhostAccountReuseGroup, GhostReusableOauthAccount } from '../../../shared/pluginAccountReuse';

const choiceKey = (source: GhostReusableOauthAccount) => JSON.stringify([source.instanceKey, source.secretKey, source.accountId]);

export function GhostAccountReuseSection(props: { ghostId: string; declared: boolean; enabled: boolean }) {
  if (!props.declared) return null;
  return <AccountReuseControls {...props} />;
}

function AccountReuseControls({ ghostId, enabled }: { ghostId: string; enabled: boolean }) {
  const { t } = useTranslation();
  const generation = useOptionalDataOwnerGeneration();
  const key = `${generation}:${ghostId}`;
  const currentKey = useRef(key); currentKey.current = key;
  const [snapshot, setSnapshot] = useState<{ key: string; groups: GhostAccountReuseGroup[] } | null>(null);
  const [selection, setSelection] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ key: string; message: string } | null>(null);
  const refresh = useCallback(async () => {
    try {
      const groups = await window.electronAPI.ghosts.reusableAccounts(ghostId);
      if (currentKey.current !== key) return;
      setSnapshot({ key, groups }); setError(null);
    } catch {
      if (currentKey.current === key) setError({ key, message: 'settings.ghosts.detail.reuseAccountLoadFailed' });
    }
  }, [ghostId, key]);
  useEffect(() => {
    currentKey.current = key;
    setSelection({}); setBusy(false);
    void refresh();
    return () => { if (currentKey.current === key) currentKey.current = ''; };
  }, [key, refresh]);

  const change = async (request: GhostAccountReuseAction) => {
    if (busy) return;
    setBusy(true); setError(null);
    try {
      const result = await window.electronAPI.ghosts.reuseAccount(ghostId, request);
      if (currentKey.current !== key) return;
      if (!result.ok) {
        if (result.error !== 'CANCELLED') setError({ key, message: 'settings.ghosts.detail.reuseAccountChangeFailed' });
        return;
      }
      setSelection({});
      await refresh();
    } catch {
      if (currentKey.current === key) setError({ key, message: 'settings.ghosts.detail.reuseAccountChangeFailed' });
    } finally { if (currentKey.current === key) setBusy(false); }
  };
  const groups = snapshot?.key === key ? snapshot.groups : [];
  return <SettingsSection className="mt-10" title={t('settings.ghosts.detail.reuseAccountTitle')}
    description={t('settings.ghosts.detail.reuseAccountDescription')}>
    {error?.key === key ? <SettingsNotice tone="error">{t(error.message)}</SettingsNotice> : null}
    {groups.map(group => <SettingsCard key={group.key}>
      <SettingsField title={group.label} hint={group.options.length ? undefined : t('settings.ghosts.detail.reuseAccountEmpty')}>
        <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-center">
          <Select label={t('settings.ghosts.detail.reuseAccountChoose')} width="full" value={selection[group.key] ?? ''}
            options={group.options.map(source => ({ value: choiceKey(source), label: `${source.pluginName} · ${source.label ?? source.accountId.slice(0, 8)}` }))}
            onValueChange={value => setSelection(old => ({ ...old, [group.key]: value }))} disabled={busy || !enabled || !group.options.length} className="flex-1" />
          <Button variant="secondary" disabled={busy || !enabled || !group.options.some(source => choiceKey(source) === selection[group.key])} onClick={() => {
            const source = group.options.find(source => choiceKey(source) === selection[group.key]);
            if (source) void change({ kind: 'connect', secretKey: group.key, source: { instanceKey: source.instanceKey, secretKey: source.secretKey, accountId: source.accountId } });
          }}>{t('settings.ghosts.detail.reuseAccountUse')}</Button>
        </div>
      </SettingsField>
      {group.accounts.map(account => <SettingsRow key={account.id} title={account.label ?? account.id.slice(0, 8)} wrap
        hint={account.status === 'expired' ? t('settings.ghosts.detail.reuseAccountUnavailable') : undefined}
        trailing={<Button variant="secondary" disabled={busy} onClick={() => void change({ kind: 'disconnect', secretKey: group.key, accountId: account.id })}>{t('settings.ghosts.detail.reuseAccountStop')}</Button>} />)}
    </SettingsCard>)}
    <div><Button variant="secondary" size="sm" disabled={busy} onClick={() => void refresh()}>{t('settings.ghosts.detail.reuseAccountRefresh')}</Button></div>
  </SettingsSection>;
}
