/**
 * Opt-in live MODEL evaluation, not a browser/backend E2E test.
 * Uses the production MCP discovery/call/screenshot pipeline with a scripted page runtime.
 * Only screenshot pixels contain the random answer. No actions reach external websites.
 * A = baseline Git source; B = current discovery/recipes + baseline workflow; C = current all.
 * Usage: node scripts/eval-browser-image-fallback.mjs --live --codex-home PATH
 *   --baseline-ref COMMIT --model gpt-6-astra --effort high --repeats 5
 * Credentials remain in memory; artifacts go to a unique OS temporary directory.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer as createHttpServer } from 'node:http';
import { runInNewContext } from 'node:vm';
import { execFileSync } from 'node:child_process';
import { randomUUID, randomInt, createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import sharp from 'sharp';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

const { values } = parseArgs({ options: {
  live: { type: 'boolean' }, 'codex-home': { type: 'string' },
  'baseline-ref': { type: 'string' }, model: { type: 'string', default: 'gpt-6-astra' },
  effort: { type: 'string', default: 'high' }, repeats: { type: 'string', default: '5' },
  only: { type: 'string' }, variants: { type: 'string', default: 'A,B,C' },
} });
const repeats = Number(values.repeats);
if (!values.live || !values['codex-home'] || !values['baseline-ref'] || !Number.isInteger(repeats) || repeats < 1) {
  throw new Error('Require --live, --codex-home, --baseline-ref and positive --repeats');
}
const root = fileURLToPath(new URL('..', import.meta.url));
const out = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-browser-fallback-eval-'));
console.log(JSON.stringify({ outputDir: out, model: values.model, effort: values.effort }));
const auth = JSON.parse(await fs.readFile(path.join(values['codex-home'], 'auth.json'), 'utf8'));
if (!auth.tokens?.access_token || !auth.tokens?.account_id) throw new Error('Subscription credentials unavailable');
const serverFile = 'packages/lizi-mcps/src/browser/server.ts';
const workflowFile = 'packages/lizi-mcps/src/browser/prompts/rules/browser-workflow.md';
const baseline = file => execFileSync('git', ['show', `${values['baseline-ref']}:${file}`], { cwd: root, encoding: 'utf8' });
const variantFiles = [serverFile, workflowFile, 'packages/lizi-mcps/src/browser/experience.ts', 'packages/lizi-mcps/src/browser/recipe-loader.ts', 'packages/lizi-mcps/src/browser/tools.ts', 'packages/lizi-mcps/src/browser/recipes/api.fxtwitter.com/recipe.json', 'packages/lizi-mcps/src/browser/recipes/x.com/siteguide.json'];
const baselineSources = new Map(variantFiles.map(file => [path.join(root, file), baseline(file)]));
const candidateHashes = {};
for (const file of variantFiles) {
  const contents = await fs.readFile(path.join(root, file), 'utf8');
  candidateHashes[file] = createHash('sha256').update(contents).digest('hex');
  await fs.writeFile(path.join(out, file.replaceAll('/', '__')), contents);
}
const source = { server: await fs.readFile(path.join(root, serverFile), 'utf8'), workflow: await fs.readFile(path.join(root, workflowFile), 'utf8') };
await fs.writeFile(path.join(out, 'candidate-server.ts'), source.server);
await fs.writeFile(path.join(out, 'candidate-workflow.md'), source.workflow);
await fs.writeFile(path.join(out, 'baseline-server.ts'), baseline(serverFile));
await fs.writeFile(path.join(out, 'baseline-workflow.md'), baseline(workflowFile));
await fs.writeFile(path.join(out, 'manifest.json'), JSON.stringify({
  kind: 'live-model-scripted-browser', model: values.model, effort: values.effort,
  baselineRef: values['baseline-ref'], repeats, only: values.only ?? null, variants: values.variants,
  candidateHashes,
  sourceHashes: Object.fromEntries(Object.entries(source).map(([k, v]) => [k, createHash('sha256').update(v).digest('hex')])),
  limitations: ['Scripted page runtime, not actual Chrome or full Cindy/Codex harness.', 'No actual X login or networking tested.', 'Tool catalog narrowed to browser + web fetch + HTTP headers.'],
}, null, 2));
const textResult = data => ({ content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data) }] });
const cases = ['failed-fetch', 'short-link', 'misleading-alt', 'login-wall', 'deleted-image', 'static-article', 'x-public-photo', 'x-public-text']
  .filter(id => !values.only || values.only.split(',').includes(id));
const variants = values.variants.split(',');
if (!cases.length || variants.some(v => !['A', 'B', 'C'].includes(v))) throw new Error('Invalid cases/variants');
const loaders = new Map();
for (const variant of variants) {
  const vite = await createServer({ root, configFile: false, logLevel: 'error',
    optimizeDeps: { noDiscovery: true, include: [], entries: [] },
    // Module loading needs no HTTP/WebSocket listener; don't contend with a running dev app.
    server: { middlewareMode: true, watch: { ignored: ['**/*'] }, hmr: { server: createHttpServer() } },
    ssr: { noExternal: [/^@cindy\//, /^@jackwener\//] },
    plugins: [{ name: 'evaluation-source-variant', enforce: 'pre', load(id) {
      const file = id.split('?')[0];
      if (variant === 'A' && baselineSources.has(file)) return id.endsWith('?raw')
        ? `export default ${JSON.stringify(baselineSources.get(file))}` : baselineSources.get(file);
      if (id === `${path.join(root, workflowFile)}?raw` && variant !== 'C') return `export default ${JSON.stringify(baseline(workflowFile))}`;
    } }],
  });
  const module = await vite.ssrLoadModule(`/${serverFile}`);
  loaders.set(variant, { vite, create: module.createBrowserMcpServer });
}

