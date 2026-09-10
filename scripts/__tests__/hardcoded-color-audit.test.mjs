import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import matter from 'gray-matter';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { findBareColors, matchBareColors } from '../shared/hardcoded-color-match.mjs';
import { addedLines, inspectFile, readExemptions, objectPathAt, audit } from '../hardcoded-color-audit.mjs';
import { classifyDesignLayer, reportDesignLayers } from '../shared/design-layer-report.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const exemptions = readExemptions(root);
const renderer = 'apps/desktop/src/renderer/';
const inspect = (file, source) => inspectFile(file, source, new Set(source.split('\n').map((_, i) => i + 1)), exemptions);

test('semantic colours, PR prose, URL and comments are not literals; numeric hex still is', () => {
  for (const source of ['hsl(var(--destructive))', 'hsla(var(--x) / .5)', 'rgb(var(--x))',
    'color-mix(in srgb, var(--a), var(--b))', 'PR #4135', '/* #4135 */',
    '// #4108\nconst link = "https://github.com/x/y/pull/4135";',
    '[#4022](https://github.com/x/y/pull/4022)', 'const label = "PR #4135";',
    '<a href="#fff">Link</a>', '&#229;', '#face { color: var(--x); }']) assert.deepEqual(matchBareColors(source), [], source);
  for (const value of ['#fff', '#1234', '#123456', '#12345678', 'rgb(1, 2, 3)', 'hsl(120 10% 20%)', 'oklch(.4 .2 120)']) {
    assert.deepEqual(matchBareColors(`const style = { color: '${value}' };`), [value]);
  }
});

test('numeric colour functions need a colour-bearing context; plain strings are prose', () => {
  for (const source of [
    "const label = 'RGB(1, 2, 3)';", "const label = 'hsl(120, 10%, 20%)';",
    "title: 'rgb(1, 2, 3) format example'", '帮助文案：支持 RGB(1, 2, 3) 与 HEX 两种写法',
  ]) assert.deepEqual(matchBareColors(source), [], source);
  for (const [source, values] of [
    ["const style = { backgroundColor: 'rgb(1, 2, 3)' };", ['rgb(1, 2, 3)']],
    ["const strokeColor = 'hsl(120 10% 20%)';", ['hsl(120 10% 20%)']],
    ["panel.style.boxShadow = '0 0 0 rgba(0,0,0,0)';", ['rgba(0,0,0,0)']],
    ['<circle fill="rgb(1,2,3)" />', ['rgb(1,2,3)']],
    ["'--panel-shadow':\n    'inset 0 1px 0 rgb(1 2 3)',", ['rgb(1 2 3)']],
    ["backgroundImage: 'linear-gradient(rgb(1,2,3), var(--x))'", ['rgb(1,2,3)']],
  ]) assert.deepEqual(matchBareColors(source), values, source);
});

test('nested fallback and mixed expressions report each literal at its real location', () => {
  const source = `// PR #4135\nconst a = 'hsl(var(--x,\n  var(--y, #123456)))';\nconst b = 'color-mix(in srgb, var(--x), rgb(1, 2, 3))';`;
  assert.deepEqual(matchBareColors(source), ['#123456', 'rgb(1, 2, 3)']);
  const hits = inspect(`${renderer}components/ui/example.tsx`, source).filter(f => f.rule === 'bare-color');
  assert.equal(hits.length, 2);
  assert.deepEqual([hits[0].line, hits[0].column], [3, 12]);
  assert.ok(hits.every(f => f.disposition === 'block' && f.reason && f.suggestion.includes('themes/colors.ts')));
  const mixed = 'hsl(var(--x, #fff)) rgb(1,2,3)';
  assert.deepEqual(findBareColors(mixed).map(h => mixed.slice(h.index, h.end)), ['#fff', 'rgb(1,2,3)']);
});

test('every old exempt Desktop consumer rejects an unapproved new colour', () => {
  for (const e of exemptions.filter(e => e.glob.startsWith(renderer) && !e.glob.includes('/themes/') && !e.glob.includes('__tests__') && !e.glob.includes('/assets/'))) {
    const file = e.glob.replace('*', 'NewConsumer');
    const hits = inspect(file, `const style = { color: '#123abc' };`).filter(f => f.rule === 'bare-color');
    assert.equal(hits[0]?.disposition, 'block', e.glob);
  }
});

