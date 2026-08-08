/**
 * sessionLayoutPrefs — 跨多个 hook 共享的右侧栏 per-session 布局偏好 key 设计 + 清理工具
 *
 * **Key 设计**:布局偏好 + 一个全局 fallback 后缀
 *   - `right-sidebar-fraction:${sessionId}`          / `right-sidebar-fraction:last`
 *     ⚠️ **已废弃(B1b-1)**:右栏宽度改为全局一份、持久化在布局树(layout.v1.json),
 *     不再 per-session。这组 key 只剩迁移/清理用途:useRightSidebarResize 首次 mount
 *     把 `:last` 迁入树并清掉全部 fraction key;cleanupSessionLayoutPrefs 保留删除项
 *     只为兜底清理迁移前残留。
 *   - `rightSidebar.fileBrowser.treeWidth:${sid}`    / `rightSidebar.fileBrowser.treeWidth:last`
 *   - `rightSidebar.fileBrowser.treeCollapsed:${sid}` (无 fallback,默认展开)
 *   - `right-sidebar-collapsed:${sessionId}`         (无 fallback,折叠/展开默认 collapsed=true)
 *
 * **fallback 语义**:上面明确带 `:last` 的 per-session key 没值时回退到 `:last`,
 * `:last` 也没值才落硬编码默认。treeCollapsed 不使用 fallback。
 * 任意 session 的拖动 / setWidth / reset 都顺手把当前值镜像到 `:last`,所以新 session 总是继承"最近一次任意 session 的偏好"。
 *
 * **清理**:session 删除时由调用方 invoke `cleanupSessionLayoutPrefs(id)` 把该 id 的 key
 *   一起删掉,避免 localStorage 泄漏(`:last` 不动)。
 * 旧的无 suffix 全局 key 在 app boot 时由 `cleanupLegacyGlobalKeys()` 一次性 best-effort 清掉。
 */

/** RSB 占可用宽 fraction 的 key 前缀(per-session)。完整 key = `${PREFIX}${sessionId}`。 */
export const RSB_FRACTION_KEY_PREFIX = 'right-sidebar-fraction:';
/** 文件浏览器树宽度 key 前缀(per-session)。 */
export const RSB_TREE_WIDTH_KEY_PREFIX = 'rightSidebar.fileBrowser.treeWidth:';
/** 文件浏览器树折叠状态 key 前缀(per-session,默认展开)。 */
export const RSB_TREE_COLLAPSED_KEY_PREFIX = 'rightSidebar.fileBrowser.treeCollapsed:';
/** RSB 折叠/展开 key 前缀(per-session,已存在于 MainLayout)。 */
export const RSB_COLLAPSED_KEY_PREFIX = 'right-sidebar-collapsed:';

/** 全局 fallback 共用的后缀。语义:任意 session 拖动 / reset 后镜像到此 key,作为新 session 的初值。 */
export const LAST_USED_SUFFIX = 'last';

/** RSB fraction 的全局 fallback key。 */
export const RSB_FRACTION_LAST_KEY = `${RSB_FRACTION_KEY_PREFIX}${LAST_USED_SUFFIX}`;
/** 文件树宽度的全局 fallback key。 */
export const RSB_TREE_WIDTH_LAST_KEY = `${RSB_TREE_WIDTH_KEY_PREFIX}${LAST_USED_SUFFIX}`;

/** 旧版无 suffix 全局 key —— 已弃用,boot 时清掉避免僵尸数据混淆。 */
const LEGACY_GLOBAL_KEYS = ['right-sidebar-fraction', 'rightSidebar.fileBrowser.treeWidth'];

/**
 * 删除某个 session 的全部布局偏好 key(fraction / treeWidth / collapsed)。best-effort,失败静默吞。
 * 由 session delete 路径调用(单删 useSessionLifecycleActions + bulk 删 CCAgentSidebarUpper)。
 * `:last` 不动,因为它代表"全局上一次偏好",和单个 session 无关。
 */
export function cleanupSessionLayoutPrefs(sessionId: string): void {
  if (!sessionId) return;
  try {
    localStorage.removeItem(`${RSB_FRACTION_KEY_PREFIX}${sessionId}`);
    localStorage.removeItem(`${RSB_TREE_WIDTH_KEY_PREFIX}${sessionId}`);
    localStorage.removeItem(`${RSB_TREE_COLLAPSED_KEY_PREFIX}${sessionId}`);
    localStorage.removeItem(`${RSB_COLLAPSED_KEY_PREFIX}${sessionId}`);
  } catch {
    // localStorage 不可用(SSR / private mode 等)—— 静默
  }
}

/**
 * 一次性清掉旧版无 suffix 全局 key。MainLayout mount 时调一次即可,幂等。
 * 不做版本号 / 一次性标记位之类的开销:`removeItem` 自身就是幂等且廉价的。
 */
export function cleanupLegacyGlobalKeys(): void {
  try {
    for (const key of LEGACY_GLOBAL_KEYS) localStorage.removeItem(key);
  } catch {
    // 同上,静默
  }
}
