import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import {
  HOST_IPC_ENTRIES_PREFIX, OWNERSHIP_RULES, SYNC_LOCAL_DOMAINS,
  clientModeRegistrars, collectContractChannels, createConstResolver, createWindowApiScanner, classify, clientBehavior, isHostWork, isWindowClass,
  moduleGroup, owningFile, rankUsage, renderMarkdown, requireResolvedContract, summarize,
} from '../host-channel-coverage.mjs';

const main = (file) => `apps/desktop/src/main/${file}`;

// Production renderMarkdown output, CodeQL #489: a backslash before a pipe broke
// the GFM cell. Existing tests only covered classification, not rendered cells.
// Minimal failure: one channel containing "\\|". Tier: runner, in-process GFM.
test('renders code cells without splitting tables or changing literal characters', () => {
  const require = createRequire(new URL('../../apps/desktop/package.json', import.meta.url));
  const { marked } = require('marked');
  for (const [channel, expected] of [
    ['plain:channel', 'plain:channel'],
    ['pipe|alone', 'pipe&#124;alone'],
    [String.raw`slash\|pipe`, 'slash&#92;&#124;pipe'],
    [String.raw`two\\|pipe`, 'two&#92;&#92;&#124;pipe'],
    [String.raw`path\file`, 'path&#92;file'],
    ['tick`<&|', 'tick&#96;&lt;&amp;&#124;'],
    ['</code>\r\n|next', '&lt;/code&gt;&#13;&#10;&#124;next'],
  ]) {
    const summary = summarize({ registrations: [
      { channel, kind: 'invoke', file: main('test.ts'), line: 1, gui: [] },
    ], unresolved: [], contract: new Set() });
    const document = renderMarkdown(summary);
    const html = marked.parse(document.slice(document.indexOf('## 全部通道')));
    assert.ok(html.includes(`<td><code>${expected}</code></td>`), html);
    assert.equal((html.match(/<td(?:\s[^>]*)?>/g) ?? []).length, 5, 'one row with exactly five cells');
  }
});
const contract = new Set(['local-db:sessions:list']);
const owner = (registration, within = contract) => {
  const { category, sub } = classify(registration, within);
  return sub ? `${category}:${sub}` : category;
};

test('classifies contract and client-mode channels before ownership', () => {
  assert.equal(owner({ channel: 'local-db:sessions:list', file: main('localDb/ipc/sessions.ts') }), 'contract');
  assert.equal(owner({ channel: 'host-client:retry', file: main('bootstrap-electron.ts'), enclosing: 'installHostClientMode' }), 'client');
});

test('B rules are final; A rules turn into two-phase C when the handler uses a window API', () => {
  assert.equal(owner({ channel: 'clipboard:copy-text', file: main('bootstrap-electron.ts'), gui: ['clipboard'] }), 'B');
  assert.equal(owner({ channel: 'anything', file: main('voice-input/index.ts') }), 'B');
  assert.equal(owner({ channel: 'ghost-page:pick-model', file: main('cindy-brain/x.ts'), perWebContents: true }), 'B');
  const plain = classify({ channel: 'maker:schedule:list', file: main('maker-ipc/register.ts'), gui: [] }, contract);
  assert.deepEqual([plain.category, plain.basis, plain.reason], ['A', 'rule', '自动化']);
  const both = classify({ channel: 'maker:schedule:export', file: main('maker-ipc/register.ts'), gui: ['dialog'] }, contract);
  assert.deepEqual([both.category, both.sub, both.basis], ['C', 'two-phase', 'dependency']);
  assert.match(both.reason, /自动化.*dialog/);
  assert.equal(owner({ channel: 'billing:get-balance', file: main('billing/index.ts'), gui: [] }), 'A');
  assert.equal(owner({ channel: 'odd:thing', file: main('odd.ts'), gui: ['shell'] }), 'C:two-phase');
});

test('Computer Use settings stay in the window; the agent browser belongs to the Host', () => {
  assert.equal(owner({ channel: 'maker:computer:status', file: main('maker-ipc/register.ts'), gui: [] }), 'B');
  const browser = classify({ channel: 'maker:browser:status', file: main('maker-ipc/register.ts'), gui: [] }, contract);
  assert.deepEqual([browser.category, browser.basis], ['A', 'rule']);
  assert.match(browser.reason, /Agent 浏览器/);
  assert.ok(isHostWork(browser));
});

