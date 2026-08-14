/**
 * SidebarTopNav —— 侧栏顶部常驻动作/导航列表(取代原 HorizontalTabbar)。
 * ---------------------------------------------------------------------------
 * 一条同级、等权的列表行,按顺序:新建 / 自动任务 / Plugins / 搜索。
 *   - 新建 / 自动任务:项目(cc-agent)视图的动作 —— 在任意视图点击都跳回项目视图并执行。
 *   - Plugins:主视图切换(navigateToView),命中当前视图时高亮。
 *   - 搜索(SidebarInlineSearch):静息态与其余行同款「🔍 搜索」;hover / 聚焦
 *     就地展开成搜索框,结果由下方功能槽(CCAgentSidebarUpper)替换列表绘制。搜索状态经
 *     ConversationSearchProvider 的 context 共享(行在此、结果在功能槽,两者是兄弟子树)。
 *   - 远程机器切换 2026-08-13 起不再占行:并入主列表段头标题(「全部任务」即
 *     范围下拉,见 MachineSwitcherMenu 头注),省一行且标题不再与范围脱节。
 * 去掉了原来的「项目(Bot)」标签 —— 项目即默认主视图,无单独入口。
 * rail 态的搜索仍是 CollapsedView 里独立的 ConversationSearchBox 图标弹窗(不走本行 / context)。
 *
 * 与 Shell"不感知路由"的原则:本组件是原 HorizontalTabbar 的同位替代,封装了
 * 自身的路由 / cc-agent 数据,Shell 仍只负责把它渲染在顶行(见 Sidebar.tsx)。
 *
 * rail(收窄)态不渲染本组件(同 HorizontalTabbar,仅 !isRail 时显示)。
 */

import { useCallback } from 'react';
import { CirclePlus, Plug, Timer } from 'lucide-react';
import { useNavigate, useMatch } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';
import { AttentionDot } from '@/components/sidebar/AttentionDot';
import { useAnyGhostUnread } from '@/cindy-brain/ghostUnreadStore';
import { useActiveMainView } from '@/hooks/useActiveMainView';
import { SidebarInlineSearch } from '@/features/cc-agent/sidebar/SidebarInlineSearch';
import { useConversationSearchContext } from '@/features/cc-agent/sidebar/conversationSearchContext';

/** 列表行通用样式 —— 各行同款 pill 行。 */
const ROW_CLASS =
  'flex h-8 w-full items-center gap-2.5 rounded-full px-3 text-sm font-normal text-[var(--sidebar-nav-text)] transition-colors hover:bg-sidebar-item-hover';
/** 命中当前视图（自动任务 / Plugin 与 Skill 管理 / issue）时的高亮 —— 与下方会话列表
 *  选中行同款反相胶囊(sidebar-item-active 族;2026-07-21 用户裁决,替代原 chat-input-chip
 *  灰 chip,顶部导航选中态与对话选中样式统一)。hover:bg-sidebar-item-active 抵消
 *  ROW_CLASS 的半透明 hover(cn/twMerge last-wins),避免选中胶囊 hover 时闪回半透明。 */
const ROW_ACTIVE_CLASS =
  'bg-sidebar-item-active font-medium text-sidebar-item-active-foreground shadow-[inset_0_0_0_1px_var(--sidebar-item-active-border)] hover:bg-sidebar-item-active';

/**
 * 渲染范围。任务列表页把「新建」以外的行搬进列表滚动区(向上滚时一起滚走,
 * 对齐 Codex;2026-08-12 用户裁决),因此本组件要能分两段渲染:
 *   - 'all'(默认):五行全渲染。非 cc-agent 视图(插件页 / Skill 页等)沿用,
 *     那些页的侧栏没有长列表,不存在滚动需求。
 *   - 'pinned':只渲染「新建」——Shell 顶部固定段。
 *   - 'scrollable':渲染其余行(自动任务 / 插件 / 搜索 / 远程机器),由 cc-agent
 *     的侧栏滚动容器在列表最上方绘制。
 */
export type SidebarTopNavSection = 'all' | 'pinned' | 'scrollable';

