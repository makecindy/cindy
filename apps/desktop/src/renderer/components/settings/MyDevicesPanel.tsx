import { remoteControlSettings } from './RemoteControlSection.settings-search';
import { deviceDisplayName } from '@/lib/deviceName';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
/**
 * MyDevicesPanel —— 「远程控制」页统一的「我的设备」面板。
 * ---------------------------------------------------------------------------
 * 合并原 ControlThisMacPanel(inbound)+ ControllableDevicesPanel(outbound):同一份同账号设备
 * 列表,每台设备一张卡,在一处管理两个方向 + 设备本身(重命名 / 删除)。
 *
 *  - 首行「本机」:承载本机重命名、「允许其他设备控制本机」总开关(总闸)+ relay 连接状态。
 *  - 其余每台设备按方向分两行胶囊(统一授权 B 方案,2026-11-03):
 *      · 「我可以:控制它」(outbound = controlEnabled):对方已拒绝本机时整行**不展示**(不让用户看到
 *        控不了的选中态而纠结);对方未开被控时仍可编辑(本地偏好独立于对方状态),附「对方未开启被控」说明;
 *      · 「它可以:控制本机」(inbound = revoke/restore 的反面):总开关关时置灰。
 *    以后的模型 key 同步、模型共享也作为「它可以」行的胶囊加入。
 *
 * 模型 = 总闸 + 逐设备例外。底层全部复用 useDeviceLinkSettings,本面板只做组装与展示。
 */

import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type MutableRefObject,
  type ReactNode,
} from 'react';
import { useTranslation } from 'react-i18next';
import { RefreshCw, Pencil, Trash2, Check, X, Monitor } from 'lucide-react';
import { cn } from '@/lib/utils';
import { toast } from '@/lib/toast';

import { Switch } from '@/components/ui/switch';
import { useDeleteDeviceDialog } from './useDeleteDeviceDialog';
import type { DeviceLinkSettings } from '@/hooks/useDeviceLinkSettings';
import { revokedDevicesStore } from '@/features/device-link/revokedDevicesStore';
import { compareDevicesByName } from '@/features/device-link/deviceSort';
import {
  canBeControlledPlatform,
  controlToggleState,
  inboundToggleState,
  resolveActiveConnectionIssue,
} from './myDevicesModel';
import { appLabel, deviceLabel, platformLabel, relativeTime, selfDeviceName } from './deviceLabels';
import { LocalNetworkPermission } from './LocalNetworkPermission';
import { DeviceIdentityConflictRow, useDeviceIdentityConflict } from '@/features/device-link/DeviceIdentityConflict';
import appI18n from 'i18next';
import type { SshDeviceHostView } from '../../../shared/sshAccess';
import { SshDeviceHostRow } from './SshDeviceHostRow';

function hardwareLabel(deviceInfo: DeviceLinkDeviceInfo | null | undefined): string | null {
  const label = deviceInfo?.modelLabel?.trim() || deviceInfo?.cpuLabel?.trim();
  return label || null;
}

function memoryLabel(memoryGb: number | null | undefined): string | null {
  if (typeof memoryGb !== 'number' || !Number.isFinite(memoryGb) || memoryGb <= 0) return null;
  const formatted = new Intl.NumberFormat(appI18n.language, { maximumFractionDigits: 1 }).format(memoryGb);
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
    device.appVersion?.trim() ? `${appLabel(device.app, t)} ${device.appVersion.trim()}` : null,
    hardwareLabel(device.deviceInfo),
    memoryLabel(device.deviceInfo?.memoryGb),
    opts.statusOverride ?? deviceStatusLabel(device, t),
  ].filter(Boolean);
  if (opts.isControlling) parts.push(t('settings.remoteControl.myDevices.controllingThisMac'));
  return parts.join(' · ');
}

/**
 * Cloud instance operations on their device cards, supplied by features/cloud-settings only
 * for an admitted account. Absent, the panel renders exactly as for any other account.
 */
