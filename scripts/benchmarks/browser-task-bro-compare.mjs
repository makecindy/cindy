#!/usr/bin/env node
/**
 * Opt-in head-to-head of Cindy's browser MCP entry and bro (https://github.com/xiaotianxt/bro) on the
 * same tasks with the same model. Not a unit test and not part of CI. It produced the numbers in
 * docs/benchmarks/browser-read-2026-11-11/.
 *
 * Both sides are driven by the local `claude` CLI in print mode with only that side's browser tools:
 *   cindy = the production browser MCP entry of --repo (scripts/eval-browser-tasks.mjs --mcp) on its
 *           own headless Chrome, a fresh profile per run;
 *   bro   = a running `bro serve` plus a Chrome that has bro's extension loaded and connected.
 * Tasks: eight read tasks on public websites (answers fetched from the sites' public APIs and pages
 * right before the runs) and five of the fixture tasks served by eval-browser-tasks.mjs --serve.
 * Runs are sequential, the side that goes first alternates per repetition, and every run is kept.
 * The task list here is the one the published numbers were measured with; `--real-sites` in
 * eval-browser-tasks.mjs carries the same eight tasks for Cindy's own before/after runs.
 *
 * Preparing bro (the published runs used 1.4.5, built from source, signed out, isolated):
 *   1. Build the server (`cargo build --release`) and the extension (`extension/dist`).
 *   2. HOME=<empty dir> bro serve                 # writes <empty dir>/.bro/settings.json with a token
 *   3. Start a Chrome with a fresh profile and the extension, for example
 *        chrome --headless=new --user-data-dir=<empty dir> --remote-debugging-port=9377 \
 *          --load-extension=<bro>/extension/dist --use-mock-keychain --password-store=basic \
 *          --disable-features=DisableLoadExtensionCommandLineSwitch,LocalNetworkAccessChecks,LocalNetworkAccessChecksWebSockets
 *   4. Give the extension the token (a headless Chrome has no Options page to paste it into):
 *        node scripts/benchmarks/browser-task-bro-compare.mjs --set-extension-token 9377 \
 *          --bro-settings <empty dir>/.bro/settings.json
 *      `curl http://127.0.0.1:3500/status` then shows the extension connected.
 *
 * Usage:
 *   node scripts/benchmarks/browser-task-bro-compare.mjs --live --bro-settings <settings.json> \
 *     [--repo <checkout under test>] [--out <dir>] [--model claude-opus-5-5] [--effort medium] \
 *     [--reps-real 3] [--reps-fixture 2] [--only crates,form] [--sides cindy,bro]
 *   --repo defaults to this checkout. Point it at a worktree of an older commit (after `pnpm install`
 *   there) to measure that version; the fixture pages always come from this checkout.
 *   bro is limited to the tools its server marks `bro/default` in their metadata (11 in 1.4.5): the
 *   others are passed to the CLI as --disallowedTools (BRO_HIDDEN_TOOLS below).
 *
 * The bro token is only read from --bro-settings and written to a per-run MCP config that is deleted
 * after the run. Each run costs real usage, so nothing starts without --live.
 *
 * Limits: one harness (Claude Code print mode), one machine and network, small samples, tasks chosen
 * by Cindy. Real sites change and can refuse automation; a failure there is a reason to look.
 */
import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { parseArgs } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

const { values } = parseArgs({ options: {
  live: { type: 'boolean' }, 'set-extension-token': { type: 'string' },
  repo: { type: 'string' }, out: { type: 'string' },
  'bro-settings': { type: 'string', default: path.join(os.homedir(), '.bro', 'settings.json') },
  'bro-url': { type: 'string', default: 'http://127.0.0.1:3500/mcp' },
  model: { type: 'string', default: 'claude-opus-5-5' }, effort: { type: 'string', default: 'medium' },
  'reps-real': { type: 'string', default: '3' }, 'reps-fixture': { type: 'string', default: '2' },
  only: { type: 'string' }, sides: { type: 'string', default: 'cindy,bro' },
} });
const root = fileURLToPath(new URL('../..', import.meta.url));
const sides = values.sides.split(',');
if (sides.some((side) => !['cindy', 'bro'].includes(side))) throw new Error('Invalid --sides');
const broToken = sides.includes('bro') || values['set-extension-token']
  ? JSON.parse(readFileSync(values['bro-settings'], 'utf8')).token : null;

