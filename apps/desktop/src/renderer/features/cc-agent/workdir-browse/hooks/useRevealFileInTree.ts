/**
 * useRevealFileInTree —— "把目标文件在文件树里露出来 + 滚到视口"的共用动作。
 *
 * 单一来源:RSB file-browser plugin 和 doc 模式 WorkdirBrowseSidebar 两侧都要
 * 在"筛选选中文件" / "跳转到某文件" 等场景里做同一件事 —— 展开它的所有父目录,
 * 等 React 把对应行渲染出来,再让 FileTreeView 把目标行滚进视口。两边的 select
 * 状态机不同(RSB 走 plugin state、doc 走 URL searchParams),但 reveal 这一段动作
 * 完全一致,沉淀到这里。以后调整(切换滚动行为、加高亮闪烁、把多次
 * 调用 dedupe 等)只改这一处。
 *
 * 用法:
 *   const fileTreeRef = useRef<FileTreeViewHandle>(null);
 *   const reveal = useRevealFileInTree(tree, fileTreeRef);
 *   // ... select callback 里:
 *   await reveal(relPath);   // 此时父目录已展开 + 行已滚到视口
 *
 * 时序细节:
 *   1) expandToPath 异步 await —— 包含未 cache 父目录的 listDir IPC
 *   2) 两次 rAF —— 第一帧让 React commit 新 expanded set / 渲染新行,
 *      第二帧让布局稳定后再调 FileTreeView 的 scrollToPath(虚拟化后由
 *      virtualizer.scrollToIndex 完成，行不在树里时静默 no-op)
 *
 * 这里不接管"清空 filter query / 设置 selectedPath / URL searchParams"等
 * caller 自己的状态机 —— caller 在调 reveal 前后自行处理那些。
 */

import { useCallback, type RefObject } from 'react';

import type { FileTreeViewHandle } from '../FileTreeView';
import type { UseFileTreeReturn } from './useFileTree';

/**
 * 返回一个 `reveal(relPath)` 函数,展开父目录并把目标行滚到视口中央。
 *
 * @param tree useFileTree 返回值
 * @param fileTreeRef 指向被渲染的 FileTreeView 的 imperative handle ref
 */
export function useRevealFileInTree(
  tree: UseFileTreeReturn,
  fileTreeRef: RefObject<FileTreeViewHandle | null>,
): (relPath: string) => Promise<void> {
  return useCallback(
    async (relPath: string) => {
      if (!relPath) return;
      await tree.expandToPath(relPath);
      // 两次 rAF 等 React commit + 布局稳定:
      // - 第一帧:expanded set 触发 FileTreeView re-render,新增的行进入虚拟列表
      // - 第二帧:浏览器布局跑完,scrollToIndex 能拿到正确的行位置
      // 单次 rAF 实测在重载父目录(刚 fetchDir)场景偶发提前调用。
      await new Promise<void>((resolve) =>
        window.requestAnimationFrame(() =>
          window.requestAnimationFrame(() => resolve()),
        ),
      );
      fileTreeRef.current?.scrollToPath(relPath);
    },
    [tree, fileTreeRef],
  );
}