export interface MyDevicesCloudSlot {
  /**
   * A cloud instance CIS still manages: pinned with this computer outside the collapsed list,
   * and its directory entry cannot be deleted here.
   */
  isManaged(deviceId: string): boolean;
  /** CIS lifecycle allows connecting (not asleep, starting or waiting for login). */
  remoteDesktopReady(deviceId: string): boolean;
  /**
   * The instance's state from CIS, in place of the directory's online / last seen on its card;
   * null for other devices.
   */
  status(
    deviceId: string,
  ): {
    label: string;
    live: boolean;
    progress?: boolean;
    /** Optional: still being read; a spinner goes before the subtitle. */
    pending?: boolean;
    /** Optional control right after the subtitle (a retry beside a read failure). */
    action?: ReactNode;
  } | null;
  /**
   * Optional: the name a managed cloud instance shows everywhere (its card, menu, dialogs, remote
   * desktop), with the usual 「(n)」 when another device has the same name; null for other devices.
   */
  displayName?(device: { deviceId: string; name: string }): string | null;
  /** Optional: that name without the 「(n)」, where a rename of the card starts; null for others. */
  baseName?(device: { deviceId: string; name: string }): string | null;
  /**
   * Optional: where a cloud card or extra row goes among the cloud cards (name order); absent,
   * directory cards come first and the extra rows after them.
   */
  order?(deviceId: string): number;
  /** The instance's rows between the card header and its access controls; null for other devices. */
  extras(device: DeviceLinkDeviceView): ReactNode;
  /** Optional instance actions in the header row, before remote desktop; absent, the row is unchanged. */
  headerActions?(device: DeviceLinkDeviceView): ReactNode;
  /** Cards after the directory's instances: CIS-only instances and the claim entry. */
  extraRows: readonly { deviceId: string; node: ReactNode }[];
  /** CIS list read failure, shown above the extra rows. */
  notice: string | null;
  /** Optional: the list could not be read and there is no card; the device list's own error line. */
  listError?: ReactNode;
  /** Optional: the list's 「刷新」 also reads the instances again; absent, it reads the directory only. */
  refresh?(): void;
}

/**
 * 深链聚焦某台设备:行渲染出来后滚入视野。等两帧再滚 —— 设置页自己的
 * section 深链滚动(父组件 effect,同帧 rAF)会先把容器滚到「我的设备」顶部,
 * 这里要排在它之后,否则被它盖掉。每个 focusRequestKey 只聚焦一次。
 */
function useFocusDeviceRow(
  rowRefs: MutableRefObject<Map<string, HTMLLIElement>>,
  focusDeviceId: string | null | undefined,
  focusRequestKey: string | null | undefined,
  rowRendered: boolean,
): void {
  const handledKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (!focusDeviceId || !focusRequestKey || !rowRendered) return;
    if (handledKeyRef.current === focusRequestKey) return;
    let second = 0;
    const first = window.requestAnimationFrame(() => {
      second = window.requestAnimationFrame(() => {
        const row = rowRefs.current.get(focusDeviceId);
        if (!row) return;
        // 真正滚到后才记为已处理:列表刷新等让 effect 在两帧之间被清理时,
        // 重新运行仍会再定位一次,不会因提前记账而永远跳过。
        handledKeyRef.current = focusRequestKey;
        const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
        row.scrollIntoView?.({ block: 'center', behavior: reduce ? 'auto' : 'smooth' });
      });
    });
    return () => {
      window.cancelAnimationFrame(first);
      window.cancelAnimationFrame(second);
    };
  }, [focusDeviceId, focusRequestKey, rowRefs, rowRendered]);
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
 * 设备卡里的一项权限:可切换的胶囊。选中 = chip 填充 + 对勾,未选 = 描边。
 * 语义与原 Switch 相同(aria-pressed 代替 switch 的 checked),点击即生效、不弹确认。
 */
