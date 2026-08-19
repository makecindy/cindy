/**
 * SidebarInlineSearch —— SidebarTopNav 顶部导航列表末尾的「搜索」行。
 * ---------------------------------------------------------------------------
 * 渲染为一条裸行(无外层 padding),融入 SidebarTopNav 的 gap-0.5 列表,与 新建/自动任务/
 * 插件等入口同款。两态一体、图标位置恒定:
 *   - 静息态(未 hover / 未聚焦 / 无查询):与 新建 / 自动化 / 插件 等导航行完全一致
 *     的「🔍 搜索」行(透明底、无边框、foreground 文字)。
 *   - 展开态(hover / 聚焦 / 有查询 / 选项菜单打开):同一容器就地变成搜索框——
 *     补上 Board 边框 + elevated 底,文字行换成真实输入框,右侧浮现排序 / 筛选两颗
 *     紧凑图标钮。边框用 border-transparent 预留 1px,展开只改颜色 → 搜索图标位置不位移。
 * 搜索状态机与结果渲染复用 useConversationSearch / SearchResultsBody(见
 * ConversationSearchBox.tsx);结果 overlay 由宿主(CCAgentSidebarUpper.ExpandedView)
 * 在其下方区域绘制。外层 wrapper 常驻挂载 → hover 进出状态稳定,不因 input 挂载/卸载抖动。
 */

