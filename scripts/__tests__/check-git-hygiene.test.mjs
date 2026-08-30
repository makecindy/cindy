import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MAX_BLOB_SIZE,
  classifyBinary,
  classifyPath,
  evaluateCandidate,
  formatBytes,
  parseTreeSets,
  validateAllowlist,
} from '../check-git-hygiene.mjs';

test('classifyPath rejects temporary exports, classifyBinary gates archive formats', () => {
  assert.equal(classifyPath('src/small.txt'), null);
  assert.equal(classifyPath('tmp/tool/node.exe').rule, 'temporary path');
  assert.equal(classifyPath('nested/github-result-42.json').rule, 'GitHub result export');
  assert.equal(classifyPath('review-pr1916-threads.json').rule, 'review snapshot');
  assert.equal(classifyPath('config/review-policy.json'), null);
  assert.equal(classifyPath('downloads/windows-2-logs.zip').rule, 'CI log export');
  assert.equal(classifyBinary('assets/tool.tar.gz').rule, 'unregistered binary/archive');
  assert.equal(classifyBinary('src/notes.md'), null);
});

test('tmp/ is rejected at any path segment, not just the repo root', () => {
  assert.equal(classifyPath('tmp/node.exe').rule, 'temporary path');
  assert.equal(classifyPath('apps/desktop/tmp/node.exe').rule, 'temporary path');
  assert.equal(classifyPath('packages/foo/tmp/github-result-1.json').rule, 'temporary path');
  assert.equal(classifyPath('foo/tmp').rule, 'temporary path');
  assert.equal(classifyPath('dist/my-tmp/x.js'), null);
  assert.equal(classifyPath('footmp/x.js'), null);
});

test('large blobs fail independently of extension and exact allowlist entries pass', () => {
  const candidate = {
    commit: 'a'.repeat(40),
    path: 'assets/model.bin',
    blob: 'b'.repeat(40),
    size: MAX_BLOB_SIZE + 1,
    isNewPath: true,
    isNewBlob: true,
  };
  assert.equal(evaluateCandidate(candidate, []).reasons[0].rule, 'large blob');
  assert.equal(
    evaluateCandidate(candidate, [
      { path: candidate.path, blob: candidate.blob, reason: 'Reviewed asset.' },
    ]),
    null
  );
  assert.ok(formatBytes(MAX_BLOB_SIZE).includes('50.0 MiB'));
});

test('temporary and review artifacts cannot be allowlisted', () => {
  const candidate = {
    commit: 'a'.repeat(40),
    path: 'tmp/review-pr123.json',
    blob: 'b'.repeat(40),
    size: 10,
    isNewPath: true,
    isNewBlob: true,
  };
  const failure = evaluateCandidate(candidate, [
    { path: candidate.path, blob: candidate.blob, reason: 'Must not bypass direct rejects.' },
  ]);
  assert.equal(failure.reasons[0].rule, 'temporary path');
});

test('a binary already present in the base is not flagged when only its path moves', () => {
  // rename 一个 base 里已有的二进制到新路径：没有新对象入库，isNewBlob=false，
  // 二进制规则不应触发；而 tmp/ 之外的普通新路径也不触发临时产物规则。
  const renamed = {
    commit: 'a'.repeat(40),
    path: 'assets/renamed.zip',
    blob: 'b'.repeat(40),
    size: 10,
    isNewPath: true,
    isNewBlob: false,
  };
  assert.equal(evaluateCandidate(renamed, []), null);
});

test('an existing path that turns large only fails when it introduces a new blob', () => {
  const existingPathNewBlob = {
    commit: 'a'.repeat(40),
    path: 'assets/model.bin',
    blob: 'b'.repeat(40),
    size: MAX_BLOB_SIZE + 1,
    isNewPath: false,
    isNewBlob: true,
  };
  assert.equal(evaluateCandidate(existingPathNewBlob, []).reasons[0].rule, 'large blob');

  const untouchedBaseBlob = {
    commit: 'a'.repeat(40),
    path: 'assets/model.bin',
    blob: 'b'.repeat(40),
    size: MAX_BLOB_SIZE + 1,
    isNewPath: false,
    isNewBlob: false,
  };
  assert.equal(evaluateCandidate(untouchedBaseBlob, []), null);
});

test('parseTreeSets records gitlink paths but not their commit SHA as blobs', () => {
  const stdout = [
    `100644 blob ${'a'.repeat(40)}\tapps/x.ts`,
    `160000 commit ${'b'.repeat(40)}\ttmp/embedded-repo`,
    `040000 tree ${'c'.repeat(40)}\tsubdir`,
  ].join('\0');
  const { blobs, paths } = parseTreeSets(stdout);
  assert.ok(paths.has('apps/x.ts'));
  assert.ok(paths.has('tmp/embedded-repo'), 'gitlink path must be recorded');
  assert.ok(blobs.has('a'.repeat(40)));
  assert.ok(!blobs.has('b'.repeat(40)), 'gitlink commit SHA is not a blob');
  assert.ok(!paths.has('subdir'), 'tree entries are not paths');
});

test('allowlist requires exact path, full object id, and documented reason', () => {
  assert.deepEqual(
    validateAllowlist({
      version: 1,
      entries: [
        { path: 'assets/tool.zip', blob: 'a'.repeat(40), reason: 'Vendor input.' },
      ],
    }),
    [{ path: 'assets/tool.zip', blob: 'a'.repeat(40), reason: 'Vendor input.' }]
  );
  assert.throws(
    () =>
      validateAllowlist({
        version: 1,
        entries: [{ path: 'assets/tool.zip', blob: 'abc', reason: '' }],
      }),
    /full blob SHA/
  );
});
