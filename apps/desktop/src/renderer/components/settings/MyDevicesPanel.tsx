import { remoteControlSettings } from './RemoteControlSection.settings-search';
import { deviceDisplayName } from '@/lib/deviceName';
import { Button } from '@/components/ui/button';
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
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import type { DeviceLinkSettings } from '@/hooks/useDeviceLinkSettings';
import { revokedDevicesStore } from '@/features/device-link/revokedDevicesStore';
import { compareDevicesByName } from '@/features/device-link/deviceSort';
import {
  canBeControlledPlatform,
  controlToggleState,
  inboundToggleState,
  resolveActiveConnectionIssue,
} from './myDevicesModel';
import { platformLabel, relativeTime } from './deviceLabels';
import appI18n from 'i18next';

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
    device.appVersion?.trim() ? `Cindy ${device.appVersion.trim()}` : null,
    hardwareLabel(device.deviceInfo),
    memoryLabel(device.deviceInfo?.memoryGb),
    opts.statusOverride ?? deviceStatusLabel(device, t),
  ].filter(Boolean);
  if (opts.isControlling) parts.push(t('settings.remoteControl.myDevices.controllingThisMac'));
  return parts.join(' · ');
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
 *  - 'others' 仅刷新按钮 + 其它设备列表——折叠区内容
 * 'self' 与 'others' 成对使用时传同一个 s,数据单源;两实例的重命名编辑态互不相干
 * (同一时刻只会编辑其中一边的设备)。
 */
