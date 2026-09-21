/**
 * 「我的管理」tab 的写操作权限判定。
 *
 * 背景:我的管理走 Hub 的 /users/published,会把「我所在的所有团队」的 skill 都列出来
 * (含我只是 viewer 的团队)。列表照常显示,但 viewer 对团队 skill 没有写权限——
 * 点「编辑信息 / 改可见性 / 删除」时应提前提示,而不是等保存触发 Hub 的 403。
 *
 * 角色数据来源:Hub /users/teams 一直返回每个团队的 myRole(admin/publisher/viewer),
 * 我们用 skill 的 owner 团队 slug(MarketSkill.authorId)去对它。
 */

/** 能做写操作(编辑/可见性/删除)的团队角色。 */
type ManageRole = 'admin' | 'publisher' | 'viewer';

/**
 * 判断某个「我的管理」里的 skill 是否因「我在其所属团队只是 viewer」而无写权限。
 *
 * - 个人归属(ownerType !== 'org' / 'organization')→ 永远有权,返回 false。
 * - 团队归属 → 查我在该团队(owner slug)的角色:
 *   - admin / publisher → 有权,返回 false。
 *   - viewer(含部门派生的只读身份)→ 无权,返回 true。
 *   - 角色未知(团队不在列表 / Hub 未返回 myRole)→ 不主动拦截,返回 false,
 *     交给保存时 Hub 的 403 兜底,避免误伤真实管理员。
 */
export function lacksTeamManagePermission(
  skill: { ownerType?: string; authorId: string },
  myRoleByTeamSlug: Map<string, ManageRole | undefined>,
): boolean {
  if (skill.ownerType !== 'org' && skill.ownerType !== 'organization') return false;
  const role = myRoleByTeamSlug.get(skill.authorId);
  if (role === undefined) return false;
  return role !== 'admin' && role !== 'publisher';
}
