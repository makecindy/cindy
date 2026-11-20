/**
 * 测试价值
 * - 生产入口与可观察结果:partitionBuddyRoster + assignBuddyToSet / deleteBuddySet /
 *   normalizeBuddySets。侧栏「伙伴集」把伙伴私聊行分组,用户看到的是「一个伙伴只进一个集」、
 *   删集后伙伴回到平铺区、群聊/任务/Cindy 设备行永不被收进集。
 * - Bug／规则依据:本功能的产品边界(不是群聊 / 不是项目 / 不是任务标签 / 不是权限组);
 *   docs/dev-rules/configuration-and-overrides.md §2「只存 override」。
 * - 现有覆盖缺口:buddySets.ts 是新模块,此前无任何用例;侧栏现有测试只覆盖收起 / 视图模式。
 * - 最小失败输入:两个集同时声明同一 buddyId;删掉唯一持有它的集;kind !== 'buddy' 但 id
 *   恰好等于集内 buddyId 的行。
 * - tier:unit,纯逻辑、无 DOM / 无真实等待。
 */
import { describe, expect, it } from 'vitest';
import {
  assignBuddyToSet,
  BUDDY_SET_LIMIT,
  createBuddySet,
  deleteBuddySet,
  emptyBuddySets,
  normalizeBuddySets,
  parseBuddySets,
  partitionBuddyRoster,
  reconcileBuddySetMembers,
  removeBuddyFromSet,
  serializeBuddySets,
  setBuddySetCollapsed,
  type BuddyRosterRow,
} from '../buddySets';

interface Row extends BuddyRosterRow {
  label: string;
}

const row = (id: string, kind: BuddyRosterRow['kind']): Row => ({ id, kind, label: id });

function stateWithTwoSets() {
  return normalizeBuddySets({
    version: 1,
    sets: [
      { buddySetId: 'set-a', name: 'A', buddyIds: ['bot-1'] },
      { buddySetId: 'set-b', name: 'B', buddyIds: [] },
    ],
  });
}

describe('buddy sets: a buddy belongs to at most one set', () => {
  it('moving a buddy to another set removes it from the first one', () => {
    const moved = assignBuddyToSet(stateWithTwoSets(), 'bot-1', 'set-b');
    const partition = partitionBuddyRoster([row('bot-1', 'buddy')], moved);
    expect(partition.groups[0]!.rows).toEqual([]);
    expect(partition.groups[1]!.rows.map((r) => r.id)).toEqual(['bot-1']);
    expect(partition.flat).toEqual([]);
  });

  it('normalizing a corrupt record that claims a buddy twice keeps only the first set', () => {
    const normalized = normalizeBuddySets({
      version: 1,
      sets: [
        { buddySetId: 'set-a', name: 'A', buddyIds: ['bot-1', 'bot-1'] },
        { buddySetId: 'set-b', name: 'B', buddyIds: ['bot-1', 'bot-2'] },
      ],
    });
    expect(normalized.sets[0]!.buddyIds).toEqual(['bot-1']);
    expect(normalized.sets[1]!.buddyIds).toEqual(['bot-2']);
    const partition = partitionBuddyRoster([row('bot-1', 'buddy'), row('bot-2', 'buddy')], normalized);
    expect(partition.groups[0]!.rows.map((r) => r.id)).toEqual(['bot-1']);
    expect(partition.groups[1]!.rows.map((r) => r.id)).toEqual(['bot-2']);
    expect(partition.flat).toEqual([]);
  });

  it('unassigning leaves the buddy in the flat roster', () => {
    const cleared = removeBuddyFromSet(stateWithTwoSets(), 'bot-1');
    const partition = partitionBuddyRoster([row('bot-1', 'buddy')], cleared);
    expect(partition.flat.map((r) => r.id)).toEqual(['bot-1']);
  });
});

describe('buddy sets: deleting a set returns its buddies to the flat roster', () => {
  it('keeps empty sets visible but lets their former members show as normal rows', () => {
    const afterDelete = deleteBuddySet(stateWithTwoSets(), 'set-a');
    expect(afterDelete.sets.map((s) => s.buddySetId)).toEqual(['set-b']);
    const partition = partitionBuddyRoster([row('bot-1', 'buddy'), row('bot-2', 'buddy')], afterDelete);
    expect(partition.flat.map((r) => r.id)).toEqual(['bot-1', 'bot-2']);
    expect(partition.groups.every((group) => group.rows.length === 0)).toBe(true);
  });
});

