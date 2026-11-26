import { Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { SettingsCard, SettingsPageHeader } from '@/components/ui/settings-rows';
import { LocalModelCatalogNotice } from '@/components/new-chat/LocalModelCatalogNotice';
import { CloudAuthProgress } from './CloudAuthProgress';
import { ProviderListEntry } from '@/components/settings/ProviderListEntry';
import { ProviderAccountHeader, ConnectedPill } from '@/components/settings/ProviderAccountHeader';
import { OAuthBrowserLink, OAuthDeviceCodeCard } from '@/components/settings/OAuthDeviceCodeCard';
import { SettingsTextInput } from '@/components/settings/SettingsTextInput';
import { ProviderLogoMark, hasProviderLogo } from '@/components/icons/ProviderLogoMark';
import type { ManagementItem } from '../../../shared/settingsManagement';

import {
  useCloudAuthorization,
  supportedActions,
  type CloudAuthorizationProps,
} from './useCloudAuthorization';
export function CloudProviderAuthorization(props: CloudAuthorizationProps) {
  const { name, online, trial = false } = props;
  const {
    t,
    items,
    selected,
    setSelected,
    loading,
    failure,
    readFailure,
    setFailure,
    operationItem,
    callback,
    setCallback,
    requesting,
    run,
    operate,
    prompt,
    open,
    busy,
    phaseText,
    progressUnreadable,
    settling,
    checking,
  } = useCloudAuthorization(props, 'providers');
  const item = items.find((value) => value.id === selected);
  const ownsOperation = item?.id === operationItem;
  const buttonDisabled = !online || requesting || loading;
  const logo = (entry: ManagementItem, size = 18) => {
    const id = entry.id.replace(/^(provider:|add:)/, '');
    return hasProviderLogo(id) ? (
      <ProviderLogoMark providerId={id} size={size} />
    ) : (
      <span className="text-15 font-medium leading-none">{entry.label.slice(0, 1)}</span>
    );
  };
  return (
    <section
      className="flex min-h-0 flex-col gap-[14px]"
      aria-label={t('settings.providers.title')}
    >
      {/* The page title of the local providers page. A failed read shows its own reload, below. */}
      <SettingsPageHeader
        title={t('settings.providers.title')}
        description={t('cloudSettings.authScope', { name })}
      />
      {failure && failure !== 'readFailed' && (
        <p role="alert" className="text-13 text-[var(--text-secondary)]">
          {t(`cloudSettings.${failure}`)}
        </p>
      )}
      {/* The client's one notice for a model list it cannot update; while reading,
          nothing. */}
      {readFailure && (
        <LocalModelCatalogNotice
          failure={{ reason: 'catalog-unavailable' }}
          onRetry={async () => {
            readFailure.reload();
            return true;
          }}
        />
      )}
      {!!items.length && (
        <SettingsCard className="flex min-h-[340px]">
          <div className="flex w-[224px] shrink-0 flex-col gap-0.5 border-r border-[var(--settings-theme-card-border)] p-2">
            {items.map((entry) => (
              <div
                key={entry.id}
                className={`relative flex w-full items-center rounded-lg text-left transition-colors ${entry.id === selected ? 'bg-[var(--settings-menu-bg-selected)]' : 'hover:bg-[var(--settings-menu-bg-hover)]'}`}
              >
                <ProviderListEntry
                  selected={entry.id === selected}
                  title={
                    entry.id.startsWith('add:')
                      ? t('cloudSettings.authAdd', { provider: entry.label })
                      : entry.label
                  }
                  icon={entry.id.startsWith('add:') ? <Plus size={14} /> : logo(entry, 14)}
                  disabled={busy && entry.id !== operationItem}
                  onSelect={() => {
                    setSelected(entry.id);
                    setFailure(undefined);
                  }}
                  statusColor={
                    entry.status === 'connected'
                      ? 'var(--remote-status-ready)'
                      : 'var(--border-default)'
                  }
                />
              </div>
            ))}
          </div>
          <div className="flex min-w-0 flex-1 flex-col">
            {item && (
              <>
                <ProviderAccountHeader
                  icon={logo(item)}
                  title={item.label}
                  subtitle={name}
                  actions={
                    <>
                      {item.status === 'connected' && <ConnectedPill />}
                      {ownsOperation && busy ? (
                        <Button
                          variant="secondary"
                          size="md"
                          disabled={buttonDisabled}
                          onClick={() => void operate('cancel')}
                        >
                          {t('settings.providers.button.cancel')}
                        </Button>
                      ) : (
                        supportedActions(item).map((action) => (
                          <Button
                            key={action.id}
                            variant="secondary"
                            size="md"
                            // While an unknown result is read back, only this button spins.
                            loading={ownsOperation && checking}
                            disabled={
                              buttonDisabled ||
                              busy ||
                              (ownsOperation && settling)
                            }
                            onClick={() => void run(item, action)}
                          >
                            {t(
                              action.intent === 'disconnect'
                                ? 'settings.providers.button.disconnect'
                                : 'settings.providers.button.authorize',
                            )}
                          </Button>
                        ))
                      )}
                    </>
                  }
                />
                <div className="flex flex-col gap-3 px-5 pb-4">
                  {ownsOperation && (
                    <CloudAuthProgress
                      text={phaseText}
                      unreadable={progressUnreadable}
                      disabled={buttonDisabled}
                    />
                  )}
                  {ownsOperation && prompt && (
                    <>
                      {prompt.kind === 'device' && prompt.userCode ? (
                        <OAuthDeviceCodeCard
                          deviceCode={{
                            verificationUrl: prompt.url,
                            userCode: prompt.userCode,
                            expiresAt: prompt.expiresAt,
                          }}
                          onOpen={open}
                        />
                      ) : (
                        <OAuthBrowserLink url={prompt.url} onOpen={open} />
                      )}
                      {prompt.kind === 'callback' && (
                        <form
                          className="flex flex-col gap-2"
                          onSubmit={(event) => {
                            event.preventDefault();
                            if (callback.trim()) void operate('respond');
                          }}
                        >
                          <label
                            className="text-13 text-[var(--text-secondary)]"
                            htmlFor="cloud-auth-callback"
                          >
                            {t('cloudSettings.authCallback')}
                          </label>
                          <SettingsTextInput
                            id="cloud-auth-callback"
                            type="password"
                            autoComplete="off"
                            value={callback}
                            onChange={setCallback}
                            disabled={buttonDisabled}
                          />
                          <Button
                            type="submit"
                            variant="secondary"
                            size="md"
                            disabled={buttonDisabled || !callback.trim()}
                          >
                            {t('cloudSettings.authContinue')}
                          </Button>
                        </form>
                      )}
                    </>
                  )}
                  {ownsOperation && trial && prompt && (
                    <Button
                      variant="secondary"
                      size="md"
                      onClick={() => {
                        void operate('respond');
                      }}
                    >
                      {t('cloudSettings.authTrialComplete')}
                    </Button>
                  )}
                  {trial && (
                    <p className="text-12 text-[var(--text-tertiary)]">
                      {t('cloudSettings.authTrial')}
                    </p>
                  )}
                </div>
              </>
            )}
          </div>
        </SettingsCard>
      )}
      {/* Nothing to sign in to, and no 「添加供应商」 on this list (as RemoteBotSettings). */}
      {!loading && !failure && !items.length && (
        <p className="py-3 text-13 text-[var(--text-secondary)]">{t('bots.remoteSettings.unsupported')}</p>
      )}
    </section>
  );
}
