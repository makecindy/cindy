import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  GENERATED_BEGIN,
  GENERATED_END,
  INVENTORY_REL_PATH,
} from '../shared/design-inventory.mjs';
import {
  resolveDesignInventoryConflict,
} from '../resolve-design-inventory-conflict.mjs';

function git(cwd, args, options = {}) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', ...options }).trim();
}

function createRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-design-conflict-'));
  git(root, ['init', '-q']);
  git(root, ['config', 'user.name', 'Test User']);
  git(root, ['config', 'user.email', 'test@example.com']);
  const inventoryPath = path.join(root, ...INVENTORY_REL_PATH.split('/'));
  fs.mkdirSync(path.dirname(inventoryPath), { recursive: true });
  return { root, inventoryPath };
}

function writeInventory(inventoryPath, manual = 'owner: base\n') {
  fs.writeFileSync(
    inventoryPath,
    `# Inventory\n${GENERATED_BEGIN}\n\nbase facts\n${GENERATED_END}\n${manual}`,
    'utf8',
  );
}

function commitAll(root, message) {
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', message]);
  return git(root, ['rev-parse', 'HEAD']);
}

function createMergeConflict() {
  const { root, inventoryPath } = createRepo();
  writeInventory(inventoryPath);
  const base = commitAll(root, 'base');
  git(root, ['switch', '-q', '-c', 'main']);
  fs.writeFileSync(inventoryPath, fs.readFileSync(inventoryPath, 'utf8').replace('base facts', 'main facts'), 'utf8');
  const main = commitAll(root, 'main inventory');
  git(root, ['switch', '-q', '--detach', base]);
  fs.writeFileSync(inventoryPath, fs.readFileSync(inventoryPath, 'utf8').replace('base facts', 'feature facts'), 'utf8');
  commitAll(root, 'feature inventory');
  try {
    execFileSync('git', ['merge', '--no-commit', 'main'], { cwd: root, stdio: 'ignore' });
  } catch {
    // Expected: the fixture deliberately creates a conflict.
  }
  return { root, inventoryPath, main };
}

function createCleanMerge() {
  const { root, inventoryPath } = createRepo();
  writeInventory(inventoryPath);
  const base = commitAll(root, 'base');
  git(root, ['switch', '-q', '-c', 'main']);
  fs.writeFileSync(path.join(root, 'main-only.txt'), 'main\n', 'utf8');
  commitAll(root, 'main-only change');
  git(root, ['switch', '-q', '--detach', base]);
  fs.writeFileSync(path.join(root, 'feature-only.txt'), 'feature\n', 'utf8');
  commitAll(root, 'feature-only change');
  try {
    execFileSync('git', ['merge', '--no-commit', 'main'], { cwd: root, stdio: 'ignore' });
  } catch {
    assert.fail('clean merge fixture unexpectedly conflicted');
  }
  return { root, inventoryPath };
}

test('resolves only the inventory conflict and preserves the manual section', () => {
  const { root, inventoryPath, main } = createMergeConflict();
  const commands = [];
  const result = resolveDesignInventoryConflict({
    cwd: root,
    mainRef: 'main',
    runInventory: (cwd, command) => {
      commands.push(command);
      if (command === 'design:inventory') {
        const current = fs.readFileSync(path.join(cwd, ...INVENTORY_REL_PATH.split('/')), 'utf8');
        fs.writeFileSync(path.join(cwd, ...INVENTORY_REL_PATH.split('/')), current.replace('main facts', 'generated facts'), 'utf8');
      }
    },
    log: () => {},
  });
  assert.equal(result.status, 'resolved');
  assert.deepEqual(commands, ['design:inventory', 'check:design-inventory']);
  assert.match(fs.readFileSync(inventoryPath, 'utf8'), /generated facts/);
  assert.match(fs.readFileSync(inventoryPath, 'utf8'), /owner: base/);
  assert.equal(git(root, ['diff', '--name-only', '--diff-filter=U']), '');
  assert.equal(git(root, ['rev-parse', 'MERGE_HEAD']), main);
});

