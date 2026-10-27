// Contract for scripts/check-test-hygiene.mjs: each case is the smallest source
// that flips one rule decision, so a detector regression cannot silently let
// slow or source-literal unit tests back into CI.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
	compareWithBaseline,
	scanRepository,
	scanTestSource,
	TEST_FILE,
} from "../check-test-hygiene.mjs";

test("hygiene scans both test and spec files", () => {
	assert.equal(TEST_FILE.test("src/example.test.ts"), true);
	assert.equal(TEST_FILE.test("src/example.spec.tsx"), true);
	assert.equal(TEST_FILE.test("src/example.test.js"), true);
	assert.equal(TEST_FILE.test("src/example.spec.cjs"), true);
	assert.equal(TEST_FILE.test("src/example.integration.spec.ts"), true);
	assert.equal(TEST_FILE.test("src/example.ts"), false);
});

test("scanTestSource counts only unjustified hits for each rule", () => {
	const cases = [
		["per-test module reset", "beforeEach(() => { vi.resetModules(); });", { resetModules: 1 }],
		["destructured reset keeps the Vitest binding", "const { resetModules } = vi; beforeEach(() => resetModules());", { resetModules: 1 }],
		["named Vitest import aliases keep reset identity", "import { vi as tools } from 'vitest'; const reload = tools.resetModules; const reset = reload; reset();", { resetModules: 1 }],
		["Vitest namespace aliases keep reset identity", "import * as api from 'vitest'; const namespace = api; const { vitest: tools } = namespace; tools.resetModules();", { resetModules: 1 }],
		["assigned mock and reset aliases keep reset identity", "import { vitest } from 'vitest'; let tools, reload; tools = vitest; reload = tools.resetModules; reload();", { resetModules: 1 }],
		["destructuring assignments keep reset identity", "let reload; ({ resetModules: reload } = vi); reload();", { resetModules: 1 }],
		["a reason cannot exempt a directly registered reset alias", "const { resetModules: reload } = vi;\n// reset-modules: cached state\nbeforeEach(reload);", { resetModules: 1 }],
		["a reason cannot exempt aliases in a cleanup helper", "import { afterEach as cleanup, vi } from 'vitest'; const tools = vi; const { resetModules: reload } = tools; function finish() {\n// reset-modules: cached state\nreload();\n} cleanup(finish);", { resetModules: 1 }],
		["namespace hooks cannot exempt a reset alias", "import * as api from 'vitest'; const reload = api.vi.resetModules; api.beforeEach(() => {\n// reset-modules: cached state\nreload();\n});", { resetModules: 1 }],
		["assigned cleanup helpers cannot exempt a reset alias", "const reload = vi.resetModules; let finish; finish = () => {\n// reset-modules: cached state\nreload();\n}; afterEach(finish);", { resetModules: 1 }],
		["a justified explicit alias restart stays exempt", "const { resetModules: reload } = vitest; it('restart', () => {\n// reset-modules: persisted state after restart\nreload();\n});", { resetModules: 0 }],
		["an unused reset alias does not reload modules", "const { resetModules: reload } = vi; beforeEach(() => {});", { resetModules: 0 }],
		["a parameter shadows a real Vitest import", "import { vi } from 'vitest'; function example(vi) { vi.resetModules(); }", { resetModules: 0 }],
		["a method parameter shadows a real Vitest import", "import { vi } from 'vitest'; const fixture = { run(vi) { vi.resetModules(); } };", { resetModules: 0 }],
		["a local function shadows a reset alias", "const { resetModules: reload } = vi; function example() { function reload() {} beforeEach(() => reload()); }", { resetModules: 0 }],
		["destructured parameters shadow a reset alias", "const { resetModules: reload } = vi; function example({ reload }) { beforeEach(() => reload()); }", { resetModules: 0 }],
		["a local object shadows the global Vitest name", "const vi = { resetModules() {} }; const { resetModules: reload } = vi; reload(); vi.resetModules();", { resetModules: 0 }],
		["computed runtime keys are not static reset aliases", "const resetModules = 'other'; vi[resetModules]();", { resetModules: 0 }],
		["non-Vitest imports cannot acquire reset identity", "import { vi } from './fixture'; import * as tools from './other'; vi.resetModules(); tools.vi.resetModules();", { resetModules: 0 }],
		["type-only imports cannot acquire reset identity", "import type { vi } from 'vitest'; vi.resetModules();", { resetModules: 0 }],
		["local hooks do not turn a justified restart into a per-test reload", "function beforeEach(callback) {} function restart() {\n// reset-modules: verify persisted state\nvi.resetModules();\n} beforeEach(restart);", { resetModules: 0 }],
		[
			"a reason cannot exempt a per-test hook",
			"beforeEach(() => {\n// reset-modules: cached state\nvi.resetModules();\n});",
			{ resetModules: 1 },
		],
		[
			"a reason cannot exempt a transitive per-test helper",
			"function reload() {\n// reset-modules: cached state\nvi.resetModules();\n}\nconst prepare = () => reload(); beforeEach(prepare);",
			{ resetModules: 1 },
		],
		[
			"same-named helpers in sibling suites keep their own lexical binding",
			"describe('reload', () => { function setup() {\n// reset-modules: cached state\nvi.resetModules();\n} beforeEach(setup); }); describe('other', () => { function setup() {} beforeEach(setup); });",
			{ resetModules: 1 },
		],
		[
			"registering a restart callback does not execute it in the hook",
			"let restart; beforeEach(() => { restart = () => {\n// reset-modules: persisted state after restart\nvi.resetModules();\n}; }); it('restart', () => restart());",
			{ resetModules: 0 },
		],
		[
			"explicit restart boundaries remain exempt",
			"function restart() {\n// reset-modules: verify persisted state after restart\nvi.resetModules();\n}\nit('restart', () => restart());",
			{ resetModules: 0 },
		],
		[
			"justified module reset",
			"// reset-modules: auto-sync prefs are module-scoped\nvi.resetModules();",
			{ resetModules: 0 },
		],
		["commented-out reset", "// vi.resetModules();", { resetModules: 0 }],
		["real 250ms wait", "await new Promise((r) => setTimeout(r, 250));", { realWaits: 1 }],
		["short wait", "await new Promise((r) => setTimeout(r, 20));", { realWaits: 0 }],
		["local timeout wrapper", "const tick = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms)); await tick(2_100);", { realWaits: 1 }],
		["constant timeout duration", "const SECOND = 1000; const timeout = 2 * SECOND; setTimeout(done, timeout);", { realWaits: 1 }],
		["generic arrow in a ts file does not hide later waits", "const identity = <T>(value: T) => value; setTimeout(done, 200);", { realWaits: 1 }],
		["property timeout keeps existing detection", "globalThis.setTimeout(done, 200);", { realWaits: 1 }],
		["a local callback timer alias cannot hide a real wait", "const later = setTimeout; await new Promise(r => later(r, 1_000));", { realWaits: 1 }],
		["a global callback timer alias cannot hide a real wait", "const realTimeout = globalThis.setTimeout; realTimeout(done, 1_000);", { realWaits: 1 }],
		["a named callback timer import is captured before fake-timer setup", "import { setTimeout as later } from 'node:timers'; vi.useFakeTimers(); later(done, 1_000);", { realWaits: 1 }],
		["callback timer namespace imports keep existing real-wait detection", "import * as timers from 'node:timers'; timers.setTimeout(done, 200);", { realWaits: 1 }],
		["callback timer default imports keep existing real-wait detection", "import timers from 'timers'; timers.setTimeout(done, 200);", { realWaits: 1 }],
		["callback timer namespace functions retain builtin named exports", "import * as timers from 'node:timers'; vi.useFakeTimers(); const later = timers.setTimeout; later(done, 200);", { realWaits: 1 }],
		["default timer objects keep native functions under the global fake clock", "import timers from 'node:timers'; vi.useFakeTimers(); const later = timers.setTimeout; vi.useRealTimers(); later(done, 200);", { realWaits: 1 }],
		["the default property of a builtin namespace also keeps native timers", "import * as timers from 'node:timers'; vi.useFakeTimers(); timers.default.setTimeout(done, 200);", { realWaits: 1 }],
		["ordinary fixture methods do not acquire native timer identity", "const fixture = { setTimeout() {} }; fixture.setTimeout(done, 200);", { realWaits: 0 }],
		["callback timer aliases preserve short waits", "const later = setTimeout; later(done, 20);", { realWaits: 0 }],
		["callback timer aliases preserve justification at the call", "const later = setTimeout;\n// real-wait: native timeout integration\nlater(done, 1_000);", { realWaits: 0 }],
		["a parameter shadows a callback timer alias", "const later = setTimeout; function example(later) { later(done, 1_000); }", { realWaits: 0 }],
		["a parameter shadows the native timer name", "function example(setTimeout) { setTimeout(done, 1_000); }", { realWaits: 0 }],
		["a local global object cannot acquire callback timer identity", "const globalThis = { setTimeout() {} }; const later = globalThis.setTimeout; later(done, 1_000);", { realWaits: 0 }],
		["a destructured parameter shadows the native timer name", "function example({ setTimeout }) { setTimeout(done, 1_000); }", { realWaits: 0 }],
		["a callback alias captured before fake timers stays real", "const later = setTimeout; vi.useFakeTimers(); later(done, 1_000);", { realWaits: 1 }],
		["a callback alias captured under fake timers stays fake after restoration", "vi.useFakeTimers(); const later = globalThis.setTimeout; vi.useRealTimers(); later(done, 1_000);", { realWaits: 0 }],
		["a callback alias chain preserves the first capture clock", "const real = setTimeout; vi.useFakeTimers(); const later = real; later(done, 1_000);", { realWaits: 1 }],
		["registration-time aliases stay real under fake-timer hooks", "const later = globalThis.setTimeout; beforeEach(() => vi.useFakeTimers()); it('real', () => later(done, 1_000));", { realWaits: 1 }],
		["test-local aliases inherit fake-timer hooks at capture", "beforeEach(() => vi.useFakeTimers()); it('fake', () => { const later = setTimeout; later(done, 1_000); });", { realWaits: 0 }],
		["destructured callback aliases retain the captured clock", "const { setTimeout: later } = globalThis; vi.useFakeTimers(); later(done, 1_000);", { realWaits: 1 }],
		["global object aliases read the timer when the method is captured", "const clock = globalThis; vi.useFakeTimers(); const later = clock.setTimeout; vi.useRealTimers(); later(done, 1_000);", { realWaits: 0 }],
		["a timeout wrapper can use a captured native alias", "const later = setTimeout; const tick = ms => new Promise(r => later(r, ms)); vi.useFakeTimers(); tick(1_000);", { realWaits: 1 }],
		["promise timer uses its first argument", "import { setTimeout } from 'node:timers/promises'; await setTimeout(1_000);", { realWaits: 1 }],
		["promise timer import alias keeps the duration", "import { setTimeout as nap } from 'node:timers/promises'; await nap(1_000);", { realWaits: 1 }],
		["promise timer namespace keeps the duration", "import * as timers from 'node:timers/promises'; await timers.setTimeout(1_000);", { realWaits: 1 }],
		["promise timer namespace alias keeps the duration", "import timers from 'timers/promises'; const promises = timers; await promises.setTimeout(1_000);", { realWaits: 1 }],
		["short promise timer ignores its numeric return value", "import { setTimeout } from 'node:timers/promises'; await setTimeout(20, 1_000);", { realWaits: 0 }],
		["promise timer wrapper uses its first argument", "import { setTimeout as delay } from 'node:timers/promises'; const tick = ms => delay(ms); await tick(1_000);", { realWaits: 1 }],
		["block-bodied async promise timer wrapper uses its first argument", "import { setTimeout as delay } from 'node:timers/promises'; const tick = async ms => { await delay(ms); }; await tick(1_000);", { realWaits: 1 }],
		["block-bodied async promise timer wrapper keeps short waits below the threshold", "import { setTimeout as delay } from 'node:timers/promises'; const tick = async ms => { await delay(ms); }; await tick(20);", { realWaits: 0 }],
		["block-bodied async wrapper does not double count a constant inner wait", "import { setTimeout as delay } from 'node:timers/promises'; const tick = async () => { await delay(1_000); }; await tick(20);", { realWaits: 1 }],
		["promise timer namespace wrapper uses its first argument", "import * as timers from 'node:timers/promises'; const tick = ms => timers.setTimeout(ms); await tick(1_000);", { realWaits: 1 }],
		["short promise timer wrapper stays below the threshold", "import { setTimeout as delay } from 'node:timers/promises'; const tick = ms => delay(ms); await tick(20);", { realWaits: 0 }],
		["promise timer wrapper does not double count a constant inner wait", "import { setTimeout as delay } from 'node:timers/promises'; const tick = () => delay(1_000); await tick(20);", { realWaits: 1 }],
		["promise timer wrapper respects parameter and fixture shadows", "import { setTimeout as delay } from 'node:timers/promises'; const tick = ms => delay(ms); function example(tick) { tick(1_000); } const fixture = { tick() {} }; fixture.tick();", { realWaits: 0 }],
		["a parameter can shadow the promise timer", "import { setTimeout as delay } from 'node:timers/promises'; function example(delay) { delay(1_000); }", { realWaits: 0 }],
		["a local function can shadow the promise timer", "import { setTimeout as delay } from 'node:timers/promises'; function example() { const delay = value => value; delay(1_000); }", { realWaits: 0 }],
		["a parameter can shadow the timer namespace", "import * as timers from 'node:timers/promises'; function example(timers) { timers.setTimeout(1_000); }", { realWaits: 0 }],
		["short wrapper and fixture shadow", "const tick = ms => new Promise(resolve => setTimeout(resolve, ms)); tick(20); function other(tick) { tick(500); }", { realWaits: 0 }],
		["fake wrapper call", "const tick = ms => new Promise(resolve => setTimeout(resolve, ms)); it('fake', () => { vi.useFakeTimers(); tick(500); });", { realWaits: 0 }],
		["an uncalled fake-timer helper does not hide real waits", "function enableFake() { vi.useFakeTimers(); } it('real', () => setTimeout(done, 200));", { realWaits: 1 }],
		["an uncalled real-timer helper does not restore fake timers", "vi.useFakeTimers(); function cleanup() { vi.useRealTimers(); } it('fake', () => setTimeout(done, 200));", { realWaits: 0 }],
		["a called fake-timer helper applies at the call site", "function enableFake() { vi.useFakeTimers(); } it('fake', () => { enableFake(); setTimeout(done, 200); });", { realWaits: 0 }],
		["a called real-timer helper applies at the call site", "vi.useFakeTimers(); const cleanup = () => vi.useRealTimers(); it('real', () => { cleanup(); setTimeout(done, 200); });", { realWaits: 1 }],
		["a registered timer helper applies as a hook", "function enableFake() { vi.useFakeTimers(); } beforeEach(enableFake); it('fake', () => setTimeout(done, 200));", { realWaits: 0 }],
		["transitive timer helper calls preserve their order", "function fake() { vi.useFakeTimers(); } const setup = () => { fake(); vi.useRealTimers(); }; it('real', () => { setup(); setTimeout(done, 200); });", { realWaits: 1 }],
		["inline Promise executors inherit test hooks", "beforeEach(() => vi.useFakeTimers()); it('fake', async () => { await new Promise(resolve => setTimeout(resolve, 200)); });", { realWaits: 0 }],
		["a real-timer alias restores the clock between tests", "vi.useFakeTimers(); const restore = vi.useRealTimers; afterEach(() => restore()); it('first', () => setTimeout(done, 100)); it('later', () => setTimeout(done, 100));", { realWaits: 1 }],
		["destructured timer aliases retain imported Vitest identity", "import { vi as tools, afterEach as cleanup } from 'vitest'; tools.useFakeTimers(); const { useRealTimers: restore } = tools; cleanup(restore); it('first', () => {}); it('later', () => setTimeout(done, 100));", { realWaits: 1 }],
		["assigned namespace timer aliases retain the restoring hook", "import * as api from 'vitest'; api.vi.useFakeTimers(); let restore; ({ useRealTimers: restore } = api.vi); api.afterEach(() => restore()); it('first', () => {}); it('later', () => setTimeout(done, 100));", { realWaits: 1 }],
		["a later static assignment replaces an initial timer alias", "vi.useFakeTimers(); let restore = vi.useFakeTimers; restore = vi.useRealTimers; afterEach(restore); it('first', () => {}); it('later', () => setTimeout(done, 100));", { realWaits: 1 }],
		["a later static assignment replaces an initial cleanup helper", "vi.useFakeTimers(); let cleanup = () => vi.useFakeTimers(); cleanup = () => vi.useRealTimers(); afterEach(cleanup); it('first', () => {}); it('later', () => setTimeout(done, 100));", { realWaits: 1 }],
		["a local replacement clears the old fake-timer identity", "let enable = vi.useFakeTimers; enable = () => {}; beforeEach(enable); it('real', () => setTimeout(done, 100));", { realWaits: 1 }],
		["a later assignment replaces a declared cleanup helper", "vi.useFakeTimers(); function cleanup() { vi.useFakeTimers(); } cleanup = () => vi.useRealTimers(); afterEach(cleanup); it('first', () => {}); it('later', () => setTimeout(done, 100));", { realWaits: 1 }],
		["a later assignment replaces a destructured timer alias", "vi.useFakeTimers(); let { useFakeTimers: restore } = vi; restore = vi.useRealTimers; afterEach(restore); it('first', () => {}); it('later', () => setTimeout(done, 100));", { realWaits: 1 }],
		["timer aliases follow calls through cleanup helpers", "vi.useFakeTimers(); const restore = vi.useRealTimers; const cleanup = () => restore(); const finish = cleanup; afterEach(finish); it('first', () => {}); it('later', () => setTimeout(done, 100));", { realWaits: 1 }],
		["unused timer aliases do not change the clock", "vi.useFakeTimers(); const restore = vi.useRealTimers; it('fake', () => setTimeout(done, 100));", { realWaits: 0 }],
		["fake-timer aliases apply only at actual calls", "const enable = vi.useFakeTimers; beforeEach(enable); it('fake', () => setTimeout(done, 100));", { realWaits: 0 }],
		["timer aliases preserve switching order", "const fake = vi.useFakeTimers; const real = vi.useRealTimers; it('real', () => { fake(); real(); setTimeout(done, 100); });", { realWaits: 1 }],
		["a parameter shadows a real timer alias", "vi.useFakeTimers(); const restore = vi.useRealTimers; it('fake', (restore) => { restore(); setTimeout(done, 100); });", { realWaits: 0 }],
		["lookalike local Vitest objects cannot exempt real waits", "const vi = { useFakeTimers() {} }; vi.useFakeTimers(); it('real', () => setTimeout(done, 100));", { realWaits: 1 }],
		["timer calls inside fixture strings do not change the clock", "const fixture = 'vi.useFakeTimers()'; it('real', () => setTimeout(done, 100));", { realWaits: 1 }],
		[
			"fake-timer file",
			"vi.useFakeTimers();\nsetTimeout(tick, 5_000);",
			{ realWaits: 0 },
		],
		[
			"real wait after fake timers are restored",
			"vi.useFakeTimers();\nvi.useRealTimers();\nsetTimeout(tick, 5_000);",
			{ realWaits: 1 },
		],
		[
			"fake timers in a sibling test do not hide a real wait after cleanup",
			"afterEach(() => vi.useRealTimers());\nit('fake', () => { vi.useFakeTimers(); setTimeout(done, 100); });\nit('real', () => { setTimeout(done, 100); });",
			{ realWaits: 1 },
		],
		[
			"afterEach invalidates file registration-time fake timers for later tests",
			"vi.useFakeTimers(); afterEach(() => vi.useRealTimers()); it('first', () => {}); it('later', () => setTimeout(done, 100));",
			{ realWaits: 1 },
		],
		["afterEach does not precede the first test", "vi.useFakeTimers(); afterEach(() => vi.useRealTimers()); it('first', () => setTimeout(done, 100));", { realWaits: 0 }],
		["afterEach restores timers only for subsequent tests", "vi.useFakeTimers(); afterEach(() => vi.useRealTimers()); it('first', () => setTimeout(done, 100)); it('second', () => setTimeout(done, 100));", { realWaits: 1 }],
		[
			"afterEach invalidates describe registration-time fake timers for later tests",
			"describe('timers', () => { vi.useFakeTimers(); afterEach(() => vi.useRealTimers()); it('first', () => {}); it('later', () => setTimeout(done, 100)); });",
			{ realWaits: 1 },
		],
		[
			"beforeEach fake timers apply to their own describe, not a sibling suite",
			"describe('fake', () => { beforeEach(() => vi.useFakeTimers()); afterEach(() => vi.useRealTimers()); it('one', () => setTimeout(done, 100)); });\ndescribe('real', () => { it('two', () => setTimeout(done, 100)); });",
			{ realWaits: 1 },
		],
		[
			"parent beforeEach runs after nested beforeAll",
			"beforeEach(() => vi.useRealTimers()); describe('child', () => { beforeAll(() => vi.useFakeTimers()); it('real', () => setTimeout(done, 100)); });",
			{ realWaits: 1 },
		],
		[
			"global afterEach applies between sibling suites",
			"vi.useFakeTimers(); afterEach(() => vi.useRealTimers()); describe('one', () => { it('first', () => {}); }); describe('two', () => { it('second', () => setTimeout(done, 100)); });",
			{ realWaits: 1 },
		],
		[
			"new nested beforeAll runs after an earlier parent test",
			"afterEach(() => vi.useRealTimers()); it('parent', () => {}); describe('child', () => { beforeAll(() => vi.useFakeTimers()); it('first child', () => setTimeout(done, 100)); });",
			{ realWaits: 0 },
		],
		[
			"multi-line real wait",
			"await new Promise((resolve) => setTimeout(\n  resolve,\n  250,\n));",
			{ realWaits: 1 },
		],
		[
			"source text in fixture string is not executable",
			"expect(output).toContain('vi.resetModules()'); expect(output).toContain('setTimeout(done, 500)');",
			{ resetModules: 0, realWaits: 0 },
		],
		[
			"source text read",
			"const src = readFileSync(resolve(__dirname, '..', 'Sidebar.tsx'), 'utf8');",
			{ sourceReads: 1 },
		],
		[
			"multi-line source text read",
			"const src = readFileSync(\n  resolve(__dirname, '..', 'Sidebar.tsx'),\n  'utf8',\n);",
			{ sourceReads: 1 },
		],
		[
			"import specifiers are not reads",
			"import { x } from '../x.ts';\nvi.mock('../y.ts');\nreadFileSync(join(__dirname, 'fixtures', 'a.ts'));",
			{ sourceReads: 0 },
		],
		...['swift', 'm', 'mm', 'h', 'cpp', 'rs', 'go', 'kt', 'java', 'cs', 'py'].map(extension => [
			`native and other production source: ${extension}`,
			`const source = readFileSync(new URL('../helper.${extension}', import.meta.url), 'utf8');`,
			{ sourceReads: 1 },
		]),
		[
			"data and binary resources are not production source",
			"readFileSync(new URL('../data.json', import.meta.url)); readFileSync(new URL('../helper.bin', import.meta.url));",
			{ sourceReads: 0 },
		],
		["workspace cwd source", "readFileSync(resolve(process.cwd(), 'src/helper.ts'), 'utf8');", { sourceReads: 1 }],
		// PR #6196: aliases must reach the same source-read decision as the real
		// fs API, while lexical shadows and executable-source harnesses stay valid.
		// Minimal unit inputs exercise scanTestSource directly; no files are read.
		["named fs read alias", "import { readFileSync as readText } from 'node:fs'; readText(new URL('../Component.tsx', import.meta.url));", { sourceReads: 1 }],
		["namespace and function aliases", "import * as files from 'fs'; const disk = files; const load = disk.readFileSync; load(new URL('../Component.tsx', import.meta.url));", { sourceReads: 1 }],
		["promise fs named read alias", "import { readFile as load } from 'node:fs/promises'; await load(new URL('../Component.tsx', import.meta.url));", { sourceReads: 1 }],
		["promise namespace destructuring", "import files from 'fs/promises'; const { readFile: load } = files; await load(new URL('../Component.tsx', import.meta.url));", { sourceReads: 1 }],
		["fs promises export alias", "import { promises as files } from 'node:fs'; const { readFile: load } = files; await load(new URL('../Component.tsx', import.meta.url));", { sourceReads: 1 }],
		["fs promises property", "import files from 'node:fs'; const load = files.promises['readFile']; await load(new URL('../Component.tsx', import.meta.url));", { sourceReads: 1 }],
		["nested fs promises destructuring", "import fs from 'node:fs'; const { promises: { readFile } } = fs; const source = await readFile(new URL('../Component.tsx', import.meta.url)); expect(source).toContain('className');", { sourceReads: 1 }],
		["CommonJS destructured fs alias", "const { readFileSync: load } = require('node:fs'); load(new URL('../Component.tsx', import.meta.url));", { sourceReads: 1 }],
		["dynamic import destructured fs alias", "const { readFileSync: load } = await import('node:fs'); load(new URL('../Component.tsx', import.meta.url));", { sourceReads: 1 }],
		["dynamic import promise namespace alias", "const files = await import('node:fs/promises'); const load = files.readFile; await load(new URL('../Component.tsx', import.meta.url));", { sourceReads: 1 }],
		["assigned fs read alias", "import files from 'node:fs'; let load; ({ readFileSync: load } = files); load(new URL('../Component.tsx', import.meta.url));", { sourceReads: 1 }],
		["read alias parameter shadow", "import { readFileSync as load } from 'node:fs'; function check(load) { load(new URL('../Component.tsx', import.meta.url)); }", { sourceReads: 0 }],
		["fs namespace method parameter shadow", "import files from 'node:fs'; const check = { run(files) { files.readFileSync(new URL('../Component.tsx', import.meta.url)); } };", { sourceReads: 0 }],
		["local read-shaped helper is not fs", "function readFileSync(value) { return value; } readFileSync(new URL('../Component.tsx', import.meta.url));", { sourceReads: 0 }],
		["local read-shaped wrapper forwards to fs", "import fs from 'node:fs'; function readFileSync(file) { return fs.readFileSync(file, 'utf8'); } readFileSync(new URL('../Component.tsx', import.meta.url));", { sourceReads: 1 }],
		["block arrow read-shaped wrapper forwards to fs", "import fs from 'node:fs'; const readFileSync = file => { return fs.readFileSync(file, 'utf8'); }; readFileSync(new URL('../Component.tsx', import.meta.url));", { sourceReads: 1 }],
		["function expression read-shaped wrapper forwards to fs", "import fs from 'node:fs'; const readFileSync = function(file) { return fs.readFileSync(file, 'utf8'); }; readFileSync(new URL('../Component.tsx', import.meta.url));", { sourceReads: 1 }],
		["another module's read API is not fs", "import { readFileSync } from 'test-double'; readFileSync(new URL('../Component.tsx', import.meta.url));", { sourceReads: 0 }],
		["alias helper reads production source", "import { readFileSync as load } from 'node:fs'; const read = (relative: string) => load(resolve(__dirname, relative), 'utf8'); read('../Component.tsx');", { sourceReads: 1 }],
		["aliased read follows execution exemption", "import { readFileSync as load } from 'node:fs'; const source = load(new URL('../Component.tsx', import.meta.url)); expect(new Function(source)()).toBe(true);", { sourceReads: 0 }],
		["aliased read keeps mixed text assertion", "import { readFileSync as load } from 'node:fs'; const source = load(new URL('../Component.tsx', import.meta.url)); new Function(source)(); expect(source).toContain('return true');", { sourceReads: 1 }],
		["embedded source code is only a fixture string", String.raw`const example = "readFileSync(new URL('../Component.tsx', import.meta.url));";`, { sourceReads: 0 }],
		["cwd fixture stays test data", "readFileSync(resolve(process.cwd(), 'fixtures/helper.ts'), 'utf8');", { sourceReads: 0 }],
		["executed source is a behavior harness", "const source = readFileSync(resolve(process.cwd(), 'src/helper.ts'), 'utf8'); const run = new Function(source); expect(run()).toBe(true);", { sourceReads: 0 }],
		["a local factory returns executed behavior", "const source = readFileSync(resolve(process.cwd(), 'src/helper.ts'), 'utf8'); function make(code) { return new Function(code); } const run = make(source); expect(run()).toBe(true);", { sourceReads: 0 }],
		["matchAll destructuring executes captured production code", "const source = readFileSync(resolve(process.cwd(), 'src/helper.ts'), 'utf8'); const matches = [...source.matchAll(/return (.*);/g)]; for (const [, code] of matches) { const run = new Function(code); expect(run()).toBe(true); }", { sourceReads: 0 }],
		["matchAll execution keeps a mixed text assertion", "const source = readFileSync(resolve(process.cwd(), 'src/helper.ts'), 'utf8'); for (const [, code] of source.matchAll(/return (.*);/g)) { new Function(code)(); expect(code).toContain('true'); }", { sourceReads: 1 }],
		["local geometry helpers return evaluated values rather than AST arguments", "const ast = ts.createSourceFile('x.ts', readFileSync(resolve(process.cwd(), 'src/helper.ts'), 'utf8')); function styles(file) { const value = new Function(file.getText())(); return Object.assign({}, value); } expect(styles(ast)).toEqual({ gap: 16 });", { sourceReads: 0 }],
		["a factory with a raw text return branch stays a source assertion", "const source = readFileSync(resolve(process.cwd(), 'src/helper.ts'), 'utf8'); function make(code, raw) { if (raw) return code; return new Function(code)(); } expect(make(source, true)).toContain('return true');", { sourceReads: 1 }],
		["execution cannot exempt a mixed text assertion", "const source = readFileSync(resolve(process.cwd(), 'src/helper.ts'), 'utf8'); new Function(source)(); expect(source).toContain('return true');", { sourceReads: 1 }],
		["node assertion cannot be hidden by execution", "const source = readFileSync(resolve(process.cwd(), 'src/helper.ts'), 'utf8'); new Function(source)(); assert.match(source, /return true/);", { sourceReads: 1 }],
		["nested node assertion cannot be hidden by execution", "const source = readFileSync(resolve(process.cwd(), 'src/helper.ts'), 'utf8'); new Function(source)(); assert.strict.match(source, /return true/);", { sourceReads: 1 }],
		["unrelated execution does not exempt source text", "const source = readFileSync(resolve(process.cwd(), 'src/helper.ts'), 'utf8'); new Function('return true')(); expect(source).toContain('return true');", { sourceReads: 1 }],
		["object property names do not alias a source binding", "const source = readFileSync(resolve(process.cwd(), 'src/helper.ts'), 'utf8'); new Function(source)(); expect(render({ source: 'content' }).props).toEqual({ active: true });", { sourceReads: 0 }],
		["member names do not alias a source binding", "const source = readFileSync(resolve(process.cwd(), 'src/helper.ts'), 'utf8'); new Function(source)(); expect(result.source).toBe('content');", { sourceReads: 0 }],
		["shorthand properties keep their source dependency", "const source = readFileSync(resolve(process.cwd(), 'src/helper.ts'), 'utf8'); new Function(source)(); expect({ source }).toEqual({});", { sourceReads: 1 }],
		["computed property names keep their source dependency", "const source = readFileSync(resolve(process.cwd(), 'src/helper.ts'), 'utf8'); new Function(source)(); expect({ [source]: true }).toEqual({});", { sourceReads: 1 }],
		["vm harness follows the actual read binding", "import vm from 'node:vm'; const sourcePath = resolve(process.cwd(), 'src/helper.ts'); const source = readFileSync(sourcePath, 'utf8'); vm.runInNewContext(source, context);", { sourceReads: 0 }],
		["a vm namespace alias executes the actual read", "import * as evaluator from 'node:vm'; const vm = evaluator; const source = readFileSync(resolve(process.cwd(), 'src/helper.ts'), 'utf8'); expect(vm.runInNewContext(source, context)).toBe(true);", { sourceReads: 0 }],
		["a local vm object cannot exempt text assertions", "const vm = { runInNewContext: code => code }; const source = readFileSync(resolve(process.cwd(), 'src/helper.ts'), 'utf8'); expect(vm.runInNewContext(source)).toContain('return true');", { sourceReads: 1 }],
		["a local vm parameter shadows a real vm import", "import vm from 'node:vm'; const source = readFileSync(resolve(process.cwd(), 'src/helper.ts'), 'utf8'); function check(vm) { expect(vm.runInNewContext(source)).toContain('return true'); } check({ runInNewContext: code => code });", { sourceReads: 1 }],
		["named vm import executes the actual read", "import { runInNewContext as evaluate } from 'node:vm'; const source = readFileSync(resolve(process.cwd(), 'src/helper.ts'), 'utf8'); expect(evaluate(source, context)).toBe(true);", { sourceReads: 0 }],
		["a local vm-shaped helper cannot exempt text assertions", "const source = readFileSync(resolve(process.cwd(), 'src/helper.ts'), 'utf8'); function runInNewContext(code) { return code; } expect(runInNewContext(source)).toContain('return true');", { sourceReads: 1 }],
		["a shadowed Function cannot exempt text assertions", "const source = readFileSync(resolve(process.cwd(), 'src/helper.ts'), 'utf8'); const Function = code => code; expect(new Function(source)).toContain('return true');", { sourceReads: 1 }],
		["AST extraction executes the source callback", "const source = ts.createSourceFile('x.ts', readFileSync(resolve(process.cwd(), 'src/helper.ts'), 'utf8')); let expression; function visit(node) { expression = node.body; } visit(source); const compiled = ts.transpileModule(expression.getText(source)).outputText; const run = new Function(compiled); expect(run()).toBe(true);", { sourceReads: 0 }],
		[
			"multi-line source path declared before the read",
			"const sourcePath = resolve(\n  __dirname,\n  '..',\n  'Image.tsx',\n);\nconst source = readFileSync(sourcePath, 'utf8');",
			{ sourceReads: 1 },
		],
		[
			"a separately executed test script is not a source read",
			"const script = join(\n dirname(fileURLToPath(import.meta.url)),\n '../scripts/test-share.mjs',\n);\nspawnSync(process.execPath, [script]);\nreadFileSync(template, 'utf8');",
			{ sourceReads: 0 },
		],
		[
			"inline executable paths are not source reads",
			"const installer = resolve(__dirname, '../install.sh'); spawnSync('bash', [resolve(__dirname, '../register.sh')]); readFileSync(logPath, 'utf8');",
			{ sourceReads: 0 },
		],
		[
			"a multi-line native source URL is read through its binding",
			"const sourceUrl = new URL(\n '../helper.swift',\n import.meta.url,\n); const source = readFileSync(sourceUrl, 'utf8');",
			{ sourceReads: 1 },
		],
		[
			"source read through a typed helper",
			"const read = (relative: string): string => readFileSync(resolve(__dirname, relative), 'utf8');\nconst source = read('../ChatInput.tsx');",
			{ sourceReads: 1 },
		],
		[
			"source read through a typed function",
			"function read(relative: string): string { return readFileSync(resolve(__dirname, relative), 'utf8'); }\nconst source = read('../ChatInput.tsx');",
			{ sourceReads: 1 },
		],
		[
			"source read through an anchor-derived descriptive binding",
			"const agentsRoot = resolve(__dirname, '..'); const source = readFileSync(resolve(agentsRoot, 'agents', 'index.ts'), 'utf8');",
			{ sourceReads: 1 },
		],
		[
			"multiline anchor bindings retain their complete initializer",
			"const agentsRoot = resolve(\n __dirname, '..',\n); const mainRoot = join(\n agentsRoot, 'main',\n); const source = readFileSync(resolve(mainRoot, 'index.ts'), 'utf8');",
			{ sourceReads: 1 },
		],
		[
			"namespace path factories retain derived repository anchors",
			"import path from 'node:path';\nconst agentsRoot = path.resolve(__dirname, '..');\nconst mainRoot = path['join'](agentsRoot, 'main');\nconst source = readFileSync(path.resolve(mainRoot, 'index.ts'), 'utf8');",
			{ sourceReads: 1 },
		],
		[
			"immutable source filename aliases flow into real reads",
			"const target = '../Component.tsx';\nconst alias = target;\nreadFileSync(resolve(__dirname, alias), 'utf8');",
			{ sourceReads: 1 },
		],
		[
			"unread names and shadowed source filename bindings are not source reads",
			"const target = '../Component.tsx'; function check(target) { readFileSync(target, 'utf8'); }",
			{ sourceReads: 0 },
		],
		[
			"immutable fixture filename remains a fixture input",
			"const target = '../fixture.ts'; readFileSync(resolve(__dirname, target), 'utf8');",
			{ sourceReads: 0 },
		],
		[
			"executing source read through a filename alias preserves the exemption",
			"const target = '../Component.ts'; const source = readFileSync(resolve(__dirname, target), 'utf8'); const load = new Function(source); expect(load()).toBe(1);",
			{ sourceReads: 0 },
		],
		[
			"namespace factories do not make temporary fixture paths repository-derived",
			"import * as path from 'node:path';\nconst fixtureRoot = path.resolve(tmpdir(), 'fixture');\nconst source = readFileSync(path.join(fixtureRoot, 'index.ts'), 'utf8');",
			{ sourceReads: 0 },
		],
		[
			"semicolon-free fixture declarations do not absorb a later repository anchor",
			"const fixtureRoot = mkdtempSync(join(tmpdir(), 'fixture-'))\nconst agentsRoot = resolve(\n __dirname, '..',\n)\nconst source = readFileSync(resolve(fixtureRoot, 'index.ts'), 'utf8');",
			{ sourceReads: 0 },
		],
		["domain object pause is not a real wait", "const meter = { pause(ms) {} }; meter.pause(1_000);", { realWaits: 0 }],
		["domain object sleep is not a real wait", "const sleeper = { sleep(ms) {} }; sleeper.sleep(1_000);", { realWaits: 0 }],
	];
	for (const [name, source, expected] of cases) {
		const result = scanTestSource(source);
		for (const [rule, count] of Object.entries(expected)) {
			assert.equal(result[rule], count, `${name}: ${rule}`);
		}
	}
	assert.equal(
		scanTestSource("readFileSync(resolve(__dirname, '../A.tsx'))", { isGuard: true }).sourceReads,
		0,
		"guard-tier files may read source",
	);
});

