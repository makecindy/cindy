import { useEffect } from 'react';
import { Trans, useTranslation } from 'react-i18next';

import { useConfirmDialog } from '@/components/ui/confirm-dialog-provider';

/** 企业作者显式 Forge 安装时的 OIDC 窄确认；不承载通用能力审核。 */
export function ForgeOidcInstallConfirmHost() {
  const { t } = useTranslation();
  const { confirm } = useConfirmDialog();

  useEffect(() => {
    return window.electronAPI.ghosts.onForgeOidcInstallConfirmRequest((payload) => {
      if (
        !payload ||
        typeof payload.requestId !== 'string' ||
        typeof payload.ghostId !== 'string' ||
        typeof payload.ghostName !== 'string' ||
        !Array.isArray(payload.hosts) ||
        !payload.hosts.every((host) => typeof host === 'string')
      ) {
        return;
      }
      void (async () => {
        let confirmed = false;
        try {
          confirmed = await confirm({
            title: t('settings.ghosts.forgeOidcInstallConfirm.title'),
            description: t('settings.ghosts.forgeOidcInstallConfirm.description'),
            content: (
              <dl className="space-y-3 text-13 text-[var(--confirm-desc)]">
                <div>
                  <dt className="text-[var(--text-tertiary)]">
                    {t('settings.ghosts.forgeOidcInstallConfirm.pluginNameLabel')}
                  </dt>
                  <dd className="mt-0.5 font-medium text-[var(--confirm-title)]">
                    {payload.ghostName}
                  </dd>
                </div>
                <div>
                  <dt className="text-[var(--text-tertiary)]">
                    {t('settings.ghosts.forgeOidcInstallConfirm.pluginIdLabel')}
                  </dt>
                  <dd className="mt-0.5 font-mono text-[var(--confirm-title)]">
                    {payload.ghostId}
                  </dd>
                </div>
                <div>
                  <dt className="text-[var(--text-tertiary)]">
                    {t('settings.ghosts.forgeOidcInstallConfirm.hostsLabel')}
                  </dt>
                  <dd className="mt-0.5 space-y-0.5 font-mono text-[var(--confirm-title)]">
                    {payload.hosts.map((host) => (
                      <div key={host}>{host}</div>
                    ))}
                  </dd>
                </div>
              </dl>
            ),
            maxWidth: 460,
            contentSelectable: true,
            describeContent: true,
            requireTypedConfirmation: {
              expected: payload.ghostId,
              label: (
                <Trans
                  i18nKey="settings.ghosts.forgeOidcInstallConfirm.typedIdLabel"
                  values={{ id: payload.ghostId }}
                  components={{
                    strong: <strong className="font-semibold text-[var(--confirm-title)]" />,
                  }}
                />
              ),
            },
            confirmText: t('settings.ghosts.forgeOidcInstallConfirm.confirm'),
            cancelText: t('settings.ghosts.forgeOidcInstallConfirm.cancel'),
          });
        } finally {
          try {
            await window.electronAPI.ghosts.resolveForgeOidcInstallConfirm(
              payload.requestId,
              confirmed,
            );
          } catch {
            // main 侧超时或 owner boundary 会按未确认收口。
          }
        }
      })();
    });
  }, [confirm, t]);

  return null;
}
