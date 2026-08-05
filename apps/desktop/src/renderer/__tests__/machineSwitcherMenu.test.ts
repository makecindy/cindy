/**
 * machineSwitcherMenu.test.ts
 * ---------------------------------------------------------------------------
 * 回归(2026-07):远程机器切换入口(MachineSwitcherMenu)并入 shell 的
 * SidebarTopNav(新建 / 自动任务 / Skill / 搜索)列表作末行,与其同款行样式,
 * 位于置顶段上方、滚动容器之外,不随会话列表滚动;不再挂在「项目」段头 /
 * 日期分组头 / 连接中占位页头(2026-07 用户定稿)。为避免回退:
 *   - SidebarTopNav 渲染 MachineSwitcherMenu 作列表末行;
 *   - CCAgentSidebarUpper 不再渲染任何机器切换入口(旧整行 MachineSwitcher /
 *     滚动区内的菜单都已移除),三种视图(项目 / 日期 / 连接中占位)都靠顶部
 *     常驻行切回「所有」,不会被困住;
 *   - ProjectsSection / DateGroupedSessionsSection 段头不再渲染该菜单;
 *   - 组件保留可见性门控 + 设备选择 + 远程连接设置入口。
 *
 * 静态扫描风格(renderer 测试环境无 jsdom),与 sidebarUpperSingleButton.test.ts 一致。
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (...seg: string[]) => readFileSync(resolve(__dirname, '..', ...seg), 'utf8');

const sidebarUpperSource = read('features', 'cc-agent', 'CCAgentSidebarUpper.tsx');
const topNavSource = read('components', 'sidebar', 'SidebarTopNav.tsx');
const projectsSectionSource = read('features', 'cc-agent', 'sidebar', 'sections', 'ProjectsSection.tsx');
const dateSectionSource = read('features', 'cc-agent', 'sidebar', 'sections', 'DateGroupedSessionsSection.tsx');
const menuSource = read('features', 'cc-agent', 'sidebar', 'MachineSwitcherMenu.tsx');

describe('远程机器切换入口并入 SidebarTopNav(置顶段上方,固定不滚动)', () => {
  it('CCAgentSidebarUpper 不再渲染任何机器切换入口', () => {
    // 旧整行 MachineSwitcher 与滚动区内的 MachineSwitcherMenu 都已移除,
    // 入口统一在 shell SidebarTopNav 末行。
    expect(sidebarUpperSource).not.toContain('MachineSwitcherMenu');
    expect(sidebarUpperSource).not.toMatch(/<MachineSwitcher\s*\/>/);
  });

  it('深链回落「所有」走 Transient(不落盘),不冲掉用户持久化的机器多选集', () => {
    // setSelectedMachineId 会持久化;深链越过过滤是系统性回落、非用户表态,
    // 必须走 setSelectedMachineIdTransient,否则一条通知深链就把落盘勾选集永久清掉。
    expect(sidebarUpperSource).toContain('setSelectedMachineIdTransient(MACHINE_ALL)');
    expect(sidebarUpperSource).not.toMatch(/[^t]setSelectedMachineId\(MACHINE_ALL\)/);
  });

  it('SidebarTopNav 渲染 MachineSwitcherMenu 作列表末行(与新建 / 搜索同列表,固定不滚动)', () => {
    expect(topNavSource).toContain("from '@/features/cc-agent/sidebar/MachineSwitcherMenu'");
    // 末行:出现在 SidebarInlineSearch 之后。
    const searchIdx = topNavSource.indexOf('<SidebarInlineSearch');
    const menuIdx = topNavSource.indexOf('<MachineSwitcherMenu />');
    expect(searchIdx).toBeGreaterThanOrEqual(0);
    expect(menuIdx).toBeGreaterThan(searchIdx);
  });

  it('连接中占位页不再自带 MachineSwitcherMenu(固定行已常驻,不会被困住)', () => {
    const idx = sidebarUpperSource.indexOf('selectedMachineConnecting ?');
    expect(idx).toBeGreaterThanOrEqual(0);
    const branch = sidebarUpperSource.slice(idx, idx + 600);
    expect(branch).not.toContain('<MachineSwitcherMenu');
  });

  it('项目段头不再渲染 MachineSwitcherMenu(已移到顶部固定行)', () => {
    expect(projectsSectionSource).not.toContain('MachineSwitcherMenu');
  });

  it('项目视图:早退条件不再依赖 hasRemote 保留空段头(入口不在本段头)', () => {
    expect(projectsSectionSource).not.toContain('useMachineSwitcher');
    expect(projectsSectionSource).not.toContain('hasRemote');
  });

  it('日期分组头不再渲染 MachineSwitcherMenu(已移到顶部固定行)', () => {
    expect(dateSectionSource).not.toContain('MachineSwitcherMenu');
  });

  it('日期分组视图:选中 0 会话的远程机器时仍渲染空态段头(空列表可感知)', () => {
    // groups 为空且 filter 未激活、初始加载已结束时,若还选中了非「所有」的远程机器,
    // machineFilterActive 让组件继续渲染空态段头(「空」标签),让用户看得出是机器
    // 过滤导致的空列表而非白屏。
    expect(dateSectionSource).toContain('machineFilterActive');
    expect(dateSectionSource).toMatch(/selectedDeviceId\s*!==\s*MACHINE_ALL/);
    expect(dateSectionSource).toContain(
      'if (groups.length === 0 && !isLoading && !filter.isFilterActive && !machineFilterActive) return null;',
    );
  });

  it('按时间分组视图:整理侧边栏(filter)按钮默认隐藏、hover 段头才浮现', () => {
    // 段头挂 group/sidebar-header,SidebarFilterPopover 包在 hover-reveal 容器里。
    expect(dateSectionSource).toContain('group/sidebar-header');
    expect(dateSectionSource).toContain('HEADER_HOVER_ACTION_CLASS');
    // filter popover 包在 hover-reveal 容器里(默认隐藏,hover 段头才浮现)。
    expect(dateSectionSource).toMatch(
      /<div className=\{HEADER_HOVER_ACTION_CLASS\}>\s*<SidebarFilterPopover/,
    );
  });

  it('机器过滤激活时其它 action 仍按默认 hover 收起(不随选中设备常驻)', () => {
    // 选中设备只体现在 MachineSwitcherMenu 自身(active 指示),其它 action 不因此常驻。
    expect(projectsSectionSource).not.toContain('useMachineFilterActive');
    expect(dateSectionSource).not.toContain('useMachineFilterActive');
  });

  it('MachineSwitcherMenu 常驻显示,不再有 hoverGroup 浮现模式', () => {
    // 固定行常驻,hover-reveal(opacity-0 + group-hover 浮现)逻辑随 hoverGroup prop 一起删除。
    expect(menuSource).not.toContain('hoverGroup');
    expect(menuSource).not.toContain('opacity-0');
    expect(menuSource).not.toContain('group-hover/sidebar-header');
  });

  it('trigger 是 SidebarTopNav 同款文字行(图标 + 范围文字 + 下拉箭头),不是图标按钮', () => {
    // trigger 文案 = 当前范围摘要:所有机器 / 本机 / 设备名 / N 台机器;旁边挂 ChevronDown。
    expect(menuSource).toContain('triggerText');
    // 「所有」态直接复用菜单项同款 allMachines 文案(2026-07 用户定稿,不用「所有机器」)。
    expect(menuSource).toContain("t('ccAgent.sidebar.machineSwitcher.allMachines')");
    expect(menuSource).toMatch(/<span className="truncate[^"]*">\{triggerText\}<\/span>/);
    expect(menuSource).toContain('<ChevronDown');
    // 与 SidebarTopNav ROW_CLASS 同款 pill 行样式;范围文字已表达过滤状态,
    // trigger 不叠常驻高亮底色(常亮易被误读为导航选中态,2026-07 用户定稿)。
    expect(menuSource).toContain('h-8 w-full');
    expect(menuSource).toContain('rounded-full');
    expect(menuSource).toContain('hover:bg-sidebar-item-hover');
    expect(menuSource).not.toContain('filterActive');
    expect(menuSource).not.toContain('--chat-input-chip-bg');
  });

  it('allMachinesLabel 孤儿 key 已从 4 个语言包删除(规则 18)', () => {
    // trigger 改回复用 allMachines 后,专用的 allMachinesLabel 不再被消费,不留孤儿 key。
    for (const locale of ['zh-CN', 'en', 'ja', 'ko']) {
      const json = JSON.parse(read('i18n', 'locales', locale, 'common.json')) as {
        ccAgent: { sidebar: { machineSwitcher: Record<string, string> } };
      };
      expect(
        'allMachinesLabel' in json.ccAgent.sidebar.machineSwitcher,
        `locale ${locale} 仍残留 allMachinesLabel`,
      ).toBe(false);
    }
  });

  it('MachineSwitcherMenu 展开菜单无标题行、无 trigger tooltip', () => {
    // 「远程机器」标题行已移除(2026-07 用户定稿),菜单直接从「所有」开始;也不包 <Tip>。
    expect(menuSource).not.toContain('py-1.5 text-xs font-medium');
    expect(menuSource).not.toMatch(/<Tip\b/);
    expect(menuSource).not.toContain("from '@/components/ui/tooltip'");
  });

  it('菜单项默认单选(整体替换选择),多选走行尾 hover 浮现的多选框', () => {
    // 本机 / 设备行点击 = 单选:select([...]) 整体替换勾选集(菜单自然关闭,
    // 不再对正常项 preventDefault);多选框走 toggle。
    expect(menuSource).toContain('onSelect={() => applySelect([MACHINE_LOCAL])}');
    expect(menuSource).toContain('applySelect([device.deviceId])');
    expect(menuSource).toContain('onToggle={() => applyToggle(MACHINE_LOCAL)}');
    expect(menuSource).toContain('onToggle={rejected ? undefined : () => applyToggle(device.deviceId)}');
    // 多选框只在行高亮(hover / 键盘)时浮现;Radix item select 由 pointerup 驱动,
    // down / up / click 三段都要拦截,toggle 挂 pointerup(挂 click 会因 pointerdown
    // 被 preventDefault 而"点了没反应",整行单选还会把菜单收掉)。
    expect(menuSource).toContain('group-data-[highlighted]/machine-item:visible');
    expect(menuSource).toContain('onPointerDown');
    expect(menuSource).toMatch(/onPointerUp=\{\(event\) => \{[\s\S]*?onToggle\(\);/);
    expect(menuSource).toContain("t('ccAgent.sidebar.machineSwitcher.multiSelect')");
    // 未勾选的行:空复选框只用于「追加勾选」。
    expect(menuSource).toContain('{onToggle && !selected && (');
    // 已勾选的行:✓ 本身是取消勾选的点击目标(行高亮浮现复选框边框提示可点,
    // 点它 toggle 移除、菜单保持打开)——用户看到 ✓ 直觉就是点它取消,
    // 不能只留 Cmd/Ctrl 修饰键路径(2026-07 用户反馈「点不掉」)。
    expect(menuSource).toContain('{onToggle && selected && (');
    expect(menuSource).toContain("t('ccAgent.sidebar.machineSwitcher.deselect')");
    // 「所有」等无多选路径的选中项仍是纯展示 ✓(不可点)。
    expect(menuSource).toContain('{selected && !onToggle && (');
    // 右槽恒定 w-4 占位,复选框浮现只切 visibility(invisible→visible),
    // 不用 hidden——避免 hover 时整行宽度 / label 截断位置跳变。
    expect(menuSource).toContain('group-data-[highlighted]/machine-item:visible');
    expect(menuSource).not.toContain('group-data-[highlighted]/machine-item:flex');
    // 被拒项:保持菜单打开只弹提示(rejected 分支 preventDefault)。
    expect(menuSource).toMatch(/if \(rejected\) \{\s*event\.preventDefault\(\);/);
  });

  it('键盘 / 修饰键多选:Cmd\\/Ctrl + Enter 或点击整行 toggle(Greptile P2 键盘可达性)', () => {
    // Radix onSelect 不带修饰键,真实输入事件(trusted click / keydown)把修饰键记进 ref;
    // 键盘 Enter/Space 合成的 click isTrusted=false 不会覆盖。
    expect(menuSource).toContain('modifierHeldRef');
    expect(menuSource).toContain('event.isTrusted');
    expect(menuSource).toMatch(/event\.metaKey \|\| event\.ctrlKey/);
    expect(menuSource).toMatch(/if \(withModifier && onToggle\) \{\s*event\.preventDefault\(\);\s*onToggle\(\);/);
    // 复选框是纯指针快捷目标,对 a11y 树隐藏(键盘路径在行级),留 title 提示。
    expect(menuSource).toContain('aria-hidden="true"');
    expect(menuSource).not.toContain("role=\"checkbox\"");
  });

  it('multiSelect / deselect 在 4 个语言包都存在(规则 18:不留英文回退)', () => {
    for (const locale of ['zh-CN', 'en', 'ja', 'ko']) {
      const json = JSON.parse(read('i18n', 'locales', locale, 'common.json')) as {
        ccAgent: { sidebar: { machineSwitcher: Record<string, string> } };
      };
      for (const key of ['multiSelect', 'deselect']) {
        const value = json.ccAgent.sidebar.machineSwitcher[key];
        expect(value, `locale ${locale} 缺 ${key}`).toBeTruthy();
      }
    }
  });

  it('MachineSwitcherMenu 保留门控 / 设备选择 / 远程设置入口', () => {
    expect(menuSource).toContain('if (!hasRemote) return null');
    expect(menuSource).toContain('MACHINE_ALL');
    expect(menuSource).toContain('MACHINE_LOCAL');
    expect(menuSource).toContain("navigate('/settings?tab=remote-control')");
    expect(menuSource).toContain('useMachineSwitcher');
  });

  it('非会话视图选机器时切回会话视图(与新建 / 搜索行同惯例,Codex P2)', () => {
    // 本行随 SidebarTopNav 在所有非 rail 视图常驻,但机器过滤只作用于会话列表——
    // 选择动作(单选 / 多选 toggle)统一经 applySelect / applyToggle 附带
    // navigateToView('cc-agent')(同视图 no-op),避免在 skillhub / 设置视图选完
    // 看不到任何效果。
    expect(menuSource).toContain('useActiveMainView');
    expect(menuSource).toMatch(/const applySelect = [\s\S]*?ensureConversationListVisible\(\);/);
    expect(menuSource).toMatch(/const applyToggle = [\s\S]*?ensureConversationListVisible\(\);/);
    // doc-browse(/cc-agent/files/:sessionId)侧栏是文件树且 navigateToView 对
    // /cc-agent/* no-op —— 必须显式退回该会话对话路由恢复会话列表。
    expect(menuSource).toContain("useMatch('/cc-agent/files/:sessionId')");
    expect(menuSource).toMatch(/navigate\(`\/cc-agent\/\$\{docSessionId\}`\)/);
    expect(menuSource).toContain("navigateToView('cc-agent')");
    // 所有选择动作都走 apply*(不残留直接调用 select/toggle 的菜单项)。
    expect(menuSource).toContain('applySelect(MACHINE_ALL)');
    expect(menuSource).toContain('applySelect([MACHINE_LOCAL])');
    expect(menuSource).toContain('applySelect([device.deviceId])');
    expect(menuSource).toContain('applyToggle(MACHINE_LOCAL)');
    expect(menuSource).toContain('applyToggle(device.deviceId)');
  });

  it('MachineSwitcherMenu hover 自动展开(2026-07-12 产品定稿,推翻早前 Codex P2 点击展开)', () => {
    // 鼠标移到本行短延迟即弹机器菜单、移开即收;受控开合走 useHoverOpenMenu,
    // trigger / content 必须完整接线(triggerRef 供「点击触发按钮不误关」判定)。
    expect(menuSource).toContain('useHoverOpenMenu');
    expect(menuSource).toContain('open={open} onOpenChange={onOpenChange}');
    expect(menuSource).toContain('ref={triggerRef as Ref<HTMLButtonElement>}');
    expect(menuSource).toContain('{...triggerProps}');
    expect(menuSource).toContain('{...contentProps}');
    // hover 展开必须非模态,否则 body pointer-events:none 造成开/关闪烁循环。
    expect(menuSource).toContain('modal={false}');
    // 菜单在行下方展开、左边贴齐本行左边(2026-07-13 用户定稿,替换 07-12 的右侧飞出)。
    expect(menuSource).toContain('side="bottom"');
    expect(menuSource).toContain('align="start"');
  });

  it('SidebarFilterPopover 仍用 useHoverOpenMenu(段头 hover 开合不受本次改动影响)', () => {
    const filterSource = read('features', 'cc-agent', 'sidebar', 'SidebarFilterPopover.tsx');
    expect(filterSource).toContain('useHoverOpenMenu');
    expect(filterSource).toContain('{...triggerProps}');
    expect(filterSource).toContain('{...contentProps}');
    expect(filterSource).toContain('HoverMenuAreaContext.Provider');
    expect(filterSource).toContain('useHoverMenuArea');
  });
});
