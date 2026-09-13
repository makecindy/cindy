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
 *   - 被控端不支持时(device-link 连到老 Desktop,它的 listDir 静默忽略该字段):
 *     控件呈现为不可用 + 说明原因,不装成"按下去就生效"的假开关
 */

import { useTranslation } from 'react-i18next';
import { Eye, EyeOff } from 'lucide-react';

import { cn } from '@/lib/utils';
import { Tip } from '@/components/ui/tooltip';
import { useFileBrowserPreference } from '@/hooks/useFileBrowserPreference';
import { FILE_TREE_HEADER_ICON_BUTTON_CLASS } from './fileTreeHeaderButtonClass';

export interface FileTreeIgnoredDirsToggleProps {
  /**
   * 当前会话的被控端不支持 `showIgnoredDirs`(老 Desktop 的 listDir 会静默
   * 忽略该字段)。由 `useFileTree` 的 `showIgnoredDirsSupported === false` 传入。
   */
  unsupported?: boolean;
}

export function FileTreeIgnoredDirsToggle({
  unsupported = false,
}: FileTreeIgnoredDirsToggleProps) {
  const { t } = useTranslation();
  const { showIgnoredDirs, setShowIgnoredDirs } = useFileBrowserPreference();

  // 不支持的老被控端:按「关」呈现 —— 这个视图里确实不会显示被忽略目录(tree
  // 也按隐藏态建的 store),同时 label 说明原因。压着不动的按下态比禁用更容易
  // 被误读为“已经打开了”。
  const pressed = !unsupported && showIgnoredDirs;

  // §14.6:状态控件描述将要发生的动作。
  const label = unsupported
    ? t('ccAgent.workdirBrowse.treeAction.showIgnoredDirsUnsupported')
    : t(
        pressed
          ? 'ccAgent.workdirBrowse.treeAction.hideIgnoredDirs'
          : 'ccAgent.workdirBrowse.treeAction.showIgnoredDirs',
      );

  return (
    <Tip text={label}>
      <button
        type="button"
        aria-pressed={pressed}
        aria-label={label}
        // aria-disabled 而不走原生 disabled:原生 disabled 的按钮不派发鼠标事件,
        // Radix tooltip 打不开 —— 用户就没有地方能看到“为什么不能按”。
        aria-disabled={unsupported || undefined}
        onClick={() => {
          if (unsupported) return;
          setShowIgnoredDirs(!showIgnoredDirs);
        }}
        className={cn(
          FILE_TREE_HEADER_ICON_BUTTON_CLASS,
          pressed && 'bg-sidebar-item-active text-sidebar-item-active-foreground',
          unsupported && 'cursor-not-allowed opacity-45 hover:bg-transparent',
        )}
      >
        {pressed ? (
          <Eye size={14} strokeWidth={2} />
        ) : (
          <EyeOff size={14} strokeWidth={2} />
        )}
      </button>
    </Tip>
  );
}
