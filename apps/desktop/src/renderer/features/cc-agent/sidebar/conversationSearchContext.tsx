/**
 * ConversationSearchContext —— 展开侧栏「内联会话搜索」的共享状态。
 * ---------------------------------------------------------------------------
 * 搜索输入行现在是 SidebarTopNav 顶部导航列表的第 4 行(新建 / 自动任务 / 技能 / 搜索),
 * 而搜索结果 overlay 渲染在其下方的功能槽(CCAgentSidebarUpper.ExpandedView)里——两者
 * 是 Sidebar 外壳下的兄弟子树,不在同一组件内。这里用一个 Provider 在两者的共同祖先
 * (Sidebar 外壳)处**只实例化一次** useConversationSearch,经 context 同时供:
 *   - SidebarTopNav 的搜索行(输入 / 排序 / 筛选 / hover 展开);
 *   - ExpandedView 的结果 overlay(读 query / status / results)。
 *
 * allKnownProjects 在此就地计算(与 CCAgentSidebarUpper 的 projectUniverse 同口径:全量
 * 会话、排除 Orca worker),供筛选面板列举项目与项目内搜索会话集解析。rail 态的搜索是
 * CollapsedView 里独立的 ConversationSearchBox 图标弹窗,不走本 context。
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';

import { useCCSessions } from '@/hooks/useCCSessions';
import { isOrcaWorkerSession } from '@/lib/orcaSessionIdentity';
import { useConversationSearchRequest } from '@/state/conversationSearchRequest';
import { useProjectAliases } from '../hooks/useProjectAliases';
import { useProjectGroups } from '../hooks/useProjectGroups';
import { useConversationSearch } from './ConversationSearchBox';
import type { ProjectNode as ProjectNodeData } from '../lib/projectGrouping';

interface ConversationSearchContextValue {
  /** 搜索状态机(query / 排序 / 筛选 / 结果 / handleSelect 等)。 */
  search: ReturnType<typeof useConversationSearch>;
  /** 供筛选面板列举项目。 */
  allKnownProjects: ProjectNodeData[];
  /** 程序化展开信号(「在此项目内搜索」自增)——搜索行据此展开并聚焦。 */
  openSignal: number;
}

const ConversationSearchContext = createContext<ConversationSearchContextValue | null>(null);

export function ConversationSearchProvider({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const projectFilterRequest = useConversationSearchRequest();
  const [openSignal, setOpenSignal] = useState(0);

  // allKnownProjects:全量会话(含归档)、排除 Orca worker,与 CCAgentSidebarUpper 同口径。
  const { sessions } = useCCSessions({ includeArchived: 'all' });
  const { aliases } = useProjectAliases();
  const searchSessions = useMemo(
    () => sessions.filter((s) => !isOrcaWorkerSession(s)),
    [sessions],
  );
  const { projects } = useProjectGroups(searchSessions, aliases);

  // 「在此项目内搜索」到达 → 自增信号,SidebarInlineSearch 据此展开搜索框并聚焦输入。
  // useCallback 稳定引用,避免 hook 内 lock effect 因回调每帧变化而反复触发。
  const handleProgrammaticOpen = useCallback(() => setOpenSignal((n) => n + 1), []);
  const search = useConversationSearch({
    enabled: true,
    navigate,
    allKnownProjects: projects,
    projectFilterRequest,
    onProgrammaticOpen: handleProgrammaticOpen,
  });

  // 展开态结果 overlay 的「点外部收起」:仅在有查询(overlay 可见)时挂 document 级 pointerdown 监听。
  //   - 命中搜索界面内部([data-conversation-search-surface] = 搜索输入行 + 结果 overlay)→ 不收起,
  //     所以点结果列表内 / 点输入行都保持展开;
  //   - 命中排序 / 筛选下拉(Radix portal,[data-radix-popper-content-wrapper])→ 视为内部,不收起;
  //   - 其余位置(搜索区域以外)→ search.reset() 清空 query,overlay 收起、输入行回落。
  // 用 pointerdown 而非 click:滚轮滚动不产生 pointerdown,故「任意位置滚动」永远不会收起(用户诉求)。
  const { trimmed, reset } = search;
  useEffect(() => {
    if (!trimmed) return;
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Element | null;
      if (!target) return;
      if (target.closest('[data-conversation-search-surface]')) return;
      if (target.closest('[data-radix-popper-content-wrapper]')) return;
      reset();
    };
    document.addEventListener('pointerdown', handlePointerDown, true);
    return () => document.removeEventListener('pointerdown', handlePointerDown, true);
  }, [trimmed, reset]);

  const value = useMemo<ConversationSearchContextValue>(
    () => ({ search, allKnownProjects: projects, openSignal }),
    [search, projects, openSignal],
  );

  return (
    <ConversationSearchContext.Provider value={value}>
      {children}
    </ConversationSearchContext.Provider>
  );
}

/** 读取共享搜索状态;必须在 ConversationSearchProvider 内使用。 */
export function useConversationSearchContext(): ConversationSearchContextValue {
  const ctx = useContext(ConversationSearchContext);
  if (!ctx) {
    throw new Error('useConversationSearchContext must be used within ConversationSearchProvider');
  }
  return ctx;
}