// ---------------------------------------------------------------------------------------------
// --set-extension-token <cdp port>: store bro's token in the extension of a headless Chrome.
// ---------------------------------------------------------------------------------------------
if (values['set-extension-token']) {
  const targets = await (await fetch(`http://127.0.0.1:${values['set-extension-token']}/json/list`)).json();
  const worker = targets.find((target) => target.type === 'service_worker' && target.url.endsWith('/service-worker.js'));
  if (!worker) throw new Error('bro extension service worker not found on that Chrome');
  const socket = new WebSocket(worker.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let nextId = 0;
  const evaluate = (expression) => new Promise((resolve) => {
    const id = ++nextId;
    const onMessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.id !== id) return;
      socket.removeEventListener('message', onMessage);
      resolve(message.result);
    };
    socket.addEventListener('message', onMessage);
    socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
  });
  const stored = await evaluate(`chrome.storage.local.set({token:${JSON.stringify(broToken)}}).then(()=>chrome.runtime.getManifest().name)`);
  await evaluate('setTimeout(()=>chrome.runtime.reload(),100)');
  socket.close();
  console.log(`token stored in extension: ${stored?.result?.value ?? 'unknown'}`);
  process.exit(0);
}

if (!values.live) throw new Error('Require --live (each run costs real usage), or --set-extension-token <cdp port>');
const repo = path.resolve(values.repo ?? root);
const out = values.out ? path.resolve(values.out) : await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-browser-bro-compare-'));
await fs.mkdir(out, { recursive: true });
const tsxLoader = (checkout) => pathToFileURL(path.join(checkout, 'node_modules/tsx/dist/loader.mjs')).href;

// Tools bro 1.4.5 does not mark `bro/default`; the model on the bro side only sees the remaining 11.
const BRO_HIDDEN_TOOLS = ['agent_done', 'browser_batch_run', 'browser_console_capture', 'browser_flow_act', 'browser_flow_finish',
  'browser_flow_observe', 'browser_flow_start', 'browser_network_capture', 'browsers_context', 'click_element', 'computer',
  'debugger_diagnose', 'extensions_pause', 'extensions_resume', 'extensions_status', 'extract_page', 'file_upload', 'fill_element',
  'find', 'form_input', 'frames_list', 'get_element_info', 'get_page_text', 'get_response_body', 'gif_creator', 'javascript_tool',
  'login_form_inspect', 'navigate', 'onepassword_fill_login', 'onepassword_find_logins', 'read_console_messages',
  'read_network_requests', 'read_page', 'resize_window', 'scroll_element', 'session_name', 'shortcuts_execute', 'shortcuts_list',
  'tabs_activate', 'tabs_claim', 'tabs_close', 'tabs_context', 'tabs_context_mcp', 'tabs_create', 'tabs_create_mcp', 'tabs_finalize',
  'upload_image', 'userscripts_list', 'userscripts_register', 'userscripts_unregister', 'wait_for_element']
  .map((name) => `mcp__bro__${name}`);

const freePort = () => new Promise((resolve, reject) => {
  const server = net.createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)); });
});
const getJson = async (url) => (await fetch(url, { headers: { 'User-Agent': 'browser-bench/1.0' } })).json();
const version = (tag) => (String(tag).match(/\d+(?:\.\d+)+/) ?? [String(tag)])[0];

// ---------------------------------------------------------------------------------------------
// Real-site tasks. Ground truth is fetched from public APIs and pages right before the runs.
// ---------------------------------------------------------------------------------------------
const REPOS = ['cli/cli', 'astral-sh/uv', 'denoland/deno', 'oven-sh/bun'];
const truth = {
  releases: Object.fromEntries(await Promise.all(REPOS.map(async (name) =>
    [name, version((await getJson(`https://api.github.com/repos/${name}/releases/latest`)).tag_name)]))),
  pr: (await getJson('https://api.github.com/search/issues?q=repo:cli/cli+is:pr+is:merged+attestation+in:title&sort=created&order=asc&per_page=1')).items[0].number,
  serde: (await getJson('https://crates.io/api/v1/crates/serde')).crate.max_stable_version,
  requests: (await getJson('https://pypi.org/pypi/requests/json')).info.version,
};
{
  const html = await (await fetch('https://support.apple.com/en-us/100100', { headers: { 'User-Agent': 'Mozilla/5.0' } })).text();
  const row = [...html.matchAll(/<tr[^>]*>(.*?)<\/tr>/gs)][1][1];
  const cells = [...row.matchAll(/<t[dh][^>]*>(.*?)<\/t[dh]>/gs)]
    .map((match) => match[1].replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim());
  truth.apple = { name: cells[0], date: cells[2], versions: cells[0].match(/\d+(?:\.\d+)+/g) ?? [] };
}
console.log(JSON.stringify({ truth }));

