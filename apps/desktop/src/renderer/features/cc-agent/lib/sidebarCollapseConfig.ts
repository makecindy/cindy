/**
 * 侧栏「自动收起」配置。
 * ---------------------------------------------------------------------------
 * 普通任务与项目内任务由 SIDEBAR_INACTIVE_COLLAPSE_MS 控制闲置折叠。
 * 下列历史数量配置保留给原有 rail 等消费者；主列表容器仍默认最多 20 个。
 * 普通任务不再因排在前 5 / 10 条而豁免闲置折叠。
 *
 * 可配置但**不暴露 GUI**:用户(开发者)可在 DevTools 控制台改 localStorage 覆盖默认值,
 * 改完刷新生效(读取发生在 render 期,非响应式):
 *   localStorage.setItem('sidebar.collapse.projectSessionLimit', '8')   // 项目内会话
 *   localStorage.setItem('sidebar.collapse.dialogueLimit', '15')        // 对话段
 *   localStorage.setItem('sidebar.collapse.projectLimit', '30')         // 项目列表
 * 删除对应 key 即恢复默认。非法值(非数字/负数)自动回落默认。
 */

/** 桌面侧栏普通任务的闲置折叠阈值；不改变手机端与自动化运行列表。 */
export const SIDEBAR_INACTIVE_COLLAPSE_MS = 30 * 60 * 1000;

const PROJECT_SESSION_LIMIT_KEY = 'sidebar.collapse.projectSessionLimit';
const DIALOGUE_LIMIT_KEY = 'sidebar.collapse.dialogueLimit';
const PROJECT_LIMIT_KEY = 'sidebar.collapse.projectLimit';

/** 项目内会话列表默认上限。 */
export const DEFAULT_PROJECT_SESSION_COLLAPSE_LIMIT = 5;
/** 对话段默认上限。 */
export const DEFAULT_DIALOGUE_COLLAPSE_LIMIT = 10;
/** 项目列表默认上限。 */
export const DEFAULT_PROJECT_COLLAPSE_LIMIT = 20;

function readLimit(key: string, fallback: number): number {
  try {
    const raw = localStorage.getItem(key);
    if (raw == null) return fallback;
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
  } catch {
    return fallback;
  }
}

/** 项目内会话列表的折叠上限(默认 5,localStorage 'sidebar.collapse.projectSessionLimit' 覆盖)。 */
export function getProjectSessionCollapseLimit(): number {
  return readLimit(PROJECT_SESSION_LIMIT_KEY, DEFAULT_PROJECT_SESSION_COLLAPSE_LIMIT);
}

/** 对话段的折叠上限(默认 10,localStorage 'sidebar.collapse.dialogueLimit' 覆盖)。 */
export function getDialogueCollapseLimit(): number {
  return readLimit(DIALOGUE_LIMIT_KEY, DEFAULT_DIALOGUE_COLLAPSE_LIMIT);
}

/** 项目列表的折叠上限(默认 20,localStorage 'sidebar.collapse.projectLimit' 覆盖)。 */
export function getProjectCollapseLimit(): number {
  return readLimit(PROJECT_LIMIT_KEY, DEFAULT_PROJECT_COLLAPSE_LIMIT);
}
