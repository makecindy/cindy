/**
 * 把「我的发布」列表按归属(ownership)分组,供 SkillHub Market mine tab 的
 * 分组视图(方案 C)使用。
 * - ownerType === 'org' / 'organization' → 团队组,key = owner.slug(authorId),label = 团队名(authorName)
 * - 其它(personal / user / 缺省)→ 个人组
 * 只对实际有 item 的 owner 建组(空组天然不出现);个人组排在最前。
 */
export interface MineOwnerGroup<T> {
  /** 'personal' 或团队 slug,用作 React key 与「归属」下拉的值。 */
  key: string;
  /** 团队组的显示名(团队名);个人组为空串,UI 用 i18n 文案。 */
  label: string;
  isPersonal: boolean;
  skills: T[];
}

export function groupMineByOwner<T extends {
  ownerType?: string;
  authorId: string;
  authorName: string;
}>(items: T[]): MineOwnerGroup<T>[] {
  const personal: T[] = [];
  const teams = new Map<string, { name: string; skills: T[] }>();
  for (const it of items) {
    if (it.ownerType === 'org' || it.ownerType === 'organization') {
      const g = teams.get(it.authorId) ?? { name: it.authorName, skills: [] };
      g.skills.push(it);
      teams.set(it.authorId, g);
    } else {
      personal.push(it);
    }
  }
  const groups: MineOwnerGroup<T>[] = [];
  if (personal.length > 0) {
    groups.push({ key: 'personal', label: '', isPersonal: true, skills: personal });
  }
  for (const [slug, g] of teams) {
    groups.push({ key: slug, label: g.name, isPersonal: false, skills: g.skills });
  }
  return groups;
}
