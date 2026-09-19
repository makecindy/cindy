import { describe, expect, it } from 'vitest';
import {
  normalizeTaskTags,
  reconcileTaskTags,
  taskTagEditRevision,
  taskTagNameKey,
  TASK_TAG_PRESETS,
  type TaskTag,
} from './taskTags';
const tag = (
  id: string,
  color: TaskTag['color'] = 'red',
  favoriteOrder: number | null = null,
): TaskTag => ({ id, name: id, color, favoriteOrder, revision: 1 });

it('keeps default names localized after recoloring without translating custom names', () => {
  for (const color of ['red', 'orange', 'yellow', 'green', 'blue', 'purple', 'gray']) {
    const original = {
      ...tag(`default:${color}`, 'white'),
      name: color[0].toUpperCase() + color.slice(1),
    };
    expect(taskTagNameKey(original)).toBe(`taskTags.${color}`);
    expect(taskTagNameKey({ ...original, name: 'My label' })).toBeNull();
    expect(taskTagNameKey({ ...original, id: 'custom' })).toBeNull();
  }
  for (const preset of TASK_TAG_PRESETS) {
    expect(taskTagNameKey({ ...tag(preset.id, 'blue'), name: preset.name })).toBe(
      `taskTags.${preset.key}`,
    );
  }
});

it('advances edit revisions only while the editable baseline remains unchanged', () => {
  const editing = { ...tag('a'), revision: 3 };
  expect(taskTagEditRevision(editing, [{ ...editing, revision: 5, sortOrder: 2 }])).toBe(5);
  expect(taskTagEditRevision(editing, [{ ...editing, revision: 2 }])).toBe(3);
  expect(taskTagEditRevision(editing, [{ ...editing, revision: 5, name: 'Other' }])).toBe(3);
  expect(taskTagEditRevision(editing, [{ ...editing, revision: 5, color: 'blue' }])).toBe(3);
  expect(taskTagEditRevision(editing, [])).toBe(3);
});
describe('task tag wire and cache projection', () => {
  it('rejects invalid colors and caps malformed cache growth', () => {
    expect(normalizeTaskTags([tag('a'), { ...tag('b'), color: 'url(secret)' }, null])).toEqual([
      tag('a'),
    ]);
    expect(normalizeTaskTags(Array.from({ length: 40 }, (_, i) => tag(String(i))))).toHaveLength(
      32,
    );
  });
  it('preserves membership while applying global rename/recolor/delete with stable ordering', () => {
    const catalog = [tag('b', 'blue', 1), { ...tag('a', 'none', 0), name: 'Renamed' }, tag('new')];
    expect(reconcileTaskTags([tag('deleted'), tag('a'), tag('b')], catalog)).toEqual([
      catalog[1],
      catalog[0],
    ]);
    expect(normalizeTaskTags([...catalog].reverse())).toEqual([catalog[1], catalog[0], catalog[2]]);
  });
});

it('uses persisted positions before names and matches SQLite legacy unicode ordering', () => {
  const a = { ...tag('a'), sortOrder: 2 };
  const b = { ...tag('b'), sortOrder: 0 };
  expect(normalizeTaskTags([a, b]).map((t) => t.id)).toEqual(['b', 'a']);
  expect(normalizeTaskTags([tag('😀'), tag('\ue000')]).map((t) => t.id)).toEqual(['\ue000', '😀']);
});
