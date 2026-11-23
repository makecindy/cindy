// Desktop E2E: real renderer, settings IPC, local persistence and title dispatcher.
// With this checkout’s Desktop Dev renderer running (pnpm dev:desktop:remote):
//   node apps/desktop/scripts/auxiliary-model.e2e.mjs
// Launches its own Electron against the compiled Dev entry, with an empty HOME,
// a unique local profile and mock keychain. Never attaches to an existing app.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { _electron as electron } from 'playwright-core';

const desktop = fileURLToPath(new URL('../', import.meta.url));
await access(path.join(desktop, '.vite/build/index.js'));
const runDir = await mkdtemp(path.join(tmpdir(), 'cindy-auxiliary-profile-'));
const out = await mkdtemp(path.join(tmpdir(), 'cindy-auxiliary-preview-'));
const home = path.join(runDir, 'home');
await mkdir(home);
const primary = 'fixture-primary';
const backup = 'fixture-backup';
const key = 'fixture-local-only';
const detail = 'Insufficient balance.\nContact your provider.';
const requests = [];
const replies = new Map([[primary, 'success'], [backup, 'success']]);
const server = createServer(async (req, res) => {
  const json = (status, value) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value));
  if (req.method !== 'POST' || req.url !== '/v1/chat/completions' || req.headers.authorization !== 'Bearer ' + key || req.headers.origin) return json(403, {});
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 65536) return json(413, {});
  }
  let model;
  try { model = JSON.parse(raw)?.model; } catch { return json(400, {}); }
  if (!replies.has(model)) return json(404, {});
  const mode = replies.get(model);
  requests.push({ model, mode });
  if (mode === 'denied') return json(402, { error: { message: detail } });
  if (mode === 'usage') return json(200, { usage: { completion_tokens: 3 } });
  return json(200, { choices: [{ message: { role: 'assistant', content: mode === 'empty' ? '' : 'Desk organization' }, finish_reason: 'stop' }] });
});

