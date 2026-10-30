/**
 * SidebarTopNav —— 侧栏顶部常驻动作/导航列表(取代原 HorizontalTabbar)。
 * ---------------------------------------------------------------------------
 * 一条同级、等权的列表行:新建固定;自动任务 / Plugins / 搜索与带主视图的插件
 * 按用户偏好排序与显示(插件的显隐沿用其「在侧边栏显示」开关);未勾选的进「更多」。
 * 最小化插件面板恢复入口仍按需出现。
 *   - 新建 / 自动任务:项目(cc-agent)视图的动作 —— 在任意视图点击都跳回项目视图并执行。
 *   - Plugins:主视图切换(navigateToView),命中当前视图时高亮。
 *   - 伙伴 2026-10-13 起不再是导航行:它是侧栏第一层的「伙伴」段(置顶上方),
 *     与任务列表并存,不再整栏切换(见 features/bots/TeammatesSection)。
 *   - 搜索(SidebarInlineSearch):静息态与其余行同款「🔍 搜索」;hover / 聚焦
 *     就地展开成搜索框,结果由下方功能槽(CCAgentSidebarUpper)替换列表绘制。搜索状态经
 *     ConversationSearchProvider 的 context 共享(行在此、结果在功能槽,两者是兄弟子树)。
 *   - 远程机器切换 2026-08-13 起不再占行:并入主列表段头标题(「全部任务」即
 *     范围下拉,见 MachineSwitcherMenu 头注),省一行且标题不再与范围脱节。
 * 去掉了原来的「项目(Bot)」标签 —— 项目即默认主视图,无单独入口。
 * rail 态由 SidebarRailNavigation 渲染同一套偏好(顺序 / 显示 / 「更多」);搜索仍是
 * CollapsedView 提供的 ConversationSearchBox 图标弹窗(不走本行 / context)。
 *
 * 与 Shell"不感知路由"的原则:本组件是原 HorizontalTabbar 的同位替代,封装了
 * 自身的路由 / cc-agent 数据,Shell 仍只负责把它渲染在顶行(见 Sidebar.tsx)。
 *
 * rail(收窄)态:任务视图用 SidebarRailNavigation;其它 Feature 的 rail 不再补入口
 * (伙伴的 rail 入口由 CollapsedView 提供)。
 */

import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import {
  CirclePlus,
  Ellipsis,
  SlidersHorizontal,
  type LucideIcon,
} from 'lucide-react';
import { useLocation, useNavigate, useMatch } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';
import { NavigationCountBadge } from '@/components/sidebar/NavigationCountBadge';
import { useAuth } from '@/contexts/AuthContext';
import { usePluginReviewUpdates } from '@/contexts/PluginReviewUpdatesContext';
import { AttentionDot, type DotTone } from '@/components/sidebar/AttentionDot';
import { useAnyGhostUnread } from '@/cindy-brain/ghostUnreadStore';
import { useGhostMainViews, type GhostMainViewItem } from '@/cindy-brain/ghostMainViews';
import { useInstalledGhosts } from '@/cindy-brain/useInstalledGhosts';
import { useActiveMainView } from '@/hooks/useActiveMainView';
import { SidebarInlineSearch } from '@/features/cc-agent/sidebar/SidebarInlineSearch';
import { SidebarIconButton, SIDEBAR_RAIL_ICON_BUTTON_CLASS } from './SidebarIconButton';
import { Tip } from '@/components/ui/tooltip';
import { useConversationSearchContext } from '@/features/cc-agent/sidebar/conversationSearchContext';
import { GhostMainViewNavEntry, MAIN_VIEW_ICONS } from './GhostMainViewNavEntries';
import { makeGenericNewMakerRouteState } from '@/features/cc-agent/lib/genericNewMakerRouteState';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { NewTag } from './NewTag';
import { SidebarNavigationCustomize } from './SidebarNavigationCustomize';
import { useHoverOpenMenu } from './useHoverOpenMenu';
import {
  SIDEBAR_NAVIGATION_ITEM_ICONS,
  ghostIdOfEntry,
  isBuiltInEntry,
  markSidebarAppArrivalsSeen,
  reconcileSidebarAppArrivals,
  resolveSidebarNavigationOrder,
  useSidebarNavigationPrefs,
  useSidebarUnseenApps,
  type SidebarNavigationAppEntryId,
  type SidebarNavigationEntryId,
  type SidebarNavigationItemId,
} from './sidebarNavigationPrefs';

/** 列表行通用样式 —— 各行同款 pill 行。 */
const ROW_CLASS =
  'flex h-8 w-full items-center gap-2.5 rounded-full px-3 text-sm font-normal text-[var(--sidebar-nav-text)] transition-colors hover:bg-sidebar-item-hover';

        {customizing ? (
          <SidebarNavigationCustomize
            // A draft belongs to one account; switching accounts starts a fresh one.
            key={dataOwnerId ?? ''}
            onDone={() => setCustomizing(false)}
          />
        ) : !showSearch ? (
          <div className="flex flex-col gap-0.5 pr-3 pl-3">
            {orderedNavigationRows}
            {customizeRow}
          </div>
        ) : (
          <>
            {searchIndex > 0 && (
              <div className="flex flex-col gap-0.5 pr-3 pl-3">{rowsBeforeSearch}</div>
            )}
            <div
              className={cn(
                'px-3',
                searchIndex > 0 && '-mt-1.5',
                pinSearch && PINNED_SEARCH_CLASS,
              )}
            >
              {searchRow}
            </div>
            {/* Entries after Search stay reachable while a query is pinned; the
                results follow them instead of replacing them. */}
            <div className="-mt-1.5 flex flex-col gap-0.5 pr-3 pl-3">
              {rowsAfterSearch}
                {customizeRow}
            </div>
          </>
        )}
>>>>>>> origin/main
      </>
    );
  }

  // Persistent-view contract: saved navigation order -> More.
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
      {showScrollable &&
        (customizing ? (
          <SidebarNavigationCustomize
            // A draft belongs to one account; switching accounts starts a fresh one.
            key={dataOwnerId ?? ''}
            onDone={() => setCustomizing(false)}
          />
        ) : (
          orderedNavigationRows
        ))}
      {showScrollable && !customizing && customizeRow}
    </div>
  );
}