test('does not modify an ordinary clean worktree', () => {
  const { root, inventoryPath } = createRepo();
  writeInventory(inventoryPath);
  commitAll(root, 'base');
  const before = fs.readFileSync(inventoryPath, 'utf8');
  const result = resolveDesignInventoryConflict({ cwd: root, runInventory: () => { throw new Error('must not run'); }, log: () => {} });
  assert.deepEqual(result, { status: 'noop', reason: 'no-merge' });
  assert.equal(fs.readFileSync(inventoryPath, 'utf8'), before);
});

test('reports an active merge with no inventory conflict without running commands', () => {
  const { root, inventoryPath } = createCleanMerge();
  const before = fs.readFileSync(inventoryPath, 'utf8');
  const result = resolveDesignInventoryConflict({ cwd: root, runInventory: () => { throw new Error('must not run'); }, log: () => {} });
  assert.deepEqual(result, { status: 'noop', reason: 'no-unresolved-paths' });
  assert.equal(fs.readFileSync(inventoryPath, 'utf8'), before);
});

test('rejects a merge with another unresolved file', () => {
  const { root, inventoryPath } = createRepo();
  writeInventory(inventoryPath);
  const base = commitAll(root, 'base');
  git(root, ['switch', '-q', '-c', 'main']);
  fs.writeFileSync(inventoryPath, fs.readFileSync(inventoryPath, 'utf8').replace('base facts', 'main facts'), 'utf8');
  fs.writeFileSync(path.join(root, 'other.txt'), 'main\n', 'utf8');
  commitAll(root, 'main changes');
  git(root, ['switch', '-q', '--detach', base]);
  fs.writeFileSync(inventoryPath, fs.readFileSync(inventoryPath, 'utf8').replace('base facts', 'feature facts'), 'utf8');
  fs.writeFileSync(path.join(root, 'other.txt'), 'feature\n', 'utf8');
  commitAll(root, 'feature changes');
  try {
    execFileSync('git', ['merge', '--no-commit', 'main'], { cwd: root, stdio: 'ignore' });
  } catch {
    // Expected: the fixture deliberately creates conflicts.
  }
  assert.throws(
    () => resolveDesignInventoryConflict({ cwd: root, mainRef: 'main', runInventory: () => {}, log: () => {} }),
    /存在其他未解决文件/,
  );
});

test('rejects when the explicit main ref is not MERGE_HEAD', () => {
  const { root } = createMergeConflict();
  assert.throws(
    () => resolveDesignInventoryConflict({ cwd: root, mainRef: 'HEAD', runInventory: () => {}, log: () => {} }),
    /MERGE_HEAD.*main ref.*不一致/,
  );
});

test('preserves the failure scene when generation changes the manual section', () => {
  const { root } = createMergeConflict();
  assert.throws(
    () => resolveDesignInventoryConflict({
      cwd: root,
      mainRef: 'main',
      runInventory: (cwd, command) => {
        if (command === 'design:inventory') {
          const target = path.join(cwd, ...INVENTORY_REL_PATH.split('/'));
          fs.appendFileSync(target, 'owner: changed\n');
        }
      },
      log: () => {},
    }),
    /改写了人工维护区/,
  );
  assert.notEqual(git(root, ['diff', '--name-only', '--diff-filter=U']), '');
});

test('preserves the failure scene when generation or validation fails', () => {
  for (const failingCommand of ['design:inventory', 'check:design-inventory']) {
    const { root } = createMergeConflict();
    assert.throws(
      () => resolveDesignInventoryConflict({
        cwd: root,
        mainRef: 'main',
        runInventory: (_cwd, command) => {
          if (command === failingCommand) throw new Error(`${command} failed`);
        },
        log: () => {},
      }),
      new RegExp(`${failingCommand} failed`),
    );
    assert.notEqual(git(root, ['diff', '--name-only', '--diff-filter=U']), '');
  }
});
