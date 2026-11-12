/**
 * Opt-in, read-only live integration experiment, not a unit test.
 * Production entry: BrowserToolRegistry -> registerBrowserTools -> real runtime.
 * Evidence gap: prior Google Play runs needed a second observation after every
 * click. Compare that path with explicit readiness + extraction, split/recipe.
 * All selectors/fields come from a separately inspected plan, never credentials.
 * Only attach to the already-authorized Cindy browser; never start/stop Chrome.
 */
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { createServer } from 'vite';

const opt = (name) => process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const sourceRoot = opt('source-root');
const cdpUrl = opt('cdp-url');
const targetId = opt('target');
const planFile = opt('plan');
const output = opt('out');
const order = (opt('order') ?? 'snapshot,precise,recipe,precise,recipe,snapshot,recipe,snapshot,precise').split(',');
if (!sourceRoot || !cdpUrl || !targetId || !planFile || !output || order.some((m) => !['snapshot', 'precise', 'recipe', 'guarded'].includes(m))) {
  throw new Error('需要 source-root/cdp-url/target/plan/out；order 只接受 snapshot/precise/recipe/guarded');
}
const plan = JSON.parse(await fs.readFile(planFile, 'utf8'));
const origin = new URL(plan.startUrl).origin;
const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-live-recipe-'));
process.env.XDT_BROWSER_RUNTIME_DIR = tempRoot;
const fromSource = (file) => import(pathToFileURL(path.join(sourceRoot, file)).href);
let vite, disconnect, active, currentCall, lastRuntimeUrl;
const report = {
  startedAt: new Date().toISOString(), sourceRoot,
  sourceHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot, encoding: 'utf8' }).trim(),
  planFile, order, runs: [], setup: [],
  scope: '真实页面生产工具调用；不含模型推理和宿主 MCP 往返；配方只在实验进程内注册',
};
const checksOf = (step) => [...new Set([step.readyText, ...(step.checks ?? [])])];
// Use supported locator + URL conditions. The pilot exposed that wait.fn with
// a function-source string is truthy in the installed Playwright version.
const readySelector = (step) => '#main-content' + checksOf(step).map((text) => `:has-text(${JSON.stringify(text)})`).join('');
try {
  // Vite expands the production import.meta.glob catalog. No mocked recipe loader.
  vite = await createServer({ root: sourceRoot, configFile: false, appType: 'custom',
    optimizeDeps: { noDiscovery: true, include: [], entries: [] },
    server: { middlewareMode: true, watch: null }, logLevel: 'error' });
  const { registerBrowserTools } = await vite.ssrLoadModule('/packages/lizi-mcps/src/browser/tools.ts');
  const { RecipeSchema } = await vite.ssrLoadModule('/packages/lizi-mcps/src/browser/recipe-loader.ts');
  const { BrowserToolRegistry } = await fromSource('packages/lizi-mcps/src/browser/tool-registry.ts');
  const { createBrowserControlRuntime } = await fromSource('packages/browser-control-runtime/src/runtime.ts');
  ({ closePlaywrightBrowserConnection: disconnect } = await fromSource('packages/browser-control-runtime/src/_generated/extension/src/browser/pw-session.ts'));
  const recipes = new Map(plan.steps.map((step, i) => {
    const recipe = RecipeSchema.parse({ id: `live-readonly-step-${i}`, match: [new URL(plan.startUrl).host],
      steps: [
        { action: 'click', selector: step.selector, timeoutMs: 15000 },
        { action: 'wait', url: origin + step.expectedPath, selector: readySelector(step), timeoutMs: 15000 },
        { action: 'extract', extract: step.extract, as: 'data' },
      ], output: '{{data}}' });
    return [recipe.id, recipe];
  }));
  for (const [i, step] of plan.steps.entries()) {
    const basic = recipes.get(`live-readonly-step-${i}`);
    const guarded = RecipeSchema.parse({ ...basic, id: `live-guarded-step-${i}`,
      validation: { site: new URL(plan.startUrl).host, state: 'active' },
      steps: basic.steps.map((s, n) => n === 0 ? { ...s,
        guard: { url: i ? origin + plan.steps[i - 1].expectedPath : plan.startUrl,
          selector: step.selector.replace(/:visible/g, '') },
      } : n === 2 ? { ...s, guard: { url: origin + step.expectedPath, selector: '#main-content' },
        expect: { minCount: 1, requiredFields: Object.keys(step.extract.fields) },
      } : s),
    });
    recipes.set(guarded.id, guarded);
  }
  report.recipes = [...recipes.values()];
  const runtime = createBrowserControlRuntime({
    config: { browser: { enabled: true, attachOnly: true, defaultProfile: 'live-comparison',
      profiles: { 'live-comparison': { cdpUrl, attachOnly: true, color: '#00D9C5' } },
      ssrfPolicy: { dangerouslyAllowPrivateNetwork: true } } }, logSink: () => {},
  });
  const observedRuntime = new Proxy(runtime, { get(target, prop) {
    if (prop !== 'call') return Reflect.get(target, prop);
    return async (req) => {
      const started = performance.now();
      const result = await target.call(req);
      if (result.data?.url) lastRuntimeUrl = result.data.url;
      currentCall?.runtime.push({ action: req.action, kind: req.request?.kind,
        ms: performance.now() - started, ok: result.ok, url: result.data?.url });
      return result;
    };
  } });
  let recipeVersion = 0;
  const registry = new BrowserToolRegistry();
  registerBrowserTools(registry, { getRuntime: () => observedRuntime, supportsSemanticQueries: () => false,
    getUserRecipes: async () => ({ recipes, siteGuides: new Map(), version: `live-recipe-experiment-${recipeVersion}` }),
    saveUserRecipe: async ({ recipe }) => { recipes.set(recipe.id, recipe); recipeVersion++; return { ok: true }; } });
  const call = async (args, measured = true, allowFailure = false) => {
    const row = { args, runtime: [] };
    currentCall = row;
    const started = performance.now();
    try {
      const response = await registry.call('browser', { targetId, ...args });
      const text = response.content.filter((c) => c.type === 'text').map((c) => c.text).join('');
      row.result = JSON.parse(text);
      row.characters = text.length;
      if (!row.result.ok && !allowFailure) throw new Error(row.result.message ?? text);
      if (lastRuntimeUrl && new URL(lastRuntimeUrl).origin !== origin) throw new Error('页面离开目标网站，停止实验');
      return row.result;
    } finally {
      row.ms = performance.now() - started;
      (measured && active ? active.rows : report.setup).push(row);
      currentCall = undefined;
    }
  };
  const snapshot = () => call({ action: 'snapshot', refs: 'aria', compact: true });
  const wait = (step, measured = true) => call({ action: 'act', request: { kind: 'wait', url: origin + step.expectedPath, selector: readySelector(step), timeoutMs: 15000 } }, measured);
  for (const mode of order) {
    active = { mode, rows: [], checkpoints: [], staleObservations: 0, startedAt: new Date().toISOString() };
    report.runs.push(active);
    await call({ action: 'navigate', url: plan.startUrl }, false);
    await wait({ expectedPath: new URL(plan.startUrl).pathname, readyText: plan.startReadyText }, false);
    // Registry/catalog initialization is measured as setup, not hidden in the first recipe.
    await call({ action: 'siteguide' }, false);
    const started = performance.now();
    let observed = await snapshot();
    for (const [i, step] of plan.steps.entries()) {
      let evidence, structured;
      if (mode === 'snapshot') {
        const lines = (observed.data?.snapshot ?? '').split('\n');
        const matches = Object.entries(observed.data?.refs ?? {}).filter(([id, ref]) => {
          if (ref.role !== step.role || ref.name !== step.name) return false;
          if (!step.href) return true;
          const line = lines.findIndex((t) => t.includes(`[ref=${id}]`));
          return lines[line + 1]?.trim() === `- /url: ${step.href}`;
        });
        if (matches.length !== 1) throw new Error(`导航控件不唯一或缺失：${step.name}`);
        const result = await call({ action: 'act', request: { kind: 'click', ref: matches[0][0] }, afterSnapshot: step.afterSnapshot });
        observed = result.afterSnapshot;
        if (!observed?.ok) throw new Error('点击成功但观察失败，停止，不重复动作');
        const ready = () => new URL(observed.data.url).pathname === step.expectedPath && checksOf(step).every((t) => observed.data.snapshot.includes(t));
        if (!ready()) {
          active.staleObservations++;
          // Same explicit readiness predicate in every arm; snapshot arm still
          // incurs the premature read that the experiment is investigating.
          await wait(step);
          observed = await snapshot();
        }
        if (!ready()) throw new Error(`缺少页面验收结果：${step.name}`);
        evidence = observed.data.snapshot;
      } else {
        let result;
        if (mode === 'recipe' || mode === 'guarded') {
          result = await call({ action: 'recipe', recipeId: `live-${mode === 'guarded' ? 'guarded' : 'readonly'}-step-${i}` });
          structured = result.output;
        } else {
          await call({ action: 'act', request: { kind: 'click', selector: step.selector, timeoutMs: 15000 } });
          await wait(step);
          result = await call({ action: 'extract', extract: step.extract });
          structured = result.data?.result;
        }
        if (!structured?.ok || structured.count < 1) throw new Error(`提取结果为空或失败：${step.name}`);
        evidence = JSON.stringify(structured);
      }
      const checks = checksOf(step).map((text) => ({ text, found: evidence.includes(text) }));
      const checkpoint = { click: step.name, url: lastRuntimeUrl, checks, ...(structured ? { structured } : {}) };
      active.checkpoints.push(checkpoint);
      if (new URL(lastRuntimeUrl).pathname !== step.expectedPath || checks.some((c) => !c.found)) {
        throw new Error(`页面或业务检查点不匹配：${JSON.stringify(checkpoint)}`);
      }
    }
    active.wallMs = performance.now() - started;
    active.ok = true;
    active.calls = active.rows.length;
    active.characters = active.rows.reduce((sum, row) => sum + row.characters, 0);
    active.runtimeCalls = active.rows.reduce((sum, row) => sum + row.runtime.length, 0);
    active.finalUrl = lastRuntimeUrl;
    console.log(JSON.stringify({ mode, run: report.runs.length, calls: active.calls, characters: active.characters,
      runtimeCalls: active.runtimeCalls, wallMs: active.wallMs, staleObservations: active.staleObservations, ok: true }));
    await fs.writeFile(output, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  }
  if (opt('maintenance-checks') === 'true') {
    active = undefined;
    report.maintenance = [];
    const probe = async (name, args, check) => {
      const result = await call(args, false, true);
      check(result);
      report.maintenance.push({ name, ok: true, result });
      return result;
    };
    await probe('wait false times out', { action: 'act', request: { kind: 'wait', fn: '() => false', timeoutMs: 200 } }, r => { assert.equal(r.ok, false); assert.match(r.message, /[Tt]imeout/); });
    await probe('wait true succeeds', { action: 'act', request: { kind: 'wait', fn: '() => true', timeoutMs: 200 } }, r => assert.equal(r.ok, true));
    await probe('async false cannot fake success', { action: 'act', request: { kind: 'wait', fn: 'async () => false', timeoutMs: 200 } }, r => { assert.equal(r.ok, false); assert.match(r.message, /synchronous predicate/); });
    await probe('wait evaluates until true', { action: 'act', request: { kind: 'wait', fn: `() => Date.now() >= ${Date.now() + 300}`, timeoutMs: 2000 } }, r => assert.equal(r.ok, true));
    const site = new URL(plan.startUrl).host;
    const draft = { id: 'live-maintenance-overview', steps: [{ action: 'extract',
      guard: { url: plan.startUrl, selector: '#main-content' },
      extract: plan.steps.at(-1).extract, expect: { minCount: 1, requiredFields: ['title'], equals: { title: '发布概览' } },
      as: 'data' }], output: '{{data}}' };
    await probe('reject unverified save', { action: 'saveRecipe', site, recipeDraft: draft }, r => assert.equal(r.ok, false));
    await probe('validate candidate on real page', { action: 'recipe', site, recipeDraft: draft }, r => assert.equal(r.verified, true));
    await probe('reject altered draft', { action: 'saveRecipe', site, recipeDraft: { ...draft, description: 'changed' } }, r => assert.equal(r.ok, false));
    await probe('save verified draft', { action: 'saveRecipe', site, recipeDraft: draft }, r => assert.equal(r.ok, true));
    await call({ action: 'navigate', url: origin + plan.steps[0].expectedPath }, false);
    await wait(plan.steps[0], false);
    await probe('wrong page stops before action', { action: 'recipe', recipeId: draft.id }, r => { assert.equal(r.failureKind, 'guard'); assert.equal(r.steps.length, 0); });
    assert.equal(recipes.get(draft.id).validation.state, 'suspended');
    await probe('suspended recipe does not execute', { action: 'recipe', recipeId: draft.id }, r => assert.equal(r.ok, false));
    assert.equal(report.setup.at(-1).runtime.length, 0);
    const repaired = { ...draft, steps: [{ ...draft.steps[0], guard: { url: origin + plan.steps[0].expectedPath, selector: '#main-content' },
      extract: plan.steps[0].extract, expect: { minCount: 1, requiredFields: Object.keys(plan.steps[0].extract.fields) } }] };
    await probe('one observed repair passes', { action: 'recipe', site, recipeDraft: repaired }, r => assert.equal(r.verified, true));
    await probe('save repaired definition', { action: 'saveRecipe', site, recipeDraft: repaired }, r => assert.equal(r.ok, true));
    assert.equal(recipes.get(draft.id).validation.state, 'active');
    const bad = { ...repaired, id: 'live-missing-field', steps: [{ ...repaired.steps[0], expect: { requiredFields: ['missingField'] } }] };
    await probe('missing field rejected', { action: 'recipe', site, recipeDraft: bad }, r => assert.equal(r.failureKind, 'expect'));
    await probe('one failed repair rejected', { action: 'recipe', site, recipeDraft: bad }, r => assert.equal(r.failureKind, 'expect'));
    await probe('repair loop blocked', { action: 'recipe', site, recipeDraft: bad }, r => assert.match(r.message, /次数已用完/));
    assert.equal(report.setup.at(-1).runtime.length, 0);
    await probe('failed repair cannot be saved', { action: 'saveRecipe', site, recipeDraft: bad }, r => assert.equal(r.ok, false));
    await call({ action: 'navigate', url: plan.startUrl }, false);
    await wait({ expectedPath: new URL(plan.startUrl).pathname, readyText: plan.startReadyText }, false);
    console.log(JSON.stringify({ maintenanceChecks: report.maintenance.length, ok: true }));
  }
  report.ok = true;
} catch (error) {
  report.ok = false;
  report.error = String(error);
  if (active) active.ok = false;
  console.error(report.error);
} finally {
  // Disconnect only this client; leave Chrome and its login intact.
  await disconnect?.({ cdpUrl });
  await vite?.close();
  await fs.rm(tempRoot, { recursive: true, force: true });
  await fs.writeFile(output, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
}
process.exitCode = report.ok ? 0 : 1;