test('C buckets: backend, window-local, two-phase and special design', () => {
  assert.equal(owner({ channel: 'terminal:create', file: main('maker-ipc/register.ts') }), 'C:backend');
  assert.equal(owner({ channel: 'maker:file-browser:read-file', file: main('file-browser/ipc.ts') }), 'C:backend');
  assert.equal(owner({ channel: 'read-file-for-attachment', file: main('bootstrap-electron.ts') }), 'C:window');
  assert.equal(owner({ channel: 'process-monitor:subscribe', file: main('process-monitor/ipc.ts'), gui: ['BrowserWindow.fromWebContents'] }), 'C:window');
  assert.equal(owner({ channel: 'projects-root:choose', file: main('bootstrap-electron.ts') }), 'C:two-phase');
  assert.equal(owner({ channel: 'worktree:reveal', file: main('worktree/index.ts') }), 'C:two-phase');
  assert.equal(owner({ channel: 'input-handoff:submit', file: main('maker-ipc/x.ts') }), 'C:special');
  assert.equal(owner({ channel: 'device-link:invoke', file: main('device-link/ipc.ts'), gui: ['dialog'] }), 'C:special');
});

test('sync channels form their own class: local settings or Host data behind a window mirror', () => {
  const sync = (channel, file) => owner({ channel, kind: 'event', file: main(file), sync: true, gui: [] });
  assert.equal(sync('layout:get', 'layout/ipc.ts'), 'S:local');
  assert.equal(sync('sidebar-settings:load-snapshot-sync', 'sidebarSettingsStore.ts'), 'S:local');
  assert.equal(sync('client-endpoints:get-sync', 'clientEndpointsService.ts'), 'S:local');
  assert.equal(sync('ghosts:unread', 'cindy-brain/index.ts'), 'S:mirror');
  // First-frame hint read from the profile before the event stream connects; login state stays with the Host.
  assert.equal(sync('auth:has-persisted-session-hint-sync', 'bootstrap-electron.ts'), 'S:local');
  // A window-only sync read stays B.
  assert.equal(sync('voice-input:history:get', 'voice-input/index.ts'), 'B');
  assert.equal(owner({ channel: 'sidebar-settings:get-project-order', file: main('projectOrderStore.ts') }), 'W');
});

test('sync-local domains match A-rule reasons exactly, so renaming a domain cannot silently reclassify', () => {
  const domains = new Set(OWNERSHIP_RULES.filter((rule) => rule.owner === 'A').map((rule) => rule.reason));
  for (const domain of SYNC_LOCAL_DOMAINS) {
    assert.ok(domains.has(domain), `SYNC_LOCAL_DOMAINS has "${domain}", which no A rule uses as its reason`);
  }
  // Each domain keeps its channels local, and the account hint keeps its own wording.
  const sync = (channel, file) => classify({ channel, kind: 'event', file: main(file), sync: true, gui: [] }, contract);
  const settings = sync('layout:get', 'layout/ipc.ts');
  assert.deepEqual([settings.category, settings.sub], ['S', 'local']);
  assert.match(settings.reason, /界面设置/);
  const account = sync('auth:has-persisted-session-hint-sync', 'bootstrap-electron.ts');
  assert.deepEqual([account.category, account.sub], ['S', 'local']);
  assert.match(account.reason, /账号提示/);
});

test('receipt channels and the relaunch checks are labelled, not mixed into window work', () => {
  assert.equal(owner({ channel: 'model-favorites:host-reply', kind: 'event', file: main('maker-ipc/x.ts') }), 'R');
  assert.equal(owner({ channel: 'app-preferences:reply', kind: 'event', file: main('app-settings.ts') }), 'R');
  const relaunch = classify({ channel: 'update-relaunch:blocking-summary', file: main('relaunchBusyActivityIpc.ts'), gui: [] }, contract);
  assert.equal(relaunch.category, 'A');
  assert.match(relaunch.reason, /升级与交接/);
  assert.equal(owner({ channel: 'update-relaunch', file: main('updateService.ts') }), 'B');
});

