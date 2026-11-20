/*
 * Test value
 * - Production entry and observable result: the handler `/api/project-info/auto-icon` serves
 *   (resolveAutomaticProjectIcon, handed over by main.ts), after the startup binding bindHostProjectIconRuntime.
 *   The website request of a known project shows up in the Host outbound proxy decisions
 *   (getHostOutboundPathSnapshotFor), which only the Host outbound transport (outbound.mjs) records.
 * - Rule, and which side is right: the desktop binds its guarded fetch for these requests
 *   (projectAutomaticIcon.desktop.ts); the Host binds its own (release table section 二, item 项目自动图标的出站请求,
 *   甲, aligned). Without it the module used a transport that reads proxy environment variables only.
 * - Coverage gap: no test reached the icon fetch through the Host; the setter guard listed the setter as unbound.
 * - Minimal failing input: a project whose package.json homepage is https://203.0.113.9/ (a documentation
 *   address the guard refuses, so nothing leaves the machine) leaves no Host proxy decision for that origin.
 * - Tier: unit (node:test, in-memory SQL, a temporary profile and project; no account, network or engine).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { getTableColumns, getTableName } from 'drizzle-orm';

import { bindHostProjectIconRuntime } from './project-icon.ts';
import { getHostOutboundPathSnapshotFor } from './outbound-proxy.ts';
import { configureHostOwner } from './agent/claude-auth.mjs';
import { resolveAutomaticProjectIcon } from '../../desktop/src/main/projectAutomaticIcon.js';
import { setCurrentDbClient, clearCurrentDbClient } from '../../desktop/src/main/localDb/client/current.ts';
import { createDbClientForHandle } from '../../desktop/src/main/localDb/client/createDbClientForHandle.ts';
import { sessions, recentWorkdirs } from '../../desktop/src/main/localDb/schema.ts';
import { lifoCleanup } from './test-support/cleanup.mjs';

test('the Host fetches project icon websites through its own outbound transport', async t => {
  t = lifoCleanup(t);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-host-icon-profile-'));
  t.after(() => fs.rmSync(profile, { recursive: true, force: true }));
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-host-icon-project-')));
  t.after(() => fs.rmSync(project, { recursive: true, force: true }));
  const website = 'https://203.0.113.9/';
  fs.writeFileSync(path.join(project, 'package.json'), JSON.stringify({ name: 'icon-fixture', homepage: website }));

  configureHostOwner({ userDataDir: profile, ownerId: 'icon-owner' });
  const sqlite = new Database(':memory:');
  t.after(() => sqlite.close());
  for (const table of [sessions, recentWorkdirs]) {
    sqlite.exec(`CREATE TABLE "${getTableName(table)}" (${Object.values(getTableColumns(table))
      .map(column => `"${column.name}" ${column.getSQLType()}`).join(',')})`);
  }
  sqlite.prepare("INSERT INTO sessions(id,status,working_dir,created_at,updated_at) VALUES ('task','active',?,0,1)").run(project);
  const client = createDbClientForHandle({ db: sqlite, drizzle: drizzle(sqlite) });
  setCurrentDbClient(client, 'icon-owner');
  t.after(() => clearCurrentDbClient(client));

  bindHostProjectIconRuntime();
  const icon = await resolveAutomaticProjectIcon({ projectKey: `local:${project}` });
  assert.equal(icon.image, null, 'the refused website gives no icon');
  const decision = getHostOutboundPathSnapshotFor([website]);
  assert.ok(decision, 'the icon request went through the Host outbound transport');
  assert.equal(decision.upstream, 'https://203.0.113.9');
});
