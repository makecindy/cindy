/**
 * Opt-in live MODEL evaluation of multi-step browser tasks. Not a unit test and not part of CI.
 *
 * A real model drives the production browser MCP entry (list_tools / call_tool) against a real
 * headless Chrome through the browser runtime, on local fixture pages served by this script.
 *   A = the browser tool layer at --baseline-ref;  C = the current working tree.
 * Every run gets fresh random answers, variants are interleaved, and every run is kept (no picking).
 * Reported per variant and task: pass rate, model turns, browser tool calls, cost, wall time.
 *
 * The model is driven by the local `claude` CLI in print mode with its own sign-in; this script
 * reads no credentials. Each run costs real usage, so it only starts with --live.
 *
 * Usage:
 *   node --import tsx scripts/eval-browser-tasks.mjs --live --baseline-ref origin/main \
 *     [--model claude-sonnet-5-5] [--repeats 3] [--only form,vault] [--variants A,C] [--parallel 3]
 *   node --import tsx scripts/eval-browser-tasks.mjs --check
 *     No model and no usage: drives batch and cdp through the MCP entry on the same real browser and
 *     fixture pages, and fails if a result is wrong. Run it after touching either action.
 *   node --import tsx scripts/eval-browser-tasks.mjs --serve
 *     Only serves the fixture pages and prints their address, one run id and its answers, for trying
 *     the sidebar and "My browser" by hand from a running Cindy. /__state?run=<id> shows what the
 *     pages recorded.
 *
 * Limits: the dedicated-browser runtime only (no sidebar, no "My browser"), fixture pages rather
 * than real sites, one harness (Claude Code print mode with only the browser tools). Results are
 * evidence for the changed paths, not a general success rate.
 */
import fs from 'node:fs/promises';
import { appendFileSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes, randomInt } from 'node:crypto';
import { parseArgs } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

const { values } = parseArgs({ options: {
  live: { type: 'boolean' }, mcp: { type: 'boolean' }, check: { type: 'boolean' }, serve: { type: 'boolean' },
  'baseline-ref': { type: 'string' }, model: { type: 'string', default: 'claude-sonnet-5-5' },
  repeats: { type: 'string', default: '3' }, only: { type: 'string' },
  variants: { type: 'string', default: 'A,C' }, parallel: { type: 'string', default: '3' },
  variant: { type: 'string' }, 'runtime-dir': { type: 'string' }, trace: { type: 'string' }, 'cdp-port': { type: 'string' },
} });
const root = fileURLToPath(new URL('..', import.meta.url));
const browserDir = 'packages/lizi-mcps/src/browser';