let app;
let ownedProfile;
const providerId = 'aux-e2e-' + randomUUID().slice(0, 8);
const sessionId = randomUUID();
let page;
try {
  const name = 'aux-e2e-' + randomUUID().slice(0, 8);
  app = await electron.launch({
    executablePath: createRequire(import.meta.url)('electron'),
    args: [desktop, '--use-mock-keychain', '--isolated=' + name, '--passive', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost'],
    cwd: desktop,
    env: { HOME: home, USERPROFILE: home, PATH: process.env.PATH, TMPDIR: runDir,
      LANG: 'zh_CN.UTF-8', XDT_ISOLATED: '1', XDT_ISOLATED_NAME: name,
      XDT_SCHEDULER_PASSIVE: '1', XDT_DISABLE_MODELS_FETCH: '1', XDT_CDP_PORT: '0' },
  });
  page = await app.firstWindow();
  page.setDefaultTimeout(20_000);
  const profile = await realpath(await app.evaluate(({ app }) => app.getPath('userData')));
  const appData = await realpath(await app.evaluate(({ app }) => app.getPath('appData')));
  assert.equal(path.dirname(profile), appData);
  assert.ok(['Cindy', 'CindyGlobal'].some(product => path.basename(profile) === product + '-dev2-' + name));
  ownedProfile = profile;
  await page.waitForFunction(() => !!window.electronAPI?.authInitialize);
  await page.waitForFunction(async () => {
    const a = window.electronAPI;
    let auth = await a.authInitialize();
    if (auth.mode === 'signed-out') auth = await a.authEnterLocal();
    if (auth.mode !== 'local' || auth.isAuthenticated || auth.dataOwnerId !== 'local-v1') return false;
    return (await a.localDb.ensureReady(auth.dataOwnerId)).ready;
  }, undefined, { timeout: 60_000, polling: 1000 });
  const settings = () => page.evaluate(() => window.electronAPI.maker.auxiliaryModelSettingsGet());
  const startupDeadline = Date.now() + 90_000;
  for (;;) {
    try { await settings(); break; }
    catch (error) {
      if (!String(error).includes('No handler registered') || Date.now() >= startupDeadline) throw error;
      await delay(500);
    }
  }
  assert.deepEqual((await settings()).models, [], 'Start with automatic auxiliary models');
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const result = await page.evaluate(({ providerId, primary, backup, key, port }) => window.electronAPI.maker.createCustomProvider({
    id: providerId, name: 'Auxiliary E2E', auth: { method: 'apiKey' },
    runtimes: { codex: { baseUrl: 'http://127.0.0.1:' + port + '/v1', wireProtocol: 'openai-chat',
      models: [primary, backup].map(id => ({ id, name: id, contextWindow: 32768, maxOutput: 256, defaultEnabled: true })) } },
  }, { codex: key }), { providerId, primary, backup, key, port: server.address().port });
  assert.ok(result.ok);
  await page.evaluate(async ({ sessionId, out, primary, providerId }) => {
    await window.electronAPI.localDb.sessions.create({ id: sessionId, title: 'Desk organization', workingDir: out, workspaceKind: 'dialogue', agentKind: 'codex', model: primary, providerId, permissionMode: 'ask' });
    location.hash = '#/cc-agent/' + sessionId;
  }, { sessionId, out, primary, providerId });
  const locale = await page.evaluate(() => document.documentElement.lang || navigator.language);
  const translations = JSON.parse(await readFile(new URL('../src/renderer/i18n/locales/' + (locale.startsWith('en') ? 'en' : locale) + '/common.json', import.meta.url), 'utf8'));
  const notice = translations.settings.auxiliaryModels.notice;
  const options = (await settings()).options;
  const pins = [primary, backup].map(id => options.find(o => o.providerId === providerId && o.modelId === id && o.available)?.id);
  assert.ok(pins.every(Boolean));
  const save = models => page.evaluate(models => window.electronAPI.maker.auxiliaryModelSettingsSet({ models }), models);
  const title = () => page.evaluate(id => window.electronAPI.maker.generateTitle('Organize the desk', 'pi', id), sessionId);
  const health = () => page.evaluate(id => window.electronAPI.maker.auxiliaryModelRouteHealthGet(id), sessionId);
  const notices = () => page.evaluate(() => window.auxiliaryE2ENotices);
  await page.evaluate(() => {
    window.auxiliaryE2ENotices = 0;
    window.electronAPI.maker.onAuxiliaryModelHealthChanged(event => {
      if (event.notify) window.auxiliaryE2ENotices++;
    });
  });
  assert.equal((await title()).title, null); // Local-only profile: no Cindy AI plan or session-agent fallback.
  assert.deepEqual(await health(), []);
  assert.equal(await notices(), 0);

  assert.deepEqual((await save([pins[0]])).models, [pins[0]]);
  for (const mode of ['usage', 'empty']) {
    replies.set(backup, mode);
    const failed = await save(pins);
    assert.equal(failed.ok, false);
    assert.equal(failed.model, pins[1]);
    assert.deepEqual((await settings()).models, [pins[0]]);
  }
  await page.evaluate(() => { location.hash = '#/settings?tab=personalization&section=personalization.auxiliaryModels'; });
  await page.locator('[data-setting-id="settings.auxiliaryModels.fallback1.label"]').click();
  const option = page.getByRole('option', { name: new RegExp(backup) });
  await page.getByRole('textbox', { name: translations.newChat.modelSelector.search.placeholderAll, exact: true }).fill(backup);
  await option.click();
  const action = page.locator('[data-settings-search-action="Test and save the selected auxiliary models"]');
  replies.set(backup, 'denied');
  await action.click();
  const failure = page.locator('[data-auxiliary-save-feedback="failed"]');
  await failure.waitFor();
  assert.ok((await failure.innerText()).includes(backup));
  assert.ok((await failure.innerText()).includes('HTTP 402'));
  assert.ok((await failure.textContent()).includes(detail));
  assert.deepEqual((await settings()).models, [pins[0]]);
  await failure.screenshot({ path: path.join(out, 'save-failure.png') });
  replies.set(backup, 'success');
  const start = requests.length;
  await action.click();
  await page.locator('[data-auxiliary-save-feedback="success"]').waitFor();
  assert.deepEqual((await settings()).models, pins);
  assert.deepEqual(requests.slice(start).map(r => r.model), [primary, backup]);
  await page.evaluate(id => { location.hash = '#/cc-agent/' + id; }, sessionId);
  console.log('PASS automatic silence, failed draft preserves previous chain, both valid title probes commit');

  replies.set(primary, 'denied');
  const fallbackStart = requests.length;
  assert.equal((await title()).title, 'Desk organization');
  assert.deepEqual(requests.slice(fallbackStart), [{ model: primary, mode: 'denied' }, { model: backup, mode: 'success' }]);
  assert.deepEqual(await health(), []);
  assert.equal(await notices(), 0);
  replies.set(backup, 'denied');
  assert.equal((await title()).title, null);
  const rows = await health();
  assert.equal(rows.length, 2);
  assert.ok(rows.every(r => r.httpStatus === 402 && r.operation === 'auto-title' && r.upstreamMessage === detail));
  const banner = page.getByRole('status').filter({ hasText: notice['auto-title'] }).filter({ hasText: notice.unavailableBody });
  await banner.waitFor();
  assert.equal(await banner.locator('p').last().textContent(), notice.unavailableBody);
  await page.screenshot({ path: path.join(out, 'outage.png') });
  await page.getByRole('button', { name: notice.details, exact: true }).click();
  const detailId = await page.getByRole('button', { name: notice.details, exact: true }).getAttribute('aria-controls');
  const details = page.locator('[id="' + detailId + '"]');
  const upstream = details.getByText(detail.replaceAll('\n', ' '), { exact: true }).first();
  await upstream.waitFor();
  assert.equal(await upstream.textContent(), detail);
  assert.ok(await details.getByText(/HTTP 402/).first().isVisible());
  await page.screenshot({ path: path.join(out, 'details.png') });
  await page.getByRole('button', { name: notice.dismiss, exact: true }).press('Enter');
  await banner.waitFor({ state: 'hidden' });
  assert.equal((await title()).title, null);
  assert.deepEqual(await health(), []);
  await page.reload();
  await page.waitForFunction(() => !!window.electronAPI?.maker);
  assert.deepEqual(await health(), []);
  console.log('PASS successful backup stays silent, whole-chain failure names title and preserves HTTP detail, dismissal survives reentry');

  // Use the real retry interval. Sleeping does not trigger any model request.
  replies.set(primary, 'success');
  const pausedCount = requests.length;
  await delay(Math.max(0, Math.max(...rows.map(r => r.lastErrorAt)) + 60_100 - Date.now()));
  assert.equal(requests.length, pausedCount);
  assert.equal((await title()).title, 'Desk organization');
  assert.deepEqual(await health(), []);
  replies.set(primary, 'denied');
  assert.equal((await title()).title, null);
  await banner.waitFor();
  assert.notEqual((await health())[0].noticeId, rows[0].noticeId);
  console.log('PASS real recovery and a new visible outage. Screenshots:', out);
} finally {
  server.closeAllConnections();
  if (server.listening) await new Promise(resolve => server.close(resolve));
  if (app) await app.close();
  if (ownedProfile) await rm(ownedProfile, { recursive: true, force: true });
  await rm(runDir, { recursive: true, force: true });
}