test('attributes package-defined channels to the desktop adapter that registers them', () => {
  const registration = { channel: 'feishuBot:status', file: 'packages/lizi-im/src/feishu/ipc.ts', registeredAt: `${main('im/host.ts')}:172` };
  assert.equal(owningFile(registration), main('im/host.ts'));
  assert.equal(moduleGroup(owningFile(registration)), 'im');
  assert.equal(owner(registration), 'A');
});

test('Host work is A plus backend and two-phase C, ranked by real calls', () => {
  const inventory = {
    registrations: [
      { channel: 'local-db:sessions:list', kind: 'invoke', file: main('localDb/a.ts'), line: 1, gui: [] },
      { channel: 'maker:schedule:list', kind: 'invoke', file: main('maker-ipc/register.ts'), line: 2, gui: [] },
      { channel: 'terminal:write', kind: 'invoke', file: main('maker-ipc/register.ts'), line: 3, gui: [] },
      { channel: 'read-file-bytes', kind: 'invoke', file: main('bootstrap-electron.ts'), line: 4, gui: [] },
      { channel: 'layout:get', kind: 'event', file: main('layout/ipc.ts'), line: 5, gui: [], sync: true },
    ],
    unresolved: [],
    contract,
  };
  const entry = (count, missing = 0, unsupported = 0) => ({ kind: 'invoke', count, handled: count - missing - unsupported, missing, unsupported });
  const channels = {
    'local-db:sessions:list': entry(9), 'read-file-bytes': entry(8), 'layout:get': { ...entry(6), kind: 'event' },
    'maker:schedule:list': entry(2, 0, 2), 'terminal:write': entry(5),
  };
  const embedded = summarize(inventory, { mode: 'embedded', channels });
  assert.deepEqual(embedded.ranking.map((row) => [row.channel, row.count]), [['terminal:write', 5], ['maker:schedule:list', 2]]);
  assert.deepEqual(
    { total: embedded.hostWork.total, A: embedded.hostWork.A, used: embedded.hostWork.used, calls: embedded.hostWork.calls },
    { total: 2, A: 1, used: 2, calls: 7 },
  );
  assert.equal(embedded.totals.S, 1);
  assert.ok(embedded.rows.filter(isWindowClass).some((row) => row.channel === 'read-file-bytes'));
  assert.ok(!embedded.rows.filter(isHostWork).some((row) => row.channel === 'layout:get'));

  const client = rankUsage(embedded.rows, { mode: 'client', channels });
  assert.deepEqual(client.map((row) => [row.channel, row.count]), [['maker:schedule:list', 2]]);
});