test('old approved Toast, hljs, composer and asset values are narrow, not file bypasses', () => {
  const cases = [
    ['components/ui/toast/Toast.tsx', "export const VARIANT_MAP = { info: { color: '#417CDD' } };", 'allowed'],
    ['components/ui/toast/Toast.tsx', "const OTHER_MAP = { color: '#417CDD' };", 'block'],
    ['components/ui/toast/Toast.tsx', "export const VARIANT_MAP = { error: { color: '#417CDD' } };", 'block'],
    ['components/ui/toast/Toast.tsx', "backgroundColor: '#417CDD',", 'block'],
    ['components/ui/toast/Toast.tsx', "background-color: '#417CDD';", 'block'],
    ['components/ui/toast/Toast.tsx', "export const VARIANT_MAP = { info: { color: '#417CCE' } };", 'block'],
    ['styles/globals.css', '[data-theme="cindy-dark"] .hljs-section { color: #2573ec; }', 'allowed'],
    ['styles/globals.css', '.new-control { color: #2573ec; }', 'block'],
    ['components/new-chat/ChatInput.tsx', "'var(--composer-pill-bg, #FCFCFC)'", 'allowed'],
    ['components/new-chat/ChatInput.tsx', "'var(--composer-pill-bg, #123abc)'", 'block'],
    ['components/new-chat/ChatInput.tsx', "'var(--other-bg, #FCFCFC)'", 'block'],
    ['components/settings/AgentIslandSection.tsx', "export const MASCOT_PREVIEW_CONFIGS = { cindy: { eyeColor: 'rgb(107 61 50)' } };", 'allowed'],
    ['components/settings/AgentIslandSection.tsx', "const PREVIEW = { eyeColor: 'rgb(107 61 50)' };", 'block'],
    ['components/settings/AgentIslandSection.tsx', "export const MASCOT_PREVIEW_CONFIGS = { erika: { eyeColor: 'rgb(107 61 50)' } };", 'block'],
    ['components/settings/AgentIslandSection.tsx', "background: 'rgb(107 61 50)'", 'block'],
  ];
  for (const [file, source, expected] of cases) assert.equal(inspect(renderer + file, source).find(f => f.rule === 'bare-color')?.disposition, expected, source);
  // The binding is structural: the same file's own object resolves to the
  // approved path, so the real sources stay allowed while lookalikes block.
  const toast = fs.readFileSync(path.join(root, renderer, 'components/ui/toast/Toast.tsx'), 'utf8');
  assert.deepEqual(objectPathAt(toast, toast.indexOf("'#417CDD'")), ['VARIANT_MAP', 'info']);
  assert.deepEqual(objectPathAt("const OTHER_MAP = { color: '#417CDD' };", 28), ['OTHER_MAP']);
  const anonymous = 'registerColor("md-table-bg", { light: "#fff" });';
  assert.deepEqual(objectPathAt(anonymous, anonymous.indexOf('"#fff"')), []);
  const css = fs.readFileSync(path.join(root,renderer,'styles/globals.css'),'utf8');
  const approvedSelectors = inspect(renderer+'styles/globals.css',css).filter(f=>f.rule==='bare-color' && f.disposition==='allowed');
  assert.deepEqual(approvedSelectors.map(f=>f.value),['#2573ec','#c9d1d9']);
  for (const file of ['components/ui/toast/Toast.tsx', 'components/settings/AgentIslandSection.tsx', 'components/settings/WorkLouderCodexKeyboardLayout.tsx']) {
    const source = fs.readFileSync(path.join(root, renderer + file), 'utf8');
    const hits = inspect(renderer + file, source).filter(f => f.rule === 'bare-color');
    assert.ok(hits.length > 0);
    assert.ok(hits.every(f => f.disposition === 'allowed'), JSON.stringify(hits.filter(f => f.disposition !== 'allowed')));
  }
});

