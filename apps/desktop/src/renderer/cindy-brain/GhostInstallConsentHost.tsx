/**
 * 插件安装／更新确认框（docs/dev-rules/plugin-security-and-authoring.md §3.1）。
 *
 * Main 在用户从插件页、拖入或双击 `.cindy` 发起安装后，检查完真实包、在任何安装锁之外
 * 把确认请求投给发起安装的这个窗口；首次安装展示全部权限，更新只在权限变多时出现并
 * 高亮变化。无论确认、取消还是被 Main 收起（超时、账号切换），答案都会回给 Main。
 * 落位前 Main 还会在锁内用同一份包复核，确认框本身不是授权事实。
 */
import { useEffect, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { useConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import { isDataOwnerPushStampCurrent } from '@/contexts/dataOwnerGeneration';
import { permissionItemIcon } from '@/features/plugin/lib/permissionItemIcon';
import { cn } from '@/lib/utils';
import type { GhostPermissionItem } from '../../shared/ghost';
import type {
  GhostInstallConsentFacts,
  GhostInstallConsentRequest,
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

function ConsentPermissionRow({
  item,
  change,
}: {
  item: GhostPermissionItem;
  change?: 'added' | 'removed';
}) {
  const { t } = useTranslation();
  const Icon = permissionItemIcon(item);
  const hostDetail = item.detailKey
    ? t(`settings.ghosts.perm.${item.detailKey}`, item.detailArgs)
    : null;
  return (
    <li className={cn('flex items-start gap-2.5 py-1.5', change === 'removed' && 'opacity-60')}>
      <Icon
        size={16}
        strokeWidth={1.8}
        className="mt-0.5 shrink-0 text-[var(--text-secondary)]"
        aria-hidden="true"
      />
      <div className="min-w-0 flex-1">
        <p
          className={cn(
            // labelArgs 含作者可控的无空格长串（域名、工具名），必须可断行。
            'break-words text-13 leading-5 text-[var(--confirm-title)]',
            change === 'removed' && 'line-through',
          )}
        >
          {t(`settings.ghosts.perm.${item.labelKey}`, item.labelArgs)}
        </p>
        {hostDetail ? (
          <p className="mt-0.5 whitespace-pre-line break-words text-12 leading-[1.5] text-[var(--text-tertiary)]">
            {hostDetail}
          </p>
        ) : null}
        {item.detail ? (
          <p className="mt-0.5 whitespace-pre-line break-words text-12 leading-[1.5] text-[var(--text-tertiary)]">
            {item.detail}
          </p>
        ) : null}
      </div>
      {change === 'added' ? (
        // 权限新增是一次 diff，沿用 diff 语义色（跨主题 token）。徽章是 chrome，不可选中。
        <span className="mt-0.5 shrink-0 select-none rounded-full px-1.5 py-px text-11 font-medium bg-[var(--diff-add-bg)] text-[var(--diff-add-fg)]">
          {t('settings.ghosts.installConsent.addedBadge')}
        </span>
      ) : null}
    </li>
  );
}

function ConsentSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mt-3 first:mt-0">
      <h3 className="text-12 font-medium leading-[1.5] text-[var(--text-secondary)]">{title}</h3>
      <ul className="mt-1">{children}</ul>
    </section>
  );
}

export function GhostInstallConsentContent({ facts }: { facts: GhostInstallConsentFacts }) {
  const { t } = useTranslation();
  if (facts.kind === 'install') {
    return (
      <div>
        <p className="text-13 leading-5 text-[var(--confirm-desc)]">
          {t('settings.ghosts.installConsent.installDescription')}
        </p>
        <div className="mt-3">
          {facts.permissions.length === 0 ? (
            <p className="text-13 leading-5 text-[var(--confirm-desc)]">
              {t('settings.ghosts.installConsent.noPermissions')}
            </p>
          ) : (
            <ConsentSection title={t('settings.ghosts.installConsent.grantsTitle')}>
              {facts.permissions.map((item) => (
                <ConsentPermissionRow key={item.key} item={item} />
              ))}
            </ConsentSection>
          )}
        </div>
      </div>
    );
  }
  return (
    <div>
      <p className="text-13 leading-5 text-[var(--confirm-desc)]">
        {t('settings.ghosts.installConsent.updateDescription')}
      </p>
      {facts.builtinOauthClientChanged ? (
        <p className="mt-2 text-13 leading-5 text-[var(--confirm-desc)]">
          {t('settings.ghosts.installConsent.oauthClientChanged')}
        </p>
      ) : null}
      <div className="mt-3">
        {facts.added.length > 0 ? (
          <ConsentSection title={t('settings.ghosts.installConsent.addedTitle')}>
            {facts.added.map((item) => (
              <ConsentPermissionRow key={item.key} item={item} change="added" />
            ))}
          </ConsentSection>
        ) : null}
        {facts.removed.length > 0 ? (
          <ConsentSection title={t('settings.ghosts.installConsent.removedTitle')}>
            {facts.removed.map((item) => (
              <ConsentPermissionRow key={item.key} item={item} change="removed" />
            ))}
          </ConsentSection>
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
        void (async () => {
          let confirmed = false;
          try {
            // 账号已切换的旧请求不渲染任何插件事实，直接按取消回给 Main。
            if (ownerStamp !== undefined && !isDataOwnerPushStampCurrent(ownerStamp)) return;
            const { facts } = request;
            const source = ghostInstallConsentSourceLabel(t, request);
            confirmed = await confirm(
              {
                title:
                  facts.kind === 'install'
                    ? t('settings.ghosts.installConsent.installTitle', { name: facts.name })
                    : t('settings.ghosts.installConsent.updateTitle', { name: facts.name }),
                description:
                  facts.kind === 'install'
                    ? t('settings.ghosts.installConsent.installMeta', {
                        version: facts.version,
                        source,
                      })
                    : t('settings.ghosts.installConsent.updateMeta', {
                        from: facts.previousVersion,
                        to: facts.version,
                        source,
                      }),
                content: <GhostInstallConsentContent facts={facts} />,
                maxWidth: 460,
                contentSelectable: true,
                describeContent: true,
                confirmText:
                  facts.kind === 'install'
                    ? t('settings.ghosts.installConsent.confirmInstall')
                    : t('settings.ghosts.installConsent.confirmUpdate'),
                cancelText: t('settings.ghosts.installConsent.cancel'),
              },
              abort.signal,
            );
          } finally {
            aborts.delete(request.requestId);
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
      for (const abort of aborts.values()) abort.abort();
      aborts.clear();
    };
  }, [confirm, t]);

  return null;
}