test('Host work is ranked by domain: two-phase C joins its A domain, unlisted prefixes form one family', () => {
  const at = (channel, file, extra = {}) => ({ channel, kind: 'invoke', file: main(file), line: 1, gui: [], ...extra });
  const inventory = { registrations: [
    at('maker:schedule:list', 'maker-ipc/register.ts'),
    at('maker:schedule:export', 'maker-ipc/register.ts', { gui: ['dialog'] }),
    at('odd:read', 'odd.ts'),
    at('odd:open', 'other/odd.ts', { gui: ['shell'] }),
    at('terminal:write', 'maker-ipc/register.ts'),
    at('clipboard:copy-text', 'bootstrap-electron.ts'),
  ], unresolved: [], contract: new Set() };
  const entry = (count) => ({ kind: 'invoke', count, handled: count, missing: 0, unsupported: 0 });
  const summary = summarize(inventory, { mode: 'embedded', channels: { 'maker:schedule:export': entry(3), 'odd:read': entry(4), 'terminal:write': entry(1) } });
  assert.deepEqual(summary.families.map((f) => [f.domain, f.total, f.used, f.calls, f.groups]), [
    ['未登记前缀', 2, 1, 4, [['odd', 1], ['other', 1]]],
    ['自动化', 2, 1, 3, [['maker-ipc', 2]]],
    [summary.rows.find((row) => row.channel === 'terminal:write').reason, 1, 1, 1, [['maker-ipc', 1]]],
  ]);
  assert.equal(summary.families.reduce((sum, f) => sum + f.total, 0), summary.hostWork.total);
  const unsampled = summarize(inventory, null);
  assert.deepEqual(unsampled.families.map((f) => [f.domain, f.total, f.used, f.calls]).slice(0, 2), [['未登记前缀', 2, null, null], ['自动化', 2, null, null]]);
  assert.match(renderMarkdown(summary), /## 要 Host 做的：按领域排行[\s\S]*\| 1 \| 未登记前缀 \| 2 \| 1 \| 4 \| odd 1、other 1 \|/);
});

test('reports what a window-class channel does in client mode from the two handler snapshots', () => {
  const snapshot = (invoke, event = []) => ({ registered: { invoke, event } });
  const embedded = snapshot(['maker:computer:status', 'update-relaunch:blocking-summary', 'clipboard:copy-text'], ['maker:computer:drag']);
  const client = snapshot(['clipboard:copy-text']);
  const row = (channel, kind = 'invoke', extra = {}) => ({ channel, kind, ...extra });
  assert.equal(clientBehavior(row('clipboard:copy-text'), client, embedded), 'local');
  assert.equal(clientBehavior(row('maker:computer:status'), client, embedded), 'unsupported');
  assert.equal(clientBehavior(row('update-relaunch:blocking-summary'), client, embedded), 'no-handler');
  assert.equal(clientBehavior(row('maker:computer:drag', 'event'), client, embedded), 'dropped');
  assert.equal(clientBehavior(row('lazy:thing'), client, embedded), 'not-registered-either');
  assert.equal(clientBehavior(row('ghost-page:pick-model', 'invoke', { perWebContents: true }), client, embedded), 'per-webcontents');
  assert.equal(clientBehavior(row('clipboard:copy-text'), null, embedded), 'unknown');
  // A registrar the client branch calls makes its channels local even when the snapshot predates it.
  const registrars = new Set(['registerComputerUseIpc']);
  const computer = row('maker:computer:status', 'invoke', { enclosing: 'registerComputerUseIpc' });
  assert.equal(clientBehavior(computer, client, embedded), 'unsupported');
  assert.equal(clientBehavior(computer, client, embedded, registrars), 'local-source');
  assert.equal(clientBehavior(row('maker:computer:drag', 'event', { enclosing: 'registerComputerUseIpc' }), null, embedded, registrars), 'local-source');
  assert.equal(clientBehavior(row('update-relaunch:blocking-summary', 'invoke', { enclosing: 'registerMakerIpc' }), client, embedded, registrars), 'no-handler');
  assert.equal(clientBehavior(row('clipboard:copy-text', 'invoke', { enclosing: 'registerComputerUseIpc' }), client, embedded, registrars), 'local');
});

// The client branch is read from the real bootstrap, so a moved or renamed branch
// stops generation instead of reporting every window-local registration as rejected.
test('reads the registrars the client-mode branch calls from the real bootstrap', () => {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const ts = createRequire(path.join(root, 'apps/desktop/package.json'))('typescript');
  const file = path.join(root, 'apps/desktop/src/main/bootstrap-electron.ts');
  const sf = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.ESNext, true);
  assert.ok(clientModeRegistrars(sf).has('registerComputerUseIpc'));
  const moved = ts.createSourceFile('x.ts', [
    'const registerMakerIpcsAfterSplash = async () => {',
    '  if (makerIpcsRegistered) return;',
    '  registerComputerUseIpc();',
    '};',
  ].join('\n'), ts.ScriptTarget.ESNext, true);
  assert.throws(() => clientModeRegistrars(moved), /client-mode branch/);
});

test('every Host IPC registry entry resolves to a literal channel the contract can count', () => {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const ts = createRequire(path.join(root, 'apps/desktop/package.json'))('typescript');
  const dir = path.join(root, HOST_IPC_ENTRIES_PREFIX);
  const files = fs.readdirSync(dir).filter((name) => name.endsWith('.ts')).map((name) => path.join(dir, name));
  const program = ts.createProgram(files, { noResolve: true, noLib: true, types: [], target: ts.ScriptTarget.ESNext });
  const { constValues } = createConstResolver(program.getTypeChecker());
  const values = [];
  for (const file of files) {
    const result = collectContractChannels(program.getSourceFile(file), 'channel', constValues);
    assert.deepEqual(result.unresolved, [], file);
    values.push(...result.values);
  }
  for (const channel of ['maker:session-background-tasks:list', 'maker:side-chat:list:v1']) {
    assert.ok(values.includes(channel), `missing ${channel}`);
    assert.equal(owner({ channel, file: main('maker-ipc/register.ts') }, new Set(values)), 'contract');
  }
});

