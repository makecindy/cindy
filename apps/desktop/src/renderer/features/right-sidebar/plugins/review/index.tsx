/**
 * review plugin —— RSB 内统一显示当前 Git 状态与消息级历史变更的常驻 tab。
 *
 * 数据源由可持久化 descriptor 选择；Git 来源走 git-review IPC，历史来源读取
 * 已记录的 turn change sets。plugin 自身持久化全部 diff 的默认展开状态、diff 模式、文件树显隐、
 * diff 自动换行偏好、文字差异偏好、隐藏空白变更偏好、Markdown 富文本预览偏好与分支来源的基准分支。
 *
 * 单例语义 —— 由 RightSidebarShell + AddTabDropdown 在调用层用
 * `addOrFocusSingletonTab` 保证,plugin 自己不挡(plugin API 不支持声明 singleton,
 * 单例是产品规则而非 plugin 能力)。
 *
 * 注册:模块顶层 import-side-effect。plugins/index.ts 把它 import 进来。
 */

import { lazy } from 'react';
import { FileDiff } from 'lucide-react';
import type { TFunction } from 'i18next';

import {
  migrateLegacyTurnTarget,
  parseReviewJumpTarget,
  parseReviewSourceDescriptor,
  type ReviewJumpTarget,
  type ReviewSourceDescriptor,
} from '../../../../../shared/reviewSource';
import { isSafeBranchBaseRef } from '../../../../../shared/reviewBranchRef';
import { registerTabKind } from '../../registry';
import type { TabKindPlugin } from '../../types';
import type { DiffViewMode } from './DiffViewer/PlainUnifiedDiff';
import { seedReviewDiffsExpanded } from './diffExpansionPreference';

const ReviewTabBody = lazy(() =>
  import('./ReviewTabBody').then((module) => ({ default: module.ReviewTabBody })),
);

export interface ReviewState {
  /** 当前选中的审查来源。 */
  descriptor: ReviewSourceDescriptor;
  /** 最近一次从消息变更卡片进入时的精确快照，切换 Git 来源后仍可返回。 */
  messageSnapshot: Extract<ReviewSourceDescriptor, { kind: 'turn-set' }> | null;
  /** Optional one-shot positioning request supplied by a review entry point. */
  jumpTarget: ReviewJumpTarget | null;
  /** 所有 diff 的持久化默认展开状态；单文件覆盖只保留在当前组件生命周期。 */
  diffsExpanded: boolean;
  /** diff 展示模式。写操作仍回到原始 unified DiffLine.index。 */
  diffViewMode: DiffViewMode;
  /** 右侧已修改文件树显隐。默认收起,用户选择通过 tab state 记住。 */
  fileTreeVisible: boolean;
  /** diff 行是否自动换行。默认关闭,保留横向滚动。 */
  wordWrap: boolean;
  /** 是否显示行内文字差异强调。默认关闭,避免大文件审查时增加渲染开销。 */
  wordDiff: boolean;
  /** 是否用忽略空白模式读取 diff。默认关闭,避免影响 patch 类操作。 */
  hideWhitespace: boolean;
  /** Markdown 文件是否默认用富文本预览替换 diff 主体。对齐 Codex,默认开启。 */
  richMarkdownPreview: boolean;
  /** 最近选择的分支比较基线；切到其它来源或消息快照后仍保留。 */
  branchBaseRef: string | null;
}

const DEFAULT_STATE: ReviewState = {
  descriptor: { kind: 'unstaged' },
  messageSnapshot: null,
  jumpTarget: null,
  diffsExpanded: true,
  diffViewMode: 'unified',
  fileTreeVisible: false,
  wordWrap: false,
  wordDiff: false,
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
  defaultState: () => ({ ...DEFAULT_STATE }),
  hydrateState: (raw): ReviewState => {
    if (!raw || typeof raw !== 'object') return { ...DEFAULT_STATE };
    const obj = raw as Record<string, unknown>;
    const diffsExpanded =
      typeof obj.diffsExpanded === 'boolean' ? obj.diffsExpanded : DEFAULT_STATE.diffsExpanded;
    const diffViewMode = obj.diffViewMode === 'split' ? 'split' : 'unified';
    const fileTreeVisible =
      typeof obj.fileTreeVisible === 'boolean'
        ? obj.fileTreeVisible
        : DEFAULT_STATE.fileTreeVisible;
    const wordWrap = typeof obj.wordWrap === 'boolean' ? obj.wordWrap : DEFAULT_STATE.wordWrap;
    const wordDiff = typeof obj.wordDiff === 'boolean' ? obj.wordDiff : DEFAULT_STATE.wordDiff;
    const hideWhitespace =
      typeof obj.hideWhitespace === 'boolean' ? obj.hideWhitespace : DEFAULT_STATE.hideWhitespace;
    const richMarkdownPreview =
      typeof obj.richMarkdownPreview === 'boolean'
        ? obj.richMarkdownPreview
        : DEFAULT_STATE.richMarkdownPreview;
    const legacyTurnTarget = migrateLegacyTurnTarget(obj.turnTarget);
    const persistedDescriptor = parseReviewSourceDescriptor(obj.descriptor);
    const descriptor = persistedDescriptor ?? legacyTurnTarget?.descriptor ?? { kind: 'unstaged' };
    const rawBranchBaseRef =
      typeof obj.branchBaseRef === 'string' ? obj.branchBaseRef.trim() : null;
    const branchBaseRef =
      rawBranchBaseRef && isSafeBranchBaseRef(rawBranchBaseRef)
        ? rawBranchBaseRef
        : descriptor.kind === 'branch'
          ? descriptor.baseRef
          : null;
    const persistedMessageSnapshot = parseReviewSourceDescriptor(obj.messageSnapshot);
    const messageSnapshot =
      persistedMessageSnapshot?.kind === 'turn-set'
        ? persistedMessageSnapshot
        : descriptor.kind === 'turn-set'
          ? descriptor
          : null;
    const jumpTarget =
      parseReviewJumpTarget(obj.jumpTarget) ??
      (!persistedDescriptor && descriptor.kind === 'turn-set'
        ? (legacyTurnTarget?.jumpTarget ?? null)
        : null);
    return {
      descriptor,
      messageSnapshot,
      jumpTarget,
      diffsExpanded,
      diffViewMode,
      fileTreeVisible,
      wordWrap,
      wordDiff,
      hideWhitespace,
      richMarkdownPreview,
      branchBaseRef,
    };
  },
  onBeforeClose: (state, { sessionId }) => {
    seedReviewDiffsExpanded(sessionId, state?.diffsExpanded ?? DEFAULT_STATE.diffsExpanded);
  },
};

registerTabKind(plugin as unknown as TabKindPlugin, import.meta.hot);
