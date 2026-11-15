/** Isolated --mock acceptance; never run against a signed-in/shared profile.
 * node apps/desktop/scripts/benchmark-plugin-refresh.cjs <label> <output-dir> [cdp-port] [inspector-port]
 * Enable the mock Electron's inspector with process._debugProcess(itsVerifiedPid).
 * Installs synthetic packages via the real manager; no production instrumentation is added.
 */
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const desktop = path.resolve(__dirname, '..');
const req = createRequire(path.join(desktop, 'package.json'));
const { chromium } = req('playwright-core');

async function connectInspector(port) {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(10_000) })).json();
  const ws = new WebSocket(targets[0].webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let id = 0;
  const pending = new Map();
  const listeners = new Map();
  ws.onmessage = ({ data }) => {
    const m = JSON.parse(data);
    if (m.id) {
      const complete = pending.get(m.id); pending.delete(m.id);
      if (typeof complete !== 'function') return;
      complete(m);
    } else if (m.method === 'Debugger.paused') {
      // This benchmark only consumes pause events; never dispatch by a remote name.
      const onPaused = listeners.get('Debugger.paused');
      if (typeof onPaused === 'function') onPaused(m.params);
    }
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const requestId = ++id;
    const timer = setTimeout(() => { pending.delete(requestId); reject(Error(`Inspector timeout: ${method}`)); }, 20_000);
    pending.set(requestId, response => {
      clearTimeout(timer);
      if (response.error) reject(new Error(JSON.stringify(response.error))); else resolve(response.result);
    });
    ws.send(JSON.stringify({ id: requestId, method, params }));
  });
  const evaluate = async (expression, awaitPromise = false) => {
    const r = await send('Runtime.evaluate', { expression: `globalThis.__benchEvaluation = (${expression})`, awaitPromise, returnByValue: true }).catch(error => { throw new Error(expression + ': ' + error.message); });
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
    return r.result.value;
  };
  return { ws, send, evaluate, listeners };
}

