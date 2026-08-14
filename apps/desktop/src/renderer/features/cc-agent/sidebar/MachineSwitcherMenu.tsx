/**
 * MachineSwitcherMenu — 主列表段头标题即「机器范围」下拉(device-link 跨设备远程控制)。
 * ---------------------------------------------------------------------------
 * 2026-08-13 用户定稿(新设计,显式推翻两条 2026-07 旧定稿):
 *   - 「全部任务」段头与设备下拉**合并**——标题文字反映当前范围(全部任务 /
 *     本机任务 / 设备名 / N 台机器),点击标题弹出「所有 / 本机 / 各远程设备」
 *     切换 + 「远程连接设置」/「侧边栏显示设置」入口。顶部导航不再有独立的远程
 *     机器行,省一行;
 *     标题不再撒谎(旧结构下范围收窄后段头仍写「全部任务」)。
 *     (推翻 2026-07 「切换器收进 SidebarTopNav 末行、不挂段头」——当年是段头
 *     挂配件,现在段头本身就是切换器,语境已不同。)
 *   - **点击展开**,不再 hover 自动展开(推翻 2026-07-12 hover 定稿):作为段头
 *     标题,hover 扫过就弹菜单太吵;段级收起同时取消,标题的点击语义让给范围切换。
 *
 * 无任何相关远程机器时标题仍是「全部任务 ▾」(2026-08-13 用户裁决:箭头保留),
 * 菜单不出现设备列表,只留「远程连接设置」与「侧边栏显示设置」——单机用户看不到
 * 设备概念,但仍能从段头进这两项。范围标题恒在后,断网逃生不再靠「假装还有
 * 远程设备」画出机器列表——目录空了就只留两项设置,用户从「远程连接设置」
 * 或范围标题本身回到本机。
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
 * 形态:段头标题样式(text-sm font-medium、sidebar-list-muted 淡灰,hover 加深,
 * 与原「全部任务」标题一致)+ 小下拉箭头;远程任务 bootstrap 读取中在标题右侧
 * 转 spinner(本行仍是远程读取状态的固定承载点,不往会话列表里插 loading 行)。
 * 范围文字本身已表达过滤状态,trigger 不叠常驻高亮底色(2026-07 用户定稿沿用)。
 *
 * 颜色全走主题 token(规则 16),文案全走 i18n(规则 18)。
 */

import { useRef, type ReactNode } from 'react';
import {
  Ban,
  Check,
  ChevronDown,
  Loader2,
  Monitor,
  MonitorCog,
  MonitorSmartphone,
  SlidersHorizontal,
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
import {
  useMachineSwitcher,
  useRemoteSessionBootstrapLoading,
} from '@/features/device-link/useMachineSwitcher';
import { MENU_CONTENT_CLASS, MENU_ITEM_CLASS, MENU_SEPARATOR_CLASS } from './menuStyles';

/** 段头标题共用样式:与原「全部任务」标题一致(淡灰、hover 加深)。 */
const SCOPE_TITLE_CLASS =
  'text-sm font-medium text-[var(--sidebar-list-muted)] transition-colors hover:text-[var(--sidebar-nav-text)]';

export function MachineSwitcherMenu({
  onOpenDisplaySettings,
}: {
  /** 打开段头同一份「侧边栏显示设置」菜单;不传则不渲染该入口。 */
  onOpenDisplaySettings?: () => void;
} = {}): ReactNode {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { devices, selectedDeviceId, select, toggle } = useMachineSwitcher();
  // 设备列表只看当前是否真有可展示的远程设备。hasRemote 还会把「目录已空、
  // raw 仍记着远端」算进去——那是旧逃生口,标题恒在后会误画出「所有 / 本机」。
  const showDeviceList = devices.length > 0;
  // 段头标题是远程任务读取状态的固定承载点。后台 bootstrap 时只更新这一行，
  // 不再把 loading 提示插入下方会话列表，避免列表整体上下跳动。
  const remoteSessionBootstrapLoading = useRemoteSessionBootstrapLoading(selectedDeviceId);
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

  const triggerLabel = t('ccAgent.sidebar.machineSwitcher.menuTrigger');
  const settingsItems = (
    <>
      <DropdownMenuItem
        className={MENU_ITEM_CLASS}
        onSelect={() => navigate('/settings?tab=remote-control')}
      >
        <MonitorCog size={14} strokeWidth={2} className="shrink-0 opacity-70" />
        <span className="truncate">{t('ccAgent.sidebar.machineSwitcher.remoteSettings')}</span>
      </DropdownMenuItem>
      {onOpenDisplaySettings ? (
        <DropdownMenuItem
          className={MENU_ITEM_CLASS}
          onSelect={() => {
            // 等本菜单关完、当前指针事件走完再开显示设置,避免两个 Radix
            // 菜单抢焦点、或同一次 click 被新菜单当成点外部而立刻关掉。
            window.setTimeout(() => onOpenDisplaySettings(), 0);
          }}
        >
          <SlidersHorizontal size={14} strokeWidth={2} className="shrink-0 opacity-70" />
          <span className="truncate">{t('ccAgent.sidebar.organizeSidebar')}</span>
        </DropdownMenuItem>
      ) : null}
    </>
  );

  // 标题文字 = 当前范围(2026-08-13 定稿:标题回答"我正在看什么"):
  // 「所有」/ 无远程 →「全部任务」;本机 →「本机任务」;单设备 → 设备名;多选 → 「N 台机器」。
  let triggerText = t('ccAgent.sidebar.allSessions');
  if (showDeviceList && selectedDeviceId !== MACHINE_ALL) {
    if (selectedDeviceId.length === 1) {
      const only = selectedDeviceId[0];
      triggerText =
        only === MACHINE_LOCAL
          ? t('ccAgent.sidebar.scopeLocalSessions')
          : (devices.find((device) => device.deviceId === only)?.name ?? triggerLabel);
    } else {
      triggerText = t('ccAgent.sidebar.machineSwitcher.selectedCount', {
        count: selectedDeviceId.length,
      });
    }
  }

  // 点击展开(2026-08-13 定稿,推翻 2026-07-12 的 hover 展开——作为段头标题,
  // hover 扫过就弹菜单太吵)。modal={false}:侧栏是常驻面板,不锁列表滚动。
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`${triggerLabel}: ${triggerText}`}
          aria-busy={remoteSessionBootstrapLoading}
          className={cn(
            'flex min-w-0 items-center gap-1 focus:outline-none',
            SCOPE_TITLE_CLASS,
            // 菜单展开期间标题保持加深(data-state=open):鼠标移进菜单后 :hover
            // 失效,标题不能瞬间变淡、菜单像悬空没了锚点。
            'data-[state=open]:text-[var(--sidebar-nav-text)]',
          )}
        >
          <span className="truncate leading-none">{triggerText}</span>
          <ChevronDown size={13} strokeWidth={2} className="shrink-0" />
          {remoteSessionBootstrapLoading && (
            <span
              aria-hidden="true"
              className="inline-flex shrink-0 animate-spinner motion-reduce:animate-none"
            >
              <Loader2 size={12} strokeWidth={1.8} />
            </span>
          )}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        // 标题下方展开、左边贴齐标题左边;空间不足时 Radix 自动翻到上方。
        side="bottom"
        align="start"
        sideOffset={4}
        className={cn(MENU_CONTENT_CLASS, 'min-w-48')}
      >
        {showDeviceList ? (
          <>
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
          </>
        ) : null}
        {settingsItems}
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
