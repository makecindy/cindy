import { assertProviderE2EProfile } from './provider-e2e-profile.mjs';
// Real isolated Desktop IPC + persistence + loopback HTTP. No host mocks or real keys.
// Start with XDT_CDP_PORT=19427 pnpm restart:desktop:remote --region=global --isolated=@worktree --passive
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { chromium } from 'playwright-core';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const dbFile = process.env.E2E_DB;
assert.ok(dbFile && /CindyGlobal-dev2-provider-auto-detection-[^/]+\/cindy-local-v1\.db$/.test(dbFile),
  'E2E_DB must name this worktree isolated local database; never use a real profile');
const disk = new Database(dbFile, { readonly: true });
const out = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-provider-save-e2e-'));
const results = [];
const requests = [];
let scenario;
const model = 'e2e-fixture-chat';
const key = 'fake-e2e-not-a-real-key';
const server = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
  const url = new URL(req.url, 'http://fixture');
  requests.push({ scenario: scenario?.name, method: req.method, path: url.pathname,
    model: body?.model, authMatches: req.headers.authorization === `Bearer ${key}`,
    apiKeyMatches: req.headers['x-api-key'] === key, marker: req.headers['x-e2e-marker'] });
  const json = (value, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
  const prefix = scenario?.prefix ?? '';
  if (!url.pathname.startsWith(prefix + '/')) return json({ error: 'wrong prefix' }, 404);
  const route = url.pathname.slice(prefix.length);
  if (req.method === 'GET') {
    if (route === '/v1/models') return json({ data: [{ id: model, owned_by: scenario.system === 'vllm' ? 'vllm' : 'fixture', root: model, max_model_len: 8192 }] });
    const fixtures = {
      sub2api: { '/api/v1/settings/public': { code: 0, data: { version: 'fixture', hide_ccs_import_button: false, backend_mode_enabled: true, subscription_enabled: false } }, '/v1/sub2api/billing': { object: 'sub2api.key_billing', schema_version: 1 } },
      litellm: { '/health/readiness/details': { litellm_version: 'fixture', status: 'healthy', success_callbacks: [] }, '/v1/model/info': { data: [{ model_name: model, litellm_params: {}, model_info: {} }] } },
      lmstudio: { '/lmstudio-greeting': { lmstudio: true }, '/api/v1/models': { models: [{ key: model, type: 'llm', publisher: 'fixture', loaded_instances: [] }] } },
      llamacpp: { '/props': { default_generation_settings: {}, total_slots: 1, build_info: 'fixture' } },
      vllm: { '/version': { version: 'fixture' } },
    };
    return fixtures[scenario.system]?.[route] ? json(fixtures[scenario.system][route]) : json({ error: 'not found' }, 404);
  }
  if (!['/v1/chat/completions', '/v1/responses', '/v1/messages'].includes(route)) return json({ error: 'unsupported endpoint' }, 404);
  if (body?.model !== model) return json({ error: 'wrong model' }, 400);
  if (scenario.reject) return json({ error: { message: 'invalid fixture key', type: 'authentication_error' } }, 401);
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const events = route.endsWith('/responses') ? [
    { type: 'response.created', response: { id: 'reply' } },
    { type: 'response.output_item.added', output_index: 0, item: { id: 'msg', type: 'message', role: 'assistant', content: [] } },
    { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'OK' },
    { type: 'response.completed', response: { id: 'reply', status: 'completed', output: [], usage: { input_tokens: 1, output_tokens: 1 } } },
  ] : route.endsWith('/messages') ? [
    { type: 'message_start', message: { id: 'reply', model, role: 'assistant', type: 'message', content: [], usage: { input_tokens: 1, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'OK' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
    { type: 'message_stop' },
  ] : [{ id: 'reply', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: 'OK' } }] },
    { id: 'reply', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } }];
  res.end(events.map(e => `${e.type ? `event: ${e.type}\n` : ''}data: ${JSON.stringify(e)}\n\n`).join('') + (route.endsWith('/completions') ? 'data: [DONE]\n\n' : ''));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
