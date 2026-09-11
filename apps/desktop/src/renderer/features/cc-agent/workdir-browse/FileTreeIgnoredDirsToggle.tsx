/**
 * FileTreeIgnoredDirsToggle — 文件树标题行里的「显示被忽略的目录」开关。
 *
 * 位置:与「搜索 / 收起 / 刷新」并列,紧挨搜索(两者都属于"树里显示什么")。
 * RSB 文件浏览器(FileBrowserBody 的 TreeHeader)与 doc 模式侧栏
 * (WorkdirBrowseSidebar 的标题行)共用本组件 —— 同一份全局偏好只留一个入口,
 * 两处以同一视觉/交互出现。
 *
 * 语义:`useFileBrowserPreference` 全局偏好(默认关),打开后文件树列出 Cindy
 * 默认隐藏的依赖 / 构建产物 / 缓存目录(build、dist、out、node_modules…)。
 * 偏好进 `useFileTree` 的 store key,切换即换 store 并用新 matcher 重拉,用户
 * 不需要手动刷新。
 *
 * 形态对齐同级按钮与既有先例(ReviewTabBody 的文件树显隐开关):
 *   - size-5 + 图标 14,与同排三个按钮同几何,不改变标题行节奏
 *   - 圆角走 DESIGN.md §5 的 pill 档(控件框 = pill);整行四个按钮共用
 *     fileTreeHeaderButtonClass 里的同一份类名,不再各写一份
 *   - 状态用 `aria-pressed` + 按压底色表达;图标随状态在 EyeOff / Eye 间切换
 *   - 文案遵循 DESIGN.md §14.6:说**下一步动作**(显示 / 隐藏),tooltip 与
 *     aria-label 一起变
 */

import { useTranslation } from 'react-i18next';
import { Eye, EyeOff } from 'lucide-react';

import { cn } from '@/lib/utils';
import { Tip } from '@/components/ui/tooltip';
import { useFileBrowserPreference } from '@/hooks/useFileBrowserPreference';
import { FILE_TREE_HEADER_ICON_BUTTON_CLASS } from './fileTreeHeaderButtonClass';

export function FileTreeIgnoredDirsToggle() {
  const { t } = useTranslation();
  const { showIgnoredDirs, setShowIgnoredDirs } = useFileBrowserPreference();

  // §14.6:状态控件描述将要发生的动作。
  const label = t(
    showIgnoredDirs
      ? 'ccAgent.workdirBrowse.treeAction.hideIgnoredDirs'
      : 'ccAgent.workdirBrowse.treeAction.showIgnoredDirs',
  );

  return (
    <Tip text={label}>
      <button
        type="button"
        aria-pressed={showIgnoredDirs}
        aria-label={label}
        onClick={() => setShowIgnoredDirs(!showIgnoredDirs)}
        className={cn(
          FILE_TREE_HEADER_ICON_BUTTON_CLASS,
          showIgnoredDirs && 'bg-sidebar-item-active text-sidebar-item-active-foreground',
        )}
      >
        {showIgnoredDirs ? (
          <Eye size={14} strokeWidth={2} />
        ) : (
          <EyeOff size={14} strokeWidth={2} />
        )}
      </button>
    </Tip>
  );
}