function AccessPill({
  label,
  ariaLabel,
  pressed,
  disabled,
  onToggle,
}: {
  label: string;
  ariaLabel: string;
  pressed: boolean;
  disabled?: boolean;
  onToggle: (next: boolean) => void;
}) {
  return (
    <button data-setting-id={remoteControlSettings.devices.id}
      type="button"
      aria-pressed={pressed}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={() => onToggle(!pressed)}
      className={cn(
        'inline-flex h-7 select-none items-center gap-1 whitespace-nowrap rounded-full border text-12 transition-colors duration-[var(--motion-fast,150ms)]',
        // 全局 *:focus-visible 去掉了 outline,焦点环与 Switch 一样用 ring。
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
        'disabled:cursor-not-allowed disabled:opacity-40',
        pressed
          ? 'border-transparent bg-[var(--surface-chip)] pl-2.5 pr-3 text-[var(--text-primary)]'
          : 'border-[var(--border-default)] px-3 text-[var(--text-tertiary)] enabled:hover:bg-[var(--surface-hover)] enabled:hover:text-[var(--text-primary)]',
      )}
    >
      {pressed ? <Check size={12} strokeWidth={2.25} aria-hidden /> : null}
      {label}
    </button>
  );
}

/** 一个方向一行:左边「我可以 / 它可以」,右边该方向的胶囊,原因副文案在胶囊下面。 */
function AccessRow({
  label,
  reason,
  children,
}: {
  label: string;
  reason?: string | null;
  children: ReactNode;
}) {
  return (
    <>
      <span className="select-none pt-1.5 text-12 leading-4 text-[var(--text-secondary)]">{label}</span>
      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex flex-wrap gap-1.5">{children}</div>
        {reason ? <span className="text-11 text-[var(--text-tertiary)]">{reason}</span> : null}
      </div>
    </>
  );
}

/**
 * variant:
 *  - 'all'    完整面板(本机卡 + 刷新 + 其它设备),独立使用时的默认形态
 *  - 'self'   仅本机卡(重命名 + 被控总开关 + relay 状态)——供折叠布局把本机常驻外层
 *  - 'others' 仅刷新按钮 + 其它设备列表——折叠区内容(白名单账号不含云实例)
 *  - 'cloud'  仅云实例(目录里的云实例卡 + 只在云端列表里的实例 + 领取入口)——与本机卡一起
 *             常驻折叠区外,「我的设备」收起时也可见;没有 cloud 时不渲染
 * 'self' 与 'others' 成对使用时传同一个 s,数据单源;两实例的重命名编辑态互不相干
 * (同一时刻只会编辑其中一边的设备)。
 */
