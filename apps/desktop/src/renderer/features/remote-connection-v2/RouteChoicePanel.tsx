/**
 * RouteChoicePanel —— 卡片里的「线路选择」区：直连与中转各占一行写最近测得的延迟，
 * 正在用的那条带绿点；可切换时下面跟「自动 / 直连 / 中转」三档。
 * 设备连接拓扑（DeviceNodePopover）与远程供应商拓扑（RemoteProviderTopology）共用一份，
 * 用户要求 2026-11-26：远程供应商卡片的路径与延迟改成和设备卡片同一种写法。
 */

import { useTranslation } from 'react-i18next';

import { SegmentedControl } from '@/components/ui/segmented-control';
import { cn } from '@/lib/utils';

import type { DeviceLinkPeerPathPreference } from '../../../shared/deviceLinkIpc';
import { AutoRouteInfoButton } from './AutoRouteInfoButton';
import { formatRtt } from './topologyPresentation';

function RouteOptionRow({
  active,
  label,
  rttText,
  available,
}: {
  active: boolean;
  label: string;
  rttText: string;
  available: boolean;
}) {
  return (
    <div className="flex items-start justify-between gap-3 text-12 leading-[1.35]">
      <span className={cn('flex min-w-0 items-start gap-2', active ? 'font-medium text-[var(--text-primary)]' : 'text-[var(--text-secondary)]')}>
        <span
          className={cn(
            'mt-1 h-1.5 w-1.5 shrink-0 rounded-full',
            active ? 'bg-[var(--status-success)]' : 'border border-[var(--border-default)]',
          )}
          aria-hidden
        />
        <span className="min-w-0 break-words">{label}</span>
      </span>
      <span
        className={cn(
          'shrink-0 tabular-nums',
          active
            ? 'font-medium text-[var(--text-primary)]'
            : available
              ? 'text-[var(--text-secondary)]'
              : 'text-[var(--text-tertiary)]',
        )}
      >
        {rttText}
      </span>
    </div>
  );
}

export function RouteChoicePanel({
  activePath,
  directRttMs,
  relayRttMs,
  relayName,
  value,
  onValueChange,
  disabled = false,
}: {
  /** 当前实际走的线路；还没建链时为 null，两行都不带绿点。 */
  activePath: 'direct' | 'relay' | null;
  directRttMs: number | null;
  relayRttMs: number | null;
  /** 中转站名称；不知道时只写「中转」。 */
  relayName: string | null;
  value: DeviceLinkPeerPathPreference;
  /** 不传时只展示两条线路，不给切换。 */
  onValueChange?: (next: DeviceLinkPeerPathPreference) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const directSelectable = directRttMs !== null || activePath === 'direct' || value === 'direct';
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-[var(--border-default)] bg-[var(--surface)] p-2.5">
      <div className="flex items-center justify-between gap-2">
        <span className="inline-flex items-center gap-1 text-11 font-medium text-[var(--text-tertiary)]">
          <span>{t('settings.remoteControl.v2.popover.routePreference')}</span>
          {onValueChange ? <AutoRouteInfoButton /> : null}
        </span>
        <span className="text-11 text-[var(--text-tertiary)]">
          {t('settings.remoteControl.v2.popover.rttNote')}
        </span>
      </div>
      <div className="flex flex-col gap-1.5">
        <RouteOptionRow
          active={activePath === 'direct'}
          label={t('settings.remoteControl.v2.path.direct')}
          rttText={directRttMs !== null ? formatRtt(directRttMs, t) : t('settings.remoteControl.v2.popover.routeUnavailable')}
          available={directRttMs !== null}
        />
        <RouteOptionRow
          active={activePath === 'relay'}
          label={
            relayName
              ? t('settings.remoteControl.v2.path.relay', { name: relayName })
              : t('settings.remoteControl.v2.popover.routeRelay')
          }
          rttText={relayRttMs !== null ? formatRtt(relayRttMs, t) : t('settings.remoteControl.v2.popover.routeMeasuring')}
          available={relayRttMs !== null}
        />
      </div>
      {onValueChange ? (
        <SegmentedControl<DeviceLinkPeerPathPreference>
          value={value}
          onValueChange={onValueChange}
          disabled={disabled}
          aria-label={t('settings.remoteControl.v2.popover.routePreference')}
          density="sm"
          fullWidth
          options={[
            { value: 'auto', label: t('settings.remoteControl.v2.popover.routeAuto') },
            {
              value: 'direct',
              label: t('settings.remoteControl.v2.popover.routeDirect'),
              disabled: !directSelectable,
              title: !directSelectable ? t('settings.remoteControl.v2.popover.routeDirectUnavailableHint') : undefined,
            },
            { value: 'relay', label: t('settings.remoteControl.v2.popover.routeRelay') },
          ]}
        />
      ) : null}
    </div>
  );
}