// ---------------------------------------------------------------------------------------------
// MCP child: one variant of the production browser MCP server over stdio, on its own headless Chrome.
// ---------------------------------------------------------------------------------------------
if (values.mcp) {
  process.env.XDT_BROWSER_RUNTIME_DIR = values['runtime-dir'];
  const { createServer } = await import('vite');
  const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
  const baseline = new Map();
  if (values.variant === 'A') {
    const changed = execFileSync('git', ['diff', '--name-only', values['baseline-ref'], '--', browserDir], { cwd: root, encoding: 'utf8' })
      .split('\n').filter(Boolean);
    for (const file of changed) {
      try {
        baseline.set(path.join(root, file), execFileSync('git', ['show', `${values['baseline-ref']}:${file}`], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
      } catch { /* New in the working tree: the baseline never imports it. */ }
    }
  }
  const vite = await createServer({ root, configFile: false, logLevel: 'silent', appType: 'custom',
    optimizeDeps: { noDiscovery: true, include: [], entries: [] },
    server: { middlewareMode: true, watch: null, hmr: false, ws: false },
    ssr: { noExternal: [/^@cindy\//, /^@jackwener\//] },
    plugins: [{ name: 'evaluation-baseline-source', enforce: 'pre', load(id) {
      const [file, query] = id.split('?');
      if (!baseline.has(file)) return undefined;
      return query === 'raw' ? `export default ${JSON.stringify(baseline.get(file))}` : baseline.get(file);
    } }],
  });
  const { createBrowserMcpServer } = await vite.ssrLoadModule(`/${browserDir}/server.ts`);
  const { createBrowserControlRuntime } = await import(pathToFileURL(path.join(root, 'packages/browser-control-runtime/src/runtime.ts')).href);
  const runtime = createBrowserControlRuntime({
    config: { browser: { enabled: true, headless: true, defaultProfile: 'eval',
      profiles: { eval: { cdpPort: Number(values['cdp-port']), color: '#00D9C5' } },
      ssrfPolicy: { dangerouslyAllowPrivateNetwork: true } } },
    logSink: () => {},
  });
  const traced = { call: async (request) => {
    const started = performance.now();
    const result = await runtime.call(request);
    appendFileSync(values.trace, `${JSON.stringify({ action: request.action, kind: request.request?.kind,
      method: request.recipeCommand?.method, ok: result.ok, ms: Math.round(performance.now() - started) })}\n`);
    return result;
  } };
  await runtime.call({ action: 'start' });
  const server = createBrowserMcpServer({
    getRuntime: () => traced,
    getBackendKind: () => 'external',
    resolveScreenshot: async (result) => {
      const data = result.data ?? {};
      const buffer = typeof data.data === 'string' ? Buffer.from(data.data, 'base64') : await fs.readFile(data.path);
      return { buffer, mimeType: buffer[0] === 0xff ? 'image/jpeg' : 'image/png' };
    },
  });
  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    await runtime.call({ action: 'stop' }).catch(() => {});
    await vite.close().catch(() => {});
    process.exit(0);
  };
  process.stdin.on('end', shutdown);
  process.stdin.on('close', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  await server.connect(new StdioServerTransport());
  await new Promise(() => {});
}

// ---------------------------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------------------------
const repeats = Number(values.repeats);
const parallel = Number(values.parallel);
if (!values.check && !values.serve && (!values.live || !values['baseline-ref'] || !Number.isInteger(repeats) || repeats < 1 || !Number.isInteger(parallel) || parallel < 1)) {
  throw new Error('Require --check, --serve, or --live with --baseline-ref and positive --repeats / --parallel');
}
const variants = values.variants.split(',');
if (variants.some((variant) => !['A', 'C'].includes(variant))) throw new Error('Invalid --variants');

const token = (prefix) => `${prefix}-${randomBytes(4).toString('hex').toUpperCase()}`;
const page = (title, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title>
<style>body{font:16px/1.5 system-ui;margin:32px;max-width:760px}label{display:block;margin:10px 0}input,select,textarea,button{font:inherit;padding:6px}table{border-collapse:collapse}td,th{border:1px solid #999;padding:4px 10px}[hidden]{display:none}</style>
</head><body><h1>${title}</h1>${body}</body></html>`;
const PRODUCTS = ['Alpha Lamp', 'Birch Stool', 'Cobalt Desk', 'Dune Rug', 'Echo Chair', 'Fern Planter', 'Garnet Shelf', 'Harbor Clock'];
const PEOPLE = ['Abara', 'Bianchi', 'Castillo', 'Dvorak', 'Eriksen', 'Fontaine', 'Gupta', 'Haddad', 'Ivanov', 'Jensen', 'Kowalski', 'Lindqvist',
  'Moreau', 'Nakamura', 'Okafor', 'Petrov', 'Quintero', 'Rossi', 'Sato', 'Tanaka', 'Usman', 'Varga', 'Weber', 'Xu', 'Yilmaz', 'Zhou'];

/** Per-run answers and what the pages recorded; the checks read only this and the final reply. */
const runs = new Map();
function newRun() {
  const id = randomBytes(6).toString('hex');
  const refundedIndex = 18 + randomInt(6); // page 4 of 5
  const state = {
    id,
    form: { note: token('NOTE'), code: token('CONF'), submitted: null },
    skus: Object.fromEntries(PRODUCTS.map((name) => [name, token('SKU')])),
    orders: Array.from({ length: 30 }, (_, index) => ({ id: token('ORD'), amount: `${randomInt(20, 900)}.${String(randomInt(100)).padStart(2, '0')}`,
      status: index === refundedIndex ? 'REFUNDED' : ['PAID', 'SHIPPED', 'PENDING'][index % 3] })),
    vault: token('VAULT'),
    badge: { employee: `E-${randomInt(10000, 99999)}`, pin: String(randomInt(1000, 9999)), code: token('BADGE'), submitted: null },
    report: `${randomInt(10, 99)},${String(randomInt(1000)).padStart(3, '0')}`,
    settings: { receipt: token('RCPT'), saved: null },
    support: token('SUP'),
    extensions: Object.fromEntries(PEOPLE.map((name) => [name, String(randomInt(2000, 9999))])),
  };
  runs.set(id, state);
  return state;
}

function readBody(req) {
  return new Promise((resolve) => { let data = ''; req.on('data', (chunk) => { data += chunk; }); req.on('end', () => resolve(data)); });
}

async function handle(req, res, ports) {
  const url = new URL(req.url, 'http://fixture');
  const state = runs.get(url.searchParams.get('run') ?? '');
  const send = (body, type = 'text/html; charset=utf-8', status = 200) => { res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' }); res.end(body); };
  if (!state) return send('unknown run', 'text/plain', 404);
  const q = `run=${state.id}`;
  if (values.serve && url.pathname === '/__state') return send(JSON.stringify(state), 'application/json');
  switch (url.pathname) {
    case '/form':
      return send(page('Create account', `<form method="post" action="/form/submit?${q}">
<label>Full name <input name="name" required></label>
<label>Email <input name="email" type="email" required></label>
<label>Plan <select name="plan"><option value="">Choose…</option><option>Basic</option><option>Pro</option><option>Team</option></select></label>
<label>Seats <input name="seats" type="number" min="1" value="1"></label>
<fieldset><legend>Region</legend>${['EU', 'US', 'APAC'].map((region) => `<label><input type="radio" name="region" value="${region}"> ${region}</label>`).join('')}</fieldset>
<label><input type="checkbox" name="newsletter" value="yes"> Subscribe to product updates</label>
<label>Notes <textarea name="notes" rows="2"></textarea></label>
<button type="submit">Create account</button></form>`));
    case '/form/submit': {
      state.form.submitted = Object.fromEntries(new URLSearchParams(await readBody(req)));
      return send(page('Account created', `<p>Thanks, ${state.form.submitted.name ?? ''}. Your confirmation code is <strong>${state.form.code}</strong>.</p>`));
    }
    case '/catalog':
      return send(page('Catalog', `<ul>${PRODUCTS.map((name, index) => `<li><a href="/product?${q}&p=${index}">${name}</a></li>`).join('')}</ul>`));
    case '/product': {
      const name = PRODUCTS[Number(url.searchParams.get('p'))];
      if (!name) return send('no such product', 'text/plain', 404);
      return send(page(name, `<dl><dt>SKU</dt><dd id="sku">${state.skus[name]}</dd><dt>Stock</dt><dd>${randomInt(1, 60)} units</dd></dl><p><a href="/catalog?${q}">Back to catalog</a></p>`));
    }
    case '/orders':
      return send(page('Orders', `<table><thead><tr><th>Order</th><th>Amount</th><th>Status</th></tr></thead><tbody id="rows"></tbody></table>
<p><button id="prev">Previous</button> <span id="where" role="status"></span> <button id="next">Next</button></p>
<script>let n=1;async function load(){const r=await fetch('/orders/data?${q}&page='+n);const rows=await r.json();
document.getElementById('rows').innerHTML=rows.map(o=>'<tr><td>'+o.id+'</td><td>'+o.amount+'</td><td>'+o.status+'</td></tr>').join('');
document.getElementById('where').textContent='Page '+n+' of 5';}
document.getElementById('next').onclick=()=>{if(n<5){n++;load();}};document.getElementById('prev').onclick=()=>{if(n>1){n--;load();}};load();</script>`));
    case '/orders/data': {
      const pageNo = Math.max(1, Math.min(5, Number(url.searchParams.get('page')) || 1));
      return send(JSON.stringify(state.orders.slice((pageNo - 1) * 6, pageNo * 6)), 'application/json');
    }
    case '/vault':
      return send(page('Vault', `<p>The access code is shown after pressing the button in the panel below.</p><vault-box></vault-box><script src="/vault.js?${q}"></script>`));
    case '/vault.js':
      return send(`customElements.define('vault-box', class extends HTMLElement { connectedCallback() {
  const root = this.attachShadow({ mode: 'closed' });
  root.innerHTML = '<div style="border:1px solid #999;padding:16px"><button type="button">Reveal access code</button><p role="status"></p></div>';
  root.querySelector('button').addEventListener('click', async (event) => {
    if (!event.isTrusted) return;
    const reply = await fetch('/vault/code?${q}', { method: 'POST' });
    root.querySelector('p').textContent = 'Access code: ' + await reply.text();
  });
} });`, 'text/javascript');
    case '/vault/code':
      return req.method === 'POST' ? send(state.vault, 'text/plain') : send('method not allowed', 'text/plain', 405);
    case '/badge':
      return send(page('Badge desk', `<p>Fill in the panel below to issue a visitor badge.</p><badge-form></badge-form><script src="/badge.js?${q}"></script>`));
    case '/badge.js':
      return send(`customElements.define('badge-form', class extends HTMLElement { connectedCallback() {
  const root = this.attachShadow({ mode: 'closed' });
  root.innerHTML = '<div style="border:1px solid #999;padding:16px"><label>Employee ID <input id="employee"></label><label>Door PIN <input id="pin" inputmode="numeric"></label><button type="button">Issue badge</button><p role="status"></p></div>';
  root.querySelector('button').addEventListener('click', async (event) => {
    if (!event.isTrusted) return;
    const body = { employee: root.querySelector('#employee').value, pin: root.querySelector('#pin').value };
    const reply = await fetch('/badge/issue?${q}', { method: 'POST', body: JSON.stringify(body) });
    root.querySelector('p').textContent = await reply.text();
  });
} });`, 'text/javascript');
    case '/badge/issue': {
      state.badge.submitted = JSON.parse(await readBody(req) || '{}');
      const ok = state.badge.submitted.employee === state.badge.employee && state.badge.submitted.pin === state.badge.pin;
      return send(ok ? `Badge issued: ${state.badge.code}` : 'Rejected: employee ID or PIN does not match.', 'text/plain');
    }
    case '/report':
      return send(page('Quarterly report', `<p><button id="go">Generate report</button></p><div id="out" role="status"></div>
<script>document.getElementById('go').onclick=async()=>{const out=document.getElementById('out');out.textContent='Generating…';
const r=await fetch('/report/data?${q}');out.innerHTML='<h2>Report ready</h2><p>Total: <strong id="total">'+await r.text()+'</strong></p>';};</script>`));
    case '/report/data':
      return setTimeout(() => send(state.report, 'text/plain'), 2500);
    case '/settings':
      return send(page('Workspace', `<p><button id="more" aria-haspopup="menu" aria-expanded="false">More</button></p>
<ul id="menu" role="menu" hidden><li role="menuitem" tabindex="0" id="open-notify">Notification settings</li><li role="menuitem" tabindex="0">Billing</li></ul>
<section id="panel" hidden><h2>Notification settings</h2>
<label><input type="checkbox" id="email" checked> Email notifications</label>
<label><input type="checkbox" id="digest"> Weekly digest</label>
<label><input type="checkbox" id="sms"> SMS alerts</label>
<label>Frequency <select id="frequency"><option>Daily</option><option>Weekly</option><option>Monthly</option></select></label>
<p><button id="save">Save changes</button></p><p id="saved" role="status"></p></section>
<script>const more=document.getElementById('more'),menu=document.getElementById('menu');
more.addEventListener('pointerdown',()=>{menu.hidden=!menu.hidden;more.setAttribute('aria-expanded',String(!menu.hidden));});
document.getElementById('open-notify').onclick=()=>{menu.hidden=true;document.getElementById('panel').hidden=false;};
document.getElementById('save').onclick=async()=>{const body={email:email.checked,digest:digest.checked,sms:sms.checked,frequency:frequency.value};
const r=await fetch('/settings/save?${q}',{method:'POST',body:JSON.stringify(body)});document.getElementById('saved').textContent='Saved · receipt '+await r.text();};</script>`));
    case '/settings/save':
      state.settings.saved = JSON.parse(await readBody(req) || '{}');
      return send(state.settings.receipt, 'text/plain');
    case '/embed':
      return send(page('Help center', `<p>Your support panel is embedded below.</p><iframe title="Support panel" src="http://localhost:${ports.frame}/panel?${q}" width="480" height="160"></iframe>`));
    case '/panel':
      return send(page('Support panel', `<p>Support code: <strong>${state.support}</strong></p>`));
    case '/directory':
      return send(page('Staff directory', `<label>Search by surname <input id="q" type="search" placeholder="Type at least 2 letters"></label><ul id="hits"></ul>
<script>document.getElementById('q').addEventListener('input',async(e)=>{const v=e.target.value.trim();const list=document.getElementById('hits');
if(v.length<2){list.innerHTML='';return;}const r=await fetch('/directory/search?${q}&q='+encodeURIComponent(v));
list.innerHTML=(await r.json()).map(p=>'<li>'+p.name+' — extension '+p.ext+'</li>').join('')||'<li>No matches</li>';});</script>`));
    case '/directory/search': {
      const needle = (url.searchParams.get('q') ?? '').toLowerCase();
      return send(JSON.stringify(needle.length < 2 ? [] : PEOPLE.filter((name) => name.toLowerCase().includes(needle)).map((name) => ({ name, ext: state.extensions[name] }))), 'application/json');
    }
    default:
      return send('not found', 'text/plain', 404);
  }
}

const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const freePort = async () => { const probe = net.createServer(); const port = await listen(probe); await new Promise((resolve) => probe.close(resolve)); return port; };
const ports = {};
const servers = [createHttpServer((req, res) => handle(req, res, ports).catch(() => { res.statusCode = 500; res.end(); })),
  createHttpServer((req, res) => handle(req, res, ports).catch(() => { res.statusCode = 500; res.end(); }))];
ports.main = await listen(servers[0]);
ports.frame = await listen(servers[1]);
const base = `http://127.0.0.1:${ports.main}`;

/** What each task asks and how it is judged. `sequence` marks the paths this change targets; the rest are controls. */
const TASKS = [
  { id: 'form', focus: 'sequence',
    prompt: (s) => `打开 ${base}/form?run=${s.id} ，用下面的信息填表并提交：姓名 Ada Lovelace，邮箱 ada@example.test，套餐 Team，席位 7，地区 APAC，勾选订阅产品更新，备注填 ${s.form.note}。然后告诉我提交后页面显示的确认码。`,
    check: (s, final) => final.includes(s.form.code) && !!s.form.submitted && s.form.submitted.name === 'Ada Lovelace' && s.form.submitted.email === 'ada@example.test'
      && s.form.submitted.plan === 'Team' && s.form.submitted.seats === '7' && s.form.submitted.region === 'APAC' && s.form.submitted.newsletter === 'yes' && s.form.submitted.notes === s.form.note },
  { id: 'catalog', focus: 'sequence',
    prompt: (s) => `打开 ${base}/catalog?run=${s.id} ，查出 Alpha Lamp、Cobalt Desk、Echo Chair、Garnet Shelf 这四件商品各自的 SKU（SKU 只在商品详情页上），列给我。`,
    check: (s, final) => ['Alpha Lamp', 'Cobalt Desk', 'Echo Chair', 'Garnet Shelf'].every((name) => final.includes(s.skus[name])) },
  { id: 'orders', focus: 'sequence',
    prompt: (s) => `打开 ${base}/orders?run=${s.id} ，订单表分 5 页。找出状态是 REFUNDED 的那一单，告诉我订单号和金额。`,
    check: (s, final) => { const order = s.orders.find((item) => item.status === 'REFUNDED'); return final.includes(order.id) && final.includes(order.amount); } },
  { id: 'report', focus: 'sequence',
    prompt: (s) => `打开 ${base}/report?run=${s.id} ，生成报告，告诉我报告里的 Total 是多少。`,
    check: (s, final) => final.includes(s.report) },
  { id: 'settings', focus: 'sequence',
    prompt: (s) => `打开 ${base}/settings?run=${s.id} ，从 More 菜单进入通知设置：关掉 Email notifications，打开 Weekly digest，Frequency 改成 Monthly，保存。告诉我保存后显示的回执号。`,
    check: (s, final) => final.includes(s.settings.receipt) && !!s.settings.saved && s.settings.saved.email === false && s.settings.saved.digest === true
      && s.settings.saved.sms === false && s.settings.saved.frequency === 'Monthly' },
  { id: 'vault', focus: 'escape-hatch',
    prompt: (s) => `打开 ${base}/vault?run=${s.id} ，按页面上的按钮显示访问码，告诉我访问码是多少。`,
    check: (s, final) => final.includes(s.vault) },
  { id: 'badge', focus: 'escape-hatch',
    prompt: (s) => `打开 ${base}/badge?run=${s.id} ，在页面的面板里把 Employee ID 填成 ${s.badge.employee}、Door PIN 填成 ${s.badge.pin}，点 Issue badge，告诉我页面显示的 badge 编号。`,
    check: (s, final) => final.includes(s.badge.code) && s.badge.submitted?.employee === s.badge.employee && s.badge.submitted?.pin === s.badge.pin },
  { id: 'iframe', focus: 'control',
    prompt: (s) => `打开 ${base}/embed?run=${s.id} ，页面里嵌入的支持面板显示的支持码是多少？`,
    check: (s, final) => final.includes(s.support) },
  { id: 'directory', focus: 'control',
    prompt: (s) => `打开 ${base}/directory?run=${s.id} ，在通讯录里搜索 Okafor，告诉我这个人的分机号。`,
    check: (s, final) => final.includes(s.extensions.Okafor) },
].filter((task) => !values.only || values.only.split(',').includes(task.id));
if (!TASKS.length) throw new Error('No tasks selected');

if (values.serve) {
  const state = newRun();
  console.log(JSON.stringify({ base, run: state.id, pages: ['form', 'catalog', 'orders', 'report', 'settings', 'vault', 'badge', 'embed', 'directory']
    .map((name) => `${base}/${name}?run=${state.id}`), state: `${base}/__state?run=${state.id}`, answers: state }, null, 2));
  await new Promise(() => {});
}

const out = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-browser-task-eval-'));

// ---------------------------------------------------------------------------------------------
// --check: no model. The working tree's batch and cdp against the real browser and fixture pages.
// ---------------------------------------------------------------------------------------------
if (values.check) {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
  const trace = path.join(out, 'runtime-trace.jsonl');
  await fs.writeFile(trace, '');
  const client = new Client({ name: 'browser-task-check', version: '1' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: ['--import', import.meta.resolve('tsx'), fileURLToPath(import.meta.url),
    '--mcp', '--variant', 'C', '--runtime-dir', path.join(out, 'runtime'), '--trace', trace, '--cdp-port', String(await freePort())], stderr: 'inherit' }));
  const browser = async (args) => JSON.parse((await client.callTool({ name: 'call_tool', arguments: { name: 'browser', args } })).content[0].text);
  const state = newRun();
  const failures = [];
  const expect = (name, ok, detail) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}`); if (!ok) failures.push({ name, detail }); };
  const nodeId = (listing, label) => Number(listing.split('\n').find((line) => line.includes(label))?.match(/^\[(\d+)\]/)?.[1]);
  const refOf = (snapshot, label) => snapshot.split('\n').find((line) => line.includes(label))?.match(/\[ref=([^\]]+)\]/)?.[1];
  try {
    const listed = JSON.parse((await client.callTool({ name: 'list_tools', arguments: { category: 'browser' } })).content[0].text);
    expect('rules are tailored and carry no markers', !listed.rules['browser-workflow'].includes('<!--') && listed.rules['browser-workflow'].includes('batch'));

    // cdp: a button and its result inside a closed shadow root, which a snapshot cannot see.
    const vault = await browser({ action: 'open', url: `${base}/vault?run=${state.id}`, afterSnapshot: {} });
    expect('snapshot does not see the closed shadow root', vault.ok && !JSON.stringify(vault.afterSnapshot).includes('Reveal access code'));
    const vaultNodes = await browser({ action: 'cdp', targetId: vault.data.targetId, commands: [{ method: 'nodes', params: { filter: 'button' } }] });
    const reveal = nodeId(vaultNodes.data?.results?.[0]?.result?.nodes ?? '', 'Reveal access code');
    expect('cdp nodes lists the button inside it', Number.isInteger(reveal), vaultNodes);
    const revealed = await browser({ action: 'batch', targetId: vault.data.targetId, steps: [
      { action: 'cdp', commands: [{ method: 'click', params: { node: reveal } }] },
      { action: 'act', request: { kind: 'wait', timeMs: 800 } },
      { action: 'cdp', commands: [{ method: 'nodes', params: { filter: 'Access code' } }] },
    ] });
    expect('cdp click is a real click and the revealed code is readable', revealed.ok && JSON.stringify(revealed.steps[2]).includes(state.vault), revealed);

    // cdp: type into fields inside a closed shadow root, then submit.
    const badge = await browser({ action: 'open', url: `${base}/badge?run=${state.id}` });
    const fields = (await browser({ action: 'cdp', targetId: badge.data.targetId, commands: [{ method: 'nodes' }] })).data?.results?.[0]?.result?.nodes ?? '';
    const issued = await browser({ action: 'batch', targetId: badge.data.targetId, steps: [
      { action: 'cdp', commands: [
        { method: 'type', params: { node: nodeId(fields, 'textbox "Employee ID"'), text: state.badge.employee } },
        { method: 'type', params: { node: nodeId(fields, 'textbox "Door PIN"'), text: state.badge.pin } },
        { method: 'click', params: { node: nodeId(fields, 'Issue badge') } },
      ] },
      { action: 'act', request: { kind: 'wait', timeMs: 800 } },
      { action: 'cdp', commands: [{ method: 'call', params: { node: nodeId(fields, 'Issue badge'), fn: 'function(){ return this.parentNode.querySelector("p").textContent }' } }] },
    ] });
    expect('cdp type + click submit the shadow form and call reads the result', issued.ok && state.badge.submitted?.employee === state.badge.employee
      && state.badge.submitted?.pin === state.badge.pin && JSON.stringify(issued.steps[2]).includes(state.badge.code), issued);
    const refused = await browser({ action: 'cdp', targetId: badge.data.targetId, commands: [{ method: 'Network.getCookies' }] });
    expect('cdp refuses cookie reads', refused.ok === false);

    // batch: a whole form in one call, on refs from one snapshot.
    const form = await browser({ action: 'open', url: `${base}/form?run=${state.id}`, afterSnapshot: {} });
    const seen = form.afterSnapshot?.data?.snapshot ?? '';
    const filled = await browser({ action: 'batch', targetId: form.data.targetId, steps: [
      { action: 'act', request: { kind: 'type', ref: refOf(seen, 'textbox "Full name"'), text: 'Ada Lovelace' } },
      { action: 'act', request: { kind: 'type', ref: refOf(seen, 'textbox "Email"'), text: 'ada@example.test' } },
      { action: 'act', request: { kind: 'select', ref: refOf(seen, 'combobox'), values: ['Team'] } },
      { action: 'act', request: { kind: 'click', ref: refOf(seen, 'button "Create account"') }, afterSnapshot: {} },
    ] });
    expect('batch fills and submits a form in one call', filled.ok && filled.completed === 4 && state.form.submitted?.name === 'Ada Lovelace'
      && state.form.submitted?.plan === 'Team' && JSON.stringify(filled.steps[3]).includes(state.form.code), filled);

    // batch: several known addresses, each read once; then a failing step stops the rest.
    const skus = await browser({ action: 'batch', targetId: form.data.targetId, steps: [0, 2].flatMap((index) => [
      { action: 'navigate', url: `${base}/product?run=${state.id}&p=${index}` },
      { action: 'extract', extract: { fields: { sku: '#sku' } } },
    ]) });
    expect('batch reads several pages in order', skus.ok && JSON.stringify(skus.steps[1]).includes(state.skus['Alpha Lamp']) && JSON.stringify(skus.steps[3]).includes(state.skus['Cobalt Desk']), skus);
    const before = readFileSync(trace, 'utf8').split('\n').length;
    const stopped = await browser({ action: 'batch', targetId: form.data.targetId, steps: [
      { action: 'act', request: { kind: 'click', ref: 'e999999' , timeoutMs: 1500 } },
      { action: 'navigate', url: `${base}/catalog?run=${state.id}` },
    ] });
    const navigated = readFileSync(trace, 'utf8').split('\n').slice(before - 1).some((line) => line.includes('"navigate"'));
    expect('batch stops at a failed step and runs nothing after it', stopped.ok === false && stopped.failedStep === 0 && stopped.completed === 0 && !navigated, stopped);
  } catch (error) {
    failures.push({ name: 'check crashed', detail: String(error?.stack ?? error) });
  } finally {
    await client.close().catch(() => {});
    for (const server of servers) server.close();
  }
  if (failures.length) console.log(JSON.stringify(failures, null, 2).slice(0, 6000));
  console.log(failures.length ? `\n${failures.length} check(s) failed` : '\nall checks passed');
  process.exit(failures.length ? 1 : 0);
}
const baselineSha = execFileSync('git', ['rev-parse', values['baseline-ref']], { cwd: root, encoding: 'utf8' }).trim();
const manifest = { kind: 'live-model-real-browser-fixture-pages', model: values.model, repeats, variants, baselineRef: values['baseline-ref'], baselineSha,
  head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  dirty: execFileSync('git', ['status', '--porcelain', '--', browserDir], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean),
  tasks: TASKS.map((task) => ({ id: task.id, focus: task.focus })),
  limitations: ['Dedicated-browser runtime only; sidebar and My browser are not exercised.', 'Fixture pages, not real sites.',
    'Claude Code print mode with only the browser tools; not a full Cindy session.'] };
await fs.writeFile(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 2));
console.log(JSON.stringify({ outputDir: out, ...manifest, tasks: manifest.tasks.map((task) => task.id) }));

const SYSTEM = '你是 Cindy，帮助用户完成请求。用中文简洁回答，事实以实际读取的内容为准。';
async function runOne(task, variant, repetition) {
  const state = newRun();
  const dir = path.join(out, `${task.id}-${variant}-${repetition}`);
  await fs.mkdir(path.join(dir, 'cwd'), { recursive: true });
  const trace = path.join(dir, 'runtime-trace.jsonl');
  await fs.writeFile(trace, '');
  const config = path.join(dir, 'mcp.json');
  await fs.writeFile(config, JSON.stringify({ mcpServers: { cindy_browser: { command: process.execPath, args: ['--import', import.meta.resolve('tsx'),
    fileURLToPath(import.meta.url), '--mcp', '--variant', variant, '--baseline-ref', baselineSha, '--runtime-dir', path.join(dir, 'runtime'),
    '--trace', trace, '--cdp-port', String(await freePort())] } } }));
  const started = Date.now();
  const child = spawn('claude', ['-p', task.prompt(state), '--output-format', 'stream-json', '--verbose', '--model', values.model,
    '--system-prompt', SYSTEM, '--tools', '', '--strict-mcp-config', '--mcp-config', config,
    '--allowedTools', 'mcp__cindy_browser__list_tools', 'mcp__cindy_browser__call_tool',
    '--no-session-persistence', '--setting-sources', 'project', '--max-turns', '40'],
  { cwd: path.join(dir, 'cwd'), stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, MCP_TIMEOUT: '90000' } });
  let stdout = '', stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const timer = setTimeout(() => child.kill('SIGTERM'), 8 * 60_000);
  const exit = await new Promise((resolve) => child.on('close', resolve));
  clearTimeout(timer);
  await fs.writeFile(path.join(dir, 'stream.jsonl'), stdout);
  if (stderr) await fs.writeFile(path.join(dir, 'stderr.txt'), stderr);
  const events = stdout.split('\n').filter(Boolean).flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
  const result = events.find((event) => event.type === 'result');
  const toolCalls = [];
  let resultChars = 0;
  for (const event of events) {
    for (const block of event.message?.content ?? []) {
      if (event.type === 'assistant' && block.type === 'tool_use') {
        const args = block.input?.args ?? {};
        toolCalls.push(block.name.endsWith('list_tools') ? 'list_tools'
          : args.action === 'batch' ? `batch(${(args.steps ?? []).map((step) => step.action === 'act' ? step.request?.kind : step.action).join(',')})`
          : args.action === 'cdp' ? `cdp(${(args.commands ?? []).map((command) => command.method).join(',')})`
          : args.action === 'act' ? `act:${args.request?.kind}` : String(args.action));
      }
      if (event.type === 'user' && block.type === 'tool_result') resultChars += JSON.stringify(block.content ?? '').length;
    }
  }
  const final = typeof result?.result === 'string' ? result.result : '';
  const runtimeCalls = readFileSync(trace, 'utf8').split('\n').filter(Boolean).length;
  const usage = result?.usage ?? {};
  const row = { task: task.id, focus: task.focus, variant, repetition,
    pass: exit === 0 && result?.is_error === false && task.check(state, final),
    error: exit !== 0 ? `claude exited ${exit}` : result?.is_error ? String(result.subtype ?? 'error') : undefined,
    turns: result?.num_turns ?? null, browserCalls: toolCalls.filter((name) => name !== 'list_tools').length, runtimeCalls,
    costUsd: result?.total_cost_usd ?? null, durationMs: result?.duration_ms ?? Date.now() - started, wallMs: Date.now() - started,
    inputTokens: (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0),
    outputTokens: usage.output_tokens ?? null, toolResultChars: resultChars, toolCalls, final };
  await fs.writeFile(path.join(dir, 'result.json'), JSON.stringify({ ...row, answers: state }, null, 2));
  // The browser profile is tens of MB per run and holds no evidence.
  await fs.rm(path.join(dir, 'runtime'), { recursive: true, force: true }).catch(() => {});
  runs.delete(state.id);
  console.log(JSON.stringify({ task: row.task, variant, repetition, pass: row.pass, turns: row.turns, browserCalls: row.browserCalls,
    costUsd: row.costUsd, seconds: Math.round(row.durationMs / 1000), error: row.error, calls: row.toolCalls.join(' → ') }));
  return row;
}

// Interleave variants within each repetition so drift in the provider or machine hits both alike.
const queue = [];
for (let repetition = 0; repetition < repeats; repetition++) {
  for (const task of TASKS) {
    const order = repetition % 2 ? [...variants].reverse() : variants;
    for (const variant of order) queue.push({ task, variant, repetition });
  }
}
const rows = [];
await Promise.all(Array.from({ length: Math.min(parallel, queue.length) }, async () => {
  for (let job = queue.shift(); job; job = queue.shift()) {
    rows.push(await runOne(job.task, job.variant, job.repetition).catch((error) => ({ task: job.task.id, focus: job.task.focus,
      variant: job.variant, repetition: job.repetition, pass: false, error: String(error?.message ?? error), toolCalls: [] })));
  }
}));
for (const server of servers) server.close();

const mean = (list) => list.length ? list.reduce((sum, value) => sum + value, 0) / list.length : null;
const summarize = (subset) => {
  const measured = subset.filter((row) => typeof row.turns === 'number');
  return { runs: subset.length, passed: subset.filter((row) => row.pass).length,
    turns: mean(measured.map((row) => row.turns)), browserCalls: mean(measured.map((row) => row.browserCalls)),
    costUsd: mean(measured.filter((row) => typeof row.costUsd === 'number').map((row) => row.costUsd)),
    seconds: mean(measured.map((row) => row.durationMs / 1000)), toolResultChars: mean(measured.map((row) => row.toolResultChars)) };
};
const summary = { byVariant: Object.fromEntries(variants.map((variant) => [variant, summarize(rows.filter((row) => row.variant === variant))])),
  byTask: Object.fromEntries(TASKS.map((task) => [task.id, Object.fromEntries(variants.map((variant) =>
    [variant, summarize(rows.filter((row) => row.task === task.id && row.variant === variant))]))])) };
await fs.writeFile(path.join(out, 'results.json'), JSON.stringify({ manifest, summary, rows }, null, 2));
const fmt = (value, digits = 1) => value === null ? '-' : value.toFixed(digits);
console.log('\nvariant  pass      turns  calls  cost$   seconds');
for (const variant of variants) {
  const s = summary.byVariant[variant];
  console.log(`${variant.padEnd(8)} ${`${s.passed}/${s.runs}`.padEnd(9)} ${fmt(s.turns).padEnd(6)} ${fmt(s.browserCalls).padEnd(6)} ${fmt(s.costUsd, 3).padEnd(7)} ${fmt(s.seconds)}`);
}
console.log('\ntask        variant  pass   turns  calls  cost$   seconds');
for (const task of TASKS) for (const variant of variants) {
  const s = summary.byTask[task.id][variant];
  console.log(`${task.id.padEnd(11)} ${variant.padEnd(8)} ${`${s.passed}/${s.runs}`.padEnd(6)} ${fmt(s.turns).padEnd(6)} ${fmt(s.browserCalls).padEnd(6)} ${fmt(s.costUsd, 3).padEnd(7)} ${fmt(s.seconds)}`);
}
console.log(`\nresults: ${path.join(out, 'results.json')}`);
process.exit(0);
