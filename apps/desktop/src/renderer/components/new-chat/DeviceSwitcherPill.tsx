/**
 * DeviceSwitcherPill —— 创建页 pill 排上的「在哪台设备上创建」选择器(#807)。
 *
 * 设备是一级维度:选完设备,右边工作区 pill 才在这台设备的语境里列「对话 + 该设备的项目」
 * (与 mobile 的「设备 → Agent → 工作区」同构)。
 *
 * 几条刻意的取舍:
 *   - **没有对端设备就整个不渲染**。绝大多数用户只有本机,给他们凭空多一个只能选「本机」的
 *     控件是纯负担。mobile 的做法是禁用并隐藏 ⇕,desktop 这排寸土寸金(mode pill + worktree
 *     齿轮已经占着,窄屏还会换行),直接不渲染更干净。
 *   - **离线设备照样列出、置灰禁用**。掉线时若直接从列表消失,用户会以为配对丢了;列出来并
 *     写明「离线」才能让人知道那台机器还在,只是没连上。
 *   - **不记忆上次选的设备**,每次进创建页默认本机。draft store 的 deviceLinkDeviceId 本来就
 *     故意不跨重启持久化(绑的是一台可能离线的活动设备),这里与之保持一致 —— 本机是压倒性
 *     主场景,默认停在某台远程机器有误发风险。
 *   - 窄屏且有多台时收成图标 + 状态点:pill 排在窄屏会进正常流并 flex-wrap,省掉设备名可以
 *     少一次换行。只有一台对端时不收(名字短,信息更重要)。
 */

import { Check, ChevronDown, Laptop } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import type { SelectableDevice } from '@/hooks/useControllableDevices';

/** null = 本机。 */
export type DeviceSwitcherValue = string | null;

interface Props {
  /** 可选的对端设备(含离线)。空数组 = 不渲染整个 pill。 */
  devices: readonly SelectableDevice[];
  /** 当前选中的设备;null = 本机。 */
  value: DeviceSwitcherValue;
  onChange: (deviceId: DeviceSwitcherValue, deviceName: string | null) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 窄屏(pill 排进正常流)时收成图标 + 状态点。 */
  compact?: boolean;
  disabled?: boolean;
}

/**
 * 当前值对应的展示名。
 *
 * 选中的设备已从可选列表消失(被撤销控制权限 / 解除配对)时**不能回落到本机文案** —— 草稿里
 * 还留着那个 deviceId 并会据此走远程创建,显示「本机」等于谎报目标,用户会以为在本机建、
 * 实际发去了旧设备(或直接失败)。这里退而显示 deviceId,让显示与实际一致;把草稿收敛回本机
 * 是调用方的职责(见 NewMakerDraftRoute 里的失效回落 effect),不在展示函数里偷偷抹掉状态。
 */
export function resolveDeviceLabel(
  devices: readonly SelectableDevice[],
  value: DeviceSwitcherValue,
  localLabel: string,
): string {
  if (value == null) return localLabel;
  return devices.find((d) => d.deviceId === value)?.name ?? value;
}

