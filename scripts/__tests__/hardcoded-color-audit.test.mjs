import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import matter from 'gray-matter';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { findBareColors, matchBareColors } from '../shared/hardcoded-color-match.mjs';
import { addedLines, inspectFile, readExemptions, validateExemptions, objectPathAt, audit } from '../hardcoded-color-audit.mjs';
import { classifyDesignLayer, reportDesignLayers } from '../shared/design-layer-report.mjs';
import { resolvePosixShell } from '../lib/posix-shell.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const exemptions = readExemptions(root);
const renderer = 'apps/desktop/src/renderer/';
// Fixed calendar day so narrow-exemption expiry never turns these cases into a time bomb.
const TODAY = '2026-10-30';
const inspect = (file, source) => inspectFile(file, source, new Set(source.split('\n').map((_, i) => i + 1)), exemptions, undefined, TODAY);
const archivedExemptions = JSON.parse(fs.readFileSync(path.join(root, 'scripts/hardcoded-color-exemptions.archive.json'), 'utf8')).entries;
const bash = resolvePosixShell('bash');
const runBash = script => bash ? spawnSync(bash, ['-e', '-c', script]) : null;

test('Tailwind palette candidates report light/dark variants without expanding blocking scope', () => {
  const hits = inspect(`${renderer}components/Example.tsx`, '<div className="bg-red-50 dark:bg-red-950/30 text-red-600 border-[var(--error-border)]" />');
  const palette = hits.filter(hit => hit.rule === 'named-palette-candidate');
  assert.deepEqual(palette.map(hit => hit.value), ['bg-red-50', 'bg-red-950/30', 'text-red-600']);
  assert.ok(palette.every(hit => hit.disposition === 'report'));
  assert.deepEqual(inspect(`${renderer}components/Example.tsx`, '// text-red-500\n<div className="text-[var(--error-fg)]" />'), []);
  // Braced className expressions (cn()/ternaries) are the same style context.
  const assembly = inspect(`${renderer}components/Example.tsx`,
    '<div className={cn("rounded-[4px]", danger && "bg-red-50 dark:text-red-600")} />');
  assert.deepEqual(assembly.filter(hit => hit.rule === 'named-palette-candidate').map(hit => hit.value), ['bg-red-50', 'text-red-600']);
  // Palette-shaped prose outside a className attribute is not a candidate:
  // plain strings, other attributes, class assembly outside an attribute, and
  // unparseable (fail-closed) expressions all stay out of the report.
  for (const source of [
    "const hint = '请用 text-red-500 标出错误';",
    '<div aria-label="text-red-500" className="text-[var(--error-fg)]" />',
    "const overlay = cn('bg-red-50');",
    '<div className={"bg-red-50"',
  ]) assert.deepEqual(inspect(`${renderer}components/Example.tsx`, source).filter(hit => hit.rule === 'named-palette-candidate'), [], source);
});

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

test('the live exemption table only holds narrow, dated entries; retired whole-file records live in the archive', () => {
  assert.ok(exemptions.length > 0);
  assert.ok(exemptions.every(e => Array.isArray(e.matches) && e.matches.length && /^\d{4}-\d{2}-\d{2}$/.test(e.reviewDate)));
  assert.ok(archivedExemptions.length > 0 && archivedExemptions.every(e => e.matches === undefined));
});

test('an expired narrow exemption stops approving new lines', () => {
  const entry = { glob: `${renderer}styles/expiry.css`, reason: 'fixture', owner: 'test', reviewDate: '2026-09-17',
    matches: [{ value: '#123456', before: 'color:\\s*' }] };
  const source = '.a { color: #123456; }';
  const run = today => inspectFile(entry.glob, source, new Set([1]), [entry], undefined, today).filter(f => f.rule === 'bare-color');
  assert.equal(run('2026-09-17')[0].disposition, 'allowed');
  const [expired] = run('2026-09-18');
  assert.equal(expired.disposition, 'block');
  assert.match(expired.reason, /expired on 2026-09-17/);
  assert.throws(() => validateExemptions([{ ...entry, reviewDate: 'soon' }]), /Invalid reviewDate/);
});