const REAL = [
  { id: 'gh-releases', kind: 'real', prompt: () => '用浏览器查这四个 GitHub 仓库各自最新 release 的版本号：cli/cli、astral-sh/uv、denoland/deno、oven-sh/bun（看各自的 /releases/latest 页面），列给我。',
    check: (final) => REPOS.every((name) => final.includes(truth.releases[name])) },
  { id: 'gh-pr', kind: 'real', prompt: () => '在 GitHub 的 cli/cli 仓库里，找出标题包含 attestation 的已合并 PR 中创建时间最早的一个，告诉我它的编号和标题。',
    check: (final) => final.includes(String(truth.pr)) },
  { id: 'crates', kind: 'real', prompt: () => '打开 https://crates.io/crates/serde ，告诉我 serde 当前的最新版本号。',
    check: (final) => final.includes(truth.serde) },
  { id: 'pypi', kind: 'real', prompt: () => '打开 https://pypi.org/project/requests/ ，告诉我 requests 当前的最新版本号和它的发布日期。',
    check: (final) => final.includes(truth.requests) },
  { id: 'hn', kind: 'real', prompt: () => '用 Hacker News 搜索（https://hn.algolia.com）找到 Dropbox 当年发的帖子 "My YC app: Dropbox - Throw away your USB drive"，告诉我发帖人的用户名和这个帖子的得分（points）。',
    check: (final) => /dhouston/i.test(final) },
  { id: 'tailscale', kind: 'real', prompt: () => '从 Tailscale 文档首页 https://tailscale.com/kb 出发，找到 tailscale up 命令的说明页，告诉我 --netfilter-mode 支持哪几个取值、默认值是什么。',
    check: (final) => /nodivert/.test(final) },
  { id: 'apple', kind: 'real', prompt: () => '打开 https://support.apple.com/en-us/100100 （Apple security releases），告诉我表格里最新的一条（第一行）是哪个更新、发布日期是哪天。',
    check: (final) => truth.apple.versions.length > 0 && truth.apple.versions.every((item) => final.includes(item)) },
  { id: 'wiki', kind: 'real', prompt: () => '打开 https://en.wikipedia.org/wiki/List_of_tallest_buildings ，在 "Tallest buildings in the world" 那张排名表里，排第 14 的建筑叫什么、有多高（米）？',
    check: (final) => /475\.6/.test(final) },
];
const FIXTURE_IDS = ['form', 'catalog', 'orders', 'settings', 'badge'];
const fixtureCheck = {
  form: (answers, final) => final.includes(answers.form.code),
  catalog: (answers, final) => ['Alpha Lamp', 'Cobalt Desk', 'Echo Chair', 'Garnet Shelf'].every((name) => final.includes(answers.skus[name])),
  orders: (answers, final) => { const order = answers.orders.find((item) => item.status === 'REFUNDED'); return final.includes(order.id) && final.includes(order.amount); },
  settings: (answers, final) => final.includes(answers.settings.receipt),
  badge: (answers, final) => final.includes(answers.badge.code),
};

// One fixture server per repetition: fresh random answers and fresh page state.
async function startFixtures() {
  const child = spawn(process.execPath, ['--import', tsxLoader(root), path.join(root, 'scripts/eval-browser-tasks.mjs'), '--serve'],
    { cwd: root, stdio: ['ignore', 'pipe', 'inherit'] });
  let buffer = '';
  const info = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('fixture server did not start')), 60_000);
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      try { const parsed = JSON.parse(buffer); clearTimeout(timer); resolve(parsed); } catch { /* still printing */ }
    });
    child.on('exit', (code) => reject(new Error(`fixture server exited ${code}`)));
  });
  return { info, stop: () => child.kill('SIGTERM') };
}

