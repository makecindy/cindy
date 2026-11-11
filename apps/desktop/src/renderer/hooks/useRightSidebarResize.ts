/**
 * useRightSidebarResize — 右侧边栏宽度读取(比例语义,布局树全局持久化)
 * ---------------------------------------------------------------------------
 * 本 hook 已不再承担拖拽:拖宽把手统一为**引擎分割线**(LayoutRoot 的
 * RootDivider,拖动经 transferSplitFraction 写树),RSB 的私有把手已拆除。
 * 保留职责:
 * - **width 兜底**:fraction × 可用宽的像素换算(RSB 优先消费引擎
 *   PaneWidthContext 的实时值,本值仅引擎未接管时回落);
 * - **resizeEdge / 所在侧推导**:面板贴哪条边(MainLayout 据此决定折叠 toggle
 *   落哪个角,B2b);
 * - **旧 localStorage 键的一次性迁移**(B1b-1,migrateLegacyRsbFraction)。
 *
 * fraction 的真身在布局树 content 分割里 right-tabs child 上(userData/
 * layout.v1.json):mount 同步读树(首帧就位),订阅 layout:changed 跟随
 * 一切写方(引擎缝把手 / reset / dev 工具)。宽度全局一份(Lizi 2026-07-07
 * 决策),不随会话变化。
 */

import { useEffect, useState } from 'react';

import { findSplitChildByPanelKind, setSplitChildFraction, type Layout } from '../../shared/layoutTree';
import { RSB_FRACTION_KEY_PREFIX, RSB_FRACTION_LAST_KEY } from '@/lib/sessionLayoutPrefs';

/**
 * 默认右栏占可用区 1/2(聊天区与右栏 1:1)。与 shared/layoutTree.ts
 * createDefaultLayout 的 right-tabs fraction 保持一致(树是持久化真身,
 * 这里只是树缺失 right-tabs 时的渲染兜底)。
 */
const DEFAULT_FRACTION = 0.5;
/** fraction 持久值的合理区间,避免 0 / 1 这种把某一栏挤没的极端值。 */
const MIN_FRACTION = 0.1;
const MAX_FRACTION = 0.9;

/** 右栏面板在布局树中的 panelKind(按 kind 寻址,不按方位)。 */
const RIGHT_TABS_KIND = 'right-tabs';

/** 右栏展开后的最小像素宽。 */
export const RIGHT_SIDEBAR_MIN_WIDTH = 280;
/** 中间聊天区允许被压到的最小像素宽(对齐 <main> 的 min-w-[400px])。 */
export const CHAT_AREA_MIN_WIDTH = 400;
/** 首帧(MainLayout 还没测出可用宽)/ 异常时的可用宽兜底。 */
export const RIGHT_SIDEBAR_AVAILABLE_WIDTH_FALLBACK = 1200;

function clampFraction(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_FRACTION;
  return Math.min(MAX_FRACTION, Math.max(MIN_FRACTION, value));
}

/** 拖宽把手所在的面板边缘(即面板与聊天区的分界边)。 */
export type ResizeEdge = 'left' | 'right';

/**
 * 从一棵布局树里读 right-tabs 的 fraction 与所在边:
 * - fraction:树里没有该面板时返回渲染兜底默认;
 * - edge:面板是所在分割的**第一个** child(在最左)→ 贴左(把手/toggle 在右缘),
 *   否则贴右(在左缘)。
 */
function readLayoutState(layout: Layout): { fraction: number; edge: ResizeEdge } {
  const ref = findSplitChildByPanelKind(layout, RIGHT_TABS_KIND);
  return {
    fraction: ref ? clampFraction(ref.fraction) : DEFAULT_FRACTION,
    edge: ref && ref.childIndex === 0 ? 'right' : 'left',
  };
}

/** 同步读当前树(mount 首帧用)。IPC 异常时落默认,不阻塞渲染。 */
function readTreeState(): { fraction: number; edge: ResizeEdge } {
  try {
    return readLayoutState(window.electronAPI.layout.getStateSync().layout);
  } catch {
    return { fraction: DEFAULT_FRACTION, edge: 'left' };
  }
}