test('source/fixture, non-UI reports and same-line mixed references retain distinct scopes', () => {
  for (const file of [`${renderer}themes/colors.ts`, `${renderer}themes/builtin/custom.ts`, `${renderer}__tests__/sample.test.ts`]) {
    assert.equal(inspect(file, "color: '#fff'")[0].disposition, 'allowed');
  }
  assert.equal(inspect('packages/device-link/src/sample.ts', "const example = '#fff'")[0].disposition, 'report');
  assert.equal(inspect(`${renderer}components/ui/sample.tsx`, "'hsl(var(--x))' + '#fff'")[0].disposition, 'block');
});

test('registered values, unknown classification, missing evidence, hit and indicator layers stay distinct', () => {
  for (const [member, good, bad] of [['keycap', '4px', 'full'], ['usage-token-bar', '2px', 'full'],
    ['usage-heatmap-day', '2px', '4px'], ['workflow-status-cell', '2px', 'full'],
    ['system-category-square', '2px', 'none'], ['ordinary-action', 'full', 'lg'], ['container', 'xl', 'full'], ['textarea', 'lg', 'full']]) {
    assert.equal(classifyDesignLayer({member, radius: good, evidence: true}).classification, 'registered-value');
    assert.equal(classifyDesignLayer({member, radius: bad, evidence: true}).classification, 'registered-value-violation');
    assert.equal(classifyDesignLayer({member, radius: good}).classification, 'missing-evidence');
  }
  assert.equal(classifyDesignLayer({member: 'some-button', radius: '4px'}).classification, 'unknown');
  assert.equal(classifyDesignLayer({member: 'usage-token-bar', layer: 'hit', radius: 'none'}).classification, 'pending-target');
  assert.equal(classifyDesignLayer({layer: 'indicator'}).classification, 'interaction-indicator');
  const source = '<button className="rounded-[4px]" aria-label="chart" />';
  assert.equal(reportDesignLayers('new.tsx', source, new Set([1]), () => ({line:1,column:1}))[0].classification, 'unknown');
  const chart = '<span data-usage-mark="usage-token-bar" className="rounded-full" />';
  assert.equal(inspect(`${renderer}components/settings/usage/UsageTokenBars.tsx`, chart)[0].classification, 'registered-value-violation');
  assert.equal(inspect(`${renderer}components/settings/usage/UsageTokenBars.tsx`, chart)[0].disposition, 'report');
});

test('malformed diff/config and invalid refs fail closed', () => {
  assert.throws(() => addedLines('@@ broken @@'), /Malformed/);
  assert.throws(() => audit({baseRef:'not-a-real-ref'}));
  assert.throws(() => audit({baseRef:'HEAD; printf nope'}));
});