export function MyDevicesPanel({
  s,
  variant = 'all',
  selfSettings,
  focusDeviceId,
  focusRequestKey,
  cloud,
  sshHosts,
}: {
  s: DeviceLinkSettings;
  variant?: 'all' | 'self' | 'others' | 'cloud';
  selfSettings?: ReactNode;
  /** SSH to the other devices (this computer as controller); absent, the cards have no SSH row. */
  sshHosts?: {
    hosts: ReadonlyMap<string, SshDeviceHostView>;
    restore: (deviceId: string) => Promise<void>;
  };
  /** 深链要聚焦的设备(本实例渲染了该设备时才处理)。 */
  focusDeviceId?: string | null;
  /** 聚焦请求的唯一键;同一设备被再次请求时随之变化。 */
  focusRequestKey?: string | null;
  /** 云实例运维(仅白名单账号);缺省时与普通账号完全一致。 */
  cloud?: MyDevicesCloudSlot;
}) {
  const { t } = useTranslation();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState('');
  const { requestDelete, deleting, dialog } = useDeleteDeviceDialog(s.remove);
  // 被对方撤销了本机访问权限的设备(控制端内存推导)。
  const revokedByPeer = useSyncExternalStore(
    revokedDevicesStore.subscribe,
    revokedDevicesStore.getSnapshot,
  );

  const self = (s.devices ?? []).find((d) => d.isSelf);
  const selfName = self ? selfDeviceName(self) : '';
  // 与切换栏同一排序规则:按稳定身份(名字 → deviceId),不跟服务端的「在线/lastSeen 倒序」——
  // 短期上下线 / 心跳不再让顺序跳动,设备只在原位改在线点。本机单独置顶(下面单独渲染)。
  const allOthers = (s.devices ?? []).filter((d) => !d.isSelf).sort(compareDevicesByName);
  // 白名单账号的云实例常驻在 'cloud' 里,不出现在折叠的其它设备列表中。
  const cloudDevices = cloud ? allOthers.filter((d) => cloud.isManaged(d.deviceId)) : [];
  const others = cloud ? allOthers.filter((d) => !cloud.isManaged(d.deviceId)) : allOthers;
  const revokedControllers = new Set(s.revokedControllers);
  const controlling = new Set(s.controlledBy.map((c) => c.deviceId));

  const rowRefs = useRef(new Map<string, HTMLLIElement>());
  const bindRow = (deviceId: string) => (node: HTMLLIElement | null) => {
    if (node) rowRefs.current.set(deviceId, node);
    else rowRefs.current.delete(deviceId);
  };
  const focusRowRendered = Boolean(
    focusDeviceId &&
      (variant === 'cloud'
        ? cloudDevices.some((d) => d.deviceId === focusDeviceId) ||
          !!cloud?.extraRows.some((row) => row.deviceId === focusDeviceId)
        : (variant !== 'others' && self?.deviceId === focusDeviceId) ||
          (variant !== 'self' && others.some((d) => d.deviceId === focusDeviceId))),
  );
  useFocusDeviceRow(rowRefs, focusDeviceId, focusRequestKey, focusRowRendered);

  // 连接问题(鉴权失效/被顶号/超限/版本不符/反复掉线)时不再显示笼统的 connecting 黄点。
  const activeConnectionIssue = resolveActiveConnectionIssue(s.linkStatus, s.connectionIssue);
  const identityConflict = useDeviceIdentityConflict();
  // 已确认另一台电脑在用本机身份时，下方的冲突说明已经讲清原因，不再叠一句笼统的「被取代 / 反复断开」。
  const connectionIssueText = activeConnectionIssue
    && !(identityConflict && (activeConnectionIssue.kind === 'replaced' || activeConnectionIssue.kind === 'unstable'))
    ? t(`settings.devices.connectionIssue.${activeConnectionIssue.kind}`)
    : null;
  const linkStatusColor = activeConnectionIssue
    ? 'var(--remote-status-disconnected)'
    : s.linkStatus === 'online'
      ? 'var(--remote-status-ready)'
      : s.linkStatus === 'connecting'
        ? 'var(--remote-status-progress)'
        : 'var(--remote-status-disconnected)';

  const handleRename = async (deviceId: string) => {
    const name = editingName.trim();
    const currentName = self?.deviceId === deviceId
      ? selfName
      : allOthers.find((d) => d.deviceId === deviceId)?.name.trim() ?? '';
    setEditingId(null);
    if (name === currentName) return;
    // A cloud card starts from its own name, which may come from CIS: unchanged, nothing to save.
    const listed = allOthers.find((d) => d.deviceId === deviceId);
    if (name && listed && name === cloud?.baseName?.(listed)) return;
    await s.rename(deviceId, name || null);
  };

  // 关掉「允许它控制本机」= 撤销访问权限;打开 = 恢复。设置页是有意操作,**不弹二次确认** ——
  // 撤销确认只留给 ControlledBanner 那种「选项外的浮层提示」侧边按钮(防误点)。
  const onInboundChange = async (deviceId: string, next: boolean) => {
    if (next) await s.restore(deviceId);
    else await s.revoke(deviceId);
  };

  const cardClass = 'rounded-xl border border-[var(--border-default)] px-4 py-3';

  if (variant === 'cloud') {
    if (!cloud) return null;
    return (
      <ul className="flex flex-col gap-2" aria-label={t('cloudSettings.instance.title')}>
        {cloud.notice ? (
          <li className="px-1 text-12 text-[var(--text-tertiary)]" role="alert">
            {cloud.notice}
          </li>
        ) : null}
        {cloud.listError ? (
          <li className="rounded-xl border border-[var(--border-default)] px-4 py-6 text-center text-12 text-[var(--text-tertiary)]">
            {cloud.listError}
          </li>
        ) : null}
        {/* Directory cards and CIS-only rows together, in the slot's order (stable otherwise). */}
        {[
          ...cloudDevices.map((d) => ({ deviceId: d.deviceId, node: () => renderDevice(d) })),
          ...cloud.extraRows.map((row) => ({
            deviceId: row.deviceId,
            node: () => (
              <li
                key={row.deviceId}
                ref={bindRow(row.deviceId)}
                data-device-id={row.deviceId}
                className={cardClass}
              >
                {row.node}
              </li>
            ),
          })),
        ]
          .map((item, index) => ({ ...item, place: cloud.order?.(item.deviceId) ?? index, index }))
          .sort((a, b) => a.place - b.place || a.index - b.index)
          .map((item) => item.node())}
      </ul>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {variant !== 'self' && (
        <div className="flex items-center justify-end">
          <Button data-setting-id={remoteControlSettings.devices.id}
            variant="secondary"
            size="sm"
            compact
            loading={s.refreshing}
            type="button"
            onClick={() => {
              void s.refresh(true);
              cloud?.refresh?.();
            }}
            disabled={s.refreshing}
            aria-label={t('settings.devices.refresh')}
          >
            <RefreshCw size={12} />
            {t('settings.devices.refresh')}
          </Button>
        </div>
      )}

      <ul
        className="flex flex-col gap-2"
        aria-label={
          variant === 'self'
            ? t('settings.devices.thisDevice')
            : t(remoteControlSettings.devices.titleKey)
        }
      >
        {/* 本机:承载重命名 + 被控总开关 + relay 状态 */}
        {variant !== 'others' && (
        <li
          ref={self ? bindRow(self.deviceId) : undefined}
          data-device-id={self?.deviceId}
          className={cardClass}
        >
          <div className="flex items-center gap-3">
            <span
              className="h-1.5 w-1.5 shrink-0 rounded-full"
              style={{ backgroundColor: linkStatusColor }}
              aria-hidden
            />
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              {self && editingId === self.deviceId ? (
                <div className="flex items-center gap-1.5">
                  <input data-setting-id={remoteControlSettings.devices.id}
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
                  <button data-setting-id={remoteControlSettings.devices.id}
                    type="button"
                    onClick={() => void handleRename(self.deviceId)}
                    aria-label={t('settings.devices.renameConfirm')}
                    className="text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                  >
                    <Check size={14} />
                  </button>
                  <button data-setting-id={remoteControlSettings.devices.id}
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
                  {selfName || t('settings.devices.thisDevice')}
                </span>
              )}
              <span className="text-11 text-[var(--text-tertiary)]">
                {self
                  ? deviceSubtitle(self, t, {
                      statusOverride: t(`settings.devices.linkStatus.${s.linkStatus}`),
                    })
                  : `${t('settings.devices.thisDevice')} · ${t(`settings.devices.linkStatus.${s.linkStatus}`)}`}
              </span>
              {activeConnectionIssue?.kind === 'device-removed' && activeConnectionIssue.rejoinable ? (
                // 官方网络上被移除:在本机点「重新加入」就回来,不需要重新登录。
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-11 text-[var(--error-fg)]">
                    {t('settings.devices.rejoin.hint')}
                  </span>
                  <Button data-setting-id={remoteControlSettings.devices.id}
                    variant="secondary"
                    size="sm"
                    compact
                    loading={s.rejoining}
                    disabled={s.rejoining}
                    type="button"
                    onClick={() => void s.rejoin()}
                  >
                    {t('settings.devices.rejoin.action')}
                  </Button>
                </div>
              ) : connectionIssueText ? (
                <span className="text-11 text-[var(--error-fg)]">
                  {connectionIssueText}
                </span>
              ) : null}
              {s.standby ? (
                <span className="text-11 text-[var(--text-tertiary)]">
                  {t('settings.devices.standbyHint')}
                </span>
              ) : null}
            </div>
            {self && editingId !== self.deviceId ? (
              <button data-setting-id={remoteControlSettings.devices.id}
                type="button"
                onClick={() => {
                  setEditingId(self.deviceId);
                  setEditingName(selfName);
                }}
                aria-label={t('settings.devices.rename')}
                className="shrink-0 rounded-lg p-1.5 text-[var(--text-tertiary)] transition-colors hover:text-[var(--text-primary)]"
              >
                <Pencil size={13} />
              </button>
            ) : null}
          </div>
          <DeviceIdentityConflictRow conflict={identityConflict} />
          <div className="mt-3 border-t border-[var(--border-default)] pt-3">
            <ControlRow
              label={t('settings.devices.allowControl')}
              reason={t('settings.devices.allowControlHint')}
            >
              <Switch data-setting-id={remoteControlSettings.devices.id}
                checked={s.enabled}
                onCheckedChange={(v) => void s.setEnabled(v)}
                aria-label={t('settings.devices.allowControl')}
              />
            </ControlRow>
          </div>
          <LocalNetworkPermission />
          {s.enabled && selfSettings && <div className="mt-3">{selfSettings}</div>}
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
          others.map(renderDevice)
        )}
      </ul>
      {dialog}
    </div>
  );

  // One device card, shared by the other-devices list and the cloud instance list.
  function renderDevice(d: DeviceLinkDeviceView) {
            const peerRevoked = revokedByPeer.has(d.deviceId);
            const control = controlToggleState(d);
            const inbound = inboundToggleState(s.enabled, revokedControllers.has(d.deviceId));
            const isControlling = controlling.has(d.deviceId);
            const cloudStatus = cloud?.status(d.deviceId) ?? null;
            const sshView = sshHosts?.hosts.get(d.deviceId) ?? null;
            // A cloud instance's own name (one per instance, as everywhere else it shows).
            const title =
              cloud?.displayName?.(d) ?? deviceLabel({ ...d, name: deviceDisplayName(d.deviceId, d.name, s.devices ?? []) }, t);
            const controlReason =
              control.reason === 'peer-off'
                ? t('settings.remoteControl.myDevices.peerControlOff')
                : null;
            return (
              <li
                key={d.deviceId}
                ref={bindRow(d.deviceId)}
                data-device-id={d.deviceId}
                className={cardClass}
              >
                {/* header: 状态点 + 名字(可编辑) + 元信息 + 重命名/删除 */}
                <div className="flex items-center gap-3">
                  <span
                    className={`h-1.5 w-1.5 shrink-0 rounded-full ${isControlling ? 'animate-pulse' : ''}`}
                    style={{
                      backgroundColor: isControlling
                        ? 'var(--status-bar-accent)'
                        : cloudStatus?.progress
                          ? 'var(--remote-status-progress)'
                          : (cloudStatus ? cloudStatus.live : d.online)
                            ? 'var(--remote-status-ready)'
                            : 'var(--remote-status-disconnected)',
                    }}
                    aria-hidden
                  />
                  <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                    {editingId === d.deviceId ? (
                      <div className="flex items-center gap-1.5">
                        <input data-setting-id={remoteControlSettings.devices.id}
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
                        <button data-settings-search-action="Save the device display name"
                          type="button"
                          onClick={() => void handleRename(d.deviceId)}
                          aria-label={t('settings.devices.renameConfirm')}
                          className="text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                        >
                          <Check size={14} />
                        </button>
                        <button data-settings-search-action="Start or cancel editing the device display name"
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
                        {title}
                      </span>
                    )}
                    {cloudStatus?.pending ? (
                      // Still being read: the spinner goes right before the state, as the local
                      // version rows put it before their status (HarnessVersionMenuRow).
                      <span className="break-words text-11 text-[var(--text-tertiary)]">
                        {deviceSubtitle(d, t, { isControlling, statusOverride: '' })}
                        {' · '}
                        <Spinner size={10} className="mr-1 inline-block align-[-1px]" />
                        {cloudStatus.label}
                      </span>
                    ) : cloudStatus?.action ? (
                      <span className="flex flex-wrap items-center gap-x-1">
                        <span className="break-words text-11 text-[var(--text-tertiary)]">
                          {deviceSubtitle(d, t, { isControlling, statusOverride: cloudStatus.label })}
                        </span>
                        {cloudStatus.action}
                      </span>
                    ) : (
                      <span className="break-words text-11 text-[var(--text-tertiary)]">
                        {deviceSubtitle(d, t, { isControlling, statusOverride: cloudStatus?.label })}
                      </span>
                    )}
                  </div>
                  {editingId !== d.deviceId && (
                    <div className="flex shrink-0 items-center gap-1">
                      {cloud?.headerActions?.(d)}
                      {canBeControlledPlatform(d.platform, d.app) && !peerRevoked && (
                        <button data-settings-search-action="Open a remote desktop session for this device" type="button" className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-full text-[var(--text-primary)] hover:bg-[var(--surface-chip)] disabled:opacity-40"
                          disabled={
                            !d.online ||
                            !d.remoteControlEnabled ||
                            !d.controlEnabled ||
                            (cloud ? !cloud.remoteDesktopReady(d.deviceId) : false)
                          }
                          title={t('remoteDesktop.title')} aria-label={t('remoteDesktop.title')}
                          onClick={() => void window.electronAPI.openRemoteDesktop({deviceId:d.deviceId,name:title}).catch(() => toast.error(t('remoteDesktop.connectionError')))}>
                          <Monitor size={16}/>
                        </button>
                      )}
                      <button data-settings-search-action="Start or cancel editing the device display name"
                        type="button"
                        onClick={() => {
                          setEditingId(d.deviceId);
                          setEditingName(cloud?.baseName?.(d) ?? d.name);
                        }}
                        aria-label={t('settings.devices.rename')}
                        className="rounded-lg p-1.5 text-[var(--text-tertiary)] transition-colors hover:text-[var(--text-primary)]"
                      >
                        <Pencil size={13} />
                      </button>
                      {/* CIS 管理的云实例不提供删除:设备被删后实例不能自行重新登记,要主人重新登录才能恢复。 */}
                      {!cloud?.isManaged(d.deviceId) && (
                      <button data-settings-search-action="Open confirmation to remove this device"
                        type="button"
                        onClick={() => requestDelete(d)}
                        disabled={deleting}
                        aria-label={t('settings.devices.delete')}
                        className="rounded-lg p-1.5 text-[var(--text-tertiary)] transition-colors hover:text-[var(--text-primary)] disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        <Trash2 size={13} />
                      </button>
                      )}
                    </div>
                  )}
                </div>

                {cloud?.extras(d) ?? null}

                {/* 两个方向各一行。手机等「不可被控」的设备、以及对方已拒绝本机的设备,都不展示「我可以」行
                    (前者永远控不了;后者避免让用户看到一个控不了的选中态而纠结)。 */}
                <div className="mt-3 grid grid-cols-[max-content_minmax(0,1fr)] items-start gap-x-4 gap-y-2 border-t border-[var(--border-default)] pt-3">
                  {canBeControlledPlatform(d.platform, d.app) && !peerRevoked && (
                    <AccessRow label={t('settings.remoteControl.myDevices.iCan')} reason={controlReason}>
                      <AccessPill
                        label={t('settings.remoteControl.myDevices.controlIt')}
                        ariaLabel={t('settings.remoteControl.deviceControlToggleAria', { name: title })}
                        pressed={control.checked}
                        onToggle={(v) => void s.setDeviceControlEnabled(d.deviceId, v)}
                      />
                    </AccessRow>
                  )}
                  <AccessRow
                    label={t('settings.remoteControl.myDevices.itCan')}
                    reason={inbound.disabled ? t('settings.remoteControl.myDevices.masterOffHint') : null}
                  >
                    <AccessPill
                      label={t('settings.remoteControl.myDevices.controlThisDevice')}
                      ariaLabel={t('settings.remoteControl.myDevices.allowInboundAria', { name: title })}
                      pressed={inbound.checked}
                      disabled={inbound.disabled}
                      onToggle={(v) => void onInboundChange(d.deviceId, v)}
                    />
                  </AccessRow>
                  {/* SSH to that device, kept by this computer (shown once that device offered SSH access). */}
                  {sshView && sshHosts && (
                    <AccessRow label={t('settings.remoteControl.sshAccess.device.rowName')}>
                      <SshDeviceHostRow view={sshView} name={title} onRestore={sshHosts.restore} />
                    </AccessRow>
                  )}
                </div>
              </li>
            );
  }
}
