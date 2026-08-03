/**
 * MachineSwitcherMenu — 侧边栏「远程机器切换」下拉入口(device-link 跨设备远程控制)。
 * ---------------------------------------------------------------------------
 * 把「所有 / 本机 / 各远程设备」切换 + 「远程连接设置」入口收进一个下拉,作为 shell
 * SidebarTopNav(新建 / 自动任务 / Skill / 搜索)列表的末行常驻,位于置顶段上方、
 * 滚动容器之外,不随会话列表滚动;不再挂在「项目」段头 / 日期分组头(2026-07 用户定稿)。
 * 下拉 **hover 自动展开**(移上即开、移开即收,点击也可开且不误关,见 useHoverOpenMenu;
 * 2026-07-12 产品定稿恢复,推翻 d5a8d77c9 按 Codex P2 改的「点击展开」)。
 *
 * 本机有 ≥1 台相关远程机器(已连接 / 连接中 / 被拒)时显示;若断网导致设备目录
 * 与远端分片都清空,但 raw 选择仍指向远端,也必须保留入口让用户切回本机。
 *
 * 机器选择:**默认单选、多选框另走多选**(2026-07 用户定稿):
 *   - 「所有」→ 重置回默认(本机 + 全部远程),菜单关闭;
 *   - 点击「本机」/ 设备行 → **单选切换**(整体替换为只看该机器),菜单关闭;
 *   - **未勾选**的行 hover / 键盘高亮时最右浮现**空复选框**,点它 → toggle 追加勾选
 *     (可连续勾多台,菜单保持打开;勾满全部自动收敛回「所有」,底层勾选集语义仍是
 *     selectedMachineStore 的多选模型);
 *   - **已勾选**的行恒显 ✓,✓ 本身就是取消勾选的点击目标(鼠标悬停到 ✓ 自身时才
 *     浮现复选框边框提示可点,不跟行高亮走),点它 → toggle 取消勾选(菜单保持打开;
 *     取消到勾选集为空时 store 自动回落「所有」)——用户看到 ✓ 直觉就是点它取消,
 *     不能只留修饰键路径;
 *   - 键盘 / 无指针路径:按住 Cmd(mac)/ Ctrl(win)+ Enter 或点击 = toggle 多选
 *     (与文件管理器多选同一习惯,Greptile P2 键盘可达性反馈)。
 * 选择跨重启持久化(selectedMachineStore → localStorage)。
 *
 * 设备三态(参考手机版 device rail):
 *   - 已连接 → 普通项,可点击切换、勾选中打勾;
 *   - 连接中 / 断线缓存 → icon 闪耀(animate-pulse),可点击切换过滤到该设备;
 *   - 被拒(对方已撤销本机远程控制) → icon 叠「禁止」标识,点击弹提示(toast),不可选中。
 * 勾选后 → 侧边栏会话整体过滤到勾选机器集(逻辑在 CCAgentSidebarUpper 合并点)。
 *
 * 形态:文字下拉行,与 SidebarTopNav(新建 / 自动任务 / Skill / 搜索)同款 pill 行
 * 风格(h-8 全宽、图标 15/1.8 meta 灰、文字 foreground、hover 灰底)——trigger 显示
 * 当前范围文字(所有 / 本机 / 设备名 / N 台机器)+ 下拉箭头。范围文字本身已表达
 * 过滤状态,trigger 不再叠常驻高亮底色(常亮易被误读为导航选中态,2026-07 用户定稿)。
 * 无任何相关远程机器且没有悬空远端选择时 return null,列表里不占行。
 *
 * 颜色全走主题 token(规则 16),文案全走 i18n(规则 18)。
 */

import { useRef, type ReactNode, type Ref } from 'react';
import {
  Ban,
  Check,
  ChevronDown,
  EllipsisVertical,
  Monitor,
  MonitorSmartphone,
} from 'lucide-react';
import { useMatch, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';
import { toast } from '@/lib/toast';
import { useActiveMainView } from '@/hooks/useActiveMainView';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  isMachineSelected,
  MACHINE_ALL,
  MACHINE_LOCAL,
} from '@/features/device-link/selectedMachineStore';
import { useMachineSwitcher } from '@/features/device-link/useMachineSwitcher';
import { MENU_CONTENT_CLASS, MENU_ITEM_CLASS, MENU_SEPARATOR_CLASS } from './menuStyles';
import { useHoverOpenMenu } from './useHoverOpenMenu';