// Value: production analyzer output, PR #10047 Greptile P2 regressions.
// Existing tests had neither a same-name invoke/event pair nor default parameters.
// Minimal inputs: two typed report entries; the real git-review open-file handler.
// Tier: runner (source analysis is this tool's production behavior).
test('keeps same-name invoke and event calls separate in totals and ranking', () => {
  const channel = 'ghosts:workdir-prefs';
  const inventory = { registrations: [
    { channel, kind: 'invoke', file: main('cindy-brain/index.ts'), line: 1, gui: [] },
    { channel, kind: 'event', sync: true, file: main('cindy-brain/index.ts'), line: 2, gui: [] },
  ], unresolved: [], contract: new Set() };
  const entry = (kind, count) => ({ kind, count, handled: count, missing: 0, unsupported: 0 });
  const usage = { version: 2, mode: 'embedded', channels: {
    [`invoke:${channel}`]: entry('invoke', 2), [`event:${channel}`]: entry('event', 7),
  } };
  const summary = summarize(inventory, usage);
  assert.deepEqual(summary.rows.map(r => [r.kind, r.used]), [['event', 7], ['invoke', 2]]);
  assert.deepEqual(summary.ranking.map(r => [r.kind, r.channel, r.count]), [['invoke', channel, 2]]);
  assert.equal(summary.usedTotals.A, 1);
  assert.equal(summary.usedTotals.S, 1);
  assert.equal(summary.usedTotals.calls, 9);
  const client = summarize(inventory, { ...usage, mode: 'client', channels: {
    [`invoke:${channel}`]: { ...entry('invoke', 5), handled: 3, unsupported: 2 },
    [`event:${channel}`]: { ...entry('event', 7), handled: 0, missing: 7 },
  } });
  assert.deepEqual(client.ranking.map(r => [r.kind, r.count]), [['invoke', 2]]);
  assert.equal(client.usedTotals.calls, 9);
  const legacy = summarize(inventory, { mode: 'embedded', channels: { [channel]: entry('event', 7) } });
  assert.equal(legacy.hostWork.used, 0);
  assert.equal(legacy.rows.find(r => r.kind === 'event').used, 7);
});