async function response(input, tools, sessionId) {
  const res = await fetch('https://chatgpt.com/backend-api/codex/responses', {
    method: 'POST', signal: AbortSignal.timeout(120_000),
    headers: { Authorization: `Bearer ${auth.tokens.access_token}`, 'chatgpt-account-id': auth.tokens.account_id,
      'OpenAI-Beta': 'responses=experimental', originator: 'codex_cli_rs', session_id: sessionId,
      accept: 'text/event-stream', 'content-type': 'application/json' },
    body: JSON.stringify({ model: values.model, instructions: '你是 Cindy，帮助用户完成请求。用中文简洁回答，事实以实际读取的内容为准。',
      input, tools, tool_choice: 'auto', store: false, stream: true, reasoning: { effort: values.effort },
      include: ['reasoning.encrypted_content'] }),
  });
  if (!res.ok) throw new Error(`Provider HTTP ${res.status}`);
  let result;
  for (const line of (await res.text()).split('\n')) {
    if (!line.startsWith('data: ') || line === 'data: [DONE]') continue;
    const event = JSON.parse(line.slice(6));
    if (event.type === 'response.completed') result = event.response;
    if (event.type === 'response.failed' || event.type === 'error') throw new Error('Provider stream failed');
  }
  if (!result) throw new Error('No completed response');
  return result;
}

