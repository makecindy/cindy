import { afterEach, expect, it } from 'vitest';
import {
  captureTaskTagScope,
  emitTaskTagCatalog,
  evictTaskTagCatalog,
  readTaskTagCatalog,
  resetTaskTagCatalogCache,
} from '../taskTagEvents';
import { setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
const tag = { id: 'work', name: 'Work', color: 'blue' as const, favoriteOrder: null, revision: 1 };
afterEach(resetTaskTagCatalogCache);
it('keeps the later-started accepted snapshot when requests complete out of order', () => {
  const old = captureTaskTagScope('a');
  const fresh = captureTaskTagScope('a');
  fresh.store([{ ...tag, name: 'Fresh', revision: 2 }]);
  old.store([tag]);
  expect(readTaskTagCatalog('a')?.tags[0].name).toBe('Fresh');
});
it('retains full directories and push updates without a mounted panel', () => {
  emitTaskTagCatalog('a', [tag]);
  expect(readTaskTagCatalog('a')?.tags).toEqual([tag]);
  expect(readTaskTagCatalog('b')).toBeUndefined();
  expect(readTaskTagCatalog(undefined)).toBeUndefined();
  const old = captureTaskTagScope('a');
  emitTaskTagCatalog('a', [{ ...tag, name: 'Latest' }]);
  old.store([tag]);
  expect(readTaskTagCatalog('a')?.tags[0].name).toBe('Latest');
});
it('rejects late replies across owner generations and device revocation', () => {
  setDataOwnerGeneration('owner-a', 1);
  const a = captureTaskTagScope('a');
  const b = captureTaskTagScope('b');
  evictTaskTagCatalog('a');
  a.store([tag]);
  b.store([tag]);
  expect(a.current()).toBe(false);
  expect(readTaskTagCatalog('a')).toBeUndefined();
  expect(readTaskTagCatalog('b')?.tags).toEqual([tag]);
  setDataOwnerGeneration('owner-b', 2);
  b.store([tag]);
  expect(b.current()).toBe(false);
  expect(readTaskTagCatalog('b')).toBeUndefined();
  setDataOwnerGeneration('owner-a', 3);
  expect(readTaskTagCatalog('b')).toBeUndefined();
});
