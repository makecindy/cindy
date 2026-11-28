import { pluginSourceWarningKey } from '@cindy/maker-shared/mcp-apps';
/**
 * 插件安装／更新确认框（docs/dev-rules/plugin-security-and-authoring.md §3.1）。
 *
 * Main 在用户从插件页、拖入或双击 `.cindy` 发起安装后，检查完真实包、在任何安装锁之外
 * 把确认请求投给发起安装的这个窗口；首次安装展示全部权限，更新高亮权限变化，分享覆盖
 * 另需明确确认替换。无论确认、取消还是被 Main 收起（超时、账号切换），答案都会回给 Main。
 * 落位前 Main 还会在锁内用同一份包复核，确认框本身不是授权事实。
 */
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';

import { useConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import { isDataOwnerPushStampCurrent } from '@/contexts/dataOwnerGeneration';
import { PluginPermissionList, usePluginPermissionFacts } from '@/features/plugin/PluginPermissionList';
import type { GhostPermissionItem } from '../../shared/ghost';
import {
  ghostInstallSourceNoticeKey,
  type GhostInstallConsentFacts,
  type GhostInstallConsentRequest,
} from '../../shared/ghostInstallConsent';

type Translate = ReturnType<typeof useTranslation>['t'];

/** 来源说明与 Main 侧任务确认卡同口径（ghostInstallConsentInteraction.ts）。 */
export function ghostInstallConsentSourceLabel(
  t: Translate,
  request: Pick<GhostInstallConsentRequest, 'initiator' | 'origin' | 'originLabel'>,
): string {
  const origin =
    request.origin === 'market'
      ? t('settings.ghosts.installConsent.originMarket')
      : request.origin === 'custom-market'
        ? request.originLabel
          ? t('settings.ghosts.installConsent.originCustomMarket', { name: request.originLabel })
          : t('settings.ghosts.installConsent.originCustomMarketUnnamed')
        : request.origin === 'local-file'
          ? t('settings.ghosts.installConsent.originLocalFile')
          : t('settings.ghosts.installConsent.originForge');
  return request.initiator === 'agent'
    ? t('settings.ghosts.installConsent.initiatedByAgent', { origin })
    : origin;
}

function ConsentSection({ title, items, countLabel, change }: {
  title: string;
  items: readonly GhostPermissionItem[];
  countLabel?: string;
  change?: 'added' | 'removed';
}) {
  const displayFacts = usePluginPermissionFacts(items);
  return (
    <section className="mt-4 first:mt-0">
      <h3 className="mb-3 flex flex-wrap items-baseline gap-x-2 text-14 font-medium leading-[1.43] text-[var(--confirm-title)]">
        <span>{title}</span>
        {countLabel ? <span className="text-12 tabular-nums text-[var(--text-secondary)]">{countLabel}</span> : null}
      </h3>
      <PluginPermissionList items={displayFacts} change={change} showAll />
    </section>
  );
}

export function GhostInstallConsentContent({ facts, origin, communityMarket, capabilityOnly = false, replacement = false, sourceChanged = false }: {
  facts: GhostInstallConsentFacts; origin?: GhostInstallConsentRequest['origin'];
  communityMarket?: GhostInstallConsentRequest['communityMarket'];
  capabilityOnly?: boolean; replacement?: boolean; sourceChanged?: boolean;
}) {
  const { t } = useTranslation();
  if (facts.kind === 'install') {
    const sourceNotice = ghostInstallSourceNoticeKey(origin, communityMarket);
    return (
      <div>
        <p className="text-13 leading-5 text-[var(--confirm-desc)]">
          {t('settings.ghosts.installConsent.installDescription')}
        </p>
        {sourceNotice ? (
          <p className={sourceNotice === 'settings.ghosts.market.communityDisclaimer'
            ? 'mt-2 text-12 leading-[1.5] text-[var(--text-tertiary)]'
            : 'mt-2 text-13 leading-[1.54] text-[var(--confirm-desc)]'}>
            {t(sourceNotice)}
          </p>
        ) : null}
        <div className="mt-3">
          {facts.permissions.length === 0 ? (
            <p className="text-13 leading-5 text-[var(--confirm-desc)]">
              {t('settings.ghosts.installConsent.noPermissions')}
            </p>
          ) : (
            <ConsentSection
              title={t('settings.ghosts.installConsent.grantsTitle')}
              items={facts.permissions}
              countLabel={t('settings.ghosts.perm.itemCount', { count: facts.permissions.length })}
            />
          )}
        </div>
      </div>
    );
  }
  return (
    <div>
      <p className="text-13 leading-5 text-[var(--confirm-desc)]">
        {capabilityOnly ? null : t(replacement ? 'sharing.localReplaceNotice' : 'settings.ghosts.installConsent.updateDescription')}
      </p>
      {replacement ? <p className="mt-2 text-13 leading-5 text-[var(--confirm-desc)]">
        {t(sourceChanged ? 'settings.ghosts.installConsent.sourceChanged' : 'sharing.localReplaceRetainsState')}
      </p> : null}
      {facts.builtinOauthClientChanged ? (
        <p className="mt-2 text-13 leading-5 text-[var(--confirm-desc)]">
          {t('settings.ghosts.installConsent.oauthClientChanged')}
        </p>
      ) : null}
      <div className="mt-3">
        {facts.added.length > 0 ? (
          <ConsentSection
            title={t('settings.ghosts.installConsent.addedTitle')}
            items={facts.added}
            change="added"
          />
        ) : null}
        {facts.removed.length > 0 ? (
          <ConsentSection
            title={t('settings.ghosts.installConsent.removedTitle')}
            items={facts.removed}
            change="removed"
          />
        ) : null}
        {facts.unchangedCount > 0 ? (
          <p className="mt-3 text-12 leading-[1.5] text-[var(--text-tertiary)]">
            {t('settings.ghosts.installConsent.unchangedCount', { count: facts.unchangedCount })}
          </p>
        ) : null}
      </div>
    </div>
  );
}

function isConsentRequest(payload: unknown): payload is GhostInstallConsentRequest {
  if (!payload || typeof payload !== 'object') return false;
  const request = payload as Partial<GhostInstallConsentRequest>;
  const facts = request.facts as Partial<GhostInstallConsentFacts> | undefined;
  return (
    typeof request.requestId === 'string' &&
    (request.initiator === 'user' || request.initiator === 'agent') &&
    typeof request.origin === 'string' &&
    !!facts &&
    (facts.kind === 'install' || facts.kind === 'update') &&
    typeof facts.name === 'string' &&
    typeof facts.version === 'string'
  );
}

/** 挂在每个窗口的 ConfirmDialogProvider 内；Main 只把请求投给发起安装的那个窗口。 */
export function GhostInstallConsentHost() {
  const { t } = useTranslation();
  const { confirm } = useConfirmDialog();

  useEffect(() => {
    const aborts = new Map<string, AbortController>();
    let disconnect: (() => void) | undefined;
    const unsubscribeDismissed = window.electronAPI.ghosts.onInstallConsentDismissed(
      (payload) => {
        if (payload && typeof payload.requestId === 'string') {
          aborts.get(payload.requestId)?.abort();
        }
      },
    );
    const unsubscribeRequest = window.electronAPI.ghosts.onInstallConsentRequest(
      (payload, ownerStamp) => {
        if (!isConsentRequest(payload)) return;
        const request = payload;
        const abort = new AbortController();
        aborts.set(request.requestId, abort);
        if (window.electronAPI.hostConnection?.client === 'browser') {
          disconnect ??= window.electronAPI.hostConnection.onStateChanged(state => {
            if (state.status !== 'connected') for (const pendingAbort of aborts.values()) pendingAbort.abort();
          });
        }
        void (async () => {
          let confirmed = false;
          try {
            // 账号已切换的旧请求不渲染任何插件事实，直接按取消回给 Main。
            if (ownerStamp !== undefined && !isDataOwnerPushStampCurrent(ownerStamp)) return;
            const { facts } = request;
            const capabilityOnly = request.purpose === 'task-capability' || request.purpose === 'ui-capability';
            const replacement = request.purpose === 'share-replace' && facts.kind === 'update';
            const source = ghostInstallConsentSourceLabel(t, request);
            confirmed = await confirm(
              {
                title:
                  capabilityOnly ? facts.name : replacement
                    ? t('sharing.localReplaceTitle', { name: facts.name }) : facts.kind === 'install'
                    ? t('settings.ghosts.installConsent.installTitle', { name: facts.name })
                    : t('settings.ghosts.installConsent.updateTitle', { name: facts.name }),
                description:
                  capabilityOnly ? t('settings.ghosts.installConsent.addedTitle') : facts.kind === 'install'
                    ? t('settings.ghosts.installConsent.installMeta', {
                        version: facts.version,
                        source,
                      })
                    : t('settings.ghosts.installConsent.updateMeta', {
                        from: facts.previousVersion,
                        to: facts.version,
                        source,
                      }),
                content: <>
                  {pluginSourceWarningKey(request.installationSource) && (facts.kind === 'install' ? facts.permissions : facts.added).some(item => item.key === 'ui:pages') &&
                    <p className="mb-3 text-13 font-medium text-[var(--warning-fg)]">{t(pluginSourceWarningKey(request.installationSource)!)}</p>}
                  {request.target && <div className="mb-3 space-y-2 text-13 leading-5 text-[var(--confirm-desc)]">
                    <p>{t('settings.ghosts.installConsent.targetIdentity', { name: request.target.namespace === 'local' ? t('settings.ghosts.installConsent.localTarget') : request.target.namespace || t('settings.ghosts.installConsent.personalTarget') })}</p>
                    {request.target.organizationIdentityUnavailable && <p>{t('settings.ghosts.installConsent.localOidcUnavailable')}</p>}
                    {request.target.sourceChanged && !replacement && <p>{t('settings.ghosts.installConsent.sourceChanged')}</p>}
                    {request.target.otherCopies > 0 && <p>{t('settings.ghosts.installConsent.otherCopies', { count: request.target.otherCopies })}</p>}
                  </div>}
                  <GhostInstallConsentContent facts={facts} origin={request.origin} communityMarket={request.communityMarket} capabilityOnly={capabilityOnly}
                    replacement={replacement} sourceChanged={request.target?.sourceChanged} />
                </>,
                maxWidth: 440,
                contentSelectable: true,
                describeContent: true,
                confirmText:
                  capabilityOnly ? t('settings.ghosts.connections.confirmAllow') : replacement
                    ? t('sharing.localReplaceButton') : facts.kind === 'install'
                    ? t('settings.ghosts.installConsent.confirmInstall')
                    : t('settings.ghosts.installConsent.confirmUpdate'),
                cancelText: t('settings.ghosts.installConsent.cancel'),
              },
              abort.signal,
            );
            confirmed = confirmed && !abort.signal.aborted;
          } finally {
            aborts.delete(request.requestId);
            if (!aborts.size) { disconnect?.(); disconnect = undefined; }
            try {
              await window.electronAPI.ghosts.resolveInstallConsent(request.requestId, confirmed);
            } catch {
              // 窗口销毁或 Main 已按超时结算时，这次回答不再生效。
            }
          }
        })();
      },
    );
    return () => {
      unsubscribeRequest();
      unsubscribeDismissed();
      disconnect?.();
      disconnect = undefined;
      for (const abort of aborts.values()) abort.abort();
      aborts.clear();
    };
  }, [confirm, t]);

  return null;
}