export function MachineSwitcherMenu(): ReactNode {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { devices, selectedDeviceId, hasRemote, select, toggle } = useMachineSwitcher();
  // 「鼠标移上去就展开」:hover 触发行即开、移开即关(受控开合,详见 useHoverOpenMenu;
  // 2026-07-12 产品确认要 hover 展开,恢复 d5a8d77c9 之前的交互)。
  const { open, onOpenChange, triggerRef, triggerProps, contentProps } = useHoverOpenMenu();
  // 本行随 SidebarTopNav 在所有非 rail 视图常驻,但机器过滤只作用于会话列表侧栏——
  // 选机器后必须让过滤结果可见(Codex P2):
  //   - /settings 等非 view 路由 → navigateToView('cc-agent') 切回会话视图
  //     (与「新建 / 自动任务」行、搜索行 ensureConversationView 同一惯例;
  //     /skillhub、/issues 的侧栏本就复用同一份会话列表,no-op 也可见);
  //   - doc-browse(/cc-agent/files/:sessionId,侧栏被换成文件树)→ 显式退回该
  //     会话的对话路由,侧栏恢复会话列表(navigateToView 对 /cc-agent/* 是 no-op,
  //     兜不住这个子路由);/cc-agent 其余子路由侧栏都是会话列表,无需处理。
  const { navigateToView } = useActiveMainView();
  const docBrowseMatch = useMatch('/cc-agent/files/:sessionId');
  const ensureConversationListVisible = () => {
    const docSessionId = docBrowseMatch?.params.sessionId;
    if (docSessionId) {
      navigate(`/cc-agent/${docSessionId}`);
      return;
    }
    navigateToView('cc-agent');
  };
  const applySelect = (next: Parameters<typeof select>[0]) => {
    select(next);
    ensureConversationListVisible();
  };
  const applyToggle = (id: string) => {
    toggle(id);
    ensureConversationListVisible();
  };

  // 无任何相关远程机器、也没有需要逃生的悬空远端选择 → 不渲染入口。
  if (!hasRemote) return null;

  const triggerLabel = t('ccAgent.sidebar.machineSwitcher.menuTrigger');
  // trigger 文案 = 当前范围摘要(手机版首页表头同款「文字 + 下拉箭头」口径):
  // 「所有」→ 与菜单项同文案「所有」;单选 → 机器名(本机 / 设备名);多选 → 「N 台机器」计数。
  let triggerText = t('ccAgent.sidebar.machineSwitcher.allMachines');
  if (selectedDeviceId !== MACHINE_ALL) {
    if (selectedDeviceId.length === 1) {
      const only = selectedDeviceId[0];
      triggerText =
        only === MACHINE_LOCAL
          ? t('ccAgent.sidebar.machineSwitcher.localMachine')
          : (devices.find((device) => device.deviceId === only)?.name ?? triggerLabel);
    } else {
      triggerText = t('ccAgent.sidebar.machineSwitcher.selectedCount', {
        count: selectedDeviceId.length,
      });
    }
  }

  // hover 自动展开(2026-07-12 产品定稿,推翻早前 Codex P2 的「点击展开」):鼠标移到
  // 本行短延迟即弹机器菜单、移开即收,点击仍可打开且不误关(useHoverOpenMenu)。
  // modal={false} 双重必要:hover 展开时模态的 body pointer-events:none 会让 trigger
  // 不可命中,形成 mouseleave/enter 开关闪烁循环;同时保证展开时复选框的 pointer
  // 事件拦截不被干扰,也允许点击外部 / Esc 关闭。
  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange} modal={false}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          ref={triggerRef as Ref<HTMLButtonElement>}
          {...triggerProps}
          aria-label={`${triggerLabel}: ${triggerText}`}
          className={cn(
            // 与 SidebarTopNav 的 ROW_CLASS 同款 pill 行:h-8 全宽、图标 meta 灰、
            // 文字 foreground、hover 灰底;truncate 兜住过长设备名。
            'flex h-8 w-full min-w-0 items-center gap-2.5 rounded-full px-3 text-sm font-normal text-[var(--sidebar-nav-text)]',
            'transition-colors hover:bg-sidebar-item-hover focus:outline-none',
            // 菜单展开期间保持行高亮(data-state=open):否则鼠标移进下方菜单后本行
            // :hover 即失效、高亮消失,菜单像悬空没了锚点(2026-07-12 用户反馈)。
            // 这是瞬态展开高亮,与「过滤选中态不常驻高亮」的定稿不冲突。
            'data-[state=open]:bg-sidebar-item-hover',
          )}
        >
          <MonitorSmartphone
            size={15}
            strokeWidth={1.8}
            className="shrink-0 text-[var(--sidebar-nav-text)]"
          />
          <span className="truncate leading-none">{triggerText}</span>
          <ChevronDown
            size={14}
            strokeWidth={1.8}
            className="shrink-0 text-[var(--sidebar-nav-text)]"
          />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        // 行下方展开、左边贴齐本行左边(2026-07-13 用户定稿,替换 07-12 的「贴行
        // 右侧飞出」——右飞菜单悬在主内容区上方,离行太远);align="start" 让菜单
        // 左边与 hover 行左边对齐,空间不足时 Radix 自动翻到上方。
        side="bottom"
        align="start"
        sideOffset={4}
        {...contentProps}
        className={cn(MENU_CONTENT_CLASS, 'min-w-48')}
      >
        <MachineMenuItem
          label={t('ccAgent.sidebar.machineSwitcher.allMachines')}
          selected={selectedDeviceId === MACHINE_ALL}
          onSelect={() => applySelect(MACHINE_ALL)}
        />
        <MachineMenuItem
          icon={<Monitor size={14} strokeWidth={2} />}
          label={t('ccAgent.sidebar.machineSwitcher.localMachine')}
          selected={isMachineSelected(selectedDeviceId, MACHINE_LOCAL)}
          onSelect={() => applySelect([MACHINE_LOCAL])}
          onToggle={() => applyToggle(MACHINE_LOCAL)}
        />
        {devices.map((device) => {
          const rejected = device.status === 'rejected';
          const connecting = device.status === 'connecting';
          return (
            <MachineMenuItem
              key={device.deviceId}
              icon={<MonitorSmartphone size={14} strokeWidth={2} />}
              label={device.name}
              selected={isMachineSelected(selectedDeviceId, device.deviceId)}
              shimmer={connecting}
              rejected={rejected}
              // 被拒:不切换,弹提示(菜单保持打开);已连接 / 连接中:单选切换或
              // 多选框勾选(连接中勾上先空、同步完填充)。
              onSelect={
                rejected
                  ? () => toast.warning(t('settings.remoteControl.accessRevokedByPeer'))
                  : () => applySelect([device.deviceId])
              }
              onToggle={rejected ? undefined : () => applyToggle(device.deviceId)}
            />
          );
        })}
        <DropdownMenuSeparator className={MENU_SEPARATOR_CLASS} />
        <DropdownMenuItem
          className={MENU_ITEM_CLASS}
          onSelect={() => navigate('/settings?tab=remote-control')}
        >
          <EllipsisVertical size={14} strokeWidth={2} className="shrink-0 opacity-70" />
          <span className="truncate">{t('ccAgent.sidebar.machineSwitcher.remoteSettings')}</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * 单个机器菜单项:**点击行 = 单选切换**(整体替换选择、菜单关闭);多选 toggle 有两条路:
 *   - 指针:**未勾选**的行 hover / 键盘高亮时最右浮现**空复选框**,点它 toggle 追加;
 *     **已勾选**的行恒显 ✓,✓ 即取消勾选的点击目标(鼠标悬停到 ✓ 自身时才浮现
 *     复选框边框提示可点),点它 toggle 取消(两者都拦截事件保持菜单打开方便连续
 *     增删;取消到空集时 store 回落「所有」);
 *   - 键盘 / 修饰键:Cmd(mac)/ Ctrl(win)+ Enter 或 + 点击整行 → toggle
 *     (复选框本身进不了菜单的 roving focus,键盘可达性走这条,Greptile P2)。
 * 「所有」与被拒项无多选路径(onToggle 不传,「所有」选中态显纯展示 ✓)。connecting →
 * icon 闪耀;rejected → icon 叠禁止标识 + 置灰,点击只弹提示(菜单保持打开,方便改选
 * 其它机器)。
 */
