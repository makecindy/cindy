/**
 * file-browser plugin — RSB 内嵌的精简文件浏览器(对标设计稿 F2 双 Pane)。
 *
 * 设计要点:
 *   - **state 最小化**:`{ selectedFilePath: string | null }`。多文件 tabs / tree
 *     width 等 doc-mode 才有的丰富功能 v1 不引入,避免在右栏狭窄空间内堆 chrome
 *     (plan 5.1 明确 "嵌入式版精简")。
 *   - **selection 不走 URL**:URL 属于会话主路由,plugin 不能污染。selectedFilePath
 *     完全由 plugin state 持有,经 store + IPC 持久化跨刷新恢复。
 *   - **底层组件复用**:`FileTreeView` / `FileBodyView` / `useFileTree` / `useFileContent`
 *     都是 controlled,直接喂 selectedFilePath + workdir 即可,无需 fork。
 *   - **dirty 切换拦截**:plugin 内 `onSelectFile` 走 `useConfirmSwitchAwayIfDirty`
 *     hook(规则 9 复用),保证用户切文件时未保存改动有机会 save / discard / cancel。
 *     跨顶层 tab 切换的 dirty 拦截 v1 不做(Phase 7 收尾)。
 *
 * 注册:模块顶层(import-side-effect)调 `registerTabKind`,Shell 在自身顶层 import
 * `./plugins` 触发本文件执行。
 */

import { lazy } from 'react';
import { FolderTree } from 'lucide-react';
import type { TFunction } from 'i18next';

import { registerTabKind } from '../../registry';
import type { TabKindPlugin } from '../../types';

const FileBrowserBody = lazy(() =>
  import('./FileBrowserBody').then((module) => ({ default: module.FileBrowserBody })),
);

/** plugin state shape — 跟 store 序列化结构一致,默认 JSON identity 即可 hydrate。 */
export interface FileBrowserState {
  /** 当前选中的 workdir-relative POSIX 路径;null = 没选(渲染空提示)。 */
  selectedFilePath: string | null;
  /**
   * 一次性目录定位请求(聊天目录 chip → openDirInSidebarFileBrowser 写入):
   * FileBrowserBody 消费后即清空。hydrateState 必须透传(TabBody 渲染前 state
   * 会统一过 hydrate,剥掉就永远到不了 Body);消费即清空保证跨重启至多重放一次。
   */
  revealDirPath?: string | null;
  /** 目录定位请求序号:同一目录重复点击也要重新触发 reveal。 */
  revealDirNonce?: number;
  /**
   * 一次性文件定位请求(聊天文件 chip 右键 → openFileInSidebarFileBrowser 写入):
   * FileBrowserBody 消费后选中文件、展开父目录并滚动到文件行。
   */
  revealFilePath?: string | null;
  /** 文件定位请求序号:同一文件重复打开也要重新触发 reveal。 */
  revealFileNonce?: number;
  /**
   * 一次性外部文件打开请求(聊天文件 chip 右键 → workdir 外本地文件):
   * FileBrowserBody 复用原生文件拖入链路消费，不把绝对路径挂进项目文件树。
   */
  externalFilePath?: string | null;
  /** 外部文件打开请求序号:同一路径重复打开也要重新触发。 */
  externalFileNonce?: number;
}

const DEFAULT_STATE: FileBrowserState = {
  selectedFilePath: null,
};

/** TabPill 上的标题:有选中文件 → 显示 basename;否则 → 走 i18n "文件浏览器"。 */
function FileBrowserTabPillTitle({
  state,
  t,
}: {
  state: FileBrowserState;
  t: TFunction;
}) {
  if (!state.selectedFilePath) {
    return <>{t('rightSidebar.tabs.kinds.fileBrowser')}</>;
  }
  const slash = state.selectedFilePath.lastIndexOf('/');
  const basename = slash < 0 ? state.selectedFilePath : state.selectedFilePath.slice(slash + 1);
  return <>{basename}</>;
}

/** TabPill 上的图标 —— 固定 FolderTree(无须随 selection 切换)。 */
function FileBrowserTabPillIcon() {
  return <FolderTree size={13} />;
}

const plugin: TabKindPlugin<FileBrowserState> = {
  kind: 'file-browser',
  menu: {
    kind: 'file-browser',
    labelKey: 'rightSidebar.tabs.kinds.fileBrowser',
    icon: FolderTree,
    order: 10,
    enabled: true,
  },
  TabPillTitle: FileBrowserTabPillTitle,
  TabPillIcon: FileBrowserTabPillIcon,
  TabBody: FileBrowserBody,
  defaultState: () => ({ ...DEFAULT_STATE }),
  // hydrateState:做最小兼容 —— 收 unknown,挑出 selectedFilePath 字段,其余忽略。
  // 后续 schema 演进时新字段缺失走 default,旧字段忽略,不会因为持久化记录格式漂移
  // 导致组件 crash。
  hydrateState: (raw): FileBrowserState => {
    if (!raw || typeof raw !== 'object') return { ...DEFAULT_STATE };
    const obj = raw as Record<string, unknown>;
    const path = obj.selectedFilePath;
    return {
      selectedFilePath: typeof path === 'string' ? path : null,
      // 目录定位请求透传(见字段注释);形状不合法按"无请求"。
      ...(typeof obj.revealDirPath === 'string' && obj.revealDirPath
        ? { revealDirPath: obj.revealDirPath }
        : {}),
      ...(typeof obj.revealDirNonce === 'number' ? { revealDirNonce: obj.revealDirNonce } : {}),
      ...(typeof obj.revealFilePath === 'string' && obj.revealFilePath
        ? { revealFilePath: obj.revealFilePath }
        : {}),
      ...(typeof obj.revealFileNonce === 'number' ? { revealFileNonce: obj.revealFileNonce } : {}),
      ...(typeof obj.externalFilePath === 'string' && obj.externalFilePath
        ? { externalFilePath: obj.externalFilePath }
        : {}),
      ...(typeof obj.externalFileNonce === 'number'
        ? { externalFileNonce: obj.externalFileNonce }
        : {}),
    };
  },
};

registerTabKind(plugin as unknown as TabKindPlugin, import.meta.hot);