async function main() {
  const [label, outputDir, cdp = '9358', inspectorPort = '9229'] = process.argv.slice(2);
  if (!label || !outputDir || !/^[a-z0-9-]+$/i.test(label)) throw Error('label and output directory required');
  const out = path.resolve(outputDir);
  const repo = path.resolve(desktop, '../..');
  if (out === repo || out.startsWith(repo + path.sep)) throw Error('Use an output directory outside the repository');
  fs.mkdirSync(out, { recursive: true });
  const inspector = await connectInspector(inspectorPort);
  let browser, page;
  try {
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdp}`);
    page = browser.contexts()[0].pages().find(p => /\/#\/cc-agent\/ui-mock-/.test(p.url()));
    if (!page) throw Error('Open the isolated mock task page first');
    const identity = await inspector.evaluate(`({pid:process.pid, argv:process.argv, mock:process.env.XDT_UI_MOCK})`);
    if (identity.mock !== '1') throw Error('Inspector target must be a --mock process');
    console.log('Inspector target', JSON.stringify(identity));
    await inspector.send('Debugger.enable');
    const chunk = fs.readdirSync(path.join(desktop, '.vite/build')).find(name =>
      name.startsWith('bootstrap-electron-') && name.endsWith('.js') &&
      fs.readFileSync(path.join(desktop, '.vite/build', name), 'utf8').includes('function getGhostManager()'));
    if (!chunk) throw Error('Build no longer exposes the benchmark entry; update this inspector adapter');
    const source = fs.readFileSync(path.join(desktop, '.vite/build', chunk), 'utf8').split('\n');
    const lineNumber = source.findIndex(line => line.startsWith('function getGhostManager()')) + 1;
    if (!lineNumber) throw Error('Cannot locate getGhostManager breakpoint');
    const paused = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('Timed out entering mock manager')), 15_000);
      inspector.listeners.set('Debugger.paused', value => { clearTimeout(timer); resolve(value); });
    });
    const bp = await inspector.send('Debugger.setBreakpointByUrl', { urlRegex: chunk.replaceAll('.', '\\.'), lineNumber });
    const trigger = page.evaluate(() => window.electronAPI.ghosts.listSync().ghosts.length);
    const frame = (await paused).callFrames[0].callFrameId;
    const setup = await inspector.send('Debugger.evaluateOnCallFrame', { callFrameId: frame, returnByValue: true,
      expression: `(() => {
        const app = require('electron').app;
        const getActiveAppSession = appSessionState.getActiveAppSession;
        const root = app.getPath('userData');
        if (app.isPackaged || !root.endsWith('plugin-refresh-bench') || getActiveAppSession().mode !== 'local') throw Error('Not the isolated local benchmark sandbox');
        const manager = getGhostManager();
        globalThis.__pluginBench ??= { manager, gateway: getGhostSubscriptionGateway(), root,
          install: async file => manager.install(file, { namespace: null }),
          activeScans: 0, stats: {}, originals: [] };
        const b = globalThis.__pluginBench;
        b.reset = () => { b.stats = { list: 0, listAsync: 0, reads: 0, sent: 0, scanMs: 0 }; return true; };
        if (!b.originals.length) {
          for (const name of ['list', 'listAsync', 'findInstalledInstance']) {
            const original = manager[name]; b.originals.push([manager, name, original]);
            manager[name] = function(...args) {
              b.stats[name === 'findInstalledInstance' ? 'reads' : name]++;
              const start = performance.now();
              if (name !== 'findInstalledInstance') b.activeScans++;
              const finish = () => { if (name !== 'findInstalledInstance') { b.activeScans--; b.stats.scanMs += performance.now() - start; } };
              try { const result = original.apply(this, args);
                if (result instanceof Promise) return result.finally(finish); finish(); return result;
              } catch (error) { finish(); throw error; }
            };
          }
          const original = b.gateway.deps.sendToGhost;
          b.originals.push([b.gateway.deps, 'sendToGhost', original]);
          b.gateway.deps.sendToGhost = function(...args) { const result = original.apply(this,args); b.stats.sent++; return result; };
        }
        b.reset(); return { root, owner: getActiveAppSession().mode };
      })()` });
    await inspector.send('Debugger.removeBreakpoint', { breakpointId: bp.breakpointId });
    await inspector.send('Debugger.resume');
    await trigger;
    if (setup.exceptionDetails) throw Error(JSON.stringify(setup.exceptionDetails));
    console.log('Verified mock', JSON.stringify(setup.result.value));
    await inspector.send('Debugger.disable');

    const JSZip = req('jszip');
    const fixture = path.join(out, 'fixtures'); fs.mkdirSync(fixture, { recursive: true });
    const installed = await inspector.evaluate(`__pluginBench.manager.list().map(g => g.manifest.id)`);
    console.log('Installed fixture count', installed.length);
    for (let n = 0; n < 30; n++) {
      const id = `refresh-fixture-${n}`;
      if (installed.includes(id)) continue;
      const zip = new JSZip();
      zip.file('ghost.json', JSON.stringify({ schemaVersion: 3, minCindyVersion: '0.1.0', id,
        name: `Refresh fixture ${n}`, version: '1.0.0', entry: 'main.js',
        ...(n === 0 ? { subscribe: { topics: ['session'] } } : {}) }));
      zip.file('main.js', 'globalThis.receivedEvents=[]; cindy.onHostMessage(m=>{if(m.type==="event")globalThis.receivedEvents.push(m);});');
      const file = path.join(fixture, `${id}.cindy`);
      fs.writeFileSync(file, await zip.generateAsync({ type: 'nodebuffer' }));
      const result = await inspector.evaluate(`__pluginBench.install(${JSON.stringify(file)}).then(r=>({ok:!!r.ghost, error:r.reason}))`, true);
      if (!result.ok) throw Error(JSON.stringify(result));
      console.log('Installed', id);
    }
    const tasks = ['ui-mock-showcase-feedback-zh', 'ui-mock-showcase-plan-zh', 'ui-mock-showcase-review-zh', 'ui-mock-showcase-release-zh'];
    const rows = [];
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    const settle = async () => {
      const deadline = Date.now() + 15_000;
      let quiet = 0;
      while (quiet < 2) {
        await sleep(300);
        const idle = await inspector.evaluate('!__pluginBench.activeScans && !__pluginBench.gateway.discovery');
        quiet = idle ? quiet + 1 : 0;
        if (Date.now() > deadline) throw Error('Plugin discovery did not settle');
      }
    };
    for (const subscribers of [0, 1]) {
      console.log('Starting scenario', subscribers);
      const subscriberId = await inspector.evaluate(`__pluginBench.manager.list().find(g=>g.manifest.id==='refresh-fixture-0').instanceKey`);
      await page.evaluate(({id,enabled}) => window.electronAPI.ghosts.setEnabled(id,enabled), {id:subscriberId, enabled:subscribers===1});
      // Warm the actual route / notification / sandbox path before timing.
      for (const id of tasks) { await page.evaluate(id => { location.hash = '/cc-agent/' + id; }, id); await settle(); }
      await inspector.evaluate('__pluginBench.reset()');
      await page.evaluate(() => {
        window.__refreshBenchLong = [];
        window.__refreshBenchObserver?.disconnect();
        window.__refreshBenchObserver = new PerformanceObserver(list => window.__refreshBenchLong.push(...list.getEntries().map(e => e.duration)));
        window.__refreshBenchObserver.observe({ type: 'longtask' });
      });
      const switches = [];
      for (let round = 0; round < 3; round++) for (const id of tasks) {
        const start = performance.now();
        await page.evaluate(id => { location.hash = '/cc-agent/' + id; }, id);
        await page.waitForURL(`**/#/cc-agent/${id}`);
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        switches.push(performance.now() - start);
        await settle();
      }
      rows.push({ kind: 'switch', subscribers, switches,
        longTasks: await page.evaluate(() => window.__refreshBenchLong),
        stats: await inspector.evaluate('__pluginBench.stats') });
      if (rows.at(-1).stats.sent !== subscribers * 12) throw Error('Unexpected session notification delivery count');
      console.log(JSON.stringify(rows.at(-1)));
    }
    const target = await inspector.evaluate(`__pluginBench.manager.list().find(g=>g.manifest.id==='refresh-fixture-1').instanceKey`);
    const workdir = path.join(out, 'project'); fs.mkdirSync(workdir, { recursive: true });
    await settle();
    await page.evaluate(() => {
      window.__policyBench = { roster: 0, policy: 0 };
      window.__policyBenchStops = [
        window.electronAPI.ghosts.onChanged(() => window.__policyBench.roster++),
        window.electronAPI.ghosts.onWorkdirPrefsChanged?.(() => window.__policyBench.policy++),
      ];
    });
    await inspector.evaluate('__pluginBench.reset()');
    const toggles = [];
    for (let n = 0; n < 12; n++) {
      const start = performance.now();
      await page.evaluate(({workdir,target,disabled}) => window.electronAPI.ghosts.setWorkdirDisabled(workdir,target,disabled), {workdir,target,disabled:n % 2 === 0});
      toggles.push(performance.now() - start); await settle();
    }
    const pushes = await page.evaluate(() => {
      window.__policyBenchStops.forEach(stop => stop?.());
      return window.__policyBench;
    });
    rows.push({ kind: 'workdir-policy', toggles, pushes, stats: await inspector.evaluate('__pluginBench.stats') });
    console.log(JSON.stringify(rows.at(-1)));
    await page.screenshot({ path: path.join(out, `${label}.png`) });
    fs.writeFileSync(path.join(out, `${label}.json`), JSON.stringify({ label, platform: process.platform, fixture: { plugins:30, switches:12 }, rows }, null, 2));
  } finally {
    await inspector.send('Debugger.resume').catch(() => {});
    await inspector.send('Debugger.disable').catch(() => {});
    await page?.evaluate(() => {
      window.__refreshBenchObserver?.disconnect();
      window.__policyBenchStops?.forEach(stop => stop?.());
      for (const key of ['__refreshBenchObserver', '__refreshBenchLong', '__policyBenchStops', '__policyBench']) delete window[key];
    }).catch(() => {});
    await inspector.evaluate(`(()=>{if(globalThis.__pluginBench){for(const [o,k,v] of __pluginBench.originals)o[k]=v;delete globalThis.__pluginBench;}delete globalThis.__benchEvaluation;return true;})()`).catch(() => {});
    inspector.ws.close(); await browser?.close();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