test("repository scan grants source exemptions only to explicit script contracts", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "cindy-hygiene-scan-"));
	try {
		fs.mkdirSync(path.join(root, "scripts", "__tests__"), { recursive: true });
		fs.writeFileSync(path.join(root, "scripts", "test-workspaces.config.mjs"), "export default { workspaces: [] };");
		fs.writeFileSync(path.join(root, "scripts", "__tests__", "runner.test.mjs"),
			"vi.resetModules(); setTimeout(done, 100); readFileSync(resolve(__dirname, '../runner.mjs'));");
		// PR #6196: a new ordinary scripts test must not bypass the unit rule
		// by its directory. The registered docs/CI contract retains only the
		// source exemption; module reloads and real waits must still be rejected.
		const appRead = "import { readFileSync as readText } from 'node:fs'; readText(new URL('../../apps/desktop/src/Component.tsx', import.meta.url));";
		fs.writeFileSync(path.join(root, "scripts", "__tests__", "ordinary.test.mjs"), appRead);
		fs.writeFileSync(path.join(root, "scripts", "__tests__", "dev-docs-contract.test.mjs"),
			appRead + "vi.resetModules(); setTimeout(done, 100);");
		const designContracts = ["design-inventory.test.mjs", "glossary-rules.test.mjs", "hardcoded-color-audit.test.mjs"];
		for (const file of designContracts) fs.writeFileSync(path.join(root, "scripts", "__tests__", file),
			appRead + "vi.resetModules(); setTimeout(done, 100);");
		const dbDir = path.join(root, "apps", "desktop", "src", "main", "localDb", "__tests__");
		fs.mkdirSync(dbDir, { recursive: true });
		fs.writeFileSync(path.join(dbDir, "migrationCompatibility.test.ts"),
			appRead + "vi.resetModules(); setTimeout(done, 100);");
		fs.writeFileSync(path.join(dbDir, "ordinary.test.ts"), appRead);
		assert.deepEqual(await scanRepository(root), {
			"apps/desktop/src/main/localDb/__tests__/migrationCompatibility.test.ts": { resetModules: 1, realWaits: 1, sourceReads: 0 },
			"apps/desktop/src/main/localDb/__tests__/ordinary.test.ts": { resetModules: 0, realWaits: 0, sourceReads: 1 },
			"scripts/__tests__/dev-docs-contract.test.mjs": { resetModules: 1, realWaits: 1, sourceReads: 0 },
			...Object.fromEntries(designContracts.map(file => ["scripts/__tests__/" + file, { resetModules: 1, realWaits: 1, sourceReads: 0 }])),
			"scripts/__tests__/ordinary.test.mjs": { resetModules: 0, realWaits: 0, sourceReads: 1 },
			"scripts/__tests__/runner.test.mjs": { resetModules: 1, realWaits: 1, sourceReads: 1 },
		});
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("compareWithBaseline only lets counts stay or shrink", () => {
	const baseline = { "a.test.ts": { resetModules: 2 } };
	const pass = compareWithBaseline(
		{ "a.test.ts": { resetModules: 1, realWaits: 0, sourceReads: 0 } },
		baseline,
	);
	assert.deepEqual(pass.violations, []);
	assert.deepEqual(pass.tightenable, ["a.test.ts"]);

	const fail = compareWithBaseline(
		{
			"a.test.ts": { resetModules: 3, realWaits: 0, sourceReads: 0 },
			"new.test.ts": { resetModules: 0, realWaits: 1, sourceReads: 0 },
		},
		baseline,
	);
	assert.deepEqual(
		fail.violations.map((v) => `${v.file}:${v.rule}:${v.limit}`),
		["a.test.ts:resetModules:2", "new.test.ts:realWaits:0"],
	);

	// Exercise the real CLI in its own Git repository. A same-PR JSON edit must
	// not become trusted merely because it was committed or --update was used.
	// Node resolves ESM entry points through symlinks; macOS os.tmpdir() may use
	// /var while import.meta.url uses /private/var. Match the real CLI path so
	// its main guard runs rather than silently exiting before creating a baseline.
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cindy-hygiene-ratchet-")));
	const baselinePath = path.join(root, "scripts", "test-hygiene-baseline.json");
	const testPath = path.join(root, "apps", "sample", "sample.test.ts");
	const relativeTestPath = "apps/sample/sample.test.ts";
	const scriptPath = path.join(root, "scripts", "check-test-hygiene.mjs");
	// The copied CLI still uses Desktop's declared TypeScript parser; make that
	// existing dependency available in this deliberately dependency-free repo.
	const requireDesktop = createRequire(new URL("../../apps/desktop/package.json", import.meta.url));
	const parserModules = path.dirname(path.dirname(path.dirname(requireDesktop.resolve("typescript"))));
	const environment = { ...process.env, CI: "", GITHUB_EVENT_PATH: "", GITHUB_EVENT_NAME: "", GITHUB_BASE_REF: "", GITHUB_SHA: "", NODE_PATH: parserModules };
	for (const key of Object.keys(environment)) if (key.startsWith("GIT_")) delete environment[key];
	const git = (...args) => execFileSync("git", args, { cwd: root, env: environment, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
	const commit = () => { git("add", "."); git("-c", "user.name=Hygiene Test", "-c", "user.email=hygiene@example.invalid", "commit", "-s", "-qm", "fixture"); return git("rev-parse", "HEAD"); };
	const writeBaseline = files => fs.writeFileSync(baselinePath, JSON.stringify({ files }));
	const writeReads = count => fs.writeFileSync(testPath, Array.from({ length: count }, (_, index) => "readFileSync(resolve(process.cwd(), 'src/input-" + index + ".ts'), 'utf8');").join("\n"));
	const cli = (args = [], extraEnv = {}) => spawnSync(process.execPath, [scriptPath, ...args], { cwd: root, env: { ...environment, ...extraEnv }, encoding: "utf8" });
	const output = result => (result.stdout ?? "") + (result.stderr ?? "");
	try {
		fs.mkdirSync(path.dirname(testPath), { recursive: true });
		fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
		fs.copyFileSync(fileURLToPath(new URL("../check-test-hygiene.mjs", import.meta.url)), scriptPath);
		fs.writeFileSync(path.join(root, "scripts", "test-workspaces.config.mjs"), "export default { workspaces: [] };");
		writeReads(1);
		git("init", "-q", "-b", "main");
		const firstIntroduction = commit();
		git("update-ref", "refs/remotes/origin/main", firstIntroduction);
		const bootstrap = cli(["--update"]);
		assert.equal(bootstrap.status, 0, output(bootstrap));
		assert.match(output(bootstrap), /baseline updated: 1 files/);
		assert.deepEqual(JSON.parse(fs.readFileSync(baselinePath, "utf8")).files,
			{ [relativeTestPath]: { sourceReads: 1 } });
		assert.equal(cli().status, 0);
		const trusted = commit();
		git("update-ref", "refs/remotes/origin/main", trusted);
		writeReads(2);
		writeBaseline({ [relativeTestPath]: { sourceReads: 2 } });
		commit();
		const raised = fs.readFileSync(baselinePath, "utf8");
		for (const args of [[], ["--update"]]) {
			const result = cli(args);
			assert.notEqual(result.status, 0, "committed hand-raised baseline must fail");
			assert.match(output(result), /baseline.*(?:increase|raise)/i);
			assert.equal(fs.readFileSync(baselinePath, "utf8"), raised);
		}
		const eventPath = path.join(root, "github-event.json");
		for (const [eventName, event] of [["pull_request", { pull_request: { base: { sha: trusted } } }], ["merge_group", { merge_group: { base_sha: trusted } }], ["push", { before: trusted }]]) {
			fs.writeFileSync(eventPath, JSON.stringify(event));
			const result = cli([], { GITHUB_EVENT_NAME: eventName, GITHUB_EVENT_PATH: eventPath, GITHUB_BASE_REF: eventName === "pull_request" ? "main" : "" });
			assert.notEqual(result.status, 0, eventName);
			assert.match(output(result), /baseline.*(?:increase|raise)/i);
		}
		fs.writeFileSync(eventPath, JSON.stringify({ pull_request: { base: { sha: "1".repeat(40) } } }));
		const unavailableCommit = cli([], { GITHUB_EVENT_NAME: "pull_request", GITHUB_EVENT_PATH: eventPath, GITHUB_BASE_REF: "main" });
		assert.notEqual(unavailableCommit.status, 0);
		assert.match(output(unavailableCommit), /trusted.*base/i);
		for (const invalidBaseline of [{ files: { [relativeTestPath]: { sourceReads: "unlimited" } } }, { files: [] }, null]) {
			fs.writeFileSync(baselinePath, JSON.stringify(invalidBaseline));
			const invalid = cli();
			assert.notEqual(invalid.status, 0);
			assert.match(output(invalid), /invalid baseline/i);
		}
		fs.unlinkSync(baselinePath);
		for (const args of [[], ["--update"]]) {
			const removed = cli(args);
			assert.notEqual(removed.status, 0);
			assert.match(output(removed), /baseline.*missing|baseline.*removed/i);
			assert.equal(fs.existsSync(baselinePath), false);
		}
		writeBaseline({ [relativeTestPath]: { sourceReads: 1 } });
		writeReads(0);
		const tightened = cli(["--update"]);
		assert.equal(tightened.status, 0, output(tightened));
		assert.deepEqual(JSON.parse(fs.readFileSync(baselinePath, "utf8")).files, {});
		assert.equal(cli().status, 0);
		git("update-ref", "-d", "refs/remotes/origin/main");
		for (const args of [[], ["--update"]]) {
			const missing = cli(args);
			assert.notEqual(missing.status, 0);
			assert.match(output(missing), /trusted.*base/i);
		}
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});