describe('buddy sets: non-buddy rows are never collected', () => {
  it('does not collect group chats, tasks or the Cindy device row even when ids collide', () => {
    // A set may contain a stale id that now belongs to a group chat or a task.
    // The `kind` guard is the product rule, not a caller convention.
    const state = normalizeBuddySets({
      version: 1,
      sets: [{ buddySetId: 'set-a', name: 'A', buddyIds: ['shared-id', 'bot-1'] }],
    });
    const rows: Row[] = [
      row('shared-id', 'group'),
      row('shared-id', 'task'),
      row('shared-id', 'device'),
      row('bot-1', 'buddy'),
    ];
    const partition = partitionBuddyRoster(rows, state);
    expect(partition.groups[0]!.rows.map((r) => r.id)).toEqual(['bot-1']);
    expect(partition.flat).toEqual(rows.slice(0, 3));
  });

  it('never mutates the input rows (a sidebar row may carry a BotProfile)', () => {
    const profile = Object.freeze({ id: 'bot-1', name: 'Cindy' });
    const frozen = Object.freeze({ id: 'bot-1', kind: 'buddy' as const, profile });
    const before = JSON.stringify(frozen);
    partitionBuddyRoster([frozen], stateWithTwoSets());
    expect(JSON.stringify(frozen)).toBe(before);
    expect(frozen.profile.name).toBe('Cindy');
  });
});

describe('buddy sets: saving one set never changes another set', () => {
  it('leaves another set\'s buddy in place when it is unchecked in this form', () => {
    const state = normalizeBuddySets({
      version: 1,
      sets: [
        { buddySetId: 'set-a', name: 'A', buddyIds: ['bot-1'] },
        { buddySetId: 'set-b', name: 'B', buddyIds: [] },
      ],
    });
    const saved = reconcileBuddySetMembers(state, 'set-b', ['bot-1', 'bot-2'], []);
    expect(saved.sets[0]!.buddyIds).toEqual(['bot-1']);
    expect(saved.sets[1]!.buddyIds).toEqual([]);
    expect(partitionBuddyRoster([row('bot-1', 'buddy')], saved).groups[0]!.rows).toHaveLength(1);
  });

  it('moves a selected buddy out of its previous set without clearing the rest', () => {
    const state = normalizeBuddySets({
      version: 1,
      sets: [{ buddySetId: 'set-a', name: 'A', buddyIds: ['bot-1', 'bot-2'] }],
    });
    const withB = createBuddySet(state, 'set-b', 'B');
    const saved = reconcileBuddySetMembers(withB, 'set-b', ['bot-1', 'bot-2'], ['bot-1']);
    expect(saved.sets[0]!.buddyIds).toEqual(['bot-2']);
    expect(saved.sets[1]!.buddyIds).toEqual(['bot-1']);
  });

  it('keeps buddies that are not shown in the form (an offline companion)', () => {
    const state = normalizeBuddySets({
      version: 1,
      sets: [{ buddySetId: 'set-a', name: 'A', buddyIds: ['bot-1', 'offline'] }],
    });
    const saved = reconcileBuddySetMembers(state, 'set-a', ['bot-1'], ['bot-1']);
    expect(saved.sets[0]!.buddyIds).toEqual(['offline', 'bot-1']);
  });

  it('is a no-op when the target set does not exist (a refused create)', () => {
    const state = normalizeBuddySets({
      version: 1,
      sets: [{ buddySetId: 'set-a', name: 'A', buddyIds: ['bot-1'] }],
    });
    expect(reconcileBuddySetMembers(state, 'missing', ['bot-1'], ['bot-1'])).toBe(state);
  });

  it('refuses to create beyond the set limit without editing an existing set', () => {
    let state = emptyBuddySets();
    for (let i = 0; i < BUDDY_SET_LIMIT; i++) state = createBuddySet(state, `set-${i}`, `Set ${i}`);
    state = normalizeBuddySets({ version: 1, sets: state.sets.map((s, i) => i === 0 ? { ...s, buddyIds: ['bot-1'] } : s) });
    const refused = createBuddySet(state, 'one-too-many', 'Overflow');
    expect(refused).toBe(state);
    expect(reconcileBuddySetMembers(refused, 'one-too-many', ['bot-1'], ['bot-1'])).toBe(state);
    expect(refused.sets[0]!.buddyIds).toEqual(['bot-1']);
  });
});

describe('buddy sets: persisted override only', () => {
  it('reads a missing / corrupt / empty record as the derived default', () => {
    expect(parseBuddySets(null)).toEqual(emptyBuddySets());
    expect(parseBuddySets('')).toEqual(emptyBuddySets());
    expect(parseBuddySets('{broken')).toEqual(emptyBuddySets());
    expect(serializeBuddySets(emptyBuddySets())).toBe('');
  });

  it('omits default fields but round-trips an explicit fold', () => {
    const created = createBuddySet(emptyBuddySets(), 'set-a', '  A  ');
    expect(created.sets[0]!.name).toBe('A');
    expect(serializeBuddySets(created)).not.toContain('collapsed');
    // An explicit choice is an override and must survive a storage round-trip.
    const collapsed = setBuddySetCollapsed(created, 'set-a', true);
    expect(parseBuddySets(serializeBuddySets(collapsed))).toEqual(collapsed);
    // Reverting to the default removes the field again (only overrides are stored).
    expect(serializeBuddySets(setBuddySetCollapsed(collapsed, 'set-a', false))).not.toContain('collapsed');
  });
});
