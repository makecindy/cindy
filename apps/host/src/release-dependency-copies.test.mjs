// Protects the dependency dedupe in scripts/build.mjs: a nested copy is removed
// only when Node would resolve the same package from an enclosing node_modules in
// the final layout, so every import keeps resolving to the same version.
// Unit tier, no I/O.
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { redundantCopies } from './release-dependency-copies.mjs';

const root = path.join('/release');
const nm = (...names) => path.join(root, ...names.flatMap(name => ['node_modules', ...name.split('/')]));

test('removes nested copies whose nearest enclosing copy is the same source, shallowest first', () => {
  const copies = new Map([
    [nm('tslib'), '/store/tslib@2'],
    [nm('a'), '/store/a'], [nm('a', 'tslib'), '/store/tslib@2'],
    [nm('a', 'b'), '/store/b'], [nm('a', 'b', 'tslib'), '/store/tslib@2'],
    [nm('@aws-sdk/core'), '/store/core@3'], [nm('a', '@aws-sdk/core'), '/store/core@3'],
  ]);
  assert.deepEqual(redundantCopies(copies, root), [nm('a', 'tslib'), nm('a', '@aws-sdk/core'), nm('a', 'b', 'tslib')]);
});

test('keeps a copy shadowed by a different version written later in the copy order', () => {
  // A -> [X@2, B]; B -> [C, X@1]; C -> X@2. B/node_modules/X@1 is copied after C, and
  // without C's own X@2, Node would resolve C's import of X to X@1.
  const copies = new Map([
    [nm('a'), '/store/a'], [nm('a', 'x'), '/store/x@2'], [nm('a', 'b'), '/store/b'],
    [nm('a', 'b', 'c'), '/store/c'], [nm('a', 'b', 'c', 'x'), '/store/x@2'],
    [nm('a', 'b', 'x'), '/store/x@1'],
  ]);
  assert.deepEqual(redundantCopies(copies, root), []);
});

test('never looks outside the release root', () => {
  const copies = new Map([[path.join('/node_modules', 'tslib'), '/store/tslib@2'], [nm('a', 'tslib'), '/store/tslib@2']]);
  assert.deepEqual(redundantCopies(copies, root), []);
});