let page;
const created = [];
try {
  browser = await chromium.connectOverCDP(process.env.E2E_CDP_URL ?? 'http://127.0.0.1:19427');
  await assertProviderE2EProfile(browser, process.env.E2E_DB);
  page = browser.contexts()[0].pages().find(p => /\/#\/settings/.test(p.url()));
  assert.ok(page, 'Open the isolated Desktop Settings / Providers page first');
  page.setDefaultTimeout(20000);
  const presets = await page.evaluate(async () => (await window.electronAPI.maker.listProviderPresets()).presets);
  if (await page.getByRole('dialog').count()) {
    await page.getByRole('dialog').getByRole('button', { name: '取消', exact: true }).click();
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
  }
  for (const item of [
    { system: 'sub2api', prefix: '' }, { system: 'sub2api', prefix: '/team', back: true },
    { system: 'litellm', prefix: '/team' }, { system: 'lmstudio', prefix: '/team' },
    { system: 'llamacpp', prefix: '/team' }, { system: 'vllm', prefix: '/team' },
  ]) {
    scenario = { ...item, name: `E2E ${item.system} ${item.back ? 'return' : 'save'} ${Date.now()}` };
    if (!await page.getByPlaceholder('我的 AI 供应商').count()) {
      await page.getByRole('button', { name: '添加供应商', exact: true }).click();
      await page.getByText('自定义端点', { exact: true }).click();
    }
    await page.getByPlaceholder('我的 AI 供应商').fill(scenario.name);
    await page.getByPlaceholder('API 密钥', { exact: true }).fill(key);
    await page.getByRole('button', { name: '添加请求头', exact: true }).click();
    await page.getByPlaceholder('Header-Name').first().fill('X-E2E-Marker');
    await page.getByPlaceholder('value', { exact: true }).first().fill('preserved-through-wizard');
    await page.getByPlaceholder('https://api.myprovider.com/v1').fill(origin + item.prefix + '/v1');
    const configure = page.getByRole('button', { name: '前往配置', exact: true });
    await configure.waitFor();
    await page.waitForTimeout(1500);
    assert.equal(await page.getByPlaceholder('https://api.myprovider.com/v1').inputValue(), origin + item.prefix + '/v1');
    assert.equal(await page.getByRole('button', { name: '下一步', exact: true }).count(), 0, 'Recognition must wait for a click');
    await configure.click();
    const next = page.getByRole('button', { name: '下一步', exact: true });
    await next.waitFor();
    await page.screenshot({ path: path.join(out, `${results.length}-handoff.png`) });
    await next.click();
    const finish = page.getByRole('button', { name: '完成添加', exact: true });
    await finish.waitFor();
    if (item.back) {
      await page.getByRole('button', { name: '← 上一步', exact: true }).click();
      await page.getByRole('button', { name: '← 上一步', exact: true }).click();
      await page.getByRole('button', { name: '保存供应商', exact: true }).click();
    } else await finish.click();
    await page.waitForFunction(async name => (await window.electronAPI.maker.listProviders()).providers.some(p => p.name === name), scenario.name);
    const saved = await page.evaluate(async name => (await window.electronAPI.maker.listProviders()).providers.find(p => p.name === name), scenario.name);
    created.push(saved.id);
    const row = disk.prepare('SELECT * FROM custom_providers WHERE id = ?').get(saved.id.replace(/^custom:/, ''));
    assert.ok(row, 'Real save must create a SQLite row');
    const stored = JSON.parse(row.runtimes);
    const preset = presets.find(p => p.id === item.system);
    assert.ok(preset);
    const expectedAgents = item.back ? ['pi'] : Object.keys(preset.runtimes);
    assert.deepEqual(Object.keys(saved.routing).sort(), expectedAgents.sort());
    assert.deepEqual(Object.keys(stored).sort(), expectedAgents.sort());
    assert.equal(stored.pi.baseUrl, origin + item.prefix + '/v1');
    assert.ok(stored.pi.models.some(m => m.id === model && m.defaultEnabled !== false));
    assert.equal(saved.source, 'user');
    assert.ok(saved.models.pi.some(m => m.id === model));
    assert.equal(new URL(saved.routing.pi.upstream).port, String(server.address().port));
    assert.equal(saved.routing.pi.upstream, origin + item.prefix + '/v1');
    const start = requests.length;
    const probes = {};
    for (const agent of Object.keys(saved.routing)) {
      const probe = await page.evaluate(input => window.electronAPI.maker.testProviderConnection(input), { kind: 'saved', providerId: saved.id, agent });
      probes[agent] = probe;
      assert.equal(probe.ok, true, JSON.stringify({ system: item.system, agent, probe }));
    }
    const posts = requests.slice(start).filter(r => r.method === 'POST');
    assert.equal(posts.length, Object.keys(saved.routing).length);
    assert.ok(posts.every(r => r.model === model && (r.authMatches || r.apiKeyMatches)));
    assert.ok(posts.every(r => r.marker === 'preserved-through-wizard'));
    assert.ok(posts.every(r => r.path.startsWith(item.prefix + '/v1/')));
    const expectedPaths = expectedAgents.map(agent => {
      // The existing provider interface audit overrides LM Studio's Codex
      // catalog default to Responses (providerInterfaceRoutes.ts).
      const wire = item.back ? 'openai-chat' : item.system === 'lmstudio' && agent === 'codex' ? 'openai-responses'
        : preset.runtimes[agent].wireProtocol ?? (agent === 'claude-code' ? 'anthropic-messages' : agent === 'codex' ? 'openai-responses' : 'openai-chat');
      assert.equal(stored[agent].wireProtocol ?? (agent === 'claude-code' ? 'anthropic-messages' : agent === 'codex' ? 'openai-responses' : 'openai-chat'), wire);
      return item.prefix + '/v1/' + ({ 'openai-chat': 'chat/completions', 'openai-responses': 'responses', 'anthropic-messages': 'messages' })[wire];
    }).sort();
    assert.deepEqual(posts.map(r => r.path).sort(), expectedPaths);
    await page.reload();
    await page.getByRole('button', { name: '添加供应商', exact: true }).waitFor();
    const reread = await page.evaluate(async id => (await window.electronAPI.maker.listProviders()).providers.find(p => p.id === id), saved.id);
    assert.deepEqual(reread.routing, saved.routing);
    const again = await page.evaluate(id => window.electronAPI.maker.testProviderConnection({ kind: 'saved', providerId: id, agent: 'pi' }), saved.id);
    assert.equal(again.ok, true);
    scenario.reject = true;
    const beforeReject = requests.length;
    const rejected = await page.evaluate(id => window.electronAPI.maker.testProviderConnection({ kind: 'saved', providerId: id, agent: 'pi' }), saved.id);
    assert.equal(rejected.ok, false);
    assert.equal(rejected.status, 401);
    assert.equal(requests.slice(beforeReject).filter(r => r.method === 'POST').length, 1, '401 must not retry another protocol');
    assert.deepEqual(disk.prepare('SELECT * FROM custom_providers WHERE id = ?').get(row.id), row, 'Probe must not mutate saved config');
    results.push({ system: item.system, prefix: item.prefix, returned: !!item.back, saved, stored, probes, posts, reread: true, diskVerified: true, reloadedProbe: again, rejected });
    console.log(`PASS ${item.system} ${item.back ? 'return' : 'save'}`);
  }
} catch (error) {
  console.error(error);
  if (page) { await page.screenshot({ path: path.join(out, 'failure.png') }).catch(() => {}); console.error((await page.getByRole('dialog').innerText().catch(() => '')).slice(0,2200)); }
  results.push({ error: error.message });
  process.exitCode = 1;
} finally {
  if (page) for (const id of created) await page.evaluate(async providerId => {
    const { dataOwnerId, ownerGeneration } = await window.electronAPI.maker.listProviders();
    await window.electronAPI.maker.deleteCustomProvider(providerId.replace(/^custom:/, ''), { dataOwnerId, ownerGeneration });
  }, id).catch(e => { console.error('Cleanup failed', e.message); process.exitCode = 1; });
  for (const id of created) assert.equal(disk.prepare('SELECT id FROM custom_providers WHERE id = ?').get(id.replace(/^custom:/, '')), undefined, 'Fixture cleanup must remove disk row');
  disk.close();
  await fs.writeFile(path.join(out, 'results.json'), JSON.stringify({ results, requests }, null, 2));
  console.log(`REPORT=${out}`);
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
