/**
 * review plugin —— RSB 内显示"本次会话改动了哪些文件"的常驻 tab。
 *
 * 数据从 git-review IPC 派生;makerChatStore 只提供 Last turn 过滤集合。plugin
 * 自身持久化用户收起过哪些 diff id(`collapsedPaths`)、diff 模式、文件树显隐、
 * diff 自动换行偏好、文字差异偏好、隐藏空白变更偏好、Markdown 富文本预览偏好与分支来源的基准分支。
 *
 * 单例语义 —— 由 RightSidebarShell + AddTabDropdown 在调用层用
 * `addOrFocusSingletonTab` 保证,plugin 自己不挡(plugin API 不支持声明 singleton,
 * 单例是产品规则而非 plugin 能力)。
 *
 * 注册:模块顶层 import-side-effect。plugins/index.ts 把它 import 进来。
 */

import { FileDiff } from 'lucide-react';
import type { TFunction } from 'i18next';

import { isSafeBranchBaseRef } from '../../../../../shared/reviewBranchRef';
import { registerTabKind } from '../../registry';
import type { TabKindPlugin } from '../../types';
import { ReviewTabBody } from './ReviewTabBody';
import type { DiffViewMode } from './DiffViewer/PlainUnifiedDiff';

export interface ReviewState {
  /** Programmatic exact-turn review target. Null keeps the normal Git-backed review surface. */
  turnTarget: {
    changeSetIds: string[];
    selectedDiffId: string | null;
    selectedPath: string | null;
    requestNonce: number;
  } | null;
  /** 用户收起过哪些 diff id。空数组表示所有当前 diff 默认展开。 */
  collapsedPaths: string[];
  /** diff 展示模式。写操作仍回到原始 unified DiffLine.index。 */
  diffViewMode: DiffViewMode;
  /** 右侧已修改文件树显隐。默认收起,用户选择通过 tab state 记住。 */
  fileTreeVisible: boolean;
  /** diff 行是否自动换行。默认关闭,保留横向滚动。 */
  wordWrap: boolean;
  /** 是否显示行内文字差异强调。对齐 Codex,默认开启。 */
  wordDiff: boolean;
  /** 是否用忽略空白模式读取 diff。默认关闭,避免影响 patch 类操作。 */
  hideWhitespace: boolean;
  /** Markdown 文件是否默认用富文本预览替换 diff 主体。对齐 Codex,默认开启。 */
  richMarkdownPreview: boolean;
  /** Branch source 的用户选择基准。首版按 tab/session 记住,不做 per-repo。 */
  branchBaseRef: string | null;
}

const DEFAULT_STATE: ReviewState = {
  turnTarget: null,
  collapsedPaths: [],
  diffViewMode: 'unified',
  fileTreeVisible: false,
  wordWrap: false,
  wordDiff: true,
  hideWhitespace: false,
  richMarkdownPreview: true,
  branchBaseRef: null,
};

function ReviewTabPillTitle({ t }: { state: ReviewState; t: TFunction }) {
  // 复用 tabs.kinds.review label(与「+」dropdown / add-tab 分组一致),
  // 避免"pill 上叫改动 / dropdown 里叫审查"的分裂文案。
  return <>{t('rightSidebar.tabs.kinds.review')}</>;
}

function ReviewTabPillIcon() {
  return <FileDiff size={13} />;
}

const plugin: TabKindPlugin<ReviewState> = {
  kind: 'review',
  menu: {
    kind: 'review',
    labelKey: 'rightSidebar.tabs.kinds.review',
    icon: FileDiff,
    order: 15, // file-browser=10, web-browser=20 之间
    enabled: true,
    singleton: true, // 每个 session 至多 1 个 review tab
  },
  TabPillTitle: ReviewTabPillTitle,
  TabPillIcon: ReviewTabPillIcon,
  TabBody: ReviewTabBody,
  defaultState: () => ({ ...DEFAULT_STATE, collapsedPaths: [] }),
  hydrateState: (raw): ReviewState => {
    if (!raw || typeof raw !== 'object') return { ...DEFAULT_STATE, collapsedPaths: [] };
    const obj = raw as Record<string, unknown>;
    const collapsedPaths = Array.isArray(obj.collapsedPaths)
      ? obj.collapsedPaths.filter((s): s is string => typeof s === 'string')
      : [];
    const diffViewMode = obj.diffViewMode === 'split' ? 'split' : 'unified';
    const fileTreeVisible = typeof obj.fileTreeVisible === 'boolean'
      ? obj.fileTreeVisible
      : DEFAULT_STATE.fileTreeVisible;
    const wordWrap = typeof obj.wordWrap === 'boolean'
      ? obj.wordWrap
      : DEFAULT_STATE.wordWrap;
    const wordDiff = typeof obj.wordDiff === 'boolean'
      ? obj.wordDiff
      : DEFAULT_STATE.wordDiff;
    const hideWhitespace = typeof obj.hideWhitespace === 'boolean'
      ? obj.hideWhitespace
      : DEFAULT_STATE.hideWhitespace;
    const richMarkdownPreview = typeof obj.richMarkdownPreview === 'boolean'
      ? obj.richMarkdownPreview
      : DEFAULT_STATE.richMarkdownPreview;
    const branchBaseRef = typeof obj.branchBaseRef === 'string' && isSafeBranchBaseRef(obj.branchBaseRef.trim())
      ? obj.branchBaseRef.trim()
      : null;
    const rawTurnTarget = obj.turnTarget;
    const turnTarget = rawTurnTarget && typeof rawTurnTarget === 'object'
      && Array.isArray((rawTurnTarget as { changeSetIds?: unknown }).changeSetIds)
      && (rawTurnTarget as { changeSetIds: unknown[] }).changeSetIds.length > 0
      && (rawTurnTarget as { changeSetIds: unknown[] }).changeSetIds.length <= 16
      && (rawTurnTarget as { changeSetIds: unknown[] }).changeSetIds.every((id) => typeof id === 'string')
      ? {
          changeSetIds: (rawTurnTarget as { changeSetIds: string[] }).changeSetIds,
          selectedDiffId: typeof (rawTurnTarget as { selectedDiffId?: unknown }).selectedDiffId === 'string'
            ? (rawTurnTarget as { selectedDiffId: string }).selectedDiffId
            : null,
          selectedPath: typeof (rawTurnTarget as { selectedPath?: unknown }).selectedPath === 'string'
            ? (rawTurnTarget as { selectedPath: string }).selectedPath
            : null,
          requestNonce: typeof (rawTurnTarget as { requestNonce?: unknown }).requestNonce === 'number'
            ? (rawTurnTarget as { requestNonce: number }).requestNonce
            : 0,
        }
      : null;
    return { turnTarget, collapsedPaths, diffViewMode, fileTreeVisible, wordWrap, wordDiff, hideWhitespace, richMarkdownPreview, branchBaseRef };
  },
};

registerTabKind(plugin as unknown as TabKindPlugin, import.meta.hot);