import { useEffect, useRef, useState } from 'react';
import { Search, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Tip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import {
  SearchFilterMenu,
  type useConversationSearch,
} from './ConversationSearchBox';
import type { ProjectNode as ProjectNodeData } from '../lib/projectGrouping';
import { projectDisplayLabelWithMachine } from '../lib/remoteProjectIdentity';

export interface SidebarInlineSearchProps {
  /** useConversationSearch 的返回值(状态 + setter + 回调)。 */
  search: ReturnType<typeof useConversationSearch>;
  /** 供筛选面板列举项目。 */
  allKnownProjects: ProjectNodeData[];
  /**
   * 程序化展开信号(单调递增)——宿主收到「在此项目内搜索」请求时自增它,
   * 本组件据此展开搜索框并聚焦输入。0 表示无信号。
   */
  openSignal: number;
  /**
   * 有实际查询时回调:确保结果 overlay 所在的 cc-agent 视图已激活。
   * 本行在所有非 rail 视图(skillhub / 设置等)都会渲染,但结果 overlay 只挂在
   * CCAgentSidebarUpper(cc-agent 视图)里——在别的视图输入会发起搜索却无处显示结果。
   * 故一旦 query 非空就切回 cc-agent(同视图时宿主内部去重、为 no-op)。
   */
  onSearchActive?: () => void;
}

export function SidebarInlineSearch({
  search,
  allKnownProjects,
  openSignal,
  onSearchActive,
}: SidebarInlineSearchProps) {
  const { t } = useTranslation();
  const inputRef = useRef<HTMLInputElement>(null);
  const [hovered, setHovered] = useState(false);
  // 焦点是否在本行内(输入框 / 排序 / 筛选触发钮)。用「行级 focus-within」而非只看输入框:
  // 下拉菜单关闭时 Radix 会把焦点交回触发钮(仍在本行内)——据此保持展开,避免菜单收起瞬间
  // 整行回落导致触发钮卸载、菜单来不及播放退出动画而「闪一下」。
  const [focusWithin, setFocusWithin] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  // 程序化展开(项目内搜索):聚焦前先展开挂载出输入框(input 仅展开态存在)。
  const [forceOpen, setForceOpen] = useState(false);

  // 展开条件:hover / 焦点在行内 / 选项菜单打开 / 有查询 / 程序化展开。任一成立即呈搜索框。
  const expanded = hovered || focusWithin || menuOpen || forceOpen || search.query.length > 0;

  // 项目右键「在此项目内搜索」会把搜索锁定到该项目(projectSelection 固定为它)。展开态里用一颗
  // 可关闭的 chip 呈现锁定项目,点 X 调 clearLock 解锁回到全局搜索——否则内联形态没有任何解锁入口
  // (筛选面板的项目勾选在锁定时是 disabled),后续从本行发起的普通搜索会一直被限死在该项目内。
  const lockedProject = search.lockedProjectKey
    ? (allKnownProjects.find((project) => project.projectKey === search.lockedProjectKey) ?? null)
    : null;
  const lockedProjectLabel = lockedProject
    ? projectDisplayLabelWithMachine(lockedProject)
    : search.lockedProjectName;

  // 程序化展开信号:展开并聚焦输入框(input 在展开态才挂载,置 forceOpen 触发挂载后再 focus)。
  useEffect(() => {
    if (!openSignal) return;
    setForceOpen(true);
    const id = window.setTimeout(() => inputRef.current?.focus({ preventScroll: true }), 0);
    return () => window.clearTimeout(id);
  }, [openSignal]);

  // 有实际查询时切回 cc-agent 视图,让结果 overlay(挂在 CCAgentSidebarUpper)有处可渲染。
  // 只在 query 非空时触发(而非一 hover/聚焦就切),避免用户扫过搜索行就被拽出当前视图;
  // 同视图时宿主 navigateToView 内部去重,重复调用为 no-op。
  // 用 ref 稳定回调引用:useActiveMainView 在每次 location 变化时重建 navigateToView,
  // 若直接把 onSearchActive 放进 deps,每次路由跳转都会触发本 effect,把用户从
  // 键盘/程序式导航拉回 cc-agent(Codex P2)。改为只依赖 query,回调通过 ref 读取最新值。
  const onSearchActiveRef = useRef(onSearchActive);
  useEffect(() => {
    onSearchActiveRef.current = onSearchActive;
  });
  useEffect(() => {
    if (search.query.length > 0) onSearchActiveRef.current?.();
  }, [search.query]);

  // 静息态行:点击 / 键盘聚焦时展开并把焦点交给真正的输入框(鼠标 hover 时其实已提前展开)。
  const activate = () => {
    setForceOpen(true);
    window.setTimeout(() => inputRef.current?.focus(), 0);
  };

  return (
    // 常驻外壳:作为 SidebarTopNav 列表末行。静息=导航行样式(透明、无边框,
    // 与 新建/自动任务/插件等入口同款);展开=搜索框(elevated + Board 边框)。h-8 / pl-3 / gap-2.5 /
    // 图标 18px 两态一致;border 恒在、静息时透明 → 展开时搜索图标不位移。
    <div
      // 标记「搜索界面内部」:Provider 的 outside-pointerdown 监听据此判定——本行内点击不收起搜索,
      // 只有点到搜索行 + 结果 overlay 以外才收起(见 conversationSearchContext)。
      data-conversation-search-surface
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocusCapture={() => setFocusWithin(true)}
      onBlurCapture={(event) => {
        // 焦点仍落在本行内(如菜单关闭后回到触发钮、输入框↔选项钮互跳)→ 保持展开;
        // 真正离开本行(点别处 / Tab 出去)才收起。菜单打开期间焦点在 portal 里(不在行内),
        // 由 menuOpen 兜底维持展开。
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
        setFocusWithin(false);
        setForceOpen(false);
      }}
      className={cn(
        'flex h-8 w-full items-center gap-2.5 rounded-full border pl-3 transition-colors',
        expanded
          ? 'border-[var(--border-default)] bg-[var(--sidebar-search-input-bg)] pr-1.5'
          : 'border-transparent pr-3',
      )}
    >
      {/* 与顶部三行同规格同色(15/1.8 + CINDY nav text)。 */}
      <Search size={15} strokeWidth={1.8} className="shrink-0 text-[var(--sidebar-nav-text)]" />
      {expanded ? (
        <>
          {search.lockedProjectKey && (
            // 锁定项目 chip:展开态显示「在此项目内搜索」锁定的项目名 + 解锁 X。
            <span className="flex min-w-0 max-w-[48%] shrink items-center gap-1 rounded-full bg-[var(--surface-chip)] py-0.5 pl-2 pr-0.5 text-xs text-[var(--text-secondary)]">
              <span className="min-w-0 truncate">{lockedProjectLabel}</span>
              <Tip text={t('ccAgent.search.filter.reset')} side="bottom">
                <button
                  type="button"
                  onClick={(event) => {
                    // 解锁 → projectSelection 回到 'all',后续普通搜索不再被限死在该项目。
                    search.clearLock();
                    event.currentTarget.blur();
                  }}
                  aria-label={t('ccAgent.search.filter.reset')}
                  className={cn(
                    'flex size-4 shrink-0 items-center justify-center rounded-full',
                    'text-[var(--text-tertiary)] hover:bg-sidebar-item-hover hover:text-[var(--text-primary)]',
                  )}
                >
                  <X size={11} />
                </button>
              </Tip>
            </span>
          )}
          <input
            ref={inputRef}
            value={search.query}
            onChange={(event) => search.setQuery(event.target.value)}
            placeholder={t('ccAgent.search.placeholder')}
            aria-label={t('ccAgent.search.placeholder')}
            // leading-none 与静息态「搜索」文字(及其余导航行)完全一致(2026-07
            // 已随导航行一起去掉 mt-0.5,改为纯 flex 垂直居中),避免 hover 展开成
            // 输入框时占位符相对「搜索」发生位移。
            className="min-w-0 flex-1 bg-transparent text-sm leading-none text-[var(--text-primary)] outline-none placeholder:text-[var(--text-tertiary)]"
          />
          {search.query && (
            <Tip text={t('ccAgent.search.clear')} side="bottom">
              <button
                type="button"
                onClick={(event) => {
                  search.setQuery('');
                  // 点击会聚焦到 X 钮(属于本行内 → focus-within 会顶着展开)。清空后主动失焦,
                  // 释放本行 focus-within,鼠标移开即自动收起(与清空前行为一致)。
                  event.currentTarget.blur();
                }}
                aria-label={t('ccAgent.search.clear')}
                className={cn(
                  'flex size-5 shrink-0 items-center justify-center rounded-full',
                  'text-[var(--text-tertiary)] hover:bg-sidebar-item-hover hover:text-[var(--text-primary)]',
                )}
              >
                <X size={13} />
              </button>
            </Tip>
          )}
          {/* 选项钮:只一颗——排序与各项筛选都收在这个菜单里(排序是它的首行子菜单)。
               紧凑纯图标形态,与搜索框合为一体(无分隔线、无文字提示)。
               菜单开合上报 → 打开期间保持展开,不因鼠标移到菜单而收起。 */}
          <SearchFilterMenu
            status={search.statusFilter}
            agentKind={search.agentFilter}
            lastActivity={search.lastActivityFilter}
            projects={search.projectSelection}
            sortBy={search.sortBy}
            allKnownProjects={allKnownProjects}
            activeCount={search.activeFilterCount}
            lockedProjectKey={search.lockedProjectKey}
            lockedProjectName={search.lockedProjectName}
            onStatusChange={search.setStatusFilter}
            onAgentKindChange={search.setAgentFilter}
            onLastActivityChange={search.setLastActivityFilter}
            onProjectsChange={search.setProjectSelection}
            onSortChange={search.setSortBy}
            onReset={search.resetFilters}
            onOpenChange={setMenuOpen}
            compact
          />
        </>
      ) : (
        // 静息:与其余导航行同款的「搜索」文字。鼠标 hover 会先触发展开,
        // 这颗按钮主要承接键盘聚焦 / 点击(触控)路径。
        <button
          type="button"
          onClick={activate}
          onFocus={activate}
          aria-label={t('ccAgent.search.open')}
          className="min-w-0 flex-1 truncate text-left text-sm font-normal leading-none text-[var(--sidebar-nav-text)]"
        >
          {t('ccAgent.search.open')}
        </button>
      )}
    </div>
  );
}
