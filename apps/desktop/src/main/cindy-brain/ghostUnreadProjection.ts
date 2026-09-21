/**
 * ghostUnreadProjection.ts — 未读角标"该不该显示"的判据(纯函数,可直测)。
 * ---------------------------------------------------------------------------
 * 账本(ghostUnreadStore)记的是**事实**:哪个意识点亮过、摘要是什么。
 * 能不能投影到界面上是另一回事,判据集中在这里,免得散落在 index.ts 的
 * 各条广播路径上各写一遍(那正是"同一规则只实现在其中一处"的老毛病)。
 *
 * 两条规则:
 *   - **停用只停投影、不删记录** —— 沉睡是"先别烦我",不是"这条我读过了";
 *     唤醒后那颗点要回来。
 *   - **能力撤了就清记录** —— 更新后身份卡不再声明 `badge` 卡槽,既有未读必须
 *     清除;权限收回了还留一颗点 = 继续兑现已撤销的能力。
 */

import type { InstalledGhost } from '../../shared/ghost.js';

/**
 * 该意识当前是否还持有未读角标能力(资格,与启用与否无关)。
 * 只看 `badge` 直接声明:它与 `notify` 是并列的两档权限,不互为前置。
 */
export function ghostDeclaresBadge(ghost: InstalledGhost | null | undefined): boolean {
  return ghost?.manifest.badge === true;
}

/** 该意识的未读现在该不该出现在界面上(资格 + 已启用)。 */
export function isGhostUnreadProjectable(ghost: InstalledGhost | null | undefined): boolean {
  return ghostDeclaresBadge(ghost) && ghost?.enabled === true;
}

/**
 * 从已装清单里挑出**能力已撤销**的未读条目(应当整条清除的那些)。
 * 停用中的意识不在结果里——它只是不投影,记录要留着。
 *
 * `rosterAuthoritative` 区分两种「空清单」,它们语义完全相反:
 *   - **false(缺省)= 还不知道**:启动早期、账号切换窗口里 manager 可能返回空表
 *     或旧表,按"全都撤销了"理解会把用户的未读整批误清。这时空表一律不动。
 *   - **true = 权威地确认过**:调用方刚做完一次完整扫描(装入 / 更新 / 卸载 /
 *     内置对账),空表就是事实。此时必须清掉孤儿记录——否则用户卸掉最后一个插件
 *     后账本里那条永远留着,同 id 重装时旧角标会凭空复活(codex review)。
 */
export function selectRevokedGhostUnreadIds(
  entries: readonly { ghostId: string }[],
  ghosts: readonly InstalledGhost[],
  rosterAuthoritative = false,
): string[] {
  if (entries.length === 0) return [];
  if (ghosts.length === 0 && !rosterAuthoritative) return [];
  const stillDeclared = new Set(
    ghosts.filter(ghostDeclaresBadge).map((ghost) => ghost.manifest.id),
  );
  return entries.map((entry) => entry.ghostId).filter((id) => !stillDeclared.has(id));
}