export function SidebarTopNav({
  section = 'all',
}: {
  section?: SidebarTopNavSection;
} = {}): React.ReactElement {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { activeKey, navigateToView } = useActiveMainView();
  const onScheduleMatch = useMatch('/cc-agent/scheduled');
  const { search, allKnownProjects, openSignal } = useConversationSearchContext();
  // 任一插件有未读 → 入口行尾一颗**静态**绿点(聚合入口按 AttentionDot 规范不呼吸,
  // 呼吸留给单条卡片;见 AttentionDot 头部的形态规范)。
  const hasGhostUnread = useAnyGhostUnread();

  // 通用「新建」入口:只 navigate 到草稿页,不清空 newMakerDraft。
  // 之前这里会把 workingDir / remoteHostId / extraDirs 清成默认,导致用户在草稿页
  // 选好「对话或选择项目」后,切到别的会话再点「新建」回来时选择被重置为默认、需要
  // 重新选。草稿页的选择由 newMakerDraft store 持久化(见 state/newMakerDraft.ts),
  // 通用新建应保留上次选择;「新建对话」等显式入口才负责清空(见 CCAgentSidebarUpper)。
  const handleNew = () => {
    navigate('/cc-agent/new', { state: { workspacePrompt: 'generic' } });
  };

  // 搜索结果 overlay 只在 cc-agent 视图(CCAgentSidebarUpper)绘制;本行却在所有非 rail 视图都渲染。
  // 用户在 plugins / 设置等视图输入搜索时,先切回 cc-agent 视图,结果才有处显示(同视图为 no-op)。
  const ensureConversationView = useCallback(() => navigateToView('cc-agent'), [navigateToView]);

  const showPinned = section !== 'scrollable';
  const showScrollable = section !== 'pinned';
  const pinSearch = section === 'scrollable' && search.query.trim().length > 0;
  const automationsRow = showScrollable ? (
    <button
      onClick={() => navigate('/cc-agent/scheduled')}
      className={cn(ROW_CLASS, onScheduleMatch && ROW_ACTIVE_CLASS)}
      aria-label={t('ccAgent.layout.automations')}
      aria-current={onScheduleMatch ? 'page' : undefined}
    >
      <Timer
        size={15}
        strokeWidth={1.8}
        className={cn(
          'shrink-0',
          // 选中反相胶囊上图标跟随 active 前景(图标自带显式色,行级 text 覆盖不到它)。
          onScheduleMatch
            ? 'text-sidebar-item-active-foreground'
            : 'text-[var(--sidebar-nav-text)]',
        )}
      />
      <span className="leading-none">{t('ccAgent.layout.automations')}</span>
    </button>
  ) : null;
  const pluginsRow = showScrollable ? (
    <button
      onClick={() => navigateToView('plugins')}
      className={cn(ROW_CLASS, activeKey === 'plugins' && ROW_ACTIVE_CLASS)}
      aria-label={t('sidebar.tabs.plugins')}
      aria-current={activeKey === 'plugins' ? 'page' : undefined}
    >
      <Plug
        size={15}
        strokeWidth={1.8}
        className={cn(
          'shrink-0',
          // 同上:选中反相胶囊上图标跟随 active 前景。
          activeKey === 'plugins'
            ? 'text-sidebar-item-active-foreground'
            : 'text-[var(--sidebar-nav-text)]',
        )}
      />
      <span className="leading-none">{t('sidebar.tabs.plugins')}</span>
      {hasGhostUnread && <AttentionDot size={6} className="ml-auto mr-0.5" />}
    </button>
  ) : null;
  const searchRow = showScrollable ? (
    <SidebarInlineSearch
      search={search}
      allKnownProjects={allKnownProjects}
      openSignal={openSignal}
      onSearchActive={ensureConversationView}
    />
  ) : null;

  // 滚动段把搜索行拆成滚动容器的直接子项:sticky 才能钉在结果列表上,
  // 不被短导航父盒的底边提前带走。输入框仍是同一份实例。
  if (section === 'scrollable') {
    return (
      <>
        <div className="flex flex-col gap-0.5 pr-3 pl-3">
          {automationsRow}
          {pluginsRow}
        </div>
        <div
          className={cn(
            // -mt-1.5 抵消滚动容器 gap-2,与上面两行仍保持 gap-0.5。
            'px-3 pb-2.5 -mt-1.5',
            pinSearch && 'sticky top-0 z-30 bg-[var(--cmd-palette-bg)]',
          )}
        >
          {searchRow}
        </div>
      </>
    );
  }

  return (
    // pt-1(原 2.5):顶行 chrome 收窄到 46px 后,列表整体上提贴近顶行(对齐 Codex)。
    // 分段渲染时(section≠'all')两段各自成块,由调用方分别放进固定区 / 滚动区;
    // padding 保持同一套,两段拼起来的视觉与整块渲染一致。pinned 段不带 pb,
    // 让滚动段紧随其后(行距仍由滚动段容器的 gap 承担)。
    <div
      className={cn(
        'flex flex-col gap-0.5 pt-1 pr-3 pl-3',
        section === 'pinned' ? 'pb-0.5' : 'pb-2.5',
      )}
    >
      {showPinned && (
        /* 1. 新建 —— 图标 15/1.8 + meta 灰:与项目行的文件夹图标同规格同色
          (2026-07 用户定稿,对齐 Codex;文字仍用 foreground)。 */
        <button onClick={handleNew} className={ROW_CLASS} aria-label={t('ccAgent.layout.new')}>
          <CirclePlus
            size={15}
            strokeWidth={1.8}
            className="shrink-0 text-[var(--sidebar-nav-text)]"
          />
          <span className="leading-none">{t('ccAgent.layout.new')}</span>
        </button>
      )}
      {automationsRow}
      {pluginsRow}
      {searchRow}
    </div>
  );
}
