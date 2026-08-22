import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const repoRoot = path.resolve(import.meta.dirname, '../..');
const script = path.join(repoRoot, 'scripts/seed-cindy-bots-offline-demo.mts');

function seed(output, replace = false) {
  const args = ['--import', 'tsx', script, '--output', output, '--json'];
  if (replace) args.push('--replace');
  return spawnSync(process.execPath, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, FORCE_COLOR: '0' },
  });
}

test('offline Bots demo seeds a current-schema, account-free isolated profile', () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-bots-offline-demo-test-'));
  const output = path.join(parent, 'cindy-bots-offline-demo-output');
  try {
    const first = seed(output);
    assert.equal(first.status, 0, first.stderr || first.stdout);
    const result = JSON.parse(first.stdout.trim());
    assert.equal(result.bots, 3);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(output, 'app-session.json'), 'utf8')), {
      activeMode: 'local',
    });
    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(output, '.cindy-bots-offline-demo.json'), 'utf8')),
      { sandboxName: 'cindy-bots-offline-demo', formatVersion: 1 },
    );
    assert.equal(fs.readFileSync(path.join(output, 'keychain-identity'), 'utf8'), 'CindyDev\n');
    assert.equal(fs.existsSync(path.join(output, 'safe-storage')), false);

    const dbPath = path.join(output, 'cindy-local-v1.db');
    const db = new Database(dbPath, { readonly: true });
    try {
      assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
      assert.equal(db.prepare('PRAGMA integrity_check').pluck().get(), 'ok');
      assert.equal(db.prepare('SELECT COUNT(*) FROM bot_profiles').pluck().get(), 3);
      assert.deepEqual(
        db.prepare('SELECT status FROM bot_delivery_outbox ORDER BY status').pluck().all(),
        ['dead-letter', 'delivered', 'failed'],
      );
      assert.deepEqual(
        db.prepare('SELECT status FROM bot_inbox_items ORDER BY status').pluck().all(),
        ['failed', 'handled', 'pending'],
      );
      assert.equal(
        db.prepare("SELECT status FROM bot_profiles WHERE id='demo-assistant-bot'").pluck().get(),
        'paused',
      );
      assert.equal(
        db.prepare("SELECT status FROM bot_profiles WHERE id='demo-pr-steward-bot'").pluck().get(),
        'error',
      );
      assert.equal(
        db.prepare("SELECT COUNT(*) FROM bot_session_links WHERE role='history'").pluck().get(),
        1,
      );
      const rule = JSON.parse(
        db.prepare(
          "SELECT rule_json FROM bot_event_subscriptions WHERE id='bot-control-events:demo-control-bot'",
        ).pluck().get(),
      );
      assert.equal(rule.activationMode, 'inbox-only');
      const maxMigration = Math.max(
        ...fs.readdirSync(path.join(repoRoot, 'apps/desktop/drizzle'))
          .filter((name) => /^\d{4}_.+\.sql$/.test(name))
          .map((name) => Number(name.slice(0, 4))),
      );
      assert.equal(
        Number(db.prepare("SELECT value FROM migration_meta WHERE key='schema_version'").pluck().get()),
        maxMigration,
      );
    } finally {
      db.close();
    }

    const withoutReplace = seed(output);
    assert.notEqual(withoutReplace.status, 0);
    assert.match(withoutReplace.stderr, /--replace/);

    fs.writeFileSync(path.join(output, 'stale-demo-file'), 'stale');
    const replaced = seed(output, true);
    assert.equal(replaced.status, 0, replaced.stderr || replaced.stdout);
    assert.equal(fs.existsSync(path.join(output, 'stale-demo-file')), false);
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test('offline Bots demo refuses to replace a directory it does not own', () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-bots-offline-demo-guard-'));
  const output = path.join(parent, 'unrelated-existing-directory');
  try {
    fs.mkdirSync(output);
    fs.writeFileSync(path.join(output, 'keep-me'), 'not a Cindy demo');
    const result = seed(output, true);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /not created by this demo seeder/);
    assert.equal(fs.readFileSync(path.join(output, 'keep-me'), 'utf8'), 'not a Cindy demo');
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test('pnpm argument separator is accepted by the seed CLI', () => {
  const result = spawnSync(process.execPath, ['--import', 'tsx', script, '--', '--help'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /account-free Cindy Bots UI demo sandbox/);
});