const SYSTEM = '你是 Cindy，帮助用户完成请求。用中文简洁回答，事实以实际读取的内容为准。';

/** One line per browser call, so a run can be read without opening its stream. */
function describeCall(side, name, input) {
  const args = input?.args ?? input ?? {};
  const short = name.replace(/^mcp__(cindy_browser|bro)__/, '');
  if (side === 'bro') return `${short}${Array.isArray(args.steps) ? `(${args.steps.map((step) => step.type).join(',')})` : Array.isArray(args.urls) ? `(${args.urls.length} urls)` : ''}`;
  if (short === 'list_tools') return 'list_tools';
  if (args.action === 'batch') return `batch(${(args.steps ?? []).map((step) => step.action === 'act' ? step.request?.kind : step.action === 'read' && Array.isArray(step.pages) ? `read(${step.pages.length})` : step.action).join(',')})`;
  if (args.action === 'cdp') return `cdp(${(args.commands ?? []).map((command) => command.method).join(',')})`;
  if (args.action === 'act') return `act:${args.request?.kind}`;
  if (args.action === 'read') return `read${Array.isArray(args.pages) ? `(${args.pages.length})` : args.targetId ? '(tab)' : ''}`;
  return `${args.action}${args.afterSnapshot ? '+snap' : ''}`;
}

async function runOne(task, side, repetition) {
  const dir = path.join(out, `${task.id}-${side}-${repetition}`);
  await fs.mkdir(path.join(dir, 'cwd'), { recursive: true });
  const trace = path.join(dir, 'runtime-trace.jsonl');
  await fs.writeFile(trace, '');
  const config = path.join(dir, 'mcp.json');
  const mcp = side === 'cindy'
    ? { cindy_browser: { command: process.execPath, args: ['--import', tsxLoader(repo), path.join(repo, 'scripts/eval-browser-tasks.mjs'),
      '--mcp', '--variant', 'C', '--runtime-dir', path.join(dir, 'runtime'), '--trace', trace, '--cdp-port', String(await freePort())] } }
    : { bro: { type: 'http', url: values['bro-url'], headers: { Authorization: `Bearer ${broToken}` } } };
  await fs.writeFile(config, JSON.stringify({ mcpServers: mcp }), { mode: 0o600 });
  const allowed = side === 'cindy' ? ['mcp__cindy_browser__list_tools', 'mcp__cindy_browser__call_tool'] : ['mcp__bro'];
  const started = Date.now();
  const child = spawn('claude', ['-p', task.prompt(), '--output-format', 'stream-json', '--verbose', '--model', values.model, '--effort', values.effort,
    '--system-prompt', SYSTEM, '--tools', '', '--strict-mcp-config', '--mcp-config', config, '--allowedTools', ...allowed,
    ...(side === 'bro' ? ['--disallowedTools', ...BRO_HIDDEN_TOOLS] : []),
    '--no-session-persistence', '--setting-sources', 'project', '--max-turns', '40'],
  { cwd: path.join(dir, 'cwd'), stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, MCP_TIMEOUT: '90000', ENABLE_TOOL_SEARCH: 'false' } });
  const events = [];
  let pending = '', stderr = '';
  child.stdout.on('data', (chunk) => {
    pending += chunk;
    const lines = pending.split('\n');
    pending = lines.pop();
    for (const line of lines) { if (!line) continue; try { events.push({ at: Date.now(), event: JSON.parse(line) }); } catch { /* partial */ } }
  });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  // A run that is still going after six minutes is stuck; it is killed and kept as a failure.
  const timer = setTimeout(() => child.kill('SIGTERM'), 6 * 60_000);
  const exit = await new Promise((resolve) => child.on('close', resolve));
  clearTimeout(timer);
  await fs.rm(config, { force: true });
  await fs.writeFile(path.join(dir, 'stream.jsonl'), events.map((item) => JSON.stringify(item)).join('\n'));
  if (stderr) await fs.writeFile(path.join(dir, 'stderr.txt'), stderr);
  const result = events.find((item) => item.event.type === 'result')?.event;
  const init = events.find((item) => item.event.type === 'system' && item.event.subtype === 'init')?.event;
  const toolCalls = [];
  const open = new Map();
  let toolMs = 0, resultChars = 0;
  for (const { at, event } of events) {
    for (const block of event.message?.content ?? []) {
      if (event.type === 'assistant' && block.type === 'tool_use') {
        open.set(block.id, at);
        toolCalls.push(describeCall(side, block.name, block.input));
      }
      if (event.type === 'user' && block.type === 'tool_result') {
        resultChars += JSON.stringify(block.content ?? '').length;
        if (open.has(block.tool_use_id)) { toolMs += at - open.get(block.tool_use_id); open.delete(block.tool_use_id); }
      }
    }
  }
  const final = typeof result?.result === 'string' ? result.result : '';
  const usage = result?.usage ?? {};
  const row = { task: task.id, kind: task.kind, side, repetition,
    pass: exit === 0 && result?.is_error === false && task.check(final),
    error: exit !== 0 ? `claude exited ${exit}` : result?.is_error ? String(result.subtype ?? 'error') : undefined,
    turns: result?.num_turns ?? null, calls: toolCalls.length, costUsd: result?.total_cost_usd ?? null,
    // seconds is the CLI's own processing time (start-up excluded); wallSeconds includes start-up.
    seconds: (result?.duration_ms ?? Date.now() - started) / 1000, apiSeconds: (result?.duration_api_ms ?? 0) / 1000, toolSeconds: toolMs / 1000,
    wallSeconds: (Date.now() - started) / 1000,
    inputTokens: (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0),
    cacheWrite: usage.cache_creation_input_tokens ?? 0, outputTokens: usage.output_tokens ?? null,
    toolResultChars: resultChars, toolCount: init?.tools?.length ?? null, toolCalls, final };
  await fs.writeFile(path.join(dir, 'result.json'), JSON.stringify(row, null, 2));
  await fs.rm(path.join(dir, 'runtime'), { recursive: true, force: true }).catch(() => {});
  console.log(JSON.stringify({ task: row.task, side, rep: repetition, pass: row.pass, turns: row.turns, calls: row.calls, cost: row.costUsd,
    s: Math.round(row.seconds * 10) / 10, api: Math.round(row.apiSeconds * 10) / 10, tool: Math.round(row.toolSeconds * 10) / 10,
    chars: row.toolResultChars, error: row.error, seq: row.toolCalls.join(' → ') }));
  return row;
}

