import { Button } from '@/components/ui/button';
import type { MakerVendor } from '@/lib/ccAgent.types';
import type { BotModelRoute } from '../../../shared/botModelChain';
import { BotModelChainEditor } from './BotModelChainEditor';
import { useBotTranslation } from './botPronounContext';

/** A purpose-specific override using the same complete-route picker as the primary model. */
export function BotTaskModelEditor({ value, inheritedRoute, onChange, disabled, hiddenVendors, deviceId }: {
  value: BotModelRoute | null;
  inheritedRoute?: BotModelRoute;
  onChange(value: BotModelRoute | null): void;
  disabled?: boolean;
  hiddenVendors?: MakerVendor[];
  deviceId?: string;
}) {
  const { t } = useBotTranslation();
  const route = value ?? inheritedRoute;
  return <div className="mt-4 min-w-0 border-t border-[var(--border-default)] pt-4" data-testid="bot-task-model-controls">
    <BotModelChainEditor label={t('bots.model.task')} value={route ? [route] : []}
      allowFallbacks={false} disabled={disabled} hiddenVendors={hiddenVendors} deviceId={deviceId}
      onChange={routes => { if (routes[0]) onChange(routes[0]); }} />
    {value ? <Button variant="secondary" tone="quiet" size="sm" compact disabled={disabled}
      onClick={() => onChange(null)}>{t('bots.model.inheritPrimary')}</Button>
      : <p className="mt-1 text-12 leading-5 text-[var(--text-secondary)]">{t('bots.model.inheritingPrimary')}</p>}
  </div>;
}