export function DeviceSwitcherPill({
  devices,
  value,
  onChange,
  open,
  onOpenChange,
  compact = false,
  disabled = false,
}: Props) {
  const { t } = useTranslation();

  // 没有任何对端设备 → 这个维度不存在,不占位、不渲染。
  if (devices.length === 0) return null;

  const localLabel = t('ccAgent.sidebar.machineSwitcher.localMachine');
  const label = resolveDeviceLabel(devices, value, localLabel);
  const current = value == null ? null : devices.find((d) => d.deviceId === value);
  // 本机不画状态点(它永远在线,画了只是噪音)。
  const showDot = current != null;
  // 当前值必须进 aria-label:compact 模式下按钮只剩图标 + 状态点、不渲染设备名文本,只报
  // 「设备」会让读屏用户完全不知道当前选的是哪台机器(Copilot review)。非 compact 时名字虽然
  // 可见,一并读出也不冗余 —— aria-label 会覆盖内文,不会重复播报。
  const triggerLabel = `${t('newChat.deviceSwitcher.label')}: ${label}`;

  const select = (deviceId: DeviceSwitcherValue, deviceName: string | null) => {
    onChange(deviceId, deviceName);
    onOpenChange(false);
  };

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid="create-agent-device-pill"
          disabled={disabled}
          title={compact ? label : undefined}
          aria-label={triggerLabel}
          className={cn(
            'inline-flex h-[30px] items-center justify-center gap-1.5 rounded-full',
            'border border-[var(--create-agent-control-border)] bg-[var(--create-agent-control-bg)]',
            'text-[12px] font-medium leading-[14px] text-[var(--create-agent-control-text)]',
            'transition-colors hover:bg-[var(--create-agent-control-bg-hover)]',
            'active:bg-[var(--create-agent-control-bg-pressed)]',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--create-agent-focus-ring)]',
            'disabled:cursor-not-allowed disabled:opacity-60',
            compact ? 'px-2.5' : 'min-w-20 max-w-[200px] px-3',
          )}
        >
          <Laptop
            size={12}
            strokeWidth={2}
            className="shrink-0 text-[var(--create-agent-control-icon)]"
          />
          {showDot && (
            <span
              aria-hidden
              className={cn(
                'size-1.5 shrink-0 rounded-full',
                current?.online ? 'bg-[var(--remote-status-ready)]' : 'bg-[var(--text-tertiary)]',
              )}
            />
          )}
          {!compact && <span className="min-w-0 truncate">{label}</span>}
          <ChevronDown
            size={12}
            strokeWidth={2}
            className="shrink-0 text-[var(--create-agent-control-icon)]"
          />
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="bottom"
        align="end"
        sideOffset={6}
        className={cn(
          // 宽度**由内容决定 + 设上限**(2026-07-29 用户裁决),而不是写死一个值:
          // DESIGN.md §4 要求 panel 宽度绑 trigger,那条是为「宽度稳定的单行输入框式 Select」
          // 写的;这里的 trigger 是 80–200px 的 pill、宽度还随当前设备名浮动,直接绑上去会让
          // 菜单在 80px 时把「设备名 + 状态点 + 离线副文案」全挤没。所以取自适应:
          //   下限 200px —— 行内容的实际最小需求(padding 24 + 图标 32 + 副文案约 96 + check 28),
          //     低于它副文案会折行;这个值也正好是 trigger 的宽度上限,短名字时两者基本齐平。
          //   上限 320px —— 超长设备名到此为止,由行内的 truncate 有限展现,不让菜单继续摊宽。
          'z-[10010] w-auto min-w-[200px] max-w-[320px] rounded-[12px] p-2',
          'bg-[var(--folder-picker-bg)]',
          'border border-[var(--folder-picker-border)]',
        )}
      >
        <div className="px-3 py-2">
          <span className="text-xs font-normal text-[var(--folder-label)]">
            {t('newChat.deviceSwitcher.label')}
          </span>
        </div>

        <DeviceRow
          icon={<Laptop size={20} strokeWidth={2} className="shrink-0 text-[var(--folder-item-icon)]" />}
          name={localLabel}
          hint={t('newChat.deviceSwitcher.localHint')}
          selected={value == null}
          onSelect={() => select(null, null)}
        />

        <div className="mx-2 my-1 h-px bg-[var(--folder-picker-border)]" />

        <div className="pending-queue-scroll -mr-2 max-h-[216px] overflow-x-hidden overflow-y-auto overscroll-contain pr-2">
          {devices.map((device) => (
            <DeviceRow
              key={device.deviceId}
              icon={
                <Laptop size={20} strokeWidth={2} className="shrink-0 text-[var(--folder-item-icon)]" />
              }
              name={device.name}
              hint={
                device.online
                  ? t('newChat.deviceSwitcher.onlineHint')
                  : t('newChat.deviceSwitcher.offlineHint')
              }
              online={device.online}
              // 离线设备点不动:隧道调用一定失败,不如在这里就说清楚。
              disabled={!device.online}
              selected={value === device.deviceId}
              onSelect={() => select(device.deviceId, device.name)}
            />
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

interface RowProps {
  icon: React.ReactNode;
  name: string;
  hint: string;
  online?: boolean;
  disabled?: boolean;
  selected: boolean;
  onSelect: () => void;
}

function DeviceRow({ icon, name, hint, online, disabled, selected, onSelect }: RowProps) {
  return (
    <button
      type="button"
      disabled={disabled}
      data-testid="create-agent-device-option"
      onClick={onSelect}
      className={cn(
        'flex w-full items-center gap-3 rounded-[8px] px-3 py-[10px] text-left',
        'transition-colors outline-none',
        // 键盘焦点必须看得见(Codex review P1):原来只有 hover / disabled 两种态,`outline-none`
        // 又把浏览器默认焦点圈去掉了 —— 用 Tab 走这个菜单时,当前落在哪一行完全没有提示,
        // 用户不知道 Enter / Space 会激活哪台设备。token 用 --create-agent-focus-ring:pill 的
        // trigger 与 VendorSegmentedSwitcher 都用它,同一控件的键盘焦点表现应当一致
        // (DESIGN.md §2 把 focus ring 列为少数被批准的彩色语义之一)。
        'focus-visible:ring-2 focus-visible:ring-[var(--create-agent-focus-ring)]',
        disabled ? 'cursor-not-allowed opacity-50' : 'hover:bg-[var(--folder-item-hover)]',
      )}
    >
      {icon}
      <div className="flex min-w-0 flex-1 flex-col items-start">
        <span className="flex w-full items-center gap-1.5">
          {online !== undefined && (
            <span
              aria-hidden
              className={cn(
                'size-1.5 shrink-0 rounded-full',
                online ? 'bg-[var(--remote-status-ready)]' : 'bg-[var(--text-tertiary)]',
              )}
            />
          )}
          <span className="min-w-0 truncate text-sm font-medium text-[var(--folder-item-name)]">
            {name}
          </span>
        </span>
        <span className="w-full truncate text-xs text-[var(--folder-item-path)]">{hint}</span>
      </div>
      {selected && (
        <Check size={16} strokeWidth={2.2} className="shrink-0 text-[var(--folder-item-name)]" />
      )}
    </button>
  );
}