const rows = [];
const save = () => fs.writeFile(path.join(out, 'results.json'), JSON.stringify({ model: values.model, effort: values.effort, truth, rows }, null, 2));
const wanted = (id) => !values.only || values.only.split(',').includes(id);
const order = (repetition) => (repetition % 2 ? [...sides].reverse() : sides);
for (let repetition = 0; repetition < Number(values['reps-real']); repetition++) {
  for (const task of REAL.filter((item) => wanted(item.id))) {
    for (const side of order(repetition)) { rows.push(await runOne(task, side, repetition)); await save(); }
  }
}
for (let repetition = 0; repetition < Number(values['reps-fixture']); repetition++) {
  const ids = FIXTURE_IDS.filter(wanted);
  if (!ids.length) break;
  const fixtures = await startFixtures();
  try {
    for (const id of ids) {
      const task = { id, kind: 'fixture', prompt: () => fixtures.info.prompts[id], check: (final) => fixtureCheck[id](fixtures.info.answers, final) };
      for (const side of order(repetition)) { rows.push(await runOne(task, side, repetition)); await save(); }
    }
  } finally { fixtures.stop(); }
}
await save();

// Averages count passing runs only; a failed or stuck run shows up in the pass column instead.
const mean = (list, key) => (list.length ? list.reduce((sum, row) => sum + (row[key] ?? 0), 0) / list.length : NaN);
console.log('\nkind     side   pass   turns  calls  cost$   seconds');
for (const kind of ['real', 'fixture']) for (const side of sides) {
  const all = rows.filter((row) => row.kind === kind && row.side === side);
  if (!all.length) continue;
  const passed = all.filter((row) => row.pass);
  console.log(`${kind.padEnd(8)} ${side.padEnd(6)} ${`${passed.length}/${all.length}`.padEnd(6)} ${mean(passed, 'turns').toFixed(1).padEnd(6)} ${mean(passed, 'calls').toFixed(1).padEnd(6)} ${mean(passed, 'costUsd').toFixed(3).padEnd(7)} ${mean(passed, 'seconds').toFixed(1)}`);
}
console.log(`\nresults: ${path.join(out, 'results.json')}`);
process.exit(0);
