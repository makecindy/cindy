import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { ProviderHookView, SlackHookView } from '../../../shared/hookControlIpc';

/** Bot identity and Feishu identity are separate: every action retains both keys. */
export function FeishuOfficialBotsPanel({ view, run, selecting, onSelect, onUnlink, onCopyCode, onCopyLink, onOpen }: {
  view: ProviderHookView;
  selecting: boolean;
  run: (action: () => Promise<{ hook: SlackHookView }>) => void;
  onOpen: (action: 'connect' | 'provider', scopeId?: string) => void;
  onSelect: (bindingId: string) => void;
  onUnlink: (bindingId: string) => void;
  onCopyCode: () => void;
  onCopyLink: () => void;
}) {
  const { t } = useTranslation();
  const key = 'settings.remoteControl.hook.feishu';
  const pending = view.binding;
  const inProgress = pending?.state === 'pending' || pending?.state === 'awaiting_confirmation';
  const connected = view.enabled && view.available && view.status === 'connected';
  return <div className="flex flex-col gap-3">
    {view.apps?.map((app) => {
      const accounts = (view.bindings ?? []).filter((row) => row.scopeId === app.scopeId);
      const linking = inProgress && pending.scopeId === app.scopeId;
      return <section key={app.scopeId} aria-label={app.scopeName ?? app.scopeId}
        className="flex flex-col gap-2 rounded-xl border border-[var(--border-default)] p-3">
        <div className="flex min-w-0 items-center gap-2">
          {app.avatarUrl ? <img src={app.avatarUrl} alt="" referrerPolicy="no-referrer" className="h-8 w-8 shrink-0 rounded-full object-cover" /> : null}
          <div className="min-w-0 flex-1">
            <div className="break-words text-13 font-medium text-[var(--text-primary)]">{app.scopeName ?? app.scopeId}</div>
            <div className="break-all text-11 text-[var(--text-tertiary)]">{app.brand === 'lark' ? 'Lark' : t(`${key}.botPlatform`)} · App ID: {app.scopeId}</div>
          </div>
        </div>
        {accounts.map((account) => <div key={account.bindingId} className="flex flex-col gap-2 border-t border-[var(--border-default)] pt-2">
          <div className="break-words text-12 text-[var(--text-primary)]">{account.localLabel || account.principalName || t(`${key}.unnamedAccount`)}</div>
          {account.localLabel && account.principalName ? <div className="break-words text-11 text-[var(--text-secondary)]">{account.principalName}</div> : null}
          <div className="select-text break-all text-11 text-[var(--text-tertiary)]">Open ID: {account.principalId}</div>
          {account.tenantKey ? <div className="select-text break-all text-11 text-[var(--text-tertiary)]">{t(`${key}.tenantId`)}: {account.tenantKey}</div> : null}
          <div className="break-words text-11 text-[var(--text-secondary)]">{t(`${key}.workingDevice`, { name: account.workingDevice?.name ?? t(`${key}.workingDeviceUnknown`) })}</div>
          <AccountRemark key={`${account.bindingId}:${account.localLabel ?? ''}`} label={account.localLabel ?? ''} placeholder={t(`${key}.accountRemark`)}
            onSave={(label) => run(() => window.electronAPI.hookControl.setFeishuAccountLabel(account.bindingId!, label))} />
          <div className="flex flex-wrap gap-2">
            {account.actions.includes('select_device') && account.workingDevice?.isCurrent === false ? <Button variant="secondary" size="xs" compact disabled={!connected || selecting}
              onClick={() => onSelect(account.bindingId!)}>{t(`${key}.setWorkingDevice`)}</Button> : null}
            {account.actions.includes('revoke') ? <Button variant="secondary" size="xs" compact disabled={!connected || inProgress}
              onClick={() => onUnlink(account.bindingId!)}>{t(`${key}.unlink`)}</Button> : null}
          </div>
        </div>)}
        {linking ? <div className="flex flex-col gap-2 border-t border-[var(--border-default)] pt-2">
          <span className="text-11 text-[var(--text-secondary)]">{t(`${key}.linkingBot`, { name: app.scopeName ?? app.scopeId })}</span>
          {pending.bindCode ? <>
            <span className="select-text break-all font-mono text-16 text-[var(--text-primary)]">{pending.bindCode}</span>
            <span className="text-11 text-[var(--text-tertiary)]">{t(`${key}.bindCode.hint`)}</span>
          </> : null}
          <div className="flex flex-wrap gap-2">
            {pending.actions.includes('copy_bind_code') ? <Button variant="secondary" size="xs" compact onClick={onCopyCode}>{t(`${key}.bindCode.copy`)}</Button> : null}
            {pending.actions.includes('open_connect_url') ? <Button variant="secondary" size="xs" compact onClick={() => onOpen('connect')}>{t(`${key}.openApp`)}</Button> : null}
            {pending.actions.includes('copy_connect_url') ? <Button variant="secondary" size="xs" compact onClick={onCopyLink}>{t('settings.remoteControl.hook.binding.copyLink')}</Button> : null}
            {pending.actions.includes('cancel') ? <Button variant="secondary" size="xs" compact disabled={!connected} onClick={() => run(() => window.electronAPI.hookControl.providerBindCancel('feishu'))}>{t(`${key}.cancel`)}</Button> : null}
          </div>
        </div> : null}
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" size="xs" compact disabled={!connected}
            onClick={() => onOpen('provider', app.scopeId)}>{t(`${key}.openBot`)}</Button>
          {accounts.length === 0 || app.multiBindAvailable ? <Button variant="secondary" size="xs" compact disabled={!connected || inProgress}
            onClick={() => run(() => window.electronAPI.hookControl.providerBindStart('feishu', app.scopeId))}>{t(accounts.length ? `${key}.addAccount` : `${key}.connect`)}</Button> : null}
        </div>
      </section>;
    })}
  </div>;
}

function AccountRemark({ label, placeholder, onSave }: { label: string; placeholder: string; onSave: (value: string) => void }) {
  const [value, setValue] = useState(label);
  return <Input value={value} onChange={setValue} maxLength={128} aria-label={placeholder} placeholder={placeholder}
    onBlur={() => { if (value.trim() !== label) onSave(value); }} />;
}