/** 把 fraction 写回布局树(迁移路径用)。best-effort,树里没有 right-tabs 静默跳过。 */
function persistTreeFraction(fraction: number): void {
  try {
    const layout = window.electronAPI.layout.getStateSync().layout;
    const ref = findSplitChildByPanelKind(layout, RIGHT_TABS_KIND);
    if (!ref) return;
    const op = setSplitChildFraction(layout, ref.splitId, ref.childIndex, clampFraction(fraction));
    if (!op.applied) return;
    void window.electronAPI.layout.set(op.layout);
  } catch {
    // IPC 不可用(测试环境等)—— 静默
  }
}

/**
 * 一次性迁移:旧 localStorage 宽度偏好 → 布局树全局 fraction(B1b-1)。
 * - 读 `:last`(旧全局 fallback)作为迁移值;
 * - 无条件清掉全部 `right-sidebar-fraction:*` 键(per-session 记忆按决策取消,不迁);
 * - 有迁移值则异步写树,并**同步返回该值**给首帧渲染(无跳变,规则 7)。
 * 结果模块级 memo:StrictMode 双跑安全。
 */
let legacyMigrationResult: number | null | undefined;
export function migrateLegacyRsbFraction(): number | null {
  if (legacyMigrationResult !== undefined) return legacyMigrationResult;
  let migrated: number | null = null;
  try {
    const raw = localStorage.getItem(RSB_FRACTION_LAST_KEY);
    if (raw !== null) {
      const parsed = Number(raw);
      if (Number.isFinite(parsed)) migrated = clampFraction(parsed);
    }
    const doomed: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith(RSB_FRACTION_KEY_PREFIX)) doomed.push(key);
    }
    for (const key of doomed) localStorage.removeItem(key);
  } catch {
    // localStorage 不可用 —— 视作无旧值
  }
  legacyMigrationResult = migrated;
  if (migrated !== null) persistTreeFraction(migrated);
  return migrated;
}

/** 测试专用:重置迁移 memo(生产代码不得调用)。 */
export function __resetRsbFractionMigrationForTests(): void {
  legacyMigrationResult = undefined;
}

/**
 * 把 fraction 换算成实际像素宽并按双侧下限 clamp:右栏 ≥ 280,且给中间留 ≥ 400。
 * 可用宽极窄(< 680)时上界退回 280(右栏优先保命、中间让步)。
 */
function fractionToWidth(fraction: number, availableWidth: number): number {
  const maxWidth = Math.max(RIGHT_SIDEBAR_MIN_WIDTH, availableWidth - CHAT_AREA_MIN_WIDTH);
  return Math.min(
    maxWidth,
    Math.max(RIGHT_SIDEBAR_MIN_WIDTH, Math.round(fraction * availableWidth)),
  );
}

export interface RightSidebarResizeResult {
  /** 右栏像素宽兜底(fraction × 可用宽 + 双侧下限 clamp;RSB 优先消费引擎实时值)。 */
  width: number;
  /** 面板与聊天区分界边(由树上位置推导;MainLayout 据此决定折叠 toggle 落角)。 */
  resizeEdge: ResizeEdge;
}

/**
 * @param availableWidth 中间 + 右栏可分配的总像素宽。布局引擎消费者可显式传入；
 *   MainLayout 只读取稳定的像素宽兜底，不再订阅 live resize，因此缺省用 fallback。
 */
export function useRightSidebarResize(
  availableWidth: number = RIGHT_SIDEBAR_AVAILABLE_WIDTH_FALLBACK,
): RightSidebarResizeResult {
  const [initialTree] = useState(() => readTreeState());
  const [fraction, setFraction] = useState(() => {
    // 首帧:旧 localStorage 值(若有)优先 —— 迁移的树写入是异步的,直接读树
    // 会拿到迁移前的值,产生一帧跳变;有迁移值就先用它渲染,树随后追平。
    const migrated = migrateLegacyRsbFraction();
    return migrated ?? initialTree.fraction;
  });
  const [resizeEdge, setResizeEdge] = useState<ResizeEdge>(initialTree.edge);

  // 订阅布局树变化(引擎缝把手 / reset / dev 工具 / 其它写方)→ 刷新。
  useEffect(
    () =>
      window.electronAPI.layout.onChanged(({ layout }) => {
        const next = readLayoutState(layout);
        setFraction(next.fraction);
        setResizeEdge(next.edge);
      }),
    [],
  );

  return { width: fractionToWidth(fraction, availableWidth), resizeEdge };
}
