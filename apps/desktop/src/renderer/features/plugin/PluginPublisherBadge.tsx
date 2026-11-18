import { BadgeCheck, Building2, Folder, Monitor, Users } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { PluginMarketItem } from '../../../shared/pluginMarket';
import type { PluginPresentationOrigin } from './lib/pluginMarketPresentation';

type PluginPublisherProps = {
  kind?: PluginMarketItem['publisherKind'];
  origin?: PluginPresentationOrigin;
};

function publisherIdentity({ kind, origin }: PluginPublisherProps) {
  return origin === 'organization' ? 'team'
    : origin === 'custom' ? 'custom'
      : origin === 'local' ? 'local'
        : kind === 'official' ? 'official'
          : origin === 'public' && kind === 'personal' ? 'community' : null;
}

/** Display provenance only; package trust and runtime privileges remain separate. */
export function PluginPublisherBadge(props: PluginPublisherProps) {
  const { t } = useTranslation();
  const identity = publisherIdentity(props);
  if (!identity) return null;
  const Icon = { official: BadgeCheck, community: Users, team: Building2, custom: Folder, local: Monitor }[identity];
  const label = identity === 'official' || identity === 'community'
    ? t(`settings.ghosts.market.publisherKind.${identity}`)
    : t(`settings.ghosts.page.origin.${identity === 'team' ? 'organization' : identity}`);
  return (
    <span
      title={t(`settings.ghosts.market.publisherDescription.${identity}`)}
      // design: intrinsic-geometry — owner-approved provenance mark, DESIGN §10: 20px high with 5px corners.
      className="inline-flex h-5 shrink-0 items-center gap-1 whitespace-nowrap rounded-[5px] px-1.5 text-11 font-medium leading-none"
      style={{ color: identity === 'local' ? 'var(--text-secondary)' : `var(--plugin-identity-${identity}-text)`,
        backgroundColor: identity === 'local' ? 'var(--surface-chip)' : `var(--plugin-identity-${identity}-bg)` }}
    >
      <Icon size={12} strokeWidth={2} aria-hidden="true" />
      {label}
    </span>
  );
}

export function PluginPublisherDescription(props: PluginPublisherProps) {
  const { t } = useTranslation();
  const identity = publisherIdentity(props);
  return identity ? <p className="mt-3 text-12 leading-5 text-[var(--text-tertiary)]">
    {t(`settings.ghosts.market.publisherDescription.${identity}`)}
  </p> : null;
}
