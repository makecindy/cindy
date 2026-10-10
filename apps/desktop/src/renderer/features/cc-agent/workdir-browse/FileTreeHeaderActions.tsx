/**
 * FileTreeHeaderActions — 文件树标题行右侧的动作按钮组。
 *
 * 两个宿主共用（此前各自复制了一份，加「显示被忽略的目录」时出现了两种圆角）：
 *   - doc 模式侧栏 WorkdirBrowseSidebar
 *   - RSB 文件浏览器 FileBrowserBody 的 TreeHeader
 *
 * tree 模式：搜索 / 显示被忽略的目录 / 收起全部 / 刷新
 * search 模式：X 退出搜索（依次替代上面四个的名字空间，与 doc 模式历史行为一致）
 *
 * 几何与可访问名：所有图标钮走 FILE_TREE_HEADER_ICON_BUTTON_CLASS（DESIGN.md §5
 * 控件框 pill 档 + 自带 focus-visible 环），并配本地化 aria-label + Tip
 * （DESIGN.md §14.6 纯图标控件的交付合同）。
 */

import { useTranslation } from 'react-i18next';
import type { ReactNode } from 'react';
import {
  ChevronsDownUp,
  RefreshCw,
  Search,
  X as XIcon,
} from 'lucide-react';

import { Tip } from '@/components/ui/tooltip';
import { FILE_TREE_HEADER_ICON_BUTTON_CLASS } from './fileTreeHeaderButtonClass';
import { FileTreeIgnoredDirsToggle } from './FileTreeIgnoredDirsToggle';

export interface FileTreeHeaderActionsProps {
  /** 当前是文件树还是项目级搜索：搜索态只留「退出搜索」。 */
  mode: 'tree' | 'search';
  onToggleSearch: () => void;
  onCollapseAll: () => void;
  onRefresh: () => void;
  /** 被控端不支持「显示被忽略的目录」（老 Desktop）：开关渲染成不可用 + 说明原因。 */
  ignoredDirsUnsupported?: boolean;
}

export function FileTreeHeaderActions({
  mode,
  onToggleSearch,
  onCollapseAll,
  onRefresh,
  ignoredDirsUnsupported = false,
}: FileTreeHeaderActionsProps) {
  const { t } = useTranslation();

  if (mode === 'search') {
    // search 是独立态：refresh / collapse 只对文件树有意义，搜索时不该出现。
    return (
      <HeaderIconButton
        label={t('ccAgent.workdirBrowse.searchPanel.exit')}
        onClick={onToggleSearch}
      >
        <XIcon size={14} strokeWidth={2} />
      </HeaderIconButton>
    );
  }

  return (
    <>
      {/* 搜索与「显示被忽略的目录」都属于「树里显示什么」，并排放。 */}
      <HeaderIconButton
        label={t('ccAgent.workdirBrowse.searchPanel.searchFiles')}
        onClick={onToggleSearch}
      >
        <Search size={14} strokeWidth={2} />
      </HeaderIconButton>
      <FileTreeIgnoredDirsToggle unsupported={ignoredDirsUnsupported} />
      <HeaderIconButton
        label={t('ccAgent.workdirBrowse.treeAction.collapseAll')}
        onClick={onCollapseAll}
      >
        <ChevronsDownUp size={14} strokeWidth={2} />
      </HeaderIconButton>
      <HeaderIconButton
        label={t('ccAgent.workdirBrowse.treeAction.refresh')}
        onClick={onRefresh}
      >
        <RefreshCw size={14} strokeWidth={2} />
      </HeaderIconButton>
    </>
  );
}

/** 标题行图标钮：Tip 文案与 aria-label 同一个来源，避免只写其中一个。 */
function HeaderIconButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Tip text={label}>
      <button
        type="button"
        aria-label={label}
        onClick={onClick}
        className={FILE_TREE_HEADER_ICON_BUTTON_CLASS}
      >
        {children}
      </button>
    </Tip>
  );
}
