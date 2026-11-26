import { ChevronDown, Shield, type LucideIcon } from 'lucide-react';
import { useId, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { GhostPermissionItem } from '../../../shared/ghost';
import { permissionItemDetail } from '../../../shared/ghostPermissionDetail';
import { permissionItemIcon } from './lib/permissionItemIcon';
import { usePluginDetailChoice } from './PluginDetailRecord';

export interface PluginPermissionFact {
  key: string;
  title: string;
  descriptions: readonly string[];
  icon?: LucideIcon;
  highRisk?: boolean;
}

export function usePluginPermissionFacts(items: readonly GhostPermissionItem[]): PluginPermissionFact[] {
  const { t, i18n } = useTranslation();
  const hosts = items.filter(item => item.labelKey === 'networkHost' && item.labelArgs?.host);
  const hostText = hosts.map(item => item.labelArgs?.host).join(i18n?.language?.startsWith('zh') ? '、' : ', ');
  return items.flatMap(item => {
    const host = item.labelKey === 'networkHost' && item.labelArgs?.host;
    if (host && item !== hosts[0]) return [];
    const detail = permissionItemDetail(item, t);
    return [{
      key: item.key,
      title: hosts.length > 1 && host ? t('settings.ghosts.perm.networkHosts') : t('settings.ghosts.perm.' + item.labelKey, item.labelArgs),
      descriptions: [hosts.length > 1 && host ? hostText : '', detail, item.detail].filter((value): value is string => Boolean(value)),
      icon: permissionItemIcon(item),
      highRisk: item.detailKey === 'nodeRuntimeDetail' || item.detailKey === 'nodeMcpDetail' ||
        detail?.startsWith('高风险') || detail?.startsWith('高風險') || detail?.startsWith('High risk'),
    }];
  });
}

export function PluginLimitedList<T>({ items, limit = 5, choiceKey, className, buttonClassName, renderItem }: {
  items: readonly T[];
  limit?: number;
  choiceKey?: string;
  className?: string;
  buttonClassName?: string;
  renderItem: (item: T) => ReactNode;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = usePluginDetailChoice(choiceKey);
  const id = useId();
  const remaining = items.length - limit;
  return (
    <>
      <ul id={id} className={className}>{(expanded || remaining <= 0 ? items : items.slice(0, limit)).map(renderItem)}</ul>
      {remaining > 0 ? (
        <Button type="button" variant="secondary" tone="quiet" size="sm" className={cn('mt-3', buttonClassName)}
          aria-controls={id} aria-expanded={expanded ?? false} onClick={() => setExpanded(!expanded)}>
          {expanded ? t('settings.ghosts.detail.descriptionCollapse') : t('settings.ghosts.detail.remainingPermissions', { count: remaining })}
          <ChevronDown size={14} aria-hidden="true" className={expanded ? 'rotate-180' : undefined} />
        </Button>
      ) : null}
    </>
  );
}

/** Groups display facts only; the caller retains the original approval items. */
export function PluginPermissionList({ items, showAll = false, limit = 5, choiceKey, change }: {
  items: readonly PluginPermissionFact[];
  showAll?: boolean;
  limit?: number;
  choiceKey?: string;
  change?: 'added' | 'removed';
}) {
  const { t } = useTranslation();
  return (
    <div>
      <PluginLimitedList items={items} limit={showAll ? items.length : limit} choiceKey={choiceKey} className="space-y-4"
        renderItem={item => {
          const Icon = item.icon ?? Shield;
          return (
            <li key={item.key} className="flex items-start gap-3">
              <Icon size={18} aria-hidden="true" className={cn('mt-0.5 shrink-0', item.highRisk ? 'text-[var(--warning-fg)]' : 'text-[var(--text-secondary)]')} />
              <div className="min-w-0 flex-1">
                <p className={cn('break-words text-14 font-medium leading-[1.429] text-[var(--text-primary)]', change === 'removed' && 'line-through')}>{item.title}</p>
                {item.descriptions.map((description, index) => (
                  <p key={index} className="mt-1 whitespace-pre-line break-words text-13 leading-[1.54] text-[var(--text-secondary)]">{description}</p>
                ))}
              </div>
              {change === 'added' ? <Badge>{t('settings.ghosts.installConsent.addedBadge')}</Badge> : null}
            </li>
          );
        }} />
    </div>
  );
}
