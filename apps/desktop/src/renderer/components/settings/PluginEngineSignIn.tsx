/**
 * Signing a plugin engine account in (subscription-account-pools.md 插件引擎的账号): the plugin
 * lists its methods. A single browser method starts right away, as built-in accounts do; otherwise
 * a dialog picks the method and, for a method that needs one, takes the key. The key goes from
 * this window to the plugin only; Cindy does not keep it.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Input } from '@/components/ui/input';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { useConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import type { PluginEnginePoolInfo } from '../../../shared/subscriptionAccounts';

type Method = PluginEnginePoolInfo['methods'][number];
export interface PluginSignInChoice {
  methodId: string;
  secret?: string;
}

function SignInForm({ methods, onChange }: { methods: readonly Method[]; onChange: (choice: PluginSignInChoice | null) => void }) {
  const { t } = useTranslation();
  const [methodId, setMethodId] = useState(methods[0]!.id);
  const [secret, setSecret] = useState('');
  const method = methods.find((item) => item.id === methodId) ?? methods[0]!;
  const report = (nextMethod: Method, nextSecret: string) => {
    if (nextMethod.kind === 'secret') onChange(nextSecret.trim() ? { methodId: nextMethod.id, secret: nextSecret } : null);
    else onChange({ methodId: nextMethod.id });
  };
  return (
    <div className="flex flex-col gap-3" data-testid="plugin-engine-sign-in">
      {methods.length > 1 && (
        <SegmentedControl
          data-settings-search-action="Choose how the plugin signs in the account being added in this dialog"
          aria-label={t('subscriptionAccounts.pluginSignIn.method')}
          value={methodId}
          options={methods.map((item) => ({ value: item.id, label: item.label }))}
          onValueChange={(value) => {
            setMethodId(value);
            const next = methods.find((item) => item.id === value) ?? methods[0]!;
            report(next, secret);
          }}
        />
      )}
      {method.kind === 'secret' ? (
        <>
          <Input
            data-settings-search-action="Enter the API key of the plugin engine account being signed in in this dialog"
            secret
            mono
            autoFocus
            value={secret}
            ariaLabel={method.secretLabel ?? method.label}
            placeholder={method.secretLabel ?? method.label}
            onChange={(value) => {
              setSecret(value);
              report(method, value);
            }}
          />
          <p className="text-12 leading-[1.5] text-[var(--text-tertiary)]">
            {t('subscriptionAccounts.pluginSignIn.secretHint')}
          </p>
        </>
      ) : (
        <p className="text-13 leading-[1.5] text-[var(--text-secondary)]">
          {t('subscriptionAccounts.pluginSignIn.browserHint')}
        </p>
      )}
    </div>
  );
}

/** Resolves the sign-in choice, or null when the user cancels. */
export function usePluginEngineSignIn(): (methods: readonly Method[], title: string) => Promise<PluginSignInChoice | null> {
  const { t } = useTranslation();
  const { confirm } = useConfirmDialog();
  return async (methods, title) => {
    if (methods.length === 0) return null;
    if (methods.length === 1 && methods[0]!.kind === 'browser') return { methodId: methods[0]!.id };
    let choice: PluginSignInChoice | null = methods[0]!.kind === 'browser' ? { methodId: methods[0]!.id } : null;
    const ok = await confirm({
      title,
      content: <SignInForm methods={methods} onChange={(next) => { choice = next; }} />,
      confirmText: t('subscriptionAccounts.login'),
    });
    return ok && choice ? choice : null;
  };
}
