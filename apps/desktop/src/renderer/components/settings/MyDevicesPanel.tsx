/**
 * MyDevicesPanel —— 「远程控制」页统一的「我的设备」面板。
 * ---------------------------------------------------------------------------
 * 合并原 ControlThisMacPanel(inbound)+ ControllableDevicesPanel(outbound):同一份同账号设备
 * 列表,每台设备一张卡,在一处管理两个方向 + 设备本身(重命名 / 删除)。
 *
 *  - 首行「本机」:承载本机重命名、「允许其他设备控制本机」总开关(总闸)+ relay 连接状态。
 *  - 其余每台设备两条控件:
 *      · 「我控制它」(outbound = controlEnabled):对方已拒绝本机时整行**不展示**(不让用户看到
 *        控不了的选中态而纠结);对方未开被控时仍可编辑(本地偏好独立于对方状态),附「对方未开启被控」说明;
 *      · 「允许它控制本机」(inbound = revoke/restore 的反面):总开关关时置灰;关掉走二次确认。
 *
 * 模型 = 总闸 + 逐设备例外。底层全部复用 useDeviceLinkSettings,本面板只做组装与展示。
 */

import { useState, useSyncExternalStore, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { RefreshCw, Pencil, Trash2, Check, X } from 'lucide-react';

import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import type { DeviceLinkSettings } from '@/hooks/useDeviceLinkSettings';
import { revokedDevicesStore } from '@/features/device-link/revokedDevicesStore';
import { compareDevicesByName } from '@/features/device-link/deviceSort';
import {
  canBeControlledPlatform,
  controlToggleState,
  inboundToggleState,
  resolveActiveConnectionIssue,
} from './myDevicesModel';

function platformLabel(platform: string | null): string {
  switch (platform) {
    case 'darwin':
      return 'macOS';
    case 'win32':
      return 'Windows';
    case 'linux':
      return 'Linux';
    case 'ios':
      return 'iOS';
    case 'android':
      return 'Android';
    default:
      return platform ?? '—';
  }
}

function hardwareLabel(deviceInfo: DeviceLinkDeviceInfo | null | undefined): string | null {
  const label = deviceInfo?.modelLabel?.trim() || deviceInfo?.cpuLabel?.trim();
  return label || null;
}

function memoryLabel(memoryGb: number | null | undefined): string | null {
  if (typeof memoryGb !== 'number' || !Number.isFinite(memoryGb) || memoryGb <= 0) return null;
  const formatted = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(memoryGb);
  return `${formatted} GB`;
}

function deviceStatusLabel(
  device: DeviceLinkDeviceView,
  t: (k: string, o?: Record<string, unknown>) => string,
): string {
  if (device.online) {
    return device.busy ? t('settings.devices.status.busy') : t('settings.devices.status.online');
  }
  return t('settings.devices.lastSeen', { time: relativeTime(device.lastSeenAt, t) });
}

function deviceSubtitle(
  device: DeviceLinkDeviceView,
  t: (k: string, o?: Record<string, unknown>) => string,
  opts: { isControlling?: boolean; statusOverride?: string } = {},
): string {
  const parts = [
    platformLabel(device.platform),
    hardwareLabel(device.deviceInfo),
    memoryLabel(device.deviceInfo?.memoryGb),
    opts.statusOverride ?? deviceStatusLabel(device, t),
  ].filter(Boolean);
  if (opts.isControlling) parts.push(t('settings.remoteControl.myDevices.controllingThisMac'));
  return parts.join(' · ');
}

/** lastSeenAt 相对时间(分钟粒度,超过 7 天显示日期)。 */
function relativeTime(
  iso: string | null,
  t: (k: string, o?: Record<string, unknown>) => string,
): string {
  if (!iso) return '—';
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return '—';
  const diffMin = Math.floor((Date.now() - ts) / 60_000);
  if (diffMin < 1) return t('settings.devices.justNow');
  if (diffMin < 60) return t('settings.devices.minutesAgo', { count: diffMin });
  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return t('settings.devices.hoursAgo', { count: diffHour });
  const diffDay = Math.floor(diffHour / 24);
  if (diffDay < 7) return t('settings.devices.daysAgo', { count: diffDay });
  return new Date(ts).toLocaleDateString();
}

/** 设备卡内的一条控件行:左标签(可带原因副文案)+ 右控件。 */
function ControlRow({
  label,
  reason,
  children,
}: {
  label: string;
  reason?: string | null;
  children: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="flex min-w-0 flex-col">
        <span className="text-12 text-[var(--text-primary)]">{label}</span>
        {reason ? <span className="text-11 text-[var(--text-tertiary)]">{reason}</span> : null}
      </div>
      {children}
    </div>
  );
}

/**
 * variant:
 *  - 'all'    完整面板(本机卡 + 刷新 + 其它设备),独立使用时的默认形态
 *  - 'self'   仅本机卡(重命名 + 被控总开关 + relay 状态)——供折叠布局把本机常驻外层
 *  - 'others' 仅刷新按钮 + 其它设备列表——折叠区内容
 * 'self' 与 'others' 成对使用时传同一个 s,数据单源;两实例的重命名编辑态互不相干
 * (同一时刻只会编辑其中一边的设备)。
 */
export function MyDevicesPanel({
  s,
  variant = 'all',
}: {
  s: DeviceLinkSettings;
  variant?: 'all' | 'self' | 'others';
}) {
  const { t } = useTranslation();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState('');
  // 被对方撤销了本机访问权限的设备(控制端内存推导)。
  const revokedByPeer = useSyncExternalStore(
    revokedDevicesStore.subscribe,
    revokedDevicesStore.getSnapshot,
  );

  const self = (s.devices ?? []).find((d) => d.isSelf);
  // 与切换栏同一排序规则:按稳定身份(名字 → deviceId),不跟服务端的「在线/lastSeen 倒序」——
  // 短期上下线 / 心跳不再让顺序跳动,设备只在原位改在线点。本机单独置顶(下面单独渲染)。
  const others = (s.devices ?? []).filter((d) => !d.isSelf).sort(compareDevicesByName);
  const revokedControllers = new Set(s.revokedControllers);
  const controlling = new Set(s.controlledBy.map((c) => c.deviceId));

  // 连接问题(鉴权失效/被顶号/超限/版本不符/反复掉线)时不再显示笼统的 connecting 黄点。
  const activeConnectionIssue = resolveActiveConnectionIssue(s.linkStatus, s.connectionIssue);
  const linkStatusColor = activeConnectionIssue
    ? 'var(--remote-status-disconnected)'
    : s.linkStatus === 'online'
      ? 'var(--remote-status-ready)'
      : s.linkStatus === 'connecting'
        ? 'var(--remote-status-progress)'
        : 'var(--remote-status-disconnected)';

  const handleRename = async (deviceId: string) => {
    const name = editingName.trim();
    const currentName =
      (self?.deviceId === deviceId ? self : others.find((d) => d.deviceId === deviceId))
        ?.name.trim() ?? '';
    setEditingId(null);
    if (name && name === currentName) return;
    await s.rename(deviceId, name || null);
  };

  // 关掉「允许它控制本机」= 撤销访问权限;打开 = 恢复。设置页是有意操作,**不弹二次确认** ——
  // 撤销确认只留给 ControlledBanner 那种「选项外的浮层提示」侧边按钮(防误点)。
  const onInboundChange = async (deviceId: string, next: boolean) => {
    if (next) await s.restore(deviceId);
    else await s.revoke(deviceId);
  };

  // 删除设备:**仅删除真正成功时**才连带清掉「已撤销」标记(s.remove 内部 catch + toast,会吞掉
  // 失败,故必须看返回值)。否则若删的是被对方撤销过的设备,切换栏的 buildSwitcherDevices 仍会拿
  // revoked id 单独撑起一颗陈旧 rejected chip,直到登出 / 停服才消失;而删除失败时清掉则会错误地
  // 抹掉一台仍存在、仍被撤销的设备的被拒状态。
  const handleDelete = async (deviceId: string) => {
    if (await s.remove(deviceId)) revokedDevicesStore.clearRevoked(deviceId);
  };

  const cardClass = 'rounded-xl border border-[var(--border-default)] px-4 py-3';

  return (
    <div className="flex flex-col gap-4">
      {variant !== 'self' && (
        <div className="flex items-center justify-end">
          <button
            type="button"
            onClick={() => void s.refresh(true)}
            disabled={s.refreshing}
            className="flex h-7 items-center gap-1.5 rounded-full border border-[var(--border-default)] px-3 text-12 text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)] disabled:opacity-50"
            aria-label={t('settings.devices.refresh')}
          >
            <Spinner icon={RefreshCw} size={12} spinning={s.refreshing} />
            {t('settings.devices.refresh')}
          </button>
        </div>
      )}

      <ul
        className="flex flex-col gap-2"
        aria-label={
          variant === 'self'
            ? t('settings.devices.thisDevice')
            : t('settings.remoteControl.sections.myDevices')
        }
      >
        {/* 本机:承载重命名 + 被控总开关 + relay 状态 */}
        {variant !== 'others' && (
        <li className={cardClass}>
          <div className="flex items-center gap-3">
            <span
              className="h-1.5 w-1.5 shrink-0 rounded-full"
              style={{ backgroundColor: linkStatusColor }}
              aria-hidden
            />
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              {self && editingId === self.deviceId ? (
                <div className="flex items-center gap-1.5">
                  <input
                    value={editingName}
                    autoFocus
                    maxLength={64}
                    onChange={(e) => setEditingName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.nativeEvent.isComposing) void handleRename(self.deviceId);
                      if (e.key === 'Escape') setEditingId(null);
                    }}
                    className="w-44 rounded-lg border border-[var(--border-default)] bg-transparent px-2 py-0.5 text-13 text-[var(--settings-input-text)] outline-none"
                  />
                  <button
                    type="button"
                    onClick={() => void handleRename(self.deviceId)}
                    aria-label={t('settings.devices.renameConfirm')}
                    className="text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                  >
                    <Check size={14} />
                  </button>
                  <button
                    type="button"
                    onClick={() => setEditingId(null)}
                    aria-label={t('settings.devices.renameCancel')}
                    className="text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                  >
                    <X size={14} />
                  </button>
                </div>
              ) : (
                <span className="truncate text-13 font-medium text-[var(--text-primary)]">
                  {self?.name || t('settings.devices.thisDevice')}
                </span>
              )}
              <span className="text-11 text-[var(--text-tertiary)]">
                {self
                  ? deviceSubtitle(self, t, {
                      statusOverride: t(`settings.devices.linkStatus.${s.linkStatus}`),
                    })
                  : `${t('settings.devices.thisDevice')} · ${t(`settings.devices.linkStatus.${s.linkStatus}`)}`}
              </span>
              {activeConnectionIssue ? (
                <span className="text-11 text-[var(--error-fg)]">
                  {t(`settings.devices.connectionIssue.${activeConnectionIssue.kind}`)}
                </span>
              ) : null}
              {s.standby ? (
                <span className="text-11 text-[var(--text-tertiary)]">
                  {t('settings.devices.standbyHint')}
                </span>
              ) : null}
            </div>
            {self && editingId !== self.deviceId ? (
              <button
                type="button"
                onClick={() => {
                  setEditingId(self.deviceId);
                  setEditingName(self.name);
                }}
                aria-label={t('settings.devices.rename')}
                className="shrink-0 rounded-md p-1.5 text-[var(--text-tertiary)] transition-colors hover:text-[var(--text-primary)]"
              >
                <Pencil size={13} />
              </button>
            ) : null}
          </div>
          <div className="mt-3 border-t border-[var(--border-default)] pt-3">
            <ControlRow
              label={t('settings.devices.allowControl')}
              reason={t('settings.devices.allowControlHint')}
            >
              <Switch
                checked={s.enabled}
                onCheckedChange={(v) => void s.setEnabled(v)}
                aria-label={t('settings.devices.allowControl')}
              />
            </ControlRow>
          </div>
        </li>
        )}

        {/* 其余同账号设备 */}
        {variant === 'self' ? null : s.listError ? (
          <li className="rounded-xl border border-[var(--border-default)] px-4 py-6 text-center text-12 text-[var(--text-tertiary)]">
            {s.listError}
          </li>
        ) : s.devices === null ? null : others.length === 0 ? (
          <li className="rounded-xl border border-[var(--border-default)] px-4 py-6 text-center text-12 text-[var(--text-tertiary)]">
            {t('settings.devices.empty')}
          </li>
        ) : (
          others.map((d) => {
            const peerRevoked = revokedByPeer.has(d.deviceId);
            const control = controlToggleState(d);
            const inbound = inboundToggleState(s.enabled, revokedControllers.has(d.deviceId));
            const isControlling = controlling.has(d.deviceId);
            const controlReason =
              control.reason === 'peer-off'
                ? t('settings.remoteControl.myDevices.peerControlOff')
                : null;
            return (
              <li key={d.deviceId} className={cardClass}>
                {/* header: 状态点 + 名字(可编辑) + 元信息 + 重命名/删除 */}
                <div className="flex items-center gap-3">
                  <span
                    className={`h-1.5 w-1.5 shrink-0 rounded-full ${isControlling ? 'animate-pulse' : ''}`}
                    style={{
                      backgroundColor: isControlling
                        ? 'var(--status-bar-accent)'
                        : d.online
                          ? 'var(--remote-status-ready)'
                          : 'var(--remote-status-disconnected)',
                    }}
                    aria-hidden
                  />
                  <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                    {editingId === d.deviceId ? (
                      <div className="flex items-center gap-1.5">
                        <input
                          value={editingName}
                          autoFocus
                          maxLength={64}
                          onChange={(e) => setEditingName(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' && !e.nativeEvent.isComposing) void handleRename(d.deviceId);
                            if (e.key === 'Escape') setEditingId(null);
                          }}
                          className="w-44 rounded-lg border border-[var(--border-default)] bg-transparent px-2 py-0.5 text-13 text-[var(--settings-input-text)] outline-none"
                        />
                        <button
                          type="button"
                          onClick={() => void handleRename(d.deviceId)}
                          aria-label={t('settings.devices.renameConfirm')}
                          className="text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                        >
                          <Check size={14} />
                        </button>
                        <button
                          type="button"
                          onClick={() => setEditingId(null)}
                          aria-label={t('settings.devices.renameCancel')}
                          className="text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                        >
                          <X size={14} />
                        </button>
                      </div>
                    ) : (
                      <span className="truncate text-13 font-medium text-[var(--text-primary)]">
                        {d.name}
                      </span>
                    )}
                    <span className="truncate text-11 text-[var(--text-tertiary)]">
                      {deviceSubtitle(d, t, { isControlling })}
                    </span>
                  </div>
                  {editingId !== d.deviceId && (
                    <div className="flex shrink-0 items-center gap-1">
                      <button
                        type="button"
                        onClick={() => {
                          setEditingId(d.deviceId);
                          setEditingName(d.name);
                        }}
                        aria-label={t('settings.devices.rename')}
                        className="rounded-md p-1.5 text-[var(--text-tertiary)] transition-colors hover:text-[var(--text-primary)]"
                      >
                        <Pencil size={13} />
                      </button>
                      <button
                        type="button"
                        onClick={() => void handleDelete(d.deviceId)}
                        disabled={d.online}
                        title={d.online ? t('settings.devices.deleteOnlineHint') : undefined}
                        aria-label={t('settings.devices.delete')}
                        className="rounded-md p-1.5 text-[var(--text-tertiary)] transition-colors hover:text-[var(--text-primary)] disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                  )}
                </div>

                {/* 两个方向控件。手机等「不可被控」的设备、以及对方已拒绝本机的设备,都不展示「我控制它」
                    (前者永远控不了;后者避免让用户看到一个控不了的选中态而纠结)。 */}
                <div className="mt-3 flex flex-col gap-3 border-t border-[var(--border-default)] pt-3">
                  {canBeControlledPlatform(d.platform) && !peerRevoked && (
                    <ControlRow
                      label={t('settings.remoteControl.myDevices.controlIt')}
                      reason={controlReason}
                    >
                      <Switch
                        checked={control.checked}
                        onCheckedChange={(v) => void s.setDeviceControlEnabled(d.deviceId, v)}
                        aria-label={t('settings.remoteControl.deviceControlToggleAria', {
                          name: d.name,
                        })}
                      />
                    </ControlRow>
                  )}
                  <ControlRow
                    label={t('settings.remoteControl.myDevices.allowInbound')}
                    reason={
                      inbound.disabled ? t('settings.remoteControl.myDevices.masterOffHint') : null
                    }
                  >
                    <Switch
                      checked={inbound.checked}
                      disabled={inbound.disabled}
                      onCheckedChange={(v) => void onInboundChange(d.deviceId, v)}
                      aria-label={t('settings.remoteControl.myDevices.allowInboundAria', {
                        name: d.name,
                      })}
                    />
                  </ControlRow>
                </div>
              </li>
            );
          })
        )}
      </ul>
    </div>
  );
}
