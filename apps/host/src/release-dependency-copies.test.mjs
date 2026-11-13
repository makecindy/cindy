// Protects the dependency dedupe in scripts/build.mjs: a nested copy is skipped
// only when Node would already resolve the same package from an enclosing
// node_modules, so imports keep resolving to the same versions. Unit tier, no I/O.
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { resolvesToExistingCopy } from './release-dependency-copies.mjs';

const root = path.join('/release');
const nm = (...names) => path.join(root, ...names.flatMap(name => ['node_modules', name]));

test('reuses the nearest enclosing copy of the same source', () => {
  const copies = new Map([[nm('tslib'), '/store/tslib@2']]);
  assert.equal(resolvesToExistingCopy(copies, { root, parent: nm('a', 'b'), name: 'tslib', source: '/store/tslib@2' }), true);
});

test('copies locally when a different version is nearer or nothing is resolvable', () => {
  const copies = new Map([[nm('tslib'), '/store/tslib@2'], [nm('a', 'tslib'), '/store/tslib@1']]);
  // a/node_modules/tslib@1 shadows the root tslib@2 for everything under a.
  assert.equal(resolvesToExistingCopy(copies, { root, parent: nm('a', 'b'), name: 'tslib', source: '/store/tslib@2' }), false);
  assert.equal(resolvesToExistingCopy(new Map(), { root, parent: nm('a'), name: 'tslib', source: '/store/tslib@2' }), false);
});

test('never looks outside the release root', () => {
  const outside = new Map([[path.join('/node_modules', 'tslib'), '/store/tslib@2']]);
  assert.equal(resolvesToExistingCopy(outside, { root, parent: nm('a'), name: 'tslib', source: '/store/tslib@2' }), false);
});