test('real git-review open-file chain detects shell in openReviewFile default argument', () => {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const desktop = path.join(root, 'apps/desktop');
  const require = createRequire(path.join(desktop, 'package.json'));
  const ts = require('typescript');
  const file = path.join(desktop, 'src/main/git-review/ipc.ts');
  const program = ts.createProgram([file, require.resolve('electron/electron.d.ts')], {
    noResolve: true, noLib: true, types: [], target: ts.ScriptTarget.ESNext,
  });
  const sf = program.getSourceFile(file);
  let handler;
  const visit = node => {
    if (ts.isCallExpression(node) && node.arguments[0]?.getText(sf) === 'GIT_REVIEW_INVOKE.OPEN_FILE') handler = node.arguments[1];
    ts.forEachChild(node, visit);
  };
  visit(sf);
  assert.ok(handler, 'real IPC registration must be found');
  const check = () => {
    const scanner = createWindowApiScanner(program.getTypeChecker());
    const gui = [...scanner.guiOf(handler, 0)];
    assert.ok(gui.includes('shell'), `expected shell, got ${gui}`);
    assert.equal(classify({ channel: 'git-review:open-file', file: main('git-review/ipc.ts'), gui }, contract).sub, 'two-phase');
  };
  check();
  // Exercise Windows separators on every platform using the same parsed program.
  const names = program.getSourceFiles().map(source => [source, source.fileName]);
  try {
    for (const [source, name] of names) source.fileName = name.replace(/\//g, '\\');
    check();
  } finally {
    for (const [source, name] of names) source.fileName = name;
  }
});

/** A program over in-memory sources, typed only by its own declarations. */
/**
 * In-memory program. TypeScript hands the host forward-slash names even on
 * Windows, so the virtual files are keyed by that form, not by `path.join`'s.
 */
function virtualProgram(ts, files) {
  const slash = name => name.replaceAll('\\', '/');
  const virtual = new Map(Object.entries(files).map(([name, text]) => [slash(name), text]));
  const options = { noResolve: true, noLib: true, types: [], target: ts.ScriptTarget.ESNext };
  const host = ts.createCompilerHost(options);
  const read = host.getSourceFile.bind(host);
  host.getSourceFile = (name, version) => (virtual.has(slash(name))
    ? ts.createSourceFile(slash(name), virtual.get(slash(name)), version, true)
    : read(name, version));
  host.fileExists = name => virtual.has(slash(name));
  host.readFile = name => virtual.get(slash(name));
  return ts.createProgram([...virtual.keys()], options, host);
}

test('real host channel contract resolves every desktopChannel, including Object.entries templates', () => {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const require = createRequire(path.join(root, 'apps/desktop/package.json'));
  const ts = require('typescript');
  const file = path.join(root, 'packages/maker-shared/src/hostChannelContract.ts');
  // The ES library keeps `(['a', 'b'] as const).map(action => …)` typed as the literal union.
  const program = ts.createProgram([file], { noResolve: true, lib: ['lib.es2022.d.ts'], types: [], target: ts.ScriptTarget.ESNext });
  const { constValues } = createConstResolver(program.getTypeChecker());
  const { values, unresolved } = collectContractChannels(program.getSourceFile(file), 'desktopChannel', constValues);
  assert.deepEqual(unresolved, []);
  for (const action of ['get-state', 'set-kind', 'set-use-real-profile', 'reset', 'get-health', 'recover',
    'probe-source-read', 'open-extension-store']) {
    assert.ok(values.includes(`browser-backend:${action}`), `missing browser-backend:${action}`);
  }
  assert.ok(values.includes('local-db:right-sidebar-tabs:ensure-singleton'));
  assert.ok(values.includes('local-db:subagent-runs:transcript'));
});

test('an unresolvable contract channel fails generation instead of being dropped', () => {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const ts = createRequire(path.join(root, 'apps/desktop/package.json'))('typescript');
  const name = path.join(root, 'virtual-contract.ts');
  const program = virtualProgram(ts, { [name]: [
    "declare function pick(): string;",
    "const KEYS = { a: 1, b: 2 } as const;",
    "export const CHANNELS = [",
    "  { desktopChannel: 'fixed:one' },",
    "  ...Object.keys(KEYS).map(key => ({ desktopChannel: `keyed:${key}` })),",
    "  ...Object.entries(KEYS).map(([key]) => ({ desktopChannel: `entry:${key}` })),",
    "  { desktopChannel: pick() },",
    "];",
  ].join('\n') });
  const { constValues } = createConstResolver(program.getTypeChecker());
  const { values, unresolved } = collectContractChannels(program.getSourceFile(name), 'desktopChannel', constValues);
  assert.deepEqual(values.sort(), ['entry:a', 'entry:b', 'fixed:one', 'keyed:a', 'keyed:b']);
  assert.deepEqual(unresolved.map(entry => [entry.line, entry.expression]), [[7, 'pick()']]);
  assert.throws(() => requireResolvedContract(unresolved), /1 channel name\(s\) the scanner cannot resolve[\s\S]*virtual-contract\.ts:7 pick\(\)/);
  assert.doesNotThrow(() => requireResolvedContract([]));
});

test('delegation table re-reading contract entries is a pass-through, not an unresolved name', () => {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const ts = createRequire(path.join(root, 'apps/desktop/package.json'))('typescript');
  const name = path.join(root, 'virtual-delegation.ts');
  const program = virtualProgram(ts, { [name]: [
    "declare const HOST_CONTRACT_CHANNELS: readonly { desktopChannel: string }[];",
    "declare const OTHER: readonly { desktopChannel: string }[];",
    "export const PROXIED = [",
    "  ...HOST_CONTRACT_CHANNELS.map((def) => ({ channel: def.desktopChannel })),",
    "  ...OTHER.map((def) => ({ channel: def.desktopChannel })),",
    "  { channel: 'maker:send' },",
    "];",
  ].join('\n') });
  const { constValues } = createConstResolver(program.getTypeChecker());
  const { values, unresolved } = collectContractChannels(program.getSourceFile(name), 'channel', constValues);
  assert.deepEqual(values, ['maker:send']);
  // Only the shared contract is a pass-through; any other source must still resolve.
  assert.deepEqual(unresolved.map(entry => entry.expression), ['def.desktopChannel']);
});
