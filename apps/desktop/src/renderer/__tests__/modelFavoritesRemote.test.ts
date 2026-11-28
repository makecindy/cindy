import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import {
  accessHostModelFavorites,
  setModelFavoritesOwner,
  addModelFavorite,
  __resetForTest,
} from '@/state/modelFavorites';
let storage: Map<string, string>;
let fail = false;
beforeEach(() => {
  storage = new Map();
  fail = false;
  vi.stubGlobal('window', {
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => {
        if (fail) throw new Error('disk full');
        storage.set(key, value);
      },
      removeItem: (key: string) => storage.delete(key),
    },
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
  __resetForTest();
  setModelFavoritesOwner('owner');
});
afterEach(() => {
  __resetForTest();
  vi.unstubAllGlobals();
});
const item = {
  providerId: 'account',
  modelId: 'model',
  agent: 'codex' as const,
  effort: 'high' as const,
};
it('remote reads and edits use the same persisted favorites as the local desktop', () => {
  const uid = addModelFavorite(item);
  const [original] = accessHostModelFavorites('owner');
  expect(original?.uid).toBe(uid);
  accessHostModelFavorites('owner', {
    kind: 'update',
    expected: original!,
    item: { ...item, fast: true },
  });
  const saved = accessHostModelFavorites('owner')[0]!;
  expect(saved.fast).toBe(true);
  accessHostModelFavorites('owner', { kind: 'remove', expected: saved });
  expect(accessHostModelFavorites('owner')).toEqual([]);
  expect([...storage.values()].some((value) => JSON.parse(value).items?.length)).toBe(false);
});
it('two controllers add independently without replacing the table; duplicate add is idempotent', () => {
  accessHostModelFavorites('owner', { kind: 'add', item });
  accessHostModelFavorites('owner', { kind: 'add', item: { ...item, effort: 'low' } });
  accessHostModelFavorites('owner', { kind: 'add', item });
  expect(accessHostModelFavorites('owner')).toHaveLength(2);
});
// 回归：被控端按配置身份去重。fast 与 ultrafast 是两条；重复添加 ultrafast 不新增。
// 改推理档不得把已存的 ultrafast 收成普通 fast。
it('keeps ultrafast distinct from fast and does not duplicate a repeated add', () => {
  accessHostModelFavorites('owner', { kind: 'add', item: { ...item, fast: true } });
  const first = accessHostModelFavorites('owner', { kind: 'add', item: { ...item, fast: 'ultrafast' } });
  const again = accessHostModelFavorites('owner', { kind: 'add', item: { ...item, fast: 'ultrafast' } });
  expect(again.map((entry) => entry.fast)).toEqual([true, 'ultrafast']);
  expect(again.map((entry) => entry.uid)).toEqual(first.map((entry) => entry.uid));
  const ultra = again.find((entry) => entry.fast === 'ultrafast')!;
  accessHostModelFavorites('owner', {
    kind: 'update',
    expected: ultra,
    item: { ...item, effort: 'low', fast: 'ultrafast' },
  });
  expect(accessHostModelFavorites('owner').find((entry) => entry.uid === ultra.uid)).toMatchObject({
    effort: 'low',
    fast: 'ultrafast',
  });
});
it('rejects a stale edit and never resurrects a removed favorite', () => {
  const [original] = accessHostModelFavorites('owner', { kind: 'add', item });
  accessHostModelFavorites('owner', {
    kind: 'update',
    expected: original!,
    item: { ...item, effort: 'low' },
  });
  expect(() => accessHostModelFavorites('owner', { kind: 'remove', expected: original! })).toThrow(
    'changed',
  );
  const current = accessHostModelFavorites('owner')[0]!;
  accessHostModelFavorites('owner', { kind: 'remove', expected: current });
  expect(() =>
    accessHostModelFavorites('owner', { kind: 'update', expected: current, item }),
  ).toThrow('changed');
});
it('rejects wrong-owner access and failed persistence without acknowledging success', () => {
  expect(() => accessHostModelFavorites('different')).toThrow('owner');
  fail = true;
  expect(() => accessHostModelFavorites('owner', { kind: 'add', item })).toThrow('disk full');
  fail = false;
  expect(accessHostModelFavorites('owner')).toEqual([]);
});
