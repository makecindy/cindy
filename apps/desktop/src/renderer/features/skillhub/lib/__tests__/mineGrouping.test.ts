import { describe, expect, it } from 'vitest';

import { groupMineByOwner } from '../mineGrouping';

const s = (name: string, ownerType: string, authorId: string, authorName: string) =>
  ({ name, ownerType, authorId, authorName } as never);

describe('groupMineByOwner', () => {
  it('个人组在前,团队按 owner 分组,只对有 item 的 owner 建组', () => {
    const groups = groupMineByOwner([
      s('a', 'org', 'team-design', 'Design'),
      s('b', 'personal', 'u_me', 'Me'),
      s('c', 'org', 'team-design', 'Design'),
      s('d', 'org', 'team-mkt', 'Marketing'),
    ]);
    expect(groups.map((g) => g.key)).toEqual(['personal', 'team-design', 'team-mkt']);
    expect(groups[0].isPersonal).toBe(true);
    expect(groups[1]).toMatchObject({ label: 'Design', isPersonal: false });
    expect(groups[1].skills.map((x: { name: string }) => x.name)).toEqual(['a', 'c']);
  });

  it('没有个人 item 时不出现个人组(空组不显示)', () => {
    const groups = groupMineByOwner([
      s('a', 'org', 't1', 'T1'),
      s('b', 'organization', 't1', 'T1'),
    ]);
    expect(groups.map((g) => g.key)).toEqual(['t1']);
    expect(groups[0].skills.map((x: { name: string }) => x.name)).toEqual(['a', 'b']);
  });

  it("ownerType 非 'org'/'organization'(user / personal / 缺省)都归个人组", () => {
    const groups = groupMineByOwner([s('a', 'user', 'u', 'U'), s('b', '', 'u2', 'U2')]);
    expect(groups).toHaveLength(1);
    expect(groups[0].isPersonal).toBe(true);
    expect(groups[0].skills).toHaveLength(2);
  });

  it('空列表返回空分组', () => {
    expect(groupMineByOwner([])).toEqual([]);
  });
});
