/**
 * collapsePrefs —— 面板折叠态的统一读写入口(布局树 B2a)。
 *
 * 面板在注册表声明 `collapseMemory`(global / per-session / none),本模块按声明分发:
 * - **global**:持久化真身是布局树上该面板 pane 的 `collapsed`(userData/layout.v1.json)。
 *   读 = 同步 getStateSync(首帧就位);写 = setPaneCollapsed + layout.set(best-effort)。
 *   运行时各窗口 state 仍本窗口独立(不做窗口间实时联动)—— 与迁移前 localStorage
 *   语义完全一致,只换了存档位置;实时联动等引擎接管折叠渲染(B2b+)再谈。
 * - **per-session**:跟会话走,localStorage 按 `<kind>:<sessionId>` 分桶(right-tabs
 *   沿用历史键前缀 `right-sidebar-collapsed:`,老用户数据无缝)。
 * - **none / 未注册 kind**:读返回 fallback、写为 no-op(未安装意识的残留 pane 不该
 *   有人来写它的折叠态)。
 *
 * 旧的左栏全局键 `sidebar-collapsed` 由 migrateLegacySidebarCollapsed 一次性迁入树,
 * 迁移值同步返回给首帧渲染,无跳变(规则 7;与右栏宽度迁移同款模式)。
 *
 * 并发说明:global 写是"读整树 → 改 → 写整树",多窗口同时写不同字段理论上存在
 * 后写覆盖先写的窗口极小竞态(与迁移前多窗口写同一 localStorage 键同级别的边缘
 * 场景);LayoutStore 提供字段级操作前先接受,不在本层造锁。
 */

import { setPaneCollapsed, walkPanes, type PanelKind } from '../../shared/layoutTree';
import { RSB_COLLAPSED_KEY_PREFIX } from '@/lib/sessionLayoutPrefs';
import { registerBuiltinPanels } from '../panels/builtinPanels';
import { getPanelKind, type CollapseMemory } from '../panels/registry';

/** per-session 分桶上下文;global 面板忽略。 */
export interface CollapseCtx {
  sessionId?: string | null;
}

/** 旧版左栏全局折叠键 —— 已废弃,仅迁移用途。 */
const LEGACY_SIDEBAR_COLLAPSED_KEY = 'sidebar-collapsed';

/**
 * 取面板声明的折叠记忆作用域。内置面板注册发生在 LayoutRoot 组件体,而 MainLayout
 * 的 state 初始化早于它 —— 这里幂等补注册,保证首帧读取也能拿到声明。
 */
function scopeOf(kind: PanelKind): CollapseMemory {
  registerBuiltinPanels();
  return getPanelKind(kind)?.collapseMemory ?? 'none';
}

/** per-session 桶键:right-tabs 沿用历史前缀保住老数据;其它 kind 走通用前缀。 */
function sessionKeyFor(kind: PanelKind, sessionId: string): string {
  if (kind === 'right-tabs') return `${RSB_COLLAPSED_KEY_PREFIX}${sessionId}`;
  return `panel-collapsed:${kind}:${sessionId}`;
}

function readGlobalFromTree(kind: PanelKind, fallback: boolean): boolean {
  try {
    const layout = window.electronAPI.layout.getStateSync().layout;
    const pane = walkPanes(layout).find((p) => p.panelKind === kind);
    return pane?.collapsed ?? fallback;
  } catch {
    return fallback;
  }
}

function readGlobalRecordFromTree(kind: PanelKind): boolean | null {
  try {
    const layout = window.electronAPI.layout.getStateSync().layout;
    const pane = walkPanes(layout).find((p) => p.panelKind === kind);
    return typeof pane?.collapsed === 'boolean' ? pane.collapsed : null;
  } catch {
    return null;
  }
}

function writeGlobalToTree(kind: PanelKind, collapsed: boolean): void {
  try {
    const layout = window.electronAPI.layout.getStateSync().layout;
    const pane = walkPanes(layout).find((p) => p.panelKind === kind);
    if (!pane) return;
    const op = setPaneCollapsed(layout, pane.id, collapsed);
    if (!op.applied) return;
    void window.electronAPI.layout.set(op.layout).catch(() => undefined);
  } catch {
    // IPC 不可用(测试环境等)—— 静默,本次不持久化
  }
}

/**
 * 读面板折叠态。global → 树;per-session → 会话桶(桶里没值落 fallback;历史语义:
 * 存过非 'false' 的值一律按 true,与右栏既有解析保持逐字节一致);none → fallback。
 */