async function run(id, variant, repetition, answer, png) {
  const started = Date.now(), actions = [], transcript = [], usage = { input: 0, output: 0, cached: 0 };
  const reportedModels = new Set();
  let imageSeen = false, blockerSeen = false, final = '', error, turns = 0;
  const wall = id === 'login-wall', deleted = id === 'deleted-image', article = ['static-article', 'x-public-text'].includes(id);
  const xPhoto = id === 'x-public-photo';
  const xCase = xPhoto || id === 'x-public-text';
  const mediaUrl = 'https://images.example/screenshot.png';
  let currentUrl = 'about:blank';
  const apiPayload = { tweet: { id: '1234567890123456789', text: '登录失败，详情见截图。', media: { photos: [{ url: mediaUrl }] } } };
  const url = xCase ? 'https://x.com/person/status/1234567890123456789/photo/1' : id === 'short-link' ? 'https://short.example/screen' : 'https://forum.example/post/42/photo/1';
  if (xCase) currentUrl = url; // tabs reports this already-open page
  const snapshot = wall ? '页面：登录后才能查看此图片。按钮：登录。' : deleted ? '图片已被作者删除。' : article
    ? '发布说明：维护窗口为周六 02:00–03:00 UTC。' : `用户反馈：登录之后出现错误，见附图。图片标签：${id === 'misleading-alt' ? '错误 E-0000，版本 0.0.0' : '截图'}。页面正文没有报错细节。`;
  const runtime = { async call(req) {
    actions.push(req);
    if (['open', 'navigate'].includes(req.action)) currentUrl = req.url ?? currentUrl;
    if (xPhoto && req.action === 'act' && req.request?.kind === 'evaluate' && currentUrl.startsWith('https://api.fxtwitter.com/')) {
      return { ok: true, action: req.action, data: { targetId: 'fixture', result: runInNewContext(`(${req.request.fn})()`, { document: { body: { innerText: JSON.stringify(apiPayload) } } }, { timeout: 100 }) } };
    }
    if (['open', 'navigate', 'snapshot'].includes(req.action) && (wall || deleted)) blockerSeen = true;
    const data = req.action === 'status' ? { backend: 'external', available: true, running: true }
      : req.action === 'tabs' ? { tabs: [{ targetId: 'fixture', url, owner: 'cindy' }] }
      : req.action === 'screenshot' ? { path: 'fixture.png', mimeType: 'image/png' }
      : { targetId: 'fixture', url: xCase ? currentUrl : url, snapshot: xPhoto ? currentUrl === mediaUrl ? '图片原图已加载。' : '公开帖子：登录失败，详情见截图。图片缩略图文字无法辨认。点击放大需要登录 X。' : snapshot };
    return { ok: true, action: req.action, data };
  } };
  const server = loaders.get(variant).create({ getRuntime: () => runtime,
    resolveScreenshot: async () => {
      if (wall || deleted || article) throw new Error('No screenshot fixture for this terminal page');
      if (xPhoto && currentUrl !== mediaUrl) return { buffer: await sharp({ create: { width: 200, height: 100, channels: 3, background: 'white' } }).png().toBuffer(), mimeType: 'image/png' };
      imageSeen = true; return { buffer: png, mimeType: 'image/png' };
    } });
  const client = new Client({ name: 'fallback-eval', version: '1' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(ct), server.connect(st)]);
  try {
    const catalog = (await client.listTools()).tools;
    const tools = catalog.map(t => ({ type: 'function', name: `cindy_browser__${t.name}`, description: t.description,
      parameters: t.inputSchema, strict: false }));
    tools.push(...['web_fetch', 'http_headers'].map(name => ({ type: 'function', name,
      description: name === 'web_fetch' ? '读取公开网页正文。' : '读取 URL 的 HTTP 响应头和跳转地址，不返回响应体。',
      parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'], additionalProperties: false }, strict: false })));
    const request = xPhoto ? `看一下这个问题：${url}` : article ? `总结这个公告的维护时间：${url}` : `看一下这个问题：${url}。请告诉我截图里的错误码和应用版本。`;
    // Replay the exact decision point: plain fetch has already failed (or returned text only).
    const input = [{ role: 'user', content: request },
      { type: 'function_call', call_id: 'initial-fetch', name: 'web_fetch', arguments: JSON.stringify({ url }) },
      { type: 'function_call_output', call_id: 'initial-fetch', output: xPhoto ? '登录失败，详情见配图。' : article || id === 'misleading-alt' ? snapshot : `URL ${url} is not accessible via this tool.` }];
    const sessionId = randomUUID();
    for (; turns < 10; turns++) {
      const result = await response(input, tools, sessionId);
      if (result.model) reportedModels.add(result.model);
      usage.input += result.usage?.input_tokens ?? 0;
      usage.output += result.usage?.output_tokens ?? 0;
      usage.cached += result.usage?.input_tokens_details?.cached_tokens ?? 0;
      input.push(...result.output);
      const calls = result.output.filter(v => v.type === 'function_call');
      for (const m of result.output.filter(v => v.type === 'message')) final += (m.content ?? []).map(c => c.text ?? '').join('');
      if (!calls.length) break;
      for (const call of calls) {
        const args = JSON.parse(call.arguments);
        let r;
        if (call.name.startsWith('cindy_browser__')) r = await client.callTool({ name: call.name.slice('cindy_browser__'.length), arguments: args });
        else if (xPhoto && args.url === mediaUrl && call.name === 'web_fetch') { imageSeen = true; r = { content: [{ type: 'image', data: png.toString('base64'), mimeType: 'image/png' }] }; }
        else r = textResult(call.name === 'http_headers' ? { status: 301, location: 'https://forum.example/post/42/photo/1' }
          : article || id === 'misleading-alt' ? snapshot : 'URL is not accessible via this tool.');
        transcript.push({ name: call.name, args, content: r.content.map(c => c.type === 'image' ? { type: 'image', bytes: c.data.length } : c) });
        const content = r.content.map(c => c.type === 'image'
          ? { type: 'input_image', image_url: `data:${c.mimeType};base64,${c.data}`, detail: 'original' }
          : { type: 'input_text', text: c.text ?? '' });
        input.push({ type: 'function_call_output', call_id: call.call_id, output: content });
      }
    }
    if (turns === 10) error = 'Evaluation turn budget exhausted';
  } catch (e) { error = e.message; }
  finally { await client.close(); await server.close(); }
  const correct = article ? final.includes('02:00') && final.includes('03:00') && actions.length === 0
    : wall ? blockerSeen && /登录/.test(final) && !imageSeen
    : deleted ? blockerSeen && /删除/.test(final) && !imageSeen
    : imageSeen && final.includes(answer.code) && (xPhoto || final.includes(answer.version));
  return { id, variant, repetition, reportedModels: [...reportedModels], durationMs: Date.now() - started, usage, turns: turns + 1, imageSeen, blockerSeen,
    browserDiscovered: transcript.some(t => t.name === 'cindy_browser__list_tools'),
    recipeUsed: actions.some(a => a.action === 'navigate' && a.url?.startsWith('https://api.fxtwitter.com/status/')),
    browserCalls: actions.length, premature: !article && !imageSeen && !blockerSeen && !error,
    pass: !error && correct, error, final, answer, transcript, actions };
}

const results = [];
try {
  for (let repetition = 0; repetition < repeats; repetition++) {
    for (const id of cases) {
      const answer = { code: `E-${randomInt(10000, 99999)}`, version: `4.${randomInt(10, 99)}.${randomInt(10, 99)}` };
      const png = await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="900" height="300"><rect width="900" height="300" fill="white"/><g fill="black" font-family="Arial" font-size="38"><text x="40" y="70">Application login failed</text><text x="40" y="145">Error: ${answer.code}</text><text x="40" y="220">App version: ${answer.version}</text></g></svg>`)).png().toBuffer();
      await fs.writeFile(path.join(out, `${id}-${repetition}.png`), png);
      // Same pixels/answer per paired trial; reverse variant order on alternating repeats.
      for (const variant of repetition % 2 ? [...variants].reverse() : variants) {
        const r = await run(id, variant, repetition, answer, png); results.push(r);
        await fs.writeFile(path.join(out, 'results.json'), JSON.stringify(results, null, 2));
        console.log(JSON.stringify({ ...r, transcript: undefined, actions: undefined, answer: undefined }));
        if (r.error?.startsWith('Provider')) throw new Error(r.error);
      }
    }
  }
} finally { for (const { vite } of loaders.values()) await vite.close(); }
const median = numbers => {
  const sorted = [...numbers].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const summary = variants.map(variant => {
  const rows = results.filter(r => r.variant === variant);
  return { variant, total: rows.length, passed: rows.filter(r => r.pass).length,
    errors: rows.filter(r => r.error).length, premature: rows.filter(r => r.premature).length,
    medianMs: median(rows.map(r => r.durationMs)),
    inputTokens: rows.reduce((n, r) => n + r.usage.input, 0),
    cachedTokens: rows.reduce((n, r) => n + r.usage.cached, 0),
    outputTokens: rows.reduce((n, r) => n + r.usage.output, 0),
    browserCalls: rows.reduce((n, r) => n + r.browserCalls, 0),
  };
});
await fs.writeFile(path.join(out, 'summary.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify({ outputDir: out, total: results.length, passed: results.filter(r => r.pass).length, summary }));
