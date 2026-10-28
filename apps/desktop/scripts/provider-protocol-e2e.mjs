import { assertProviderE2EProfile } from './provider-e2e-profile.mjs';
// Black-box real Desktop IPC -> native adapters -> loopback HTTP fault injection.
// No database writes, host mocks, SDK mocks, real keys or paid upstreams.
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
const out = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-protocol-e2e-'));
const wires = ['openai-chat', 'openai-responses', 'anthropic-messages', 'google-generative-ai'];
const model = 'e2e-protocol-model';
const records = [];
let active;
function frames(wire) {
  const events = wire === 'openai-responses' ? [
    { type: 'response.created', response: { id: 'reply' } },
    { type: 'response.output_item.added', output_index: 0, item: { id: 'msg', type: 'message', role: 'assistant', content: [] } },
    { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'OK' },
    { type: 'response.completed', response: { id: 'reply', status: 'completed', output: [], usage: { input_tokens: 1, output_tokens: 1 } } },
  ] : wire === 'anthropic-messages' ? [
    { type: 'message_start', message: { id: 'reply', model, role: 'assistant', type: 'message', content: [], usage: { input_tokens: 1, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'OK' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
    { type: 'message_stop' },
  ] : wire === 'google-generative-ai' ? [{ candidates: [{ content: { parts: [{ text: 'OK' }] }, finishReason: 'STOP' }] }] : [{ id: 'reply', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: 'OK' } }] },
    { id: 'reply', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } }];
  return events;
}
const encode = events => events.map(e => `${e.type ? `event: ${e.type}\n` : ''}data: ${JSON.stringify(e)}\n\n`).join('');
const server = http.createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c);
  const url = new URL(req.url, 'http://fixture');
  const wire = url.pathname.endsWith('/chat/completions') ? wires[0] : url.pathname.endsWith('/responses') ? wires[1]
    : url.pathname.endsWith('/messages') ? wires[2] : url.pathname.includes(':streamGenerateContent') ? wires[3] : 'unknown';
  active.requests.push({ method: req.method, path: url.pathname, wire });
  const json = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  if (active.kind === 'success' && wire !== active.wire || active.kind === 'unsupported') return json(active.status ?? 400, { error: { code: 'unsupported_protocol', message: 'protocol not supported' } });
  if (active.kind === 'http') return json(active.status, { error: { message: active.message } });
  if (active.kind === 'disconnect') return req.socket.destroy();
  if (active.kind === 'timeout') return; // Real 8-second candidate deadline.
  if (active.kind === 'overall') return setTimeout(() => {
    if (!res.destroyed) json(400, { error: { code: 'unsupported_protocol', message: 'protocol not supported' } });
  }, 6000);
  if (active.kind === 'redirect') { res.writeHead(307, { location: '/redirect-target' }); return res.end(); }
  if (active.kind === 'html') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<html>Login</html>'); }
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  if (active.kind === 'empty') return res.end('data: [DONE]\n\n');
  if (active.kind === 'malformed') return res.end('data: {broken}\n\n');
  if (active.kind === 'stream-error') return res.end(encode([{ error: { type: 'authentication_error', message: 'invalid api key' } }]));
  const events = frames(wire);
  if (active.kind === 'partial-end' || active.kind === 'partial-reset') {
    const partial = wire === wires[3] ? [{ candidates: [{ content: { parts: [{ text: 'partial' }] } }] }] : events.slice(0, wire === wires[0] ? 1 : 3);
    res.write(encode(partial));
    if (active.kind === 'partial-end') return res.end();
    return setTimeout(() => res.destroy(), 80);
  }
  res.end(encode(events));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}/team/v1`;
let browser;
try {
  browser = await chromium.connectOverCDP(process.env.E2E_CDP_URL ?? 'http://127.0.0.1:19427');
  await assertProviderE2EProfile(browser, process.env.E2E_DB);
  const page = browser.contexts()[0].pages().find(p => /localhost:\d+\/#\/settings/.test(p.url()));
  assert.ok(page, 'An isolated Desktop settings window must be open');
  const cases = wires.map((wire, i) => ({ kind: 'success', wire, count: i + 1 }));
  for (const wire of wires) cases.push(...[
    { kind: 'http', status: 401, message: 'invalid api key', code: 'AUTH_INVALID' },
    { kind: 'http', status: 403, message: 'forbidden', code: 'AUTH_FORBIDDEN' },
    { kind: 'http', status: 402, message: 'insufficient_quota', code: 'QUOTA_EXCEEDED' },
    { kind: 'http', status: 429, message: 'rate limit unsupported_protocol', code: 'RATE_LIMITED' },
    { kind: 'http', status: 400, message: 'invalid request parameter' },
    { kind: 'http', status: 404, message: 'not found' },
    { kind: 'http', status: 503, message: 'unsupported_protocol' },
    { kind: 'disconnect' }, { kind: 'partial-end' }, { kind: 'partial-reset' },
    { kind: 'empty' }, { kind: 'malformed' }, { kind: 'html' }, { kind: 'redirect' },
    { kind: 'stream-error' }, { kind: 'timeout', code: 'TIMEOUT' },
  ].map(c => ({ ...c, wire, count: 1, preferred: wire })));
  for (const status of [400, 404, 405, 415, 422]) cases.push({ kind: 'unsupported', status, count: 4 });
  cases.push({ kind: 'overall', count: 3, code: 'TIMEOUT' });
  for (const c of cases) {
    active = { ...c, requests: [] };
    const input = { kind: 'adhoc', strategy: 'auto', requestId: `matrix-${Date.now()}-${records.length}`,
      spec: { agent: 'pi', baseUrl, modelId: model, authMethod: 'apiKey', apiKey: 'fake-e2e-not-a-real-key',
        ...(c.preferred ? { wireProtocol: c.preferred } : {}) } };
    const start = Date.now();
    const result = await page.evaluate(input => window.electronAPI.maker.testProviderConnection(input), input);
    const row = { ...c, elapsedMs: Date.now() - start, result, requests: active.requests };
    records.push(row);
    await fs.writeFile(path.join(out, 'results.json'), JSON.stringify(records, null, 2));
    assert.equal(result.ok, c.kind === 'success', JSON.stringify(row));
    assert.equal(active.requests.length, c.count, JSON.stringify(row));
    assert.equal(result.attempts.length, c.count, JSON.stringify(row));
    if (c.kind === 'success') {
      assert.equal(result.selected.wireProtocol, c.wire);
      assert.deepEqual(active.requests.map(r => r.wire), wires.slice(0, c.count));
    } else if (c.kind === 'unsupported' || c.kind === 'overall') assert.deepEqual(active.requests.map(r => r.wire), wires.slice(0, c.count));
    else { assert.equal(active.requests[0].wire, c.wire); assert.notEqual(result.decision, 'next'); }
    if (c.code) assert.equal(result.code, c.code, JSON.stringify(row));
    if (c.kind === 'timeout') assert.ok(row.elapsedMs >= 7500 && row.elapsedMs < 12000, JSON.stringify(row));
    if (c.kind === 'overall') assert.ok(row.elapsedMs >= 14500 && row.elapsedMs < 19000, JSON.stringify(row));
    row.pass = true;
    await fs.writeFile(path.join(out, 'results.json'), JSON.stringify(records, null, 2));
    console.log(`PASS ${c.kind} ${c.wire ?? ''} ${c.status ?? ''} requests=${c.count}`);
  }
} catch (error) {
  console.error(error);
  await fs.writeFile(path.join(out, 'failure.txt'), String(error.stack));
  process.exitCode = 1;
} finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  console.log(`REPORT=${out}`);
}