export function readPanelCollapsed(kind: PanelKind, ctx: CollapseCtx, fallback: boolean): boolean {
  const scope = scopeOf(kind);
  if (scope === 'global') return readGlobalFromTree(kind, fallback);
  if (scope === 'per-session') {
    const sessionId = ctx.sessionId ?? null;
    if (!sessionId) return fallback;
    try {
      const raw = localStorage.getItem(sessionKeyFor(kind, sessionId));
      return raw === null ? fallback : raw !== 'false';
    } catch {
      return fallback;
    }
  }
  return fallback;
}

/**
 * 读面板折叠态的显式记录。与 readPanelCollapsed 不同,这里保留「从未记录」语义:
 * - global:树上 collapsed 字段存在才返回 boolean,否则 null。
 * - per-session:会话桶 localStorage 有键才返回 boolean,否则 null。
 * - none / 未注册 kind:永远 null。
 */
export function readPanelCollapsedRecord(kind: PanelKind, ctx: CollapseCtx): boolean | null {
  const scope = scopeOf(kind);
  if (scope === 'global') return readGlobalRecordFromTree(kind);
  if (scope === 'per-session') {
    const sessionId = ctx.sessionId ?? null;
    if (!sessionId) return null;
    try {
      const raw = localStorage.getItem(sessionKeyFor(kind, sessionId));
      return raw === null ? null : raw !== 'false';
    } catch {
      return null;
    }
  }
  return null;
}

// In-memory write identity only, never a second preference store. A newer user
// write must supersede a provisional default even when it writes the same value.
let nextSessionWriteRevision = 0;
const sessionWriteRevisions = new Map<string, number>();

/** 写面板折叠态;per-session 返回写代次,供失败默认值的精确撤回使用。 */
export function writePanelCollapsed(kind: PanelKind, ctx: CollapseCtx, collapsed: boolean): number | undefined {
  const scope = scopeOf(kind);
  if (scope === 'global') {
    writeGlobalToTree(kind, collapsed);
    return;
  }
  if (scope === 'per-session') {
    const sessionId = ctx.sessionId ?? null;
    if (!sessionId) return;
    try {
      const key = sessionKeyFor(kind, sessionId);
      localStorage.setItem(key, String(collapsed));
      const revision = ++nextSessionWriteRevision;
      sessionWriteRevisions.set(key, revision);
      return revision;
    } catch {
      // storage 不可用 —— 静默
    }
  }
}

/** Withdraw a failed per-session default only if the record still has that value. */
export function clearPanelCollapsedRecord(
  kind: PanelKind,
  ctx: CollapseCtx,
  expected: boolean,
  revision: number,
): void {
  if (scopeOf(kind) !== 'per-session' || !ctx.sessionId) return;
  try {
    const key = sessionKeyFor(kind, ctx.sessionId);
    if (sessionWriteRevisions.get(key) !== revision) return;
    if (localStorage.getItem(key) === String(expected)) {
      localStorage.removeItem(key);
      sessionWriteRevisions.delete(key);
    }
  } catch {
    // Keep the same best-effort storage semantics as the read/write helpers.
  }
}

/**
 * 一次性迁移:旧左栏全局键 `sidebar-collapsed` → 布局树 sidebar pane 的 collapsed。
 * 有旧值则异步写树并**同步返回该值**给首帧渲染(树的异步写完成前界面已是迁移后
 * 状态,无跳变);无旧值返回 null。结果模块级 memo,StrictMode 双跑安全。
 */
let legacySidebarMigration: boolean | null | undefined;
export function migrateLegacySidebarCollapsed(): boolean | null {
  if (legacySidebarMigration !== undefined) return legacySidebarMigration;
  let migrated: boolean | null = null;
  try {
    const raw = localStorage.getItem(LEGACY_SIDEBAR_COLLAPSED_KEY);
    if (raw !== null) {
      migrated = raw === 'true';
      localStorage.removeItem(LEGACY_SIDEBAR_COLLAPSED_KEY);
    }
  } catch {
    // localStorage 不可用 —— 视作无旧值
  }
  legacySidebarMigration = migrated;
  if (migrated !== null) writePanelCollapsed('session-list', {}, migrated);
  return migrated;
}

/** 测试专用:重置迁移 memo(生产代码不得调用)。 */
export function __resetCollapsePrefsForTests(): void {
  legacySidebarMigration = undefined;
}
