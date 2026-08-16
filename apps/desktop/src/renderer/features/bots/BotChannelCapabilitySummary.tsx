import { CheckCircle2, CircleAlert, CircleSlash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import {
  botChannelFeatureCapabilities,
  type BotChannelConnection,
  type BotChannelFeature,
} from '../../../shared/botChannelRegistry';

const FEATURE_KEYS: Record<BotChannelFeature, string> = {
  'direct-messages': 'directMessages',
  groups: 'groups',
  threads: 'threads',
  replies: 'replies',
  cards: 'cards',
  reactions: 'reactions',
  attachments: 'attachments',
  'group-history': 'groupHistory',
  'durable-delivery': 'durableDelivery',
};

export function BotChannelCapabilitySummary({ connection }: { connection: BotChannelConnection }) {
  const { t, i18n } = useTranslation();
  const capabilities = botChannelFeatureCapabilities(connection);
  const native = capabilities.filter((item) => item.availability === 'native');
  const degraded = capabilities.filter((item) => item.availability === 'degraded');
  const unsupported = capabilities.filter((item) => item.availability === 'unsupported');
  const featureName = (feature: BotChannelFeature) =>
    t(`bots.channelCapabilities.features.${FEATURE_KEYS[feature]}`);
  const formatFeatures = (features: BotChannelFeature[]) =>
    new Intl.ListFormat(i18n.language, { style: 'short', type: 'conjunction' }).format(
      features.map(featureName),
    );

  return (
    <div className="mt-2 space-y-1.5 border-t border-[var(--border-default)] pt-2 text-10 leading-4">
      <div className="flex items-start gap-1.5 text-[var(--text-secondary)]">
        <CheckCircle2 size={12} className="mt-0.5 shrink-0 text-[var(--status-success)]" />
        <span>
          {t('bots.channelCapabilities.native')}:{' '}
          {formatFeatures(native.map((item) => item.feature))}
        </span>
      </div>
      {degraded.map((item) => (
        <div key={item.feature} className="flex items-start gap-1.5 text-[var(--text-secondary)]">
          <CircleAlert size={12} className="mt-0.5 shrink-0 text-[var(--warning-accent)]" />
          <span>
            {featureName(item.feature)}:{' '}
            {item.detail
              ? t(`bots.channelCapabilities.details.${item.detail}`)
              : t('bots.channelCapabilities.degradedFallback')}
          </span>
        </div>
      ))}
      {unsupported.length > 0 ? (
        <div className="flex items-start gap-1.5 text-[var(--text-tertiary)]">
          <CircleSlash2 size={12} className="mt-0.5 shrink-0" />
          <span>
            {t('bots.channelCapabilities.unsupported')}:{' '}
            {formatFeatures(unsupported.map((item) => item.feature))}
          </span>
        </div>
      ) : null}
    </div>
  );
}
