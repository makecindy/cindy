/**
 * machineSwitcherMenu.test.ts
 * ---------------------------------------------------------------------------
 * 2026-08-13 用户定稿(新设计,显式推翻 2026-07 的两条旧定稿):机器范围切换
 * 与「全部任务」段头**合并**——MachineSwitcherMenu 即主列表段头标题,文字反映
 * 当前范围(全部任务 / 本机任务 / 设备名 / N 台机器),点击展开范围菜单;
 * SidebarTopNav 不再有独立的远程机器行。为避免回退:
 *   - 范围标题由 MainListScopeHeader 渲染,ProjectsSection 与空态/占位分支共用;
 *     SidebarTopNav 不再 import / 渲染它;
 *   - 无远程设备时标题仍带箭头,菜单只留远程连接设置 / 侧边栏显示设置;
 *   - 点击展开(不再 hover 自动展开);段级收起同时取消;
 *   - 组件保留设备选择(单选 + 多选)+ 侧边栏显示设置 / 远程连接设置入口。
 *
 * 静态扫描风格(renderer 测试环境无 jsdom),与 sidebarUpperSingleButton.test.ts 一致。
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (...seg: string[]) => readFileSync(resolve(__dirname, '..', ...seg), 'utf8');

const sidebarUpperSource = read('features', 'cc-agent', 'CCAgentSidebarUpper.tsx');
const topNavSource = read('components', 'sidebar', 'SidebarTopNav.tsx');
const projectsSectionSource = read(
  'features',
  'cc-agent',
  'sidebar',
  'sections',
  'ProjectsSection.tsx',
);
const menuSource = read('features', 'cc-agent', 'sidebar', 'MachineSwitcherMenu.tsx');

describe('远程机器切换入口并入 SidebarTopNav(置顶段上方,固定不滚动)', () => {
  it('深链回落「所有」走 Transient(不落盘),不冲掉用户持久化的机器多选集', () => {
    // setSelectedMachineId 会持久化;深链越过过滤是系统性回落、非用户表态,
    // 必须走 setSelectedMachineIdTransient,否则一条通知深链就把落盘勾选集永久清掉。
    expect(sidebarUpperSource).toContain('setSelectedMachineIdTransient(MACHINE_ALL)');
    expect(sidebarUpperSource).not.toMatch(/[^t]setSelectedMachineId\(MACHINE_ALL\)/);
  });

  it('SidebarTopNav 不再渲染 MachineSwitcherMenu(2026-08-13 并入段头标题)', () => {
    expect(topNavSource).not.toContain("from '@/features/cc-agent/sidebar/MachineSwitcherMenu'");
    expect(topNavSource).not.toContain('<MachineSwitcherMenu />');
    // 搜索行仍在；最小化面板存在且选用侧栏模式时，恢复入口插在插件与搜索之间。
    expect(topNavSource).toContain('<SidebarInlineSearch');
  });

  // 2026-08-12 用户裁决(对齐 Codex):任务列表向上滚动时,除「新建」外的顶部导航行
  // 一起滚走。实现为 SidebarTopNav 分段渲染 —— Shell 只画固定段,cc-agent 在自己的
  // 列表滚动容器最上方画可滚动段;归属由 feature-context 的开关声明,Shell 不判路由。
  it('顶部导航分两段:新建固定,其余行进任务列表滚动区', () => {
    const featureContextSource = read('features', 'feature-context.tsx');
    const sidebarShellSource = read('components', 'sidebar', 'Sidebar.tsx');

    // 三段渲染契约。
    expect(topNavSource).toContain(
      "export type SidebarTopNavSection = 'all' | 'pinned' | 'scrollable'",
    );
    expect(topNavSource).toContain("const showPinned = section !== 'scrollable'");
    expect(topNavSource).toContain("const showScrollable = section !== 'pinned'");

    // Shell:接管时只画固定段,否则整块常驻行(插件页等无长列表的视图)。
    expect(sidebarShellSource).toContain(
      "<SidebarTopNav section={ownsTopNavScrollableRows ? 'pinned' : 'all'} />",
    );
    // Shell 仍不感知路由:归属只读 context 开关(架构不变量:Shell 不 import router)。
    // 只查 import 语句——文件头注释里本就写着「刻意不 import useLocation」。
    expect(sidebarShellSource).toContain('useOwnsTopNavScrollableRows()');
    expect(sidebarShellSource).not.toMatch(/^import .*from 'react-router-dom'/m);

    // cc-agent:展开态把可滚动段画进滚动容器;rail 态也由 CollapsedView 按导航偏好
    // 整段渲染(SidebarRailNavigation),Shell 不再补 rail 伙伴图标。
    expect(sidebarUpperSource).toContain('useOwnTopNavScrollableRows(true)');
    expect(sidebarUpperSource).toContain('<SidebarRailNavigation');
    expect(sidebarShellSource).toContain(
      '!ownsTopNavScrollableRows && <SidebarTopNav section="rail" />',
    );
    expect(sidebarUpperSource).toContain('<SidebarTopNav section="scrollable" />');
    const scrollRefIdx = sidebarUpperSource.indexOf('ref={sidebarScrollRef}');
    const scrollableRowsIdx = sidebarUpperSource.indexOf('<SidebarTopNav section="scrollable" />');
    expect(scrollRefIdx).toBeGreaterThanOrEqual(0);
    expect(scrollableRowsIdx).toBeGreaterThan(scrollRefIdx);
    // 搜索打开时搜索行作为滚动容器直接子项 sticky;打开查询时记下并复位滚动,
    // 清查询时还原,不再用 overlay 盖住输入框。
    expect(topNavSource).toContain(
      "const pinSearch = section === 'scrollable' && search.query.trim().length > 0",
    );
    // 搜索吸顶不改变导航行高度，也不在输入框外绘制额外背景。
    expect(topNavSource).toContain("pinSearch && 'sticky top-0 z-page-overlay'");
    expect(topNavSource).toContain("if (section === 'scrollable')");
    expect(sidebarUpperSource).toContain('lastListScrollTopRef.current = el.scrollTop');
    expect(sidebarUpperSource).toContain(
      'sidebarScrollRef.current?.scrollTo({ top: lastListScrollTopRef.current })',
    );
    expect(sidebarUpperSource).toContain('search.statusFilter');
    expect(sidebarUpperSource).toContain('searchProjectKey');
    expect(sidebarUpperSource).toContain('onContextMenu={(event) => event.stopPropagation()}');
    expect(sidebarUpperSource).toContain('{searchActive ? (');
    expect(sidebarUpperSource).toContain(
      '<div hidden={searchActive} className="flex flex-col gap-2">',
    );
    expect(sidebarUpperSource).toContain('freezeListScrollOnOpenRef.current = true');
    expect(sidebarUpperSource).toContain('const restoreListScroll = useCallback');
    expect(sidebarUpperSource).toContain('const restoreListScrollAfterPointer = useCallback');
    expect(sidebarUpperSource).toContain('restoreListScrollAfterPointer()');
    expect(sidebarUpperSource).toContain(
      "window.addEventListener('pointerup', onPointerEnd, true)",
    );
    expect(sidebarUpperSource).toContain("document.addEventListener('focusin', onFocusIn)");
    const inlineSearchSource = read('features', 'cc-agent', 'sidebar', 'SidebarInlineSearch.tsx');
    expect(inlineSearchSource).toContain('inputRef.current?.focus({ preventScroll: true })');
    expect(sidebarUpperSource).not.toContain('absolute inset-0 z-page-float');
    expect(sidebarUpperSource).not.toContain(
      "search.trimmed && 'sticky top-0 z-page-overlay bg-[var(--cmd-palette-bg)]'",
    );

    // 声明语义与 useRegisterSidebarUpper 一致:卸载不复位,避免切到 /settings 时闪变。
    expect(featureContextSource).toContain('export function useOwnTopNavScrollableRows');
    expect(featureContextSource).toContain('export function useOwnsTopNavScrollableRows');
  });

  // 导航改为用户自定义顺序:内置入口与插件主视图按保存顺序排列,「更多」收尾;
  // 展开态与 rail 同一契约。(插件停靠面板恢复入口已随停靠面板一起退场。)
  it('插件主视图与内置入口按保存顺序排列，「更多」收尾', () => {
    expect(topNavSource).toContain('<GhostMainViewNavEntry item={app} variant="row" />');
    const scrollRowsIdx = topNavSource.indexOf('{orderedNavigationRows}');
    const scrollMoreIdx = topNavSource.indexOf('{customizeRow}', scrollRowsIdx);
    expect(scrollRowsIdx).toBeGreaterThanOrEqual(0);
    expect(scrollMoreIdx).toBeGreaterThan(scrollRowsIdx);

    const persistentRowsIdx = topNavSource.lastIndexOf('orderedNavigationRows');
    const persistentMoreIdx = topNavSource.indexOf('!customizing && customizeRow', persistentRowsIdx);
    expect(persistentMoreIdx).toBeGreaterThan(persistentRowsIdx);

    const railStart = topNavSource.indexOf('export function SidebarRailNavigation');
    const railTilesIdx = topNavSource.indexOf('variant="rail" />', railStart);
    const railMoreIdx = topNavSource.indexOf('<SidebarNavigationMoreMenu', railTilesIdx);
    expect(railStart).toBeGreaterThanOrEqual(0);
    expect(railTilesIdx).toBeGreaterThan(railStart);
    expect(railMoreIdx).toBeGreaterThan(railTilesIdx);
  });

  // 2026-08-12 用户反馈:滚动后首行紧贴固定的「新建」被硬切、露出半截字。
  it('滚动后顶部渐隐,未滚动时不加 mask(避免裁掉首行 hover 胶囊 / 焦点环)', () => {
    // 按需启用:与右栏 TabBar 的 side-aware fade 同一取舍(常开 mask 会裁 border)。
    expect(sidebarUpperSource).toContain('const [topFade, setTopFade] = useState(false)');
    expect(sidebarUpperSource).toContain('const next = el.scrollTop > 1;');
    expect(sidebarUpperSource).toContain('...(topFade');
    // 用 mask-image(alpha)而非叠色块:透出侧栏自身背景,双主题天然正确、无需取色。
    expect(sidebarUpperSource).toContain(
      "WebkitMaskImage: 'linear-gradient(to bottom, transparent 0, black 24px)'",
    );
    expect(sidebarUpperSource).toContain(
      "maskImage: 'linear-gradient(to bottom, transparent 0, black 24px)'",
    );
    // jsdom 无 ResizeObserver:必须带 guard,否则测试环境构造即抛。
    expect(sidebarUpperSource).toContain("typeof ResizeObserver !== 'undefined'");
  });

  // 2026-08-12 用户裁决:整理菜单里「显示 / 任务信息」加行首图标,让选项一眼可辨。
  it('显示与任务信息选项带图标,显示模式与置顶段菜单同字形', () => {
    const filterSource = read('features', 'cc-agent', 'sidebar', 'SidebarFilterPopover.tsx');
    const pinnedSectionSource = read(
      'features',
      'cc-agent',
      'sidebar',
      'sections',
      'PinnedSection.tsx',
    );

    // 显示模式:同一概念在两处菜单必须用同一个 lucide 字形(不各造一套)。
    expect(filterSource).toContain("labelKey: 'ccAgent.sidebar.viewStyleList', Icon: AlignJustify");
    expect(filterSource).toContain(
      "labelKey: 'ccAgent.sidebar.viewStyleListWide', Icon: LayoutList",
    );
    expect(pinnedSectionSource).toContain(
      "labelKey: 'ccAgent.sidebar.viewStyleList', Icon: AlignJustify",
    );
    expect(pinnedSectionSource).toContain(
      "labelKey: 'ccAgent.sidebar.viewStyleListWide', Icon: LayoutList",
    );

    // 任务信息各项各配数据类型图标;时间用 Clock 而非 Timer(后者是自动任务专用字形)。
    expect(filterSource).toContain("labelKey: 'ccAgent.sidebar.taskInfo.time', Icon: Clock");
    expect(filterSource).toContain("labelKey: 'ccAgent.sidebar.taskInfo.pr', Icon: GitPullRequest");
    expect(filterSource).toContain("labelKey: 'ccAgent.sidebar.taskInfo.worktree', Icon: Folders");
    expect(filterSource).toContain("labelKey: 'ccAgent.sidebar.taskInfo.tokens', Icon: Coins");
    expect(filterSource).toContain("labelKey: 'ccAgent.sidebar.taskInfo.cost', Icon: Wallet");
    expect(filterSource).not.toMatch(/taskInfo\.time', Icon: Timer/);

    // 本轮确认的菜单统一带图标，分组入口直接表达侧栏组标题与缩进任务行。
    expect(filterSource).toContain('Icon={SidebarGroupsIcon}');
    expect(filterSource).toContain('Icon={ArrowDownWideNarrow}');
    expect(filterSource).toContain('Icon={ListOrdered}');
  });

  // 2026-08-12 用户裁决:置顶段头的显示样式按钮显示**当前选中**的模式图标,
  // 此前恒为 LayoutGrid(网格),选文字/列表时与实际状态不符。
  it('置顶段头显示样式 trigger 的图标跟随当前模式', () => {
    const pinnedSectionSource = read(
      'features',
      'cc-agent',
      'sidebar',
      'sections',
      'PinnedSection.tsx',
    );
    // 选项表提到模块级,菜单项与 trigger 共用同一张表(不各写一份字形映射)。
    expect(pinnedSectionSource).toContain('const VIEW_STYLE_OPTIONS');
    expect(pinnedSectionSource).toContain('function viewStyleIcon(mode: SidebarViewMode)');
    expect(pinnedSectionSource).toContain('const ViewStyleTriggerIcon = viewStyleIcon(mode)');
    expect(pinnedSectionSource).toContain('<ViewStyleTriggerIcon size={13} strokeWidth={2} />');
    // trigger 不再硬编码网格图标。
    expect(pinnedSectionSource).not.toContain('<LayoutGrid size={13} strokeWidth={2} />');
  });

  // 2026-08-12 用户裁决:侧栏空白处右键也能开整理菜单。
  it('侧栏空白处右键打开整理菜单(行级右键仍归各自的菜单)', () => {
    const filterSource = read('features', 'cc-agent', 'sidebar', 'SidebarFilterPopover.tsx');
    // 同一组件两种形态:段头按钮 / 受控光标定位(隐形 fixed trigger,同 ProjectNode 做法)。
    expect(filterSource).toContain('const isContextMode = contextMenuPos !== undefined');
    expect(filterSource).toContain("position: 'fixed'");
    expect(filterSource).toContain('left: contextMenuPos?.x ?? 0');
    expect(filterSource).toContain('top: contextMenuPos?.y ?? 0');

    // 滚动容器接右键;行级菜单靠自身 stopPropagation 抢先处理,这里只兜空白区。
    expect(sidebarUpperSource).toContain('onContextMenu={handleSidebarBlankContextMenu}');
    expect(sidebarUpperSource).toContain(
      'setOrganizeMenuPos({ x: event.clientX, y: event.clientY })',
    );
    expect(sidebarUpperSource).toContain('contextMenuPos={organizeMenuPos}');
  });

  // 2026-08-13 实机回归:重命名输入框上右键,行级 handler 裸 return 让事件冒泡到
  // 滚动容器,整理菜单和系统的剪切/粘贴菜单叠着弹。编辑态必须 stopPropagation
  // (但不 preventDefault——系统可编辑菜单要照常出)。
  it('行级右键在编辑态阻止冒泡,不触发空白处整理菜单', () => {
    const files = [
      ['features', 'cc-agent', 'sidebar', 'SessionItem.tsx'],
      ['features', 'cc-agent', 'sidebar', 'SessionCard.tsx'],
      ['features', 'cc-agent', 'sidebar', 'sections', 'ProjectNode.tsx'],
    ] as const;
    for (const parts of files) {
      const source = read(...parts);
      // 编辑态分支必须 stopPropagation 后再 return;裸 `if (isEditing) return` 即回归。
      expect(source).toMatch(
        /if \(isEditing(?:Name)?\) \{\s*\n(?:\s*\/\/[^\n]*\n)*\s*e\.stopPropagation\(\);\s*\n\s*return;/,
      );
      expect(source).not.toMatch(
        /onContextMenu=\{\(e\) => \{\s*\n\s*if \(isEditing(?:Name)?\) return;/,
      );
    }
  });

  it('项目顺序与任务排序拆开,关分组不再改写 sortBy', () => {
    const hookSource = read('features', 'cc-agent', 'hooks', 'useSidebarFilter.ts');
    expect(hookSource).not.toContain('nextSortByAfterGroupByChange');
    expect(hookSource).toContain('setProjectOrder');
    expect(hookSource).toContain('migrateLegacyManualSort');
  });

  it('列表行也接收来源标签(平铺时项目会话不再丢项目名)', () => {
    const entryListSource = read('features', 'cc-agent', 'sidebar', 'SessionEntryList.tsx');
    expect(entryListSource).toContain('sourceLabel={sourceLabelMap?.get(entry.session.id)}');
    expect(
      entryListSource.match(/sourceLabel=\{sourceLabelMap\?\.get\(entry\.session\.id\)\}/g),
    ).toHaveLength(2);
    const automationGroupSource = read(
      'features',
      'cc-agent',
      'sidebar',
      'AutomationSessionGroupItem.tsx',
    );
    expect(automationGroupSource).toContain('sourceLabel: sourceLabelMap?.get(session.id)');
    const cardSource = read('features', 'cc-agent', 'sidebar', 'SessionCard.tsx');
    expect(cardSource).toContain('sourceLabel,');
    // Outside the inbox; the inbox leaves the project name to the row's project icon.
    expect(cardSource).toContain('{showProject && sourceLabel && !inboxMode ? (');
    const itemSource = read('features', 'cc-agent', 'sidebar', 'SessionItem.tsx');
    expect(itemSource).toContain('{showProject && sourceLabel && !inboxMode ? (');
  });

  // 2026-08-12 用户裁决:筛选各维度选中后菜单不关闭(常要连调几项);排序与显示
  // 模式仍选完即关(一次一个决定)。
  it('所有子菜单选择后保持打开,便于连续调整', () => {
    const filterSource = read('features', 'cc-agent', 'sidebar', 'SidebarFilterPopover.tsx');
    const selectItem = filterSource.slice(
      filterSource.indexOf('function SelectMenuItem('),
      filterSource.indexOf('function CheckMenuItem('),
    );
    expect(selectItem).toMatch(/event\.preventDefault\(\);\s*onSelect\(\);/);
    expect(selectItem).not.toContain('keepOpen');
    expect(filterSource).toContain('checked={groupDevice}');
    expect(filterSource).not.toContain("disabled={sortBy === 'manual'}");
  });

  // 2026-08-13 用户裁决:「优先级」光看标签猜不出排序依据,需要 hover 说明。
  it('排序的「优先级」有 hover 说明,自解释的档位不加', () => {
    const filterSource = read('features', 'cc-agent', 'sidebar', 'SidebarFilterPopover.tsx');
    // 说明挂在选项表上(与 labelKey / Icon 同源),不在渲染处硬编码文案。
    expect(filterSource).toMatch(
      /value: 'priority',\s*\n\s*labelKey: 'ccAgent\.sidebar\.filterSortBy\.priority',\s*\n\s*tipKey: 'ccAgent\.sidebar\.filterSortByTip\.priority',/,
    );
    // recency / manual 名字自解释,不配说明——菜单不该变成说明书。
    expect(filterSource).not.toMatch(/filterSortBy\.recency',\s*\n?\s*tipKey/);
    expect(filterSource).not.toMatch(/filterSortBy\.manual',\s*\n?\s*tipKey/);
    // side="right":菜单贴侧栏右缘,提示往上下会压住相邻选项。
    expect(filterSource).toContain('<Tip text={tip} side="right">');
    // 渲染处从选项表取,tipKey 缺省时传 undefined(Tip 据此透明透传、不挂 tooltip)。
    expect(filterSource).toContain('tip={option.tipKey ? t(option.tipKey) : undefined}');
  });

  // 设计文档 §3.3 定稿 + 2026-08-12 用户重申:筛选不作用于置顶区。
  // 2026-08-12 用户裁决:任务信息按用户勾选顺序显示(先勾时间再勾费用 → 时间在前)。
  it('任务信息渲染顺序 = 勾选顺序,不再是固定的 pr → tokens → cost → time', () => {
    const infoMetaSource = read('features', 'cc-agent', 'sidebar', 'SessionInfoMeta.tsx');
    const filterCoreSource = read(
      'features',
      'cc-agent',
      'hooks',
      'helpers',
      'sidebarFilterCore.ts',
    );

    // 勾选状态本身按先后追加(存储即顺序),这是整条链路的源头。
    expect(filterCoreSource).toContain('return prev.concat(field);');
    // 拼装遍历 fields 数组,而不是走固定的 if 序列。
    expect(infoMetaSource).toContain('for (const field of fields)');
    // PR 也参与排序:以 'pr' 占位进入 pieces,渲染时换成徽标。
    expect(infoMetaSource).toContain("if (field === 'pr' && hasPrRef)");
    expect(infoMetaSource).toContain("pieces.push({ key: 'pr', text: '' })");
    expect(infoMetaSource).toContain("piece.key === 'pr' ?");
    expect(infoMetaSource).toContain("if (field === 'worktree' && hasWorktree)");
    expect(infoMetaSource).toContain("piece.key === 'worktree' ?");
    // 菜单摘要的图标串同样按勾选顺序(遍历 taskInfoFields,不是遍历选项表)。
    const filterSource = read('features', 'cc-agent', 'sidebar', 'SidebarFilterPopover.tsx');
    expect(filterSource).toContain('{summaryFields.map((field) => {');
  });

  // 2026-08-12 用户裁决:任务信息行的当前选中项用图标表示,不再罗列短词。
  it('任务信息摘要用图标串,筛选各维度行也有图标', () => {
    const filterSource = read('features', 'cc-agent', 'sidebar', 'SidebarFilterPopover.tsx');
    // 摘要节点渲染已选项的图标(顺序见上一条:按勾选顺序);文字版留给 aria-label。
    expect(filterSource).toContain('valueNode={');
    expect(filterSource).toContain('aria-label={valueNode ? value : undefined}');
    // 具体维度行配图标(状态 / 项目 / Agent / 最近活跃 / 筛选 / 任务信息)。
    expect(filterSource).toContain('Icon={Filter}');
    expect(filterSource).toContain('toggleProject(DIALOGUE_FILTER_KEY)');
    expect(filterSource).toContain("t('ccAgent.sidebar.dialogues')");
    expect(filterSource).toContain('Icon={ListChecks}');
    expect(filterSource).toContain('Icon={Folder}');
    expect(filterSource).toContain('Icon={Bot}');
    expect(filterSource).toContain('Icon={CalendarClock}');
    expect(filterSource).toContain('Icon={Info}');
  });

  it('机器过滤激活时其它 action 仍按默认 hover 收起(不随选中设备常驻)', () => {
    // 选中设备只体现在 MachineSwitcherMenu 自身(active 指示),其它 action 不因此常驻。
    expect(projectsSectionSource).not.toContain('useMachineFilterActive');
  });

  it('MachineSwitcherMenu 常驻显示,不再有 hoverGroup 浮现模式', () => {
    // 固定行常驻,hover-reveal(opacity-0 + group-hover 浮现)逻辑随 hoverGroup prop 一起删除。
    expect(menuSource).not.toContain('hoverGroup');
    expect(menuSource).not.toContain('opacity-0');
    expect(menuSource).not.toContain('group-hover/sidebar-header');
  });

  it('allMachinesLabel 孤儿 key 已从全部语言包删除(规则 18)', () => {
    // trigger 改回复用 allMachines 后,专用的 allMachinesLabel 不再被消费,不留孤儿 key。
    for (const locale of ['zh-CN', 'zh-TW', 'en', 'ja', 'ko']) {
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
    // 「远程机器」标题行已移除(2026-07 用户定稿);有远程时菜单从「所有」开始,
    // 无远程时从两个设置入口开始。trigger 也不包 <Tip>。
    expect(menuSource).not.toContain('py-1.5 text-xs font-medium');
    expect(menuSource).not.toMatch(/<Tip\b/);
    expect(menuSource).not.toContain("from '@/components/ui/tooltip'");
  });

  it('multiSelect / deselect / menuTrigger 在全部语言包都存在,且不再叫远程机器', () => {
    for (const locale of ['zh-CN', 'zh-TW', 'en', 'ja', 'ko']) {
      const json = JSON.parse(read('i18n', 'locales', locale, 'common.json')) as {
        ccAgent: { sidebar: { machineSwitcher: Record<string, string> } };
      };
      for (const key of ['multiSelect', 'deselect', 'menuTrigger']) {
        const value = json.ccAgent.sidebar.machineSwitcher[key];
        expect(value, `locale ${locale} 缺 ${key}`).toBeTruthy();
      }
      expect(json.ccAgent.sidebar.machineSwitcher.menuTrigger).not.toMatch(
        /远程机器|遠端機器|Remote machines|リモートマシン|원격 기기/,
      );
    }
  });

  it('MachineSwitcherMenu 点击展开(2026-08-13 定稿,推翻 2026-07-12 hover 展开)', () => {
    // 作为段头标题,hover 扫过就弹菜单太吵;hover 机制连同 useHoverOpenMenu
    // hook 一起下线(该 hook 已无消费方,文件已删)。
    expect(menuSource).not.toContain('useHoverOpenMenu');
    expect(menuSource).not.toContain('triggerProps');
    // 非模态:侧栏是常驻面板,不锁列表滚动。
    expect(menuSource).toContain('modal={false}');
    // 菜单在标题下方展开、左边贴齐标题左边。
    expect(menuSource).toContain('side="bottom"');
    expect(menuSource).toContain('align="start"');
  });

  it('SidebarFilterPopover 点击展开(2026-08-12 用户裁决,推翻早前的 hover 自动展开)', () => {
    const filterSource = read('features', 'cc-agent', 'sidebar', 'SidebarFilterPopover.tsx');
    // 显示设置菜单改回普通 Radix 点击开合:hover 机制整套摘除。
    // 断言按「是否真的接线」判定,不按字符串出现——文件头注释会提到 useHoverOpenMenu 这个名字。
    expect(filterSource).not.toContain("from './useHoverOpenMenu'");
    expect(filterSource).not.toMatch(/useHoverOpenMenu\(/);
    expect(filterSource).not.toMatch(/useHoverMenuArea\(/);
    expect(filterSource).not.toContain('HoverMenuAreaContext.Provider');
    expect(filterSource).not.toContain('{...triggerProps}');
    expect(filterSource).not.toContain('{...contentProps}');
    // 非模态保留(侧栏常驻,不锁滚动);2026-08-12 起同一组件还支持受控光标模式
    // (空白处右键),故 modal 与 open 分行书写,断言收窄到 modal 本身。
    expect(filterSource).toMatch(/<DropdownMenu\s+modal=\{false\}/);
    // 触发按钮配色与段头其余按钮统一到侧栏 token 对(此前用通用 text-tertiary,hover 不齐)。
    expect(filterSource).toContain("'text-[var(--sidebar-list-muted)]'");
    expect(filterSource).toContain("'transition-colors hover:text-[var(--sidebar-nav-text)]'");
    expect(filterSource).not.toContain("'text-[var(--text-tertiary)]'");
    // hover 不再开菜单 → 补 tooltip(与「对话」段头同款按钮一致)。
    expect(filterSource).toContain(
      '<Tip text={t(\'ccAgent.sidebar.organizeSidebar\')} side="bottom">',
    );
  });

  it('显示设置菜单无自身标题行,且高度按可用空间收口可滚动(2026-08-12 用户裁决)', () => {
    const filterSource = read('features', 'cc-agent', 'sidebar', 'SidebarFilterPopover.tsx');
    // 标题行去掉节约高度(与 MachineSwitcherMenu 2026-07 的「无标题行」同规);
    // organizeSidebar 文案仍被 trigger tooltip 消费,不是孤儿 key(规则 18)。
    const contentStart = filterSource.indexOf('<DropdownMenuContent');
    const firstSectionHeading = filterSource.indexOf('filterGroupByHeading');
    expect(contentStart).toBeGreaterThanOrEqual(0);
    expect(firstSectionHeading).toBeGreaterThan(contentStart);
    // content 打开后第一个渲染的文案就是「分组」段标题,中间没有 organizeSidebar 标题行。
    expect(filterSource.slice(contentStart, firstSectionHeading)).not.toContain('organizeSidebar');
    // 渲染进程画不到窗口外:菜单高度按 Radix 可用高度收口 + 纵向滚动,
    // 否则 content 的 overflow-hidden 会把超出部分静默切掉(实机丢过「分组」整段)。
    expect(filterSource).toContain(
      'max-h-[calc(var(--radix-dropdown-menu-content-available-height)-0.75rem)] overflow-x-hidden overflow-y-auto',
    );
    expect(filterSource).toContain('collisionPadding={8}');
  });

  it('项目顺序菜单勾选跟 resolveDisplayedProjectOrder,不回退查看端偏好', () => {
    const filterSource = read('features', 'cc-agent', 'sidebar', 'SidebarFilterPopover.tsx');
    expect(filterSource).toContain('resolveDisplayedProjectOrder(');
    expect(filterSource).toContain(
      'scopedProjectOrder: FilterProjectOrder = resolveDisplayedProjectOrder(',
    );
    expect(filterSource).not.toContain("hostCustom ? 'custom' : projectOrder");
  });

  it('远程 GET 用 fetch fence,本机播种只在成功后按 owner 锁定', () => {
    const hookSource = read('features', 'cc-agent', 'hooks', 'useRemoteHostProjectOrders.ts');
    expect(hookSource).toContain('createProjectOrderFetchFence');
    expect(hookSource).toContain('shouldApplyFetch');
    expect(hookSource).toContain('shouldSeedLocalHostProjectOrder');
    expect(hookSource).toContain('seededLocalHostOwners.add');
    expect(hookSource).not.toContain('localHostSeedStarted = true');
    expect(hookSource).toContain('void load(1)');
    expect(hookSource).toContain(
      "attempt < 3 && entries.some(([, result]) => result.kind === 'transient')",
    );
  });
});