test('worktree includes staged, unstaged and untracked source; commit mode excludes them', t => {
  // Isolated Git fixture only. No task-branch commit/index/worktree is changed.
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-design-audit-'));
  t.after(() => fs.rmSync(temp, {recursive:true,force:true}));
  const run = (...args) => execFileSync('git', args, {cwd:temp,encoding:'utf8',stdio:['pipe','pipe','pipe']}).trim();
  run('init', '-q');
  fs.mkdirSync(path.join(temp,'scripts'),{recursive:true});
  fs.writeFileSync(path.join(temp,'scripts/hardcoded-color-exemptions.json'),'[]');
  const file = renderer + 'sample.tsx';
  fs.mkdirSync(path.dirname(path.join(temp,file)),{recursive:true});
  fs.writeFileSync(path.join(temp,file), "const a = 'var(--surface)';\n");
  run('add','.');
  const tree = run('write-tree');
  const commit = execFileSync('git', ['-c','user.name=Test Fixture','-c','user.email=fixture@example.invalid','commit-tree',tree,'-m','isolated test fixture'],{cwd:temp,encoding:'utf8'}).trim();
  run('update-ref','HEAD',commit);
  fs.appendFileSync(path.join(temp,file), "const b = '#123abc';\n"); run('add',file);
  fs.appendFileSync(path.join(temp,file), "const c = 'var(--x, #abc123)';\n");
  fs.writeFileSync(path.join(temp,renderer+'new.tsx'), "const style = { color: 'rgb(4,5,6)' };\n");
  fs.writeFileSync(path.join(temp,renderer+'plain.tsx'), "const label = 'RGB(1, 2, 3)';\n");
  const result = audit({root:temp,baseRef:commit,worktree:true});
  assert.equal(result.counts.unexpected,3);
  assert.deepEqual(result.findings.filter(f=>f.file===file).map(f=>f.line),[2,3]);
  // Plain-string function colours in an untracked renderer file are prose,
  // not palette values: no finding, so verify does not fail on help text.
  assert.deepEqual(result.findings.filter(f=>f.file===renderer+'plain.tsx'),[]);
  assert.equal(audit({root:temp,baseRef:commit}).counts.unexpected,0);
  assert.equal(audit({root:temp,baseRef:commit,worktree:true}).candidateHash,result.candidateHash);
  // Execute the real CLI against this isolated candidate, then the actual CI
  // aggregation shell. A process failure must not turn into a green summary.
  for (const rel of ['hardcoded-color-audit.mjs', 'shared/hardcoded-color-match.mjs', 'shared/design-layer-report.mjs']) {
    const target = path.join(temp, 'scripts', rel);
    fs.mkdirSync(path.dirname(target), {recursive:true});
    fs.copyFileSync(path.join(root, 'scripts', rel), target);
  }
  const cli = (...args) => spawnSync(process.execPath, ['scripts/hardcoded-color-audit.mjs', ...args], {cwd:temp,encoding:'utf8'});
  const failed = cli('--base-ref',commit,'--worktree','--json');
  assert.equal(failed.status,1,failed.stderr);
  assert.equal(JSON.parse(failed.stdout).counts.unexpected,3);
  assert.equal(cli('--base-ref',commit,'--worktree','--report').status,0);
  assert.equal(cli('--base-ref',commit,'--head-ref',commit).status,0);
  for (const args of [['--base-ref'], ['--bogus'], ['--base-ref','missing-ref'], ['--head-ref',commit,'--worktree']]) assert.equal(cli(...args).status,2);
  const workflow = matter.engines.yaml.parse(fs.readFileSync(path.join(root,'.github/workflows/ci.yml'),'utf8'));
  const summary = workflow.jobs.verify.steps[0];
  for (const checks of ['success','failure','cancelled','skipped']) {
    for (const shards of ['success','failure','cancelled','skipped']) {
      const aggregate = spawnSync('bash',['-e','-c',summary.run], {env:{...process.env,VERIFY_CHECKS_RESULT:checks,LINUX_UNIT_SHARDS_RESULT:shards}});
      assert.equal(aggregate.status === 0, checks === 'success' && shards === 'success');
    }
  }
  const propagated = spawnSync('bash',['-e','-c',summary.run], {env:{...process.env,VERIFY_CHECKS_RESULT:failed.status ? 'failure' : 'success',LINUX_UNIT_SHARDS_RESULT:'success'}});
  assert.notEqual(propagated.status,0);
  fs.writeFileSync(path.join(temp,'scripts/hardcoded-color-exemptions.json'),'{bad json');
  assert.throws(()=>audit({root:temp,baseRef:commit,worktree:true}));
  assert.equal(cli('--base-ref',commit,'--worktree','--report').status,2);
});

test('historical prose/function names are not CSS channels, gradients and shadows retain literals', () => {
  for (const source of ['ordinary pointer (#3246)', 'Registered 2026-09-06, #4001.', 'shape colors 已随 #4064 恢复',
    'color (owner-approved 2026-09-08)', 'color(surface)', 'rgb()', 'hsl()', 'color-mix(in srgb, var(--a), var(--b))']) {
    assert.deepEqual(matchBareColors(source), [], source);
  }
  for (const [source, values] of [
    ['background: linear-gradient(#1234, #fff);', ['#1234', '#fff']],
    ['box-shadow: 0 1px 2px #fff;', ['#fff']],
    ['shadow-[0_1px_2px_#123abc]', ['#123abc']],
    ['color(display-p3 1 0 .5 / .6)', ['color(display-p3 1 0 .5 / .6)']],
    ['hsl(var(--x, rgb(1,2,3)))', ['rgb(1,2,3)']],
  ]) assert.deepEqual(matchBareColors(source), values, source);
  const source = 'color: `rgb(\n1,\n2,\n3)`;';
  const result = inspectFile(renderer + 'new.tsx', source, new Set([3]), exemptions);
  assert.deepEqual([result[0].line, result[0].column], [3, 1]);
  assert.equal(result[0].literalStart.line, 1);
});

