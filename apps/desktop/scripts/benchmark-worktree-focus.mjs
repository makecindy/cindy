/**
 * Explicit, real-Git benchmark (not a unit test).
 * node apps/desktop/scripts/benchmark-worktree-focus.mjs <baseline-ref>
 * Executes the baseline/current detectCwd and WorktreeProvider source with a
 * minimal hooks/IPC harness. Git is real; Electron, rendering and IPC are not.
 * Cooldown time is virtual, reported execution times exclude that wait.
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { promisify } from 'node:util';
import vm from 'node:vm';
import ts from 'typescript';

const exec = promisify(execFile);
const baseline = process.argv[2];
if (!baseline) throw new Error('Pass the baseline Git ref explicitly');
const root = (await exec('git', ['rev-parse', '--show-toplevel'])).stdout.trim();
const managerPath = 'apps/desktop/src/main/worktree/WorktreeManager.ts';
const providerPath = 'apps/desktop/src/renderer/contexts/WorktreeContext.tsx';
const source = async (ref, file) =>
  ref
    ? (await exec('git', ['show', `${ref}:${file}`], { cwd: root })).stdout
    : fs.readFile(path.join(root, file), 'utf8');
const versions = await Promise.all(
  [baseline, null].map(async (ref) => ({
    label: ref ? 'before' : 'after',
    manager: await source(ref, managerPath),
    provider: await source(ref, providerPath),
  })),
);

function functionsOnly(sourceText, names, tsx = false) {
  const ast = ts.createSourceFile(
    tsx ? 'source.tsx' : 'source.ts',
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    tsx ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const statements = ast.statements.filter(
    (s) =>
      (ts.isFunctionDeclaration(s) && names.includes(s.name?.text)) ||
      (ts.isVariableStatement(s) &&
        s.declarationList.declarations.some((d) => names.includes(d.name.getText(ast)))),
  );
  assert.equal(statements.length, names.length, 'benchmark source extraction drifted');
  return ts.transpileModule(statements.map((s) => s.getText(ast)).join('\n'), {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.React,
    },
  }).outputText;
}

const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-worktree-focus-'));
const env = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
);
Object.assign(env, {
  GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : os.devNull,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_TERMINAL_PROMPT: '0',
});
const rawGit = (args, cwd) => exec('git', args, { cwd, env, windowsHide: true });
const tick = () => new Promise(setImmediate);

async function run(version, dirs, scenario) {
  let count = 0,
    active = 0,
    peak = 0,
    probes = 0,
    now = 0;
  let metas = {};
  const effects = [],
    disposers = [],
    listeners = new Map(),
    timers = new Map();
  const statsReset = () => {
    count = 0;
    peak = 0;
  };
  const gitExec = async (args, cwd) => {
    count++;
    peak = Math.max(peak, ++active);
    try {
      return await rawGit(args, cwd);
    } finally {
      active--;
    }
  };
  const context = vm.createContext({
    exports: {},
    path,
    gitExec,
    GitExecError: Error,
    getManagedWorktreeBasePath: () => null,
    log: {
      warn: (...args) => {
        throw new Error(JSON.stringify(args));
      },
    },
    React: { createElement: () => null },
    WorktreeContext: { Provider: {} },
    useRef: (current) => ({ current }),
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
    useState: () => [
      metas,
      (value) => {
        metas = typeof value === 'function' ? value(metas) : value;
      },
    ],
    useEffect: (fn) => effects.push(fn),
    Date: { now: () => now },
    setTimeout: (fn, ms) => {
      const id = Symbol();
      timers.set(id, { fn, at: now + ms });
      return id;
    },
    clearTimeout: (id) => timers.delete(id),
    window: {
      addEventListener: (name, fn) => listeners.set(name, fn),
      removeEventListener: (name) => listeners.delete(name),
      electronAPI: {
        worktreeListAll: async () => dirs.map((dir, i) => ({ sessionId: String(i), path: dir })),
        worktreeDetectCwd: async ({ cwd }) => {
          probes++;
          try {
            return await context.detectCwd(cwd);
          } finally {
            probes--;
          }
        },
      },
    },
  });
  vm.runInContext(functionsOnly(version.manager, ['detectCwd']), context);
  const names = ['isLiveOfficialPath', 'WorktreeProvider'];
  if (version.label === 'after')
    names.push('FOREGROUND_REFRESH_INTERVAL_MS', 'VALIDATION_CONCURRENCY');
  vm.runInContext(functionsOnly(version.provider, names, true), context);
  const drain = async () => {
    const deadline = performance.now() + 120_000;
    do {
      if (performance.now() > deadline) throw new Error('benchmark timed out');
      await new Promise((resolve) => setTimeout(resolve, 2));
    } while (probes || active);
    await tick();
  };
  let start = performance.now();
  context.WorktreeProvider({ children: null });
  effects.forEach((fn) => disposers.push(fn()));
  await drain();
  assert.equal(Object.keys(metas).length, dirs.length);
  if (scenario !== 'cold') {
    statsReset();
    now = scenario === 'warm-focus' ? 1000 : 20_000;
    start = performance.now();
    listeners.get('focus')();
    // All ten focus events arrive while the first Git probe is still running.
    await tick();
    for (let i = 1; i < 10; i++) listeners.get('focus')();
    await drain();
  }
  const immediate = {
    gitProcesses: count,
    peakGitProcesses: peak,
    elapsedMs: +(performance.now() - start).toFixed(2),
  };
  let trailing = null;
  if (timers.size) {
    statsReset();
    start = performance.now();
    for (const [id, timer] of timers) {
      timers.delete(id);
      now = timer.at;
      timer.fn();
    }
    await drain();
    trailing = {
      gitProcesses: count,
      peakGitProcesses: peak,
      elapsedMs: +(performance.now() - start).toFixed(2),
    };
  }
  assert.equal(Object.keys(metas).length, dirs.length);
  disposers.forEach((dispose) => dispose?.());
  return { version: version.label, worktrees: dirs.length, scenario, ...immediate, trailing };
}

try {
  const repo = path.join(fixture, 'repo');
  await fs.mkdir(repo);
  await rawGit(['init', '--quiet'], repo);
  await rawGit(
    [
      '-c',
      'user.name=Benchmark',
      '-c',
      'user.email=benchmark@example.invalid',
      'commit',
      '--quiet',
      '--allow-empty',
      '-m',
      'fixture',
    ],
    repo,
  );
  const dirs = [];
  for (let i = 0; i < 100; i++) {
    const dir = path.join(fixture, `worktree-${i}`);
    await rawGit(['worktree', 'add', '--quiet', '--detach', dir, 'HEAD'], repo);
    dirs.push(dir);
  }
  console.log(
    JSON.stringify({
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      git: (await rawGit(['--version'], repo)).stdout.trim(),
      baseline,
      note: 'Real temporary Git worktrees; source-level hooks/IPC harness; not Electron/Windows UI profiling.',
    }),
  );
  for (let repeat = 1; repeat <= 3; repeat++) {
    for (const size of [10, 30, 100]) {
      for (const scenario of ['cold', 'focus-burst', 'warm-focus']) {
        for (const version of repeat % 2 ? versions : [...versions].reverse()) {
          console.log(
            JSON.stringify({ repeat, ...(await run(version, dirs.slice(0, size), scenario)) }),
          );
        }
      }
    }
  }
} finally {
  await fs.rm(fixture, { recursive: true, force: true });
}