function MachineMenuItem({
  icon,
  label,
  selected,
  onSelect,
  onToggle,
  shimmer = false,
  rejected = false,
}: {
  icon?: ReactNode;
  label: string;
  selected: boolean;
  onSelect: () => void;
  /** 多选动作(勾选 / 取消勾选);不传则该项无复选框、无修饰键 toggle(「所有」/ 被拒项)。 */
  onToggle?: () => void;
  shimmer?: boolean;
  rejected?: boolean;
}): ReactNode {
  const { t } = useTranslation();
  // Radix 的 onSelect 自定义事件不携带修饰键信息,且键盘 Enter/Space 会合成一次
  // isTrusted=false 的 click(不带修饰键)再触发 select——所以在真实输入事件上把
  // 修饰键状态记进 ref:trusted click 直接记;keydown(Enter/Space)记完后合成 click
  // 因 isTrusted=false 不会覆盖。onSelect 消费后立即复位。
  const modifierHeldRef = useRef(false);
  return (
    <DropdownMenuItem
      className={cn(
        MENU_ITEM_CLASS,
        'group/machine-item',
        rejected && 'text-[var(--text-tertiary)]',
      )}
      onClick={(event) => {
        if (event.isTrusted) modifierHeldRef.current = event.metaKey || event.ctrlKey;
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          modifierHeldRef.current = event.metaKey || event.ctrlKey;
        }
      }}
      onSelect={(event) => {
        const withModifier = modifierHeldRef.current;
        modifierHeldRef.current = false;
        // 被拒项只弹提示,保持菜单打开方便改选;正常单选让菜单自然关闭。
        if (rejected) {
          event.preventDefault();
          onSelect();
          return;
        }
        // Cmd/Ctrl + Enter/点击 → 多选 toggle,菜单保持打开(与复选框同语义)。
        if (withModifier && onToggle) {
          event.preventDefault();
          onToggle();
          return;
        }
        onSelect();
      }}
    >
      {icon && (
        <span className="relative inline-flex shrink-0 items-center justify-center">
          <span className={cn(shimmer && 'animate-pulse', rejected && 'opacity-50')}>{icon}</span>
          {rejected && <Ban size={14} strokeWidth={2} className="absolute inset-0 m-auto" />}
        </span>
      )}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {/* 右槽:恒定 w-4 占位(所有行都渲染),复选框浮现 / 消失只切 visibility / 边框——
          整行宽度与 label 截断位置在 hover 前后完全不变。
          已勾选且可多选 → 恒显 ✓,✓ 即取消勾选的点击目标(鼠标悬停到 ✓ 自身时才
          浮现复选框边框提示可点,点它把该机器从勾选集**移除**,菜单保持打开);
          已勾选不可多选(「所有」)→ 纯展示 ✓;
          未勾选且可多选 → 行高亮(hover / 键盘)时浮现空复选框,点它把该机器
          **追加**进勾选集。 */}
      <span className="flex h-4 w-4 shrink-0 items-center justify-center">
        {selected && !onToggle && (
          <Check size={14} strokeWidth={2.5} className="shrink-0 text-foreground" />
        )}
        {onToggle && selected && (
          <span
            // 与未勾选复选框同款纯指针快捷目标:对 a11y 树隐藏,键盘 / 读屏的取消
            // 路径是行级 Cmd/Ctrl+Enter(见 onSelect);title 给鼠标用户提示。
            // 事件拦截口径同下方复选框(down / up / click 三段拦死,toggle 挂 pointerup)。
            aria-hidden="true"
            title={t('ccAgent.sidebar.machineSwitcher.deselect')}
            onPointerDown={(event) => {
              event.preventDefault();
              event.stopPropagation();
            }}
            onPointerUp={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onToggle();
            }}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
            }}
            className={cn(
              // 边框只在鼠标悬停到 ✓ 自身时浮现(:hover),不跟行高亮走——行高亮
              // (data-highlighted)含键盘 roving focus,toggle 后菜单保持打开时该项
              // 仍持焦,边框会常驻,视觉上像"永远多一个框"(2026-07 用户反馈)。
              'flex h-4 w-4 shrink-0 cursor-pointer items-center justify-center rounded-[4px] border border-transparent text-foreground',
              'hover:border-[var(--text-secondary)]',
            )}
          >
            <Check size={14} strokeWidth={2.5} className="shrink-0" />
          </span>
        )}
        {onToggle && !selected && (
          <span
            // 纯指针快捷目标:进不了菜单的 roving focus,故对 a11y 树隐藏,键盘 / 读屏
            // 的多选路径是行级 Cmd/Ctrl+Enter(见 onSelect);title 给鼠标用户提示。
            aria-hidden="true"
            title={t('ccAgent.sidebar.machineSwitcher.multiSelect')}
            // Radix 菜单项的 select 由 **pointerup** 驱动(item 收到 pointerup 后合成
            // click → onSelect → 整行单选 + 关菜单),所以 down / up / click 三段都要
            // stopPropagation 拦死,toggle 挂在 pointerup(pointerdown 被 preventDefault
            // 后部分环境不再合成 click,挂 click 会"点了没反应")。
            onPointerDown={(event) => {
              event.preventDefault();
              event.stopPropagation();
            }}
            onPointerUp={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onToggle();
            }}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
            }}
            className={cn(
              'invisible flex h-4 w-4 shrink-0 cursor-pointer items-center justify-center rounded-[4px] border',
              'group-data-[highlighted]/machine-item:visible',
              'border-[var(--text-tertiary)] text-transparent hover:border-[var(--text-secondary)] hover:text-[var(--text-tertiary)]',
            )}
          >
            <Check size={11} strokeWidth={2.5} />
          </span>
        )}
      </span>
    </DropdownMenuItem>
  );
}
