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
  it('CCAgentSidebarUpper 不再渲染旧整行 MachineSwitcher', () => {
    // 旧整行 MachineSwitcher 已移除;范围标题改由 MainListScopeHeader 在
    // 空态 / 占位分支恒在,不再假装入口在 SidebarTopNav。
    expect(sidebarUpperSource).not.toMatch(/<MachineSwitcher\s*\/>/);
    expect(sidebarUpperSource).toContain('MainListScopeHeader');
  });

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

    // cc-agent:展开态声明接管,并把可滚动段画进滚动容器;rail 态交回 Shell。
    expect(sidebarUpperSource).toContain('useOwnTopNavScrollableRows(!isCollapsed)');
    expect(sidebarUpperSource).toContain('<SidebarTopNav section="scrollable" />');
    const scrollRefIdx = sidebarUpperSource.indexOf('ref={sidebarScrollRef}');
    const scrollableRowsIdx = sidebarUpperSource.indexOf('<SidebarTopNav section="scrollable" />');
    expect(scrollRefIdx).toBeGreaterThanOrEqual(0);
    expect(scrollableRowsIdx).toBeGreaterThan(scrollRefIdx);
    // 搜索打开时搜索行作为滚动容器直接子项 sticky;打开查询时记下并复位滚动,
    // 清查询时还原,不再用 overlay 盖住输入框。
    expect(topNavSource).toContain("const pinSearch = section === 'scrollable' && search.query.trim().length > 0");
    expect(topNavSource).toContain("pinSearch && 'sticky top-0 z-30 bg-[var(--cmd-palette-bg)]'");
    expect(topNavSource).toContain('if (section === \'scrollable\')');
    expect(sidebarUpperSource).toContain('lastListScrollTopRef.current = el.scrollTop');
    expect(sidebarUpperSource).toContain(
      'sidebarScrollRef.current?.scrollTo({ top: lastListScrollTopRef.current })',
    );
    expect(sidebarUpperSource).toContain('search.statusFilter');
    expect(sidebarUpperSource).toContain('searchProjectKey');
    expect(sidebarUpperSource).toContain('onContextMenu={(event) => event.stopPropagation()}');
    expect(sidebarUpperSource).toContain('{searchActive ? (');
    expect(sidebarUpperSource).toContain('<div hidden={searchActive} className="flex flex-col gap-2">');
    expect(sidebarUpperSource).toContain('freezeListScrollOnOpenRef.current = true');
    expect(sidebarUpperSource).toContain('const restoreListScroll = useCallback');
    expect(sidebarUpperSource).toContain('const restoreListScrollAfterPointer = useCallback');
    expect(sidebarUpperSource).toContain('restoreListScrollAfterPointer()');
    expect(sidebarUpperSource).toContain("window.addEventListener('pointerup', onPointerEnd, true)");
    expect(sidebarUpperSource).toContain("document.addEventListener('focusin', onFocusIn)");
    const inlineSearchSource = read('features', 'cc-agent', 'sidebar', 'SidebarInlineSearch.tsx');
    expect(inlineSearchSource).toContain('inputRef.current?.focus({ preventScroll: true })');
    expect(sidebarUpperSource).not.toContain('absolute inset-0 z-20');
    expect(sidebarUpperSource).not.toContain(
      "search.trimmed && 'sticky top-0 z-30 bg-[var(--cmd-palette-bg)]'",
    );

    // 声明语义与 useRegisterSidebarUpper 一致:卸载不复位,避免切到 /settings 时闪变。
    expect(featureContextSource).toContain('export function useOwnTopNavScrollableRows');
    expect(featureContextSource).toContain('export function useOwnsTopNavScrollableRows');
  });

  it('插件面板恢复入口在展开态和 rail 态都位于插件与搜索之间', () => {
    const expandedPluginsIdx = topNavSource.indexOf('{pluginsRow}');
    const expandedRestoreIdx = topNavSource.indexOf('{restoreRow}', expandedPluginsIdx);
    const expandedSearchIdx = topNavSource.indexOf('{searchRow}', expandedRestoreIdx);
    expect(expandedPluginsIdx).toBeGreaterThanOrEqual(0);
    expect(expandedRestoreIdx).toBeGreaterThan(expandedPluginsIdx);
    expect(expandedSearchIdx).toBeGreaterThan(expandedRestoreIdx);

    const railPluginsIdx = sidebarUpperSource.indexOf("label={t('sidebar.tabs.plugins')}");
    const railRestoreIdx = sidebarUpperSource.indexOf(
      '<GhostPanelRestoreEntry',
      railPluginsIdx,
    );
    const railSearchIdx = sidebarUpperSource.indexOf('<ConversationSearchBox', railRestoreIdx);
    expect(railPluginsIdx).toBeGreaterThanOrEqual(0);
    expect(railRestoreIdx).toBeGreaterThan(railPluginsIdx);
    expect(railSearchIdx).toBeGreaterThan(railRestoreIdx);
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

    // 任务信息四项各配数据类型图标;时间用 Clock 而非 Timer(后者是自动任务专用字形)。
    expect(filterSource).toContain("labelKey: 'ccAgent.sidebar.taskInfo.time', Icon: Clock");
    expect(filterSource).toContain("labelKey: 'ccAgent.sidebar.taskInfo.pr', Icon: GitPullRequest");
    expect(filterSource).toContain("labelKey: 'ccAgent.sidebar.taskInfo.tokens', Icon: Coins");
    expect(filterSource).toContain("labelKey: 'ccAgent.sidebar.taskInfo.cost', Icon: Wallet");
    expect(filterSource).not.toMatch(/taskInfo\.time', Icon: Timer/);

    // 抽象策略段(分组 / 排序 / 筛选维度)刻意不配图标,避免为凑图标而增噪。
    expect(filterSource).not.toMatch(/filterSortBy\.\w+', Icon:/);
    expect(filterSource).not.toMatch(/filterGroupBy\.\w+', Icon:/);
    expect(filterSource).not.toMatch(/filterStatus\.\w+', Icon:/);
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

  it('关项目分组时 hook 把 manual 回落到 recency', () => {
    const hookSource = read('features', 'cc-agent', 'hooks', 'useSidebarFilter.ts');
    expect(hookSource).toContain('nextSortByAfterGroupByChange');
    expect(hookSource).toContain('const nextSort = nextSortByAfterGroupByChange(next, current)');
  });

  it('列表行也接收来源标签(平铺时项目会话不再丢项目名)', () => {
    const entryListSource = read('features', 'cc-agent', 'sidebar', 'SessionEntryList.tsx');
    expect(entryListSource).toContain('sourceLabel={sourceLabelMap?.get(entry.session.id)}');
    expect(entryListSource.match(/sourceLabel=\{sourceLabelMap\?\.get\(entry\.session\.id\)\}/g)).toHaveLength(
      2,
    );
    const automationGroupSource = read(
      'features',
      'cc-agent',
      'sidebar',
      'AutomationSessionGroupItem.tsx',
    );
    expect(automationGroupSource).toContain('sourceLabel: sourceLabelMap?.get(session.id)');
    const cardSource = read('features', 'cc-agent', 'sidebar', 'SessionCard.tsx');
    expect(cardSource).toContain('sourceLabel,');
    expect(cardSource).toContain('{sourceLabel ? (');
    const itemSource = read('features', 'cc-agent', 'sidebar', 'SessionItem.tsx');
    expect(itemSource).toContain('{sourceLabel ? (');
  });

  // 2026-08-12 用户裁决:筛选各维度选中后菜单不关闭(常要连调几项);排序与显示
  // 模式仍选完即关(一次一个决定)。
  it('筛选维度选中后保持菜单打开,排序 / 显示模式仍选完即关', () => {
    const filterSource = read('features', 'cc-agent', 'sidebar', 'SidebarFilterPopover.tsx');
    // keepOpen 走 onSelect 的 preventDefault(Radix 据此不关闭菜单)。
    expect(filterSource).toContain('keepOpen = false');
    expect(filterSource).toContain('if (keepOpen) event.preventDefault();');
    // 三个筛选维度都传 keepOpen。
    expect(filterSource).toMatch(/onSelect=\{\(\) => setStatus\(option\.value\)\}\s*\n\s*keepOpen/);
    expect(filterSource).toMatch(/onSelect=\{\(\) => setVendor\(option\.value\)\}\s*\n\s*keepOpen/);
    expect(filterSource).toMatch(
      /onSelect=\{\(\) => setLastActivity\(option\.value\)\}\s*\n\s*keepOpen/,
    );
    // 排序 / 显示模式不传(选完即关)。
    expect(filterSource).not.toMatch(
      /onSelect=\{\(\) => setSortBy\(option\.value\)\}\s*\n\s*keepOpen/,
    );
    expect(filterSource).not.toMatch(
      /onSelect=\{\(\) => setMainViewMode\(option\.value\)\}\s*\n\s*keepOpen/,
    );
    expect(filterSource).toContain("checked={groupDevice && sortBy !== 'manual'}");
    expect(filterSource).toContain("disabled={sortBy === 'manual'}");
    expect(filterSource).toContain("t('ccAgent.sidebar.filterGroupByDeviceManualTip')");
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
  it('置顶区不受项目 / Agent / 最近活跃筛选影响(归档仍按状态隐藏)', () => {
    // 置顶会话:直接用 allGroups.pinned,不再套 vendor / project 过滤。
    expect(sidebarUpperSource).toMatch(
      /const visiblePinnedSessions = useMemo\(\(\) => \{[\s\S]*?return allGroups\.pinned;\s*\}, \[allGroups\.pinned\]\)/,
    );
    // 置顶项目:仍尊重「从侧栏移除」(用户显式隐藏),但不再按 project / vendor 过滤。
    const pinnedProjectsBlock = sidebarUpperSource.slice(
      sidebarUpperSource.indexOf('const visiblePinnedProjects'),
      sidebarUpperSource.indexOf('const visiblePinnedEntries'),
    );
    expect(pinnedProjectsBlock).toContain('hiddenProjectComparisonKeys');
    expect(pinnedProjectsBlock).toContain('pinnedProjectKeys.has(project.projectKey)');
    expect(pinnedProjectsBlock).not.toContain('vendorPredicate');
    expect(pinnedProjectsBlock).not.toContain('filter.projectsAsSet');
    expect(pinnedProjectsBlock).not.toContain('allowedProjects');
    // 「最近活跃」本就豁免:置顶取 allGroups(未经活跃时间收窄),不是 activityFilteredSessions。
    expect(sidebarUpperSource).toContain('const allGroups = useProjectGroups(sidebarSessions');
  });

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
    // 菜单摘要的图标串同样按勾选顺序(遍历 taskInfoFields,不是遍历选项表)。
    const filterSource = read('features', 'cc-agent', 'sidebar', 'SidebarFilterPopover.tsx');
    expect(filterSource).toContain('{taskInfoFields.map((field) => {');
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
    expect(filterSource).toContain('Icon={CircleDot}');
    expect(filterSource).toContain('Icon={Folder}');
    expect(filterSource).toContain('Icon={Bot}');
    expect(filterSource).toContain('Icon={CalendarClock}');
    expect(filterSource).toContain('Icon={Info}');
  });

  it('空态 / 远程 loading-error / 连接中占位都挂范围标题(2026-08-13 第 4 轮 P1)', () => {
    const headerSource = read('features', 'cc-agent', 'sidebar', 'MainListScopeHeader.tsx');
    expect(headerSource).toContain('<MachineSwitcherMenu onOpenDisplaySettings=');
    expect(headerSource).not.toContain('filterActiveBadge');
    expect(headerSource).toContain('<SidebarFilterPopover');
    expect(projectsSectionSource).toContain('<MainListScopeHeader');
    expect(projectsSectionSource).toContain('hasMainListContent');
    expect(projectsSectionSource).not.toMatch(/if \(\s*allProjectKeysForOrder\.length === 0/);
    // 连接中 / 全屏 loading-error 不再把范围标题一起摘掉。
    const connectingIdx = sidebarUpperSource.indexOf('selectedMachineConnecting ?');
    expect(connectingIdx).toBeGreaterThanOrEqual(0);
    expect(sidebarUpperSource.slice(connectingIdx, connectingIdx + 900)).toContain(
      '<MainListScopeHeader',
    );
    expect(sidebarUpperSource).toContain('deviceGroupingAvailable');
    const placeholderMarkers = [
      "remoteDeviceDirectoryStatus === 'error' && !hasVisibleSidebarContent",
      'remoteSessionBootstrapFailures.length > 0 && !hasVisibleSidebarContent',
      "remoteDeviceDirectoryStatus === 'loading' && !hasVisibleSidebarContent",
      'remoteSessionBootstrapLoadingDevices.length > 0 && !hasVisibleSidebarContent',
      'selectedMachineConnecting ?',
    ];
    for (const marker of placeholderMarkers) {
      const idx = sidebarUpperSource.indexOf(marker);
      expect(idx, `缺占位分支 ${marker}`).toBeGreaterThanOrEqual(0);
      expect(sidebarUpperSource.slice(idx, idx + 700), marker).toContain('<MainListScopeHeader');
    }
    // 空账户 / 只剩置顶:ProjectsSection 不再因无内容整段 return null。
    expect(projectsSectionSource).toContain('const hasMainListContent =');
    expect(projectsSectionSource).toContain('{hasMainListContent ? (');
  });

  it('项目段头标题即范围下拉(2026-08-13 定稿,推翻 2026-07「不挂段头」)', () => {
    expect(projectsSectionSource).toContain("from '../MainListScopeHeader'");
    expect(projectsSectionSource).toContain('<MainListScopeHeader');
    // 段头不再渲染硬编码的「全部任务」标题(标题文字由菜单 trigger 按范围决定)。
    expect(projectsSectionSource).not.toContain("t('ccAgent.sidebar.allSessions')");
    // 段级收起随合并取消:标题的点击语义让给范围切换。
    expect(projectsSectionSource).not.toContain('isSectionCollapsed');
  });

  it('项目视图:范围判定走 effective 选择 hook,不再有旧 hasRemoteMachines 结构', () => {
    // 单机范围下设备分组退场(2026-08-13 用户定稿)——生效与选项可见共用
    // deviceGroupingAvailable,由 effective 机器选择派生。
    expect(projectsSectionSource).toContain('useEffectiveSelectedMachineId');
    expect(projectsSectionSource).toContain(
      'const singleMachineScope = selectedMachineId !== MACHINE_ALL && selectedMachineId.length === 1',
    );
    expect(projectsSectionSource).toContain(
      'const deviceGroupingAvailable = hasRemoteDevices && !singleMachineScope',
    );
    expect(projectsSectionSource).toContain('hasRemoteDevices={deviceGroupingAvailable}');
    expect(projectsSectionSource).not.toContain('hasRemoteMachines');
    expect(sidebarUpperSource).toContain("if (device.status === 'rejected') continue;");
    expect(sidebarUpperSource).toContain(
      "if (device.status === 'connecting' && isRemoteDeviceMarkedDisconnected(device.deviceId))",
    );
  });

  // (侧边栏重设计 D 期:按日期分组段已删除,其 MachineSwitcherMenu / 空态 /
  //  hover-reveal 断言随 DateGroupedSessionsSection.tsx 一并下线。)

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

  it('trigger 是段头标题形态(范围文字 + 小箭头),不再是导航 pill 行(2026-08-13 定稿)', () => {
    // 标题文字 = 当前范围:全部任务 / 本机任务 / 设备名 / N 台机器。
    expect(menuSource).toContain('triggerText');
    expect(menuSource).toContain("t('ccAgent.sidebar.allSessions')");
    expect(menuSource).toContain("t('ccAgent.sidebar.scopeLocalSessions')");
    expect(menuSource).toMatch(/<span className="truncate[^"]*">\{triggerText\}<\/span>/);
    expect(menuSource).toContain('<ChevronDown size={13}');
    // 段头标题样式(与原「全部任务」一致:淡灰 + hover 加深),不再是 pill 导航行。
    expect(menuSource).toContain('SCOPE_TITLE_CLASS');
    expect(menuSource).not.toContain('h-8 w-full');
    expect(menuSource).not.toContain('hover:bg-sidebar-item-hover');
    expect(menuSource).not.toContain('filterActive');
    expect(menuSource).not.toContain('--chat-input-chip-bg');
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

  it('菜单项默认单选(整体替换选择),多选走行尾 hover 浮现的多选框', () => {
    // 本机 / 设备行点击 = 单选:select([...]) 整体替换勾选集(菜单自然关闭,
    // 不再对正常项 preventDefault);多选框走 toggle。
    expect(menuSource).toContain('onSelect={() => applySelect([MACHINE_LOCAL])}');
    expect(menuSource).toContain('applySelect([device.deviceId])');
    expect(menuSource).toContain('onToggle={() => applyToggle(MACHINE_LOCAL)}');
    expect(menuSource).toContain(
      'onToggle={rejected ? undefined : () => applyToggle(device.deviceId)}',
    );
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
    expect(menuSource).toMatch(
      /if \(withModifier && onToggle\) \{\s*event\.preventDefault\(\);\s*onToggle\(\);/,
    );
    // 复选框是纯指针快捷目标,对 a11y 树隐藏(键盘路径在行级),留 title 提示。
    expect(menuSource).toContain('aria-hidden="true"');
    expect(menuSource).not.toContain('role="checkbox"');
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

  it('段头标题固定承载远程任务读取 loading(spinner 附在箭头后,不进会话列表)', () => {
    expect(menuSource).toContain('useRemoteSessionBootstrapLoading(selectedDeviceId)');
    expect(menuSource).toContain('aria-busy={remoteSessionBootstrapLoading}');
    expect(menuSource).toMatch(
      /<span className="truncate leading-none">\{triggerText\}<\/span>\s*<ChevronDown[\s\S]*?animate-spinner motion-reduce:animate-none/,
    );
    expect(menuSource).toContain('<Loader2 size={12} strokeWidth={1.8} />');
  });

  it('MachineSwitcherMenu 保留设备选择 / 显示设置 / 远程设置入口;无远程时仍带箭头只留设置项', () => {
    // 段头恒在:无远程设备时不再退化成不可点的静态标题(旧 return <span>),
    // 箭头保留,菜单只渲染两个设置入口、不出现设备列表。
    expect(menuSource).not.toContain('if (!hasRemote) return null');
    expect(menuSource).not.toMatch(
      /if \(!hasRemote\) \{\s*\n\s*return <span className=\{SCOPE_TITLE_CLASS\}>/,
    );
    // 设备列表只看当前 devices.length,不把「目录已空、raw 仍记远端」当成还有远程。
    expect(menuSource).toContain('const showDeviceList = devices.length > 0');
    expect(menuSource).toContain('{showDeviceList ? (');
    expect(menuSource).toContain('{settingsItems}');
    expect(menuSource).toContain('MACHINE_ALL');
    expect(menuSource).toContain('MACHINE_LOCAL');
    expect(menuSource).toContain("navigate('/settings?tab=remote-control')");
    expect(menuSource).toContain('useMachineSwitcher');
    // 范围菜单底部:远程连接设置在上、侧边栏显示设置在下;点后者后等本菜单关完
    // 再开段头那份菜单,避免两个 Radix 菜单抢焦点把新开的立刻关掉。
    expect(menuSource).toContain('onOpenDisplaySettings');
    expect(menuSource).toContain("t('ccAgent.sidebar.organizeSidebar')");
    expect(menuSource).toContain('window.setTimeout(() => onOpenDisplaySettings(), 0)');
    expect(menuSource).toContain('<MonitorCog size={14} strokeWidth={2}');
    expect(menuSource).toContain('<SlidersHorizontal size={14} strokeWidth={2}');
    expect(menuSource).not.toContain('EllipsisVertical');
    // 设置项抽到 settingsItems:有远程时先画设备列表再 separator,再插入该片段;
    // 无远程时菜单只有这一段。片段内部远程连接设置在上、显示设置在下。
    const settingsItemsIndex = menuSource.indexOf('{settingsItems}');
    const separatorIndex = menuSource.indexOf('<DropdownMenuSeparator');
    expect(settingsItemsIndex).toBeGreaterThan(separatorIndex);
    const remoteSettingsIndex = menuSource.indexOf(
      "t('ccAgent.sidebar.machineSwitcher.remoteSettings')",
    );
    const displaySettingsIndex = menuSource.indexOf("t('ccAgent.sidebar.organizeSidebar')");
    expect(displaySettingsIndex).toBeGreaterThan(remoteSettingsIndex);
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
      'max-h-[calc(var(--radix-dropdown-menu-content-available-height)-0.75rem)] overflow-y-auto',
    );
    expect(filterSource).toContain('collisionPadding={8}');
  });
});