test('every old exempt Desktop consumer rejects an unapproved new colour', () => {
  for (const e of archivedExemptions.filter(e => e.glob.startsWith(renderer) && !e.glob.includes('/themes/') && !e.glob.includes('__tests__') && !e.glob.includes('/assets/'))) {
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
    // The composer fallback exemption expired on 2026-09-17 (“集成收口删”) and was not renewed.
    ['components/new-chat/ChatInput.tsx', "'var(--composer-pill-bg, #FCFCFC)'", 'block'],
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

test('spacing reports distinguish real generated references, unknown variables and mixed values', () => {
  const file = renderer + 'components/new-chat/PermissionPrompt.tsx';
  for (const [value, classification] of [
    ['p-[var(--space-4)]', 'spacing-source-reference'],
    ['gap-x-[var(--space-2)]', 'spacing-source-reference'],
    ['gap-y-[var(--space-0_5)]', 'spacing-source-reference'],
    ['hover:ps-[var(--space-4)]', 'spacing-source-reference'],
    ['pl-[var(--space-input-lg)]', 'spacing-source-reference'],
    ['md:!gap-y-[13px]', 'literal-spacing'],
    ['py-[1px]', 'literal-spacing'],
    ['pe-[.5rem]', 'literal-spacing'],
    ['gap-x-[var(--spacing-2)]', 'unknown-spacing-reference'],
    ['p-[var(--space-999)]', 'unknown-spacing-reference'],
    ['p-[var(--text-14)]', 'unknown-spacing-reference'],
    ['p-[var(--size-input-lg)]', 'unknown-spacing-reference'],
    ['px-[calc(var(--space-4)+1px)]', 'mixed-spacing-expression'],
    ['p-[var(--space-4,13px)]', 'mixed-spacing-expression'],
    ['p-[var(--space-4,initial)]', 'mixed-spacing-expression'],
    ['p-[var(--space-4,auto)]', 'mixed-spacing-expression'],
    ['p-[var(--space-4,var(--space-2))]', 'mixed-spacing-expression'],
    ['p-[calc(var(--space-4)*2)]', 'mixed-spacing-expression'],
    ['gap-[calc(var(--space-4)-var(--space-2))]', 'spacing-expression'],
    ['p-[calc(var(--space-4)_+_env(safe-area-inset-top))]', 'mixed-spacing-expression'],
    ['p-[calc(min(var(--space-2),var(--space-4)))]', 'mixed-spacing-expression'],
    ['p-[var(--space-4,var(--missing))]', 'unknown-spacing-reference'],
    ['p-[env(safe-area-inset-top)]', 'unclassified-spacing'],
    ['p-[calc(100%-4px)]', 'unclassified-spacing'],
    ['mt-[var(--space-4)]', 'spacing-source-reference'],
    ['space-x-[var(--space-4)]', 'spacing-source-reference'],
    ['space-y-[4px]', 'literal-spacing'],
    ['ms-[var(--space-4,initial)]', 'mixed-spacing-expression'],
    ['mt-[3px]', 'literal-spacing'],
    ['mx-[7px]', 'literal-spacing'],
    ['me-[13px]', 'literal-spacing'],
    ['p-[14px_16px]', 'literal-spacing'],
    ['px-[8px_12px]', 'literal-spacing'],
    ['p-[-14px_-16px]', 'literal-spacing'],
    ['p-[1lh]', 'literal-spacing'],
    ['mt-[2dvh]', 'literal-spacing'],
    ['gap-[1cqw]', 'literal-spacing'],
    ['p-[12PX]', 'literal-spacing'],
    ['p-[17pt]', 'literal-spacing'],
    ['p-[1lh_2dvh]', 'literal-spacing'],
  ]) {
    const source = `<div className="${value}" />`;
    const [hit] = inspect(file, source);
    assert.equal(hit?.classification, classification, value);
    assert.equal(hit.disposition, 'report');
    assert.equal(hit.rule, 'role-spacing');
    assert.equal(hit.line, 1);
    assert.equal(source.slice(hit.column - 1, hit.column - 1 + hit.value.length), hit.value);
    assert.match(hit.suggestion, /foundations.spacing/);
    assert.doesNotMatch(hit.suggestion, /radius overrides/);
  }
  for (const value of ['p-4', 'm-4', 'mt-2', 'gap-x-2', 'gap-y-2', 'space-x-2', 'space-y-reverse', 'gapx-[13px]', 'gapy-[13px]']) {
    assert.deepEqual(inspect(file, `<div className="${value}" />`), [], value);
  }
  const source = '// gap-x-[13px]\n<div className="gap-x-[13px]" />\n<div className="p-[var(--space-4)]" />';
  const result = inspectFile(file, source, new Set([3]), exemptions);
  assert.equal(result.length, 1);
  assert.equal(result[0].line, 3);
  assert.equal(result[0].classification, 'spacing-source-reference');
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
  // The isolated repo carries its own contract inputs: audit({root}) must
  // read and hash bindings and the DTCG source from root, not this checkout.
  const bindings = 'packages/design-tokens/src/desktop-bindings.json';
  const dtcg = 'packages/design-tokens/src/semantic/foundations.json';
  fs.mkdirSync(path.dirname(path.join(temp, bindings)), {recursive:true});
  fs.copyFileSync(path.join(root, bindings), path.join(temp, bindings));
  fs.mkdirSync(path.dirname(path.join(temp, dtcg)), {recursive:true});
  fs.copyFileSync(path.join(root, dtcg), path.join(temp, dtcg));
  const result = audit({root:temp,baseRef:commit,worktree:true});
  assert.equal(result.counts.unexpected,3);
  assert.deepEqual(result.findings.filter(f=>f.file===file).map(f=>f.line),[2,3]);
  // Plain-string function colours in an untracked renderer file are prose,
  // not palette values: no finding, so verify does not fail on help text.
  assert.deepEqual(result.findings.filter(f=>f.file===renderer+'plain.tsx'),[]);
  assert.equal(audit({root:temp,baseRef:commit}).counts.unexpected,0);
  assert.equal(audit({root:temp,baseRef:commit,worktree:true}).candidateHash,result.candidateHash);
  // The isolated root's own bindings drive classification and fail-closed
  // validation — a custom valid source registers, and corruption introduced
  // between two audit calls must not be served from any stale copy.
  const localBindings = JSON.parse(fs.readFileSync(path.join(root, bindings), 'utf8'));
  localBindings.foundations.css['space-local'] = 'semantic.foundations.space-local';
  fs.writeFileSync(path.join(temp,bindings), JSON.stringify(localBindings));
  const localDtcg = JSON.parse(fs.readFileSync(path.join(root, dtcg), 'utf8'));
  localDtcg.semantic.foundations['space-local'] = { $type: 'dimension', $value: '{reference.foundations.space-4}' };
  fs.writeFileSync(path.join(temp,dtcg), JSON.stringify(localDtcg));
  fs.writeFileSync(path.join(temp,renderer+'LocalSpacing.tsx'), 'export const L = <div className="p-[var(--space-local)]" />;\n');
  const local = audit({root:temp,baseRef:commit,worktree:true});
  assert.equal(local.findings.find(f=>f.rule==='role-spacing')?.classification,'spacing-source-reference');
  fs.writeFileSync(path.join(temp,bindings),'{bad json');
  assert.throws(()=>audit({root:temp,baseRef:commit,worktree:true}));
  fs.copyFileSync(path.join(root, bindings), path.join(temp, bindings));
  fs.copyFileSync(path.join(root, dtcg), path.join(temp, dtcg));
  fs.rmSync(path.join(temp,renderer+'LocalSpacing.tsx'));
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
      // Windows' bash.exe is a WSL shim and does not forward Node's ad-hoc
      // environment object. Set fixture values inside the shell script so
      // this contract test behaves the same on Windows and Linux.
      const aggregateScript = summary.run
        .replaceAll('$VERIFY_CHECKS_RESULT', checks)
        .replaceAll('$LINUX_UNIT_SHARDS_RESULT', shards);
      const aggregate = runBash(aggregateScript);
      if (!aggregate) return t.skip('Git Bash is unavailable on this host');
      assert.equal(aggregate.status === 0, checks === 'success' && shards === 'success');
    }
  }
  const propagatedScript = summary.run
    .replaceAll('$VERIFY_CHECKS_RESULT', failed.status ? 'failure' : 'success')
    .replaceAll('$LINUX_UNIT_SHARDS_RESULT', 'success');
  const propagated = runBash(propagatedScript);
  if (!propagated) return t.skip('Git Bash is unavailable on this host');
  assert.notEqual(propagated.status,0);
  fs.writeFileSync(path.join(temp,'scripts/hardcoded-color-exemptions.json'),'{bad json');
  assert.throws(()=>audit({root:temp,baseRef:commit,worktree:true}));
  assert.equal(cli('--base-ref',commit,'--worktree','--report').status,2);
  fs.writeFileSync(path.join(temp,'scripts/hardcoded-color-exemptions.json'),'[]');
  // Corrupt bindings must fail closed even with no spacing candidate in the
  // diff: classifySpacing's lazy read never runs for colour-/docs-only
  // candidates, so the audit itself has to validate the contract it hashes.
  fs.writeFileSync(path.join(temp,bindings),'{bad json');
  assert.equal(cli('--base-ref',commit,'--worktree','--report').status,2);
  // Arrays pass typeof checks yet carry no entries, and a mapping without
  // space-* foundations silently degrades every spacing report to unknown.
  fs.writeFileSync(path.join(temp,bindings),'{"foundations":{"css":[]}}');
  assert.equal(cli('--base-ref',commit,'--worktree','--report').status,2);
  fs.writeFileSync(path.join(temp,bindings),'{"foundations":{"css":{"text":"semantic.foundations.text-14"}}}');
  assert.equal(cli('--base-ref',commit,'--worktree','--report').status,2);
  // A prefix-correct but non-existent target must not invent a real source:
  // the binding has to resolve against the DTCG generation source.
  const poisoned = JSON.parse(fs.readFileSync(path.join(root, bindings), 'utf8'));
  poisoned.foundations.css['space-typo'] = 'semantic.foundations.space-typo';
  fs.writeFileSync(path.join(temp,bindings), JSON.stringify(poisoned));
  assert.equal(cli('--base-ref',commit,'--worktree','--report').status,2);
  fs.copyFileSync(path.join(root, bindings), path.join(temp, bindings));
  fs.rmSync(path.join(temp,dtcg));
  assert.equal(cli('--base-ref',commit,'--worktree','--report').status,2);
  fs.copyFileSync(path.join(root, dtcg), path.join(temp, dtcg));
  // A target that exists as a key but is not a leaf dimension token — an
  // empty object or a group — never reaches generation output either.
  const leafless = JSON.parse(fs.readFileSync(path.join(root, dtcg), 'utf8'));
  leafless.semantic.foundations['space-4'] = {};
  fs.writeFileSync(path.join(temp,dtcg), JSON.stringify(leafless));
  assert.equal(cli('--base-ref',commit,'--worktree','--report').status,2);
  fs.copyFileSync(path.join(root, dtcg), path.join(temp, dtcg));
  fs.appendFileSync(path.join(temp,file), '\nconst spacing = "gap-x-[var(--space-4)]";\n');
  const reported = cli('--base-ref',commit,'--worktree','--report','--json');
  assert.equal(reported.status,0,reported.stderr);
  const report = JSON.parse(reported.stdout);
  assert.equal(report.findings.find(f=>f.rule==='role-spacing')?.classification,'spacing-source-reference');
  assert.match(report.scriptHashes[bindings],/^[a-f0-9]{64}$/);
  assert.match(report.scriptHashes[dtcg],/^[a-f0-9]{64}$/);
  fs.writeFileSync(path.join(temp,bindings),'{bad json');
  assert.equal(cli('--base-ref',commit,'--worktree','--report').status,2);
  fs.rmSync(path.join(temp,bindings));
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

test('CI design commands feed the existing verify job and preserve Windows aggregation', (t) => {
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
  assert.deepEqual(windows.needs,['windows-unit-shards','windows-runner-checks']);
  assert.match(windows.if,/always\(\)/);
  for(const name of ['linux-unit-shards','windows-unit-shards']) {
    const job=workflow.jobs[name];
    const shards=job.strategy.matrix.shard;
    assert.ok(shards.length>=2);
    assert.deepEqual(shards,shards.map((_,i)=>i+1));
    assert.equal(job.strategy['fail-fast'],false);
    assert.ok(job.steps.some(s=>s.run==='pnpm run test:workspaces --tier unit'));
  }
  // Companion DB regressions run once per OS: on Linux shard 1, and on Windows
  // in the parallel one-off job instead of on a shard's critical path.
  assert.ok(workflow.jobs['linux-unit-shards'].steps.some(s=>s.name==='Run companion database regressions' && s.if==='matrix.shard == 1'));
  assert.ok(workflow.jobs['windows-runner-checks'].steps.some(s=>s.name==='Run companion database regressions' && s.if===undefined));
  const gateVars=['$WINDOWS_UNIT_SHARDS_RESULT','$WINDOWS_RUNNER_CHECKS_RESULT'];
  for(const result of ['success','failure','cancelled','skipped']) {
    for(const target of gateVars) {
      const windowsScript=gateVars.reduce((script,name)=>script.replaceAll(name,name===target?result:'success'),windows.steps[0].run);
      const run=runBash(windowsScript);
      if (!run) return t.skip('Git Bash is unavailable on this host');
      assert.equal(run.status===0,result==='success',`${target}=${result}`);
    }
  }
});

test('new off-scale radii block in Desktop renderer consumers; governed and dynamic values stay report-only', () => {
  const file = `${renderer}components/Example.tsx`;
  const blocked = source => inspect(file, source).filter(f => f.rule === 'off-scale-radius');
  for (const value of ['rounded-md', 'hover:rounded-t-md', 'rounded-2xl', 'rounded-[6px]', 'rounded-tl-[10px]', 'rounded-[0.375rem]']) {
    const [hit] = blocked(`<div className="${value}" />`);
    assert.equal(hit?.disposition, 'block', value);
    assert.match(hit.suggestion, /DESIGN §5/);
  }
  assert.equal(blocked("const s = { borderRadius: 10 };")[0]?.disposition, 'block');
  assert.equal(inspect(`${renderer}styles/x.css`, '.x { border-radius: 6px; }').filter(f => f.rule === 'off-scale-radius' && f.disposition === 'block').length, 1);
  for (const value of ['rounded', 'rounded-sm', 'rounded-lg', 'rounded-xl', 'rounded-full', 'rounded-none', 'rounded-[4px]', 'rounded-[12px]', 'rounded-[var(--r)]']) {
    assert.deepEqual(blocked(`<div className="${value}" />`), [], value);
  }
  // Declared intrinsic content geometry (DESIGN §5) is reported for review, not blocked.
  const icon = inspect(file, '{/* design: intrinsic-geometry — plugin icon mask */}\n<img className="rounded-[3px]" />')
    .filter(f => f.rule === 'off-scale-radius');
  assert.deepEqual(icon.map(f => [f.disposition, f.classification]), [['report', 'declared-intrinsic-geometry']]);
  const far = inspect(file, '// design: intrinsic-geometry\n\n\n<div className="rounded-[10px]" />').filter(f => f.rule === 'off-scale-radius');
  assert.equal(far[0].disposition, 'block');
  // Only added lines: an untouched off-scale radius on another line is existing debt.
  const result = inspectFile(file, '<div className="rounded-md" />\n<div className="rounded-xl" />', new Set([2]), exemptions, undefined, TODAY);
  assert.deepEqual(result.filter(f => f.disposition === 'block'), []);
  // Tests and fixtures are outside the blocking scope.
  assert.deepEqual(inspect(`${renderer}components/__tests__/x.test.tsx`, '<div className="rounded-md" />').filter(f => f.disposition === 'block'), []);
});

test('shorthand, !important and trailing-declaration radii are parsed value by value', () => {
  const file = `${renderer}components/Example.tsx`;
  const css = `${renderer}styles/x.css`;
  const blocked = (source, at = css) => inspect(at, source).filter(f => f.rule === 'off-scale-radius' && f.disposition === 'block');
  assert.equal(blocked('.x { border-radius: 6px !important; }').length, 1);
  assert.equal(blocked('.x { border-radius: 8px 10px; }').length, 1);
  assert.equal(blocked('.x { border-radius: 12px / 6px }').length, 1);
  assert.equal(blocked('.x { border-radius: .375rem }').length, 1);
  assert.equal(blocked('.x { border-radius: 6PX }').length, 1);
  assert.equal(blocked('<i className="rounded-[.375rem]" />', file).length, 1);
  assert.equal(blocked('<i className="rounded-[0.375REM]" />', file).length, 1);
  assert.equal(blocked("const s = { borderRadius: '6px' };", file).length, 1);
  for (const ok of ['.x { border-radius: 8px 12px !important; }', '.x { border-radius: 0 8px; }', '.x { border-radius: var(--r) 6px; }'.replace('6px', 'var(--s)'),
    '.x { border-radius: 50%; }', '.x { border-radius: calc(var(--r) - 2px); }']) {
    assert.deepEqual(blocked(ok), [], ok);
  }
});

test('a radius only blocks in a confirmed style context; prose that mentions one stays a report', () => {
  const file = `${renderer}components/Example.tsx`;
  const dispositions = source => inspect(file, source).filter(f => f.rule === 'off-scale-radius').map(f => f.disposition);
  for (const source of ['<div className="rounded-md" />', 'const c = cn("flex", on && "rounded-md");', 'const A = "flex items-center rounded-md";',
    'const s = { borderRadius: 6 };']) assert.deepEqual(dispositions(source), ['block'], source);
  for (const source of ['const help = "Use rounded-md";', "const note = 'CSS example: border-radius: 6px';", 'const h = "borderRadius: 6 is not allowed";',
    'const css = `.x{border-radius:6px}`;']) assert.deepEqual(dispositions(source), ['report'], source);
});

test('an intrinsic-geometry declaration must be a comment that gives a reason', () => {
  const file = `${renderer}components/Example.tsx`;
  const dispositions = source => inspect(file, source).filter(f => f.rule === 'off-scale-radius').map(f => f.disposition);
  assert.deepEqual(dispositions('// design: intrinsic-geometry — plugin icon mask\n<img className="rounded-[3px]" />'), ['report']);
  assert.deepEqual(dispositions('/* design: intrinsic-geometry: swatch art */\n<img className="rounded-[3px]" />'), ['report']);
  assert.deepEqual(dispositions('// design: intrinsic-geometry\n<img className="rounded-[3px]" />'), ['block']);
  assert.deepEqual(dispositions('// design: intrinsic-geometry —\n<img className="rounded-[3px]" />'), ['block']);
  assert.deepEqual(dispositions("const note = 'design: intrinsic-geometry — x';\n<img className=\"rounded-[3px]\" />"), ['block']);
});

test('multiline shorthands, multiline prose strings and quoted markers are handled lexically', () => {
  const file = `${renderer}components/Example.tsx`;
  const css = `${renderer}styles/x.css`;
  const radius = (source, at = file) => inspect(at, source).filter(f => f.rule === 'off-scale-radius').map(f => f.disposition);
  // Valid CSS may split a shorthand across lines: every value counts.
  assert.deepEqual(radius('.x {\n  border-radius: 8px\n    10px;\n}', css), ['block']);
  assert.deepEqual(radius('.x {\n  border-radius: 8px\n    12px;\n}', css), []);
  // A multiline template that merely documents a radius is prose, not a style object.
  assert.deepEqual(radius('const help = `CSS example:\nborderRadius: 6\n`;'), ['report']);
  assert.deepEqual(radius('const help = `a ${x}\nmore\nborderRadius: 6`;'), ['report']);
  assert.deepEqual(radius('const s = {\n  borderRadius: 6,\n};'), ['block']);
  assert.deepEqual(radius('const t = `${a}`;\nconst s = { borderRadius: 6 };'), ['block']);
  // A marker that only appears inside a string literal declares nothing.
  assert.deepEqual(radius("const note = '// design: intrinsic-geometry — example';\n<i className=\"rounded-[3px]\" />"), ['block']);
  assert.deepEqual(radius('const note = "/* design: intrinsic-geometry — x */";\n<i className="rounded-[3px]" />'), ['block']);
  assert.deepEqual(radius('// design: intrinsic-geometry — plugin icon mask\n<i className="rounded-[3px]" />'), ['report']);
});

test('reviewDate must be a real calendar day', () => {
  const entry = { glob: `${renderer}x.css`, reason: 'fixture', owner: 'test', matches: [{ value: '#123456', before: 'color:\\s*' }] };
  for (const reviewDate of ['9999-99-99', '2026-02-30', '2026-13-01', '2026-1-1', 'soon']) {
    assert.throws(() => validateExemptions([{ ...entry, reviewDate }]), /Invalid reviewDate/, reviewDate);
  }
  assert.doesNotThrow(() => validateExemptions([{ ...entry, reviewDate: '2028-02-29' }]));
  assert.throws(() => validateExemptions([{ ...entry, reviewDate: '2027-02-29' }]), /Invalid reviewDate/);
});

test('corner, logical and assignment radius spellings block; a multiline declaration counts when any spanned line changed', () => {
  const file = `${renderer}components/Example.tsx`;
  const css = `${renderer}styles/x.css`;
  const run = (source, at, changed) => inspectFile(at, source, changed ?? new Set(source.split('\n').map((_, i) => i + 1)), exemptions, undefined, TODAY)
    .filter(f => f.rule === 'off-scale-radius').map(f => `${f.disposition}@${f.line}`);
  assert.deepEqual(run('.x { border-top-left-radius: 6px; }', css), ['block@1']);
  assert.deepEqual(run('.x { border-start-end-radius: 10px; }', css), ['block@1']);
  assert.deepEqual(run("const s = { borderTopLeftRadius: '6px' };", file), ['block@1']);
  assert.deepEqual(run("panel.style.borderRadius = '6px';", file), ['block@1']);
  assert.deepEqual(run("el.style.setProperty('border-radius', '6px');", file), ['block@1']);
  for (const ok of ["panel.style.borderRadius = '8px';", "el.style.setProperty('border-radius', '12px');", 'if (a.borderRadius == 6) {}']) {
    assert.deepEqual(run(ok, file), [], ok);
  }
  assert.deepEqual(run('.x { border-top-left-radius: 6px }', file), ['report@1']);
  const multi = '.x {\n  border-radius: 8px\n    10px;\n}';
  assert.deepEqual(run(multi, css, new Set([3])), ['block@3']);
  assert.deepEqual(run(multi, css, new Set([1, 4])), []);
});

test('Tailwind arbitrary shorthand radii are checked item by item', () => {
  const file = `${renderer}components/Example.tsx`;
  const dispositions = value => inspect(file, `<div className="${value}" />`).filter(f => f.rule === 'off-scale-radius').map(f => f.disposition);
  for (const value of ['rounded-[8px_10px]', 'rounded-[6px_12px]', 'rounded-[8px_8px/6px]', 'rounded-t-[12px_10px]']) {
    assert.deepEqual(dispositions(value), ['block'], value);
  }
  for (const value of ['rounded-[8px_12px]', 'rounded-[0_8px]', 'rounded-[var(--r)_6px]'.replace('6px', 'var(--s)'), 'rounded-[50%]']) {
    assert.deepEqual(dispositions(value), [], value);
  }
});

test('quoted and bracketed static radius keys are code, not prose', () => {
  const file = `${renderer}components/Example.tsx`;
  const dispositions = source => inspect(file, source).filter(f => f.rule === 'off-scale-radius').map(f => f.disposition);
  for (const source of ["const s = { 'borderRadius': 6 };", 'const s = { "borderRadius": 6 };', "style['borderRadius'] = '6px';",
    "const s = { 'borderTopLeftRadius': 10 };"]) assert.deepEqual(dispositions(source), ['block'], source);
  for (const source of ["style['borderRadius'] = '8px';", "const s = { 'borderRadius': 12 };"]) assert.deepEqual(dispositions(source), [], source);
  // A quoted mention inside prose is still just prose.
  for (const source of ['const h = "borderRadius: 6 is bad";', "const h = 'use borderRadius: 6';"]) assert.deepEqual(dispositions(source), ['report'], source);
});

test('scientific-notation radii and multi-line class-list templates are handled', () => {
  const file = `${renderer}components/Example.tsx`;
  const css = `${renderer}styles/x.css`;
  const run = (source, at = file) => inspect(at, source).filter(f => f.rule === 'off-scale-radius').map(f => f.disposition);
  assert.deepEqual(run('.x { border-radius: 6e0px }', css), ['block']);
  assert.deepEqual(run('<i className="rounded-[6E+0px]" />'), ['block']);
  assert.deepEqual(run('.x { border-radius: 1.2e1px }', css), []);
  assert.deepEqual(run('.x { border-radius: 8e0px }', css), []);
  // A bare class list may span lines (template literal) and contain interpolations.
  assert.deepEqual(run('const classes = `flex items-center\n  rounded-md`;'), ['block']);
  assert.deepEqual(run('const classes = `flex ${x}\n  rounded-md border`;'), ['block']);
  // Prose that spans lines is still prose.
  assert.deepEqual(run('const h = `Use the\n rounded-md class`;'), ['report']);
});
