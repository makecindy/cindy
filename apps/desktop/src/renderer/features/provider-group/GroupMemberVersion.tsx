import type { ComponentPropsWithoutRef } from 'react';
import { useTranslation } from 'react-i18next';

import { Tip } from '@/components/ui/tooltip';

import type { ProviderGroupMemberStatus } from '../../../shared/providerGroup';

type VersionStatus = Pick<ProviderGroupMemberStatus, 'appVersion' | 'guestSupport'>;

/** 版本和更新提示并入名称行，未知信息只在悬停说明中展开。 */
export function GroupMemberVersion({ status }: { status: VersionStatus | undefined }) {
  const { t } = useTranslation();
  const needsUpdate = status?.guestSupport === 'needs-update';
  if (!status?.appVersion && !needsUpdate) return null;
  return (
    <span className="inline-flex shrink-0 items-baseline gap-2 text-12 text-[var(--text-tertiary)]">
      {status?.appVersion && <span>v{status.appVersion}</span>}
      {needsUpdate && (
        <span className="text-[var(--warning-fg)]">{t('providerGroup.member.version.updateRequired')}</span>
      )}
    </span>
  );
}

/** 整个名称按钮可悬停或聚焦查看说明，不额外增加按钮或常驻信息行。 */
export function GroupMemberDetailsButton({ status, ...props }: {
  status: VersionStatus | undefined;
} & ComponentPropsWithoutRef<'button'>) {
  const { t } = useTranslation();
  const details = [status?.appVersion
    ? t('providerGroup.member.version.current', { version: status.appVersion })
    : t('providerGroup.member.version.unknown')];
  if (status?.guestSupport === 'needs-update') details.push(t('providerGroup.member.version.needsUpdate'));
  else if (!status?.guestSupport || status.guestSupport === 'unknown') details.push(t('providerGroup.member.version.supportUnknown'));
  return <Tip text={status ? details.join(' · ') : null}><button {...props} /></Tip>;
}
