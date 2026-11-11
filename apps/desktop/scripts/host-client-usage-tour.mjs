#!/usr/bin/env node
/**
 * Walk the UI fixture (`--mock`) so the IPC usage counter sees what a normal day
 * of the window calls. Pair it with CINDY_IPC_USAGE_FILE and rank the result:
 *
 *   CINDY_IPC_USAGE_FILE=/tmp/ipc-usage.json XDT_CDP_PORT=9333 \
 *     pnpm restart:desktop:remote -- --mock --isolated=host-usage
 *   node apps/desktop/scripts/host-client-usage-tour.mjs --cdp=http://127.0.0.1:9333 --profile=<sandbox userData>
 *   node scripts/host-channel-coverage.mjs --usage /tmp/ipc-usage.json
 *
 * Navigation only: never fills or submits the composer. --mock does not block
 * real model calls when the sandbox has configured providers or an account.
 * Refuses any instance that the dev registry does not list as an isolated sandbox.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');

const arg = (name) => process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const cdp = arg('cdp') ?? 'http://127.0.0.1:9333';
const profile = arg('profile');
const settle = Number(arg('settle-ms') ?? 1500);
assert.ok(profile, '--profile=<isolated sandbox userData> is required');

/** The CDP endpoint must belong to a registered isolated dev instance on that profile. */
async function assertIsolatedInstance(browser) {
  const session = await browser.newBrowserCDPSession();
  try {
    const { processInfo } = await session.send('SystemInfo.getProcessInfo');
    const main = processInfo.filter((p) => p.type === 'browser');
    assert.equal(main.length, 1, 'cannot identify the Desktop main process');
    const record = JSON.parse(await fs.readFile(path.join(profile, '.dev-instances', `${main[0].id}.json`), 'utf8'));
    assert.equal(record.isolated, true, 'connected Desktop is not isolated');
    assert.equal(record.profileKind, 'isolated-sandbox');
    assert.equal(await fs.realpath(record.userDataDir), await fs.realpath(profile), 'connected Desktop uses another profile');
  } finally {
    await session.detach();
  }
}
const SETTINGS_TABS = [
  'general', 'appearance', 'personalization', 'providers', 'shortcuts', 'storage', 'usage', 'ghosts',
  'builtin-tools', 'computer-use', 'pi-extensions', 'remote-control', 'shared-tasks', 'im-bot',
  'voice-input', 'agent-island', 'cindy-make', 'import', 'help', 'about',
];
const PAGES = ['/cc-agent/new', '/cc-agent/new-dialogue', '/cc-agent/scheduled', '/cc-agent/orca/new',
  '/bots/list', '/bots/roster', '/bots/market', '/issues', '/skillhub', '/plugins'];

const browser = await chromium.connectOverCDP(cdp);
try {
  await assertIsolatedInstance(browser);
  // Secondary windows (sidebar tabs, resource usage) carry a query flag; the main window does not.
  const pages = browser.contexts().flatMap((context) => context.pages());
  const page = pages.find((p) => /^https?:\/\/[^?#]+\/?#/.test(p.url()) || /^file:.*index\.html#/.test(p.url()));
  assert.ok(page, `no main renderer window on the CDP endpoint (${pages.map((p) => p.url()).join(', ')})`);
  await page.waitForFunction(() => Boolean(/** @type {any} */ (window).electronAPI?.localDb?.sessions), null, { timeout: 60_000 });

  const visit = async (hash) => {
    await page.evaluate((target) => { location.hash = target; }, hash);
    await page.waitForTimeout(settle);
  };
  const sessions = await page.evaluate(async () => {
    const rows = await /** @type {any} */ (window).electronAPI.localDb.sessions.list(50);
    return (Array.isArray(rows) ? rows : []).map((row) => row.id).filter(Boolean);
  });
  const visited = [];
  for (const id of sessions.slice(0, 12)) { await visit(`#/cc-agent/${id}`); visited.push(`task ${id}`); }
  for (const tab of SETTINGS_TABS) { await visit(`#/settings?tab=${tab}`); visited.push(`settings ${tab}`); }
  for (const route of PAGES) { await visit(`#${route}`); visited.push(route); }

  if (sessions[0]) { await visit(`#/cc-agent/${sessions[0]}`); visited.push('back to first task'); }
  console.log(`[host-client-usage-tour] visited ${visited.length} views (${sessions.length} fixture tasks)`);
} finally {
  await browser.close();
}