export function MyDevicesPanel({
  s,
  variant = 'all',
  selfSettings,
  focusDeviceId,
  focusRequestKey,
}: {
  s: DeviceLinkSettings;
  variant?: 'all' | 'self' | 'others';
  selfSettings?: ReactNode;
  /** 深链要聚焦的设备(本实例渲染了该设备时才处理)。 */
  focusDeviceId?: string | null;
  /** 聚焦请求的唯一键;同一设备被再次请求时随之变化。 */
  focusRequestKey?: string | null;
}) {
  const { t } = useTranslation();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<DeviceLinkDeviceView | null>(null);
  const [deleting, setDeleting] = useState(false);
  const deletePending = useRef(false);
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
  const modelUseRevoked = new Set(s.modelUseRevokedControllers);
  const controlling = new Set(s.controlledBy.map((c) => c.deviceId));

  const rowRefs = useRef(new Map<string, HTMLLIElement>());
  const bindRow = (deviceId: string) => (node: HTMLLIElement | null) => {
    if (node) rowRefs.current.set(deviceId, node);
    else rowRefs.current.delete(deviceId);
  };
  const focusRowRendered = Boolean(
    focusDeviceId &&
      ((variant !== 'others' && self?.deviceId === focusDeviceId) ||
        (variant !== 'self' && others.some((d) => d.deviceId === focusDeviceId))),
  );
  useFocusDeviceRow(rowRefs, focusDeviceId, focusRequestKey, focusRowRendered);

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
  const handleDelete = async () => {
    if (!deleteTarget || deletePending.current) return;
    const { deviceId } = deleteTarget;
    deletePending.current = true;
    setDeleting(true);
    try {
      if (await s.remove(deviceId)) {
        revokedDevicesStore.clearRevoked(deviceId);
        setDeleteTarget(null);
      }
    } finally {
      deletePending.current = false;
      setDeleting(false);
    }
  };

  const cardClass = 'rounded-xl border border-[var(--border-default)] px-4 py-3';

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
            onClick={() => void s.refresh(true)}
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
                  {self?.name?.trim() && self.name.trim() !== self.deviceId ? self.name.trim() : t('settings.devices.thisDevice')}
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
              <button data-setting-id={remoteControlSettings.devices.id}
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
              <Switch data-setting-id={remoteControlSettings.devices.id}
                checked={s.enabled}
                onCheckedChange={(v) => void s.setEnabled(v)}
                aria-label={t('settings.devices.allowControl')}
              />
            </ControlRow>
          </div>
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
                        : d.online
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
                        {deviceDisplayName(d.deviceId, d.name, s.devices ?? [])}
                      </span>
                    )}
                    <span className="break-words text-11 text-[var(--text-tertiary)]">
                      {deviceSubtitle(d, t, { isControlling })}
                    </span>
                  </div>
                  {editingId !== d.deviceId && (
                    <div className="flex shrink-0 items-center gap-1">
                      {canBeControlledPlatform(d.platform) && !peerRevoked && (
                        <button data-settings-search-action="Open a remote desktop session for this device" type="button" className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-full text-[var(--text-primary)] hover:bg-[var(--surface-chip)] disabled:opacity-40"
                          disabled={!d.online || !d.remoteControlEnabled || !d.controlEnabled}
                          title={t('remoteDesktop.title')} aria-label={t('remoteDesktop.title')}
                          onClick={() => void window.electronAPI.openRemoteDesktop({deviceId:d.deviceId,name:d.name}).catch(() => toast.error(t('remoteDesktop.connectionError')))}>
                          <Monitor size={16}/>
                        </button>
                      )}
                      <button data-settings-search-action="Start or cancel editing the device display name"
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
                      <button data-settings-search-action="Open confirmation to remove this device"
                        type="button"
                        onClick={() => setDeleteTarget(d)}
                        disabled={deleting}
                        aria-label={t('settings.devices.delete')}
                        className="rounded-md p-1.5 text-[var(--text-tertiary)] transition-colors hover:text-[var(--text-primary)] disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                  )}
                </div>

                {/* 两个方向各一行。手机等「不可被控」的设备、以及对方已拒绝本机的设备,都不展示「我可以」行
                    (前者永远控不了;后者避免让用户看到一个控不了的选中态而纠结)。 */}
                <div className="mt-3 grid grid-cols-[max-content_minmax(0,1fr)] items-start gap-x-4 gap-y-2 border-t border-[var(--border-default)] pt-3">
                  {canBeControlledPlatform(d.platform) && !peerRevoked && (
                    <AccessRow label={t('settings.remoteControl.myDevices.iCan')} reason={controlReason}>
                      <AccessPill
                        label={t('settings.remoteControl.myDevices.controlIt')}
                        ariaLabel={t('settings.remoteControl.deviceControlToggleAria', { name: d.name })}
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
                      ariaLabel={t('settings.remoteControl.myDevices.allowInboundAria', { name: d.name })}
                      pressed={inbound.checked}
                      disabled={inbound.disabled}
                      onToggle={(v) => void onInboundChange(d.deviceId, v)}
                    />
                    {/* 「用本机模型」跟着「控制本机」：能控制本机时默认可用，可以单独关掉。手机不借模型，不显示。 */}
                    {canBeControlledPlatform(d.platform) && (
                      <AccessPill
                        label={t('settings.remoteControl.myDevices.useThisDeviceModels')}
                        ariaLabel={t('settings.remoteControl.myDevices.allowModelUseAria', { name: d.name })}
                        pressed={inbound.checked && !modelUseRevoked.has(d.deviceId)}
                        disabled={inbound.disabled || !inbound.checked}
                        onToggle={(v) => void s.setModelUse(d.deviceId, v)}
                      />
                    )}
                  </AccessRow>
                </div>
              </li>
            );
          })
        )}
      </ul>
      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open && !deletePending.current) setDeleteTarget(null);
        }}
        presentation="standard"
        title={t('settings.devices.deleteTitle', { name: deleteTarget?.name ?? '' })}
        description={t('settings.devices.deleteMessage')}
        confirmText={t('settings.devices.delete')}
        confirmVariant="destructive"
        autoFocusConfirm
        loading={deleting}
        onConfirm={() => void handleDelete()}
      />
    </div>
  );
}
