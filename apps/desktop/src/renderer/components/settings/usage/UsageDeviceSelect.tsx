/**
 * UsageDeviceSelect — 用量历史的设备范围选择: 所有设备 (默认, 合并) / 本机 / 其它电脑。
 *
 * 选项与状态说明由 main 返回的 payload.devices 驱动 (见 main/usage/peerUsageSync.ts)。
 * 其它电脑的数据来自最近一次成功读取, 每项下方注明「数据截至」或读不到的原因,
 * 让用户知道合计里包含到哪一刻。外观沿用同页时间范围选择器。
 */

import React from 'react';
import { useTranslation } from 'react-i18next';
import * as Select from '@radix-ui/react-select';
import { Check, ChevronDown } from 'lucide-react';

import type { UsageHistoryDevice } from '@/hooks/useUsageHistory';

export const USAGE_DEVICE_ALL = 'all';
export const USAGE_DEVICE_LOCAL = 'local';

export interface UsageDeviceOption {
  /** 传给 useUsageHistory 的 device 值。 */
  value: string;
  device: UsageHistoryDevice | null;
}

/** 本机排第一, 其它电脑按名称排序; 手机不参与 (main 侧已过滤)。 */
export function buildUsageDeviceOptions(
  devices: readonly UsageHistoryDevice[],
): UsageDeviceOption[] {
  const self = devices.find((device) => device.isSelf) ?? null;
  const peers = devices
    .filter((device) => !device.isSelf)
    .sort((a, b) => a.name.localeCompare(b.name));
  return [
    { value: USAGE_DEVICE_ALL, device: null },
    { value: USAGE_DEVICE_LOCAL, device: self },
    ...peers.map((device) => ({ value: device.deviceId, device })),
  ];
}

/** 至少有一台其它电脑时才值得显示选择器。 */
export function hasPeerUsageDevices(devices: readonly UsageHistoryDevice[] | undefined): boolean {
  return Boolean(devices?.some((device) => !device.isSelf));
}

/** 合并范围里有设备读不到最新数据 (离线、未授权、需要更新、失败)。 */
export function hasIncompleteUsageDevices(
  devices: readonly UsageHistoryDevice[] | undefined,
): boolean {
  return Boolean(
    devices?.some(
      (device) => !device.isSelf && device.status !== 'ok' && device.status !== 'syncing',
    ),
  );
}

const STATUS_KEY: Record<Exclude<UsageHistoryDevice['status'], 'ok' | 'syncing'>, string> = {
  offline: 'usageHistory.device.status.offline',
  'remote-disabled': 'usageHistory.device.status.remoteDisabled',
  unsupported: 'usageHistory.device.status.unsupported',
  error: 'usageHistory.device.status.error',
};

const itemClassName =
  'flex w-full cursor-pointer select-none items-center justify-between gap-2 rounded-lg px-3 py-2 text-left text-13 text-[var(--text-primary)] outline-none data-[highlighted]:bg-[var(--surface-hover)] data-[state=checked]:bg-[var(--settings-menu-bg-selected)] data-[state=checked]:font-medium data-[state=checked]:text-[var(--settings-menu-text-selected)]';

export function UsageDeviceSelect({
  value,
  devices,
  onValueChange,
}: {
  value: string;
  devices: readonly UsageHistoryDevice[];
  onValueChange: (value: string) => void;
}): React.JSX.Element {
  const { t, i18n } = useTranslation();
  const options = buildUsageDeviceOptions(devices);

  const formatTime = (ts: number): string =>
    new Intl.DateTimeFormat(i18n.language, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(ts));

  const label = (option: UsageDeviceOption): string => {
    if (option.value === USAGE_DEVICE_ALL) return t('usageHistory.device.all');
    if (option.value === USAGE_DEVICE_LOCAL) {
      return option.device?.name
        ? t('usageHistory.device.selfNamed', { name: option.device.name })
        : t('usageHistory.device.self');
    }
    return option.device?.name ?? option.value;
  };

  const detail = (device: UsageHistoryDevice | null): string | null => {
    if (!device || device.isSelf) return null;
    if (device.status === 'syncing') return t('usageHistory.device.status.syncing');
    const since = device.syncedAt
      ? t('usageHistory.device.status.syncedAt', { time: formatTime(device.syncedAt) })
      : t('usageHistory.device.status.noData');
    if (device.status === 'ok') return since;
    return `${t(STATUS_KEY[device.status])} · ${since}`;
  };

  return (
    <Select.Root value={value} onValueChange={onValueChange}>
      <Select.Trigger
        aria-label={t('usageHistory.device.ariaLabel')}
        className="flex h-9 w-[190px] items-center justify-between gap-2 rounded-full border border-[var(--border-default)] bg-[var(--surface-elevated)] px-3 text-13 text-[var(--text-primary)] outline-none focus:ring-2 focus:ring-[var(--focus-ring-soft)]"
      >
        <span className="min-w-0 truncate">
          <Select.Value />
        </span>
        <Select.Icon asChild>
          <ChevronDown size={15} className="shrink-0 text-[var(--text-tertiary)]" />
        </Select.Icon>
      </Select.Trigger>
      <Select.Portal>
        <Select.Content
          position="popper"
          side="bottom"
          align="end"
          sideOffset={4}
          className="z-[10010] min-w-[var(--radix-select-trigger-width)] max-w-[320px] overflow-hidden rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] p-1"
        >
          <Select.Viewport>
            {options.map((option) => {
              const sub = detail(option.device);
              return (
                <Select.Item key={option.value} value={option.value} className={itemClassName}>
                  <span className="flex min-w-0 flex-col">
                    <Select.ItemText>{label(option)}</Select.ItemText>
                    {sub ? (
                      <span className="text-12 font-normal text-[var(--text-tertiary)]">{sub}</span>
                    ) : null}
                  </span>
                  <Select.ItemIndicator>
                    <Check size={14} strokeWidth={2.25} />
                  </Select.ItemIndicator>
                </Select.Item>
              );
            })}
          </Select.Viewport>
        </Select.Content>
      </Select.Portal>
    </Select.Root>
  );
}
