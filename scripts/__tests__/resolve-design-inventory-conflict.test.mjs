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
  renderDefaultHumanRow,
} from '../shared/design-inventory.mjs';
import {
  inventorySubprocessEnv,
  parseCliArgs,
  resolveDesignInventoryConflict,
} from '../resolve-design-inventory-conflict.mjs';

const CLI_PATH = path.resolve('scripts/resolve-design-inventory-conflict.mjs');
const HUMAN_TABLE =
  '\n## 人工标注\n\n| ID | owner | 迁移状态 | protected | 目标道路 | 下一动作 |\n' +
  '| --- | --- | --- | --- | --- | --- |\n' +
  '| `desktop.existing` | human-owner | pilot | protected | approved route | keep exactly |\n';

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

function createMergeConflict({ manual = 'owner: base\n' } = {}) {
  const { root, inventoryPath } = createRepo();
  writeInventory(inventoryPath, manual);
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

test('allows standard default rows while preserving every existing human byte', () => {
  const { root, inventoryPath } = createMergeConflict({ manual: HUMAN_TABLE });
  resolveDesignInventoryConflict({
    cwd: root,
    mainRef: 'main',
    runInventory: (cwd, command) => {
      if (command !== 'design:inventory') return;
      const target = path.join(cwd, ...INVENTORY_REL_PATH.split('/'));
      const current = fs.readFileSync(target, 'utf8');
      fs.writeFileSync(
        target,
        current.replace(
          '| `desktop.existing` | human-owner | pilot | protected | approved route | keep exactly |',
          '| `desktop.existing` | human-owner | pilot | protected | approved route | keep exactly |\n' +
          renderDefaultHumanRow('desktop.new-surface'),
        ),
        'utf8',
      );
    },
    log: () => {},
  });

  const result = fs.readFileSync(inventoryPath, 'utf8');
  assert.match(result, /human-owner \| pilot \| protected \| approved route \| keep exactly/);
  assert.match(result, new RegExp(renderDefaultHumanRow('desktop.new-surface').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('rejects a newly added human row that is not the standard default', () => {
  const { root } = createMergeConflict({ manual: HUMAN_TABLE });
  assert.throws(
    () => resolveDesignInventoryConflict({
      cwd: root,
      mainRef: 'main',
      runInventory: (cwd, command) => {
        if (command !== 'design:inventory') return;
        const target = path.join(cwd, ...INVENTORY_REL_PATH.split('/'));
        const current = fs.readFileSync(target, 'utf8');
        fs.writeFileSync(
          target,
          current.replace(
            '| `desktop.existing` | human-owner | pilot | protected | approved route | keep exactly |',
            '| `desktop.existing` | human-owner | pilot | protected | approved route | keep exactly |\n' +
            '| `desktop.new-surface` | invented-owner | legacy | — | route | next |',
          ),
          'utf8',
        );
      },
      log: () => {},
    }),
    /非标准默认人工行/,
  );
  assert.notEqual(git(root, ['diff', '--name-only', '--diff-filter=U']), '');
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
  const { root } = createMergeConflict({ manual: HUMAN_TABLE });
  assert.throws(
    () => resolveDesignInventoryConflict({
      cwd: root,
      mainRef: 'main',
      runInventory: (cwd, command) => {
        if (command === 'design:inventory') {
          const target = path.join(cwd, ...INVENTORY_REL_PATH.split('/'));
          const current = fs.readFileSync(target, 'utf8');
          fs.writeFileSync(target, current.replace('human-owner', 'changed-owner'), 'utf8');
        }
      },
      log: () => {},
    }),
    /改写了人工维护区/,
  );
  assert.notEqual(git(root, ['diff', '--name-only', '--diff-filter=U']), '');
});

test('clears every casing of the inventory override from child commands', () => {
  const source = {
    PATH: 'test-path',
    CINDY_INVENTORY_DOC: 'first.md',
    cindy_inventory_doc: 'second.md',
  };
  assert.deepEqual(inventorySubprocessEnv(source), { PATH: 'test-path' });
  assert.deepEqual(source, {
    PATH: 'test-path',
    CINDY_INVENTORY_DOC: 'first.md',
    cindy_inventory_doc: 'second.md',
  });
});

test('CLI parser accepts only the documented main-ref form', () => {
  assert.deepEqual(parseCliArgs([]), { mainRef: 'origin/main' });
  assert.deepEqual(parseCliArgs(['--main-ref', 'upstream/main']), { mainRef: 'upstream/main' });
  for (const args of [
    ['--main-ref'],
    ['--main-ref=upstream/main'],
    ['--main-reff', 'upstream/main'],
    ['--main-ref', 'one', '--main-ref', 'two'],
    ['unexpected'],
  ]) {
    assert.throws(() => parseCliArgs(args), /用法/);
  }
});

test('CLI rejects unknown arguments before inspecting Git state', () => {
  assert.throws(
    () => execFileSync(process.execPath, [CLI_PATH, '--unknown'], {
      cwd: path.dirname(CLI_PATH),
      encoding: 'utf8',
      stdio: 'pipe',
    }),
    (error) => error.status === 1 && /用法/.test(error.stderr),
  );
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