test('actual layer reporter keeps visible keycap and chart marks separate from targets and generic boxes', () => {
  const file = renderer + 'components/settings/usage/UsageTokenBars.tsx';
  for (const [source, classification] of [
    ['<kbd className="border rounded-[4px]">K</kbd>', 'registered-value'],
    ['<kbd className="border rounded-full">K</kbd>', 'registered-value-violation'],
    ['<span data-usage-mark="usage-token-bar" className="rounded-[2px]" />', 'registered-value'],
    ['<button className="usage-chart-target rounded-full" />', 'pending-target'],
    ['<span className="usage-chart-indicator rounded-[2px]" />', 'interaction-indicator'],
    ['<div className="border rounded-xl" />', 'unknown'],
    ['<button aria-label="keyboard shortcut" className="rounded-full" />', 'unknown'],
  ]) {
    const result = inspect(file, source);
    assert.equal(result[0].classification, classification, source);
    assert.equal(result[0].disposition, 'report');
  }
});

test('CI design commands feed the existing verify job and preserve Windows aggregation', () => {
  const workflow = matter.engines.yaml.parse(fs.readFileSync(path.join(root,'.github/workflows/ci.yml'),'utf8'));
  const pkg = JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8'));
  const checks = workflow.jobs['verify-checks'];
  const colors = checks.steps.find(step => step.name === 'Check added design colours');
  assert.equal(pkg.scripts['check:design-colors'], 'node scripts/hardcoded-color-audit.mjs');
  assert.equal(pkg.scripts['report:design-colors'], 'node scripts/hardcoded-color-audit.mjs --report');
  assert.equal(colors.run, 'pnpm check:design-colors --base-ref "$DESIGN_BASE_REF" --head-ref "$DESIGN_HEAD_REF"');
  assert.match(colors.env.DESIGN_BASE_REF, /github\.event\.pull_request\.base\.sha/);
  assert.match(colors.env.DESIGN_HEAD_REF, /github\.sha/);
  for (const node of [checks, colors, checks.steps.find(s=>s.name==='Check design inventory freshness')]) {
    assert.equal(node['continue-on-error'], undefined);
    assert.equal(node.if, undefined);
  }
  assert.equal(checks.steps.find(s=>s.name==='Check design inventory freshness').run, 'pnpm check:design-inventory');
  assert.ok(checks.steps.some(s=>s.run==='pnpm test:runner'));
  assert.ok(pkg.scripts['test:runner'].includes('scripts/__tests__/hardcoded-color-audit.test.mjs'));
  assert.equal(workflow.jobs.verify.name,'verify');
  assert.match(workflow.jobs.verify.if,/always\(\)/);
  assert.deepEqual(workflow.jobs.verify.needs,['verify-checks','linux-unit-shards']);
  const windows=workflow.jobs['windows-unit'];
  assert.equal(windows.name,'Windows unit tests');
  assert.equal(windows.needs,'windows-unit-shards');
  assert.match(windows.if,/always\(\)/);
  for(const name of ['linux-unit-shards','windows-unit-shards']) {
    const job=workflow.jobs[name];
    assert.deepEqual(job.strategy.matrix.shard,[1,2]);
    assert.equal(job.strategy['fail-fast'],false);
    assert.ok(job.steps.some(s=>s.run==='pnpm run test:workspaces --tier unit'));
    assert.ok(job.steps.some(s=>s.name==='Run companion database regressions' && s.if==='matrix.shard == 1'));
  }
  for(const result of ['success','failure','cancelled','skipped']) {
    const run=spawnSync('bash',['-e','-c',windows.steps[0].run],{env:{...process.env,WINDOWS_UNIT_SHARDS_RESULT:result}});
    assert.equal(run.status===0,result==='success');
  }
});
