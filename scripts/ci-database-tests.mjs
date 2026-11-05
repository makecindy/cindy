#!/usr/bin/env node
// Path-gated real SQLite regressions; ordinary unit tests deliberately exclude these tiers.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import manifest from './test-workspaces.config.mjs';
import {
  buildPnpmArgs, checkIncludeCoverage, checkTestFiles, readAllFiles,
  resolveTestInvocation, stripAgentEnvPollutants, selectFilesForTier,
} from './test-workspaces.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DESKTOP = manifest.workspaces.find(workspace => workspace.name === 'desktop');
const REPLAY = 'src/main/localDb/__tests__/migrationReplay.test.ts';
// Upgrade/connection invariants always run. Other DB behavior is selected by
// Vitest's import graph for changed DB sources, not by a list of known failures.
const CORE_DB_INCLUDE = [
  'src/main/localDb/__tests__/*Migration*.test.ts',
  'src/main/localDb/__tests__/migration*.test.ts',
  'src/main/localDb/__tests__/schema*.test.ts',
  'src/main/localDb/__tests__/legacyMigrationLineageBridge.test.ts',
  'src/main/localDb/__tests__/cjkTempTriggersSurvival.test.ts',
  'src/main/__tests__/schemaDriftRepair.test.ts',
  'src/main/__tests__/betterSqliteFactory.test.ts',
];
const INFRASTRUCTURE = new Set([
  '.github/workflows/ci.yml', '.gitattributes', '.npmrc', '.nvmrc',
  'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml',
  'apps/desktop/package.json', 'apps/desktop/drizzle.config.ts',
  'scripts/ci-database-tests.mjs', 'scripts/vitest-database-ci.config.mjs', 'scripts/test-workspaces.mjs',
  'scripts/test-workspaces.config.mjs', 'scripts/shared/pnpm-invocation.mjs',
  'scripts/shared/node-webstorage.mjs',
]);

// Source modules that the DB tier imports directly (including vi.mock targets),
// e.g. git-context/prRefsStore.ts reached from localDb/__tests__. A transitive
// closure covers nearly the whole app, so only the direct edge gates the step.
export function databaseEntrypoints(allFiles, root = ROOT) {
  const known = new Set(allFiles);
  const entrypoints = new Set();
  const specifier = /(?:\bfrom|\bimport|\brequire\(|\bmock\()\s*\(?\s*['"](\.[^'"]*)['"]/g;
  for (const test of selectFilesForTier(DESKTOP, DESKTOP.tiers.db, allFiles)) {
    const source = fs.readFileSync(path.join(root, test), 'utf8');
    for (const match of source.matchAll(specifier)) {
      const target = path.posix.join(path.posix.dirname(test), match[1].replace(/\.[cm]?js$/, ''));
      const resolved = [`${target}.ts`, `${target}.tsx`, `${target}/index.ts`, target].find(file => known.has(file));
      if (resolved) entrypoints.add(resolved);
    }
  }
  return entrypoints;
}

export function needsDatabaseTests(files, entrypoints = new Set()) {
  return files.some(file => INFRASTRUCTURE.has(file) || entrypoints.has(file)
    || /^apps\/desktop\/(?:drizzle\/|native\/sqlite-vec\/|src\/main\/localDb\/|src\/test\/vitest\/|vitest\.config\.)/.test(file)
    || /^apps\/desktop\/src\/main\/scheduler-host\//.test(file)
    || /^apps\/desktop\/scripts\/validate-migrations\.mjs$/.test(file)
    || /^apps\/desktop\/src\/main\/__tests__\/(?:.*Migration|schemaDriftRepair|betterSqliteFactory|.*LocalSessions|codexHistoryPromptInit|orcaStaleIndexCleanup)\.test\.ts$/.test(file));
}

export function detectDatabaseChanges({ eventName, event = {}, head, root = ROOT, git = execFileSync }) {
  const base = eventName === 'pull_request' ? event.pull_request?.base?.sha
    : eventName === 'merge_group' ? event.merge_group?.base_sha
      : eventName === 'push' ? event.before : undefined;
  // Manual runs and new branches have no trustworthy comparison; never skip their DB gate.
  if (!base || /^0+$/.test(base)) return { required: true, reason: 'No event base; run all database regressions' };
  if (!/^[a-f0-9]{40}$/i.test(base) || !/^[a-f0-9]{40}$/i.test(head ?? '')) {
    throw new Error('Database CI requires complete event base/head commit SHAs');
  }
  // No rename detection: a move out of localDb must still report the deleted DB path.
  // NUL separators also preserve spaces/newlines instead of silently splitting filenames.
  const output = git('git', ['diff', '--name-only', '--no-renames', '-z', base, head, '--'], {
    cwd: root, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024,
  });
  const files = output.split('\0').filter(Boolean);
  const desktopFiles = fs.existsSync(path.join(root, DESKTOP.cwd))
    ? readAllFiles(path.join(root, DESKTOP.cwd)).map(file => `${DESKTOP.cwd}/${file}`) : [];
  const entrypoints = databaseEntrypoints(desktopFiles, root);
  return { required: needsDatabaseTests(files, entrypoints), reason: `${files.length} changed paths`, files };
}

export function requireDatabasePlatform(platform = process.platform) {
  if (!['win32', 'darwin'].includes(platform)) {
    throw new Error(`Database CI requires macOS or Windows; migration replay skips on ${platform}`);
  }
}

export function databaseTestRuns(root, allFiles, reportDir, changedFiles) {
  const dbConfig = DESKTOP.tiers.db;
  const entrypoints = databaseEntrypoints(allFiles, root);
  const relatedFiles = (changedFiles ?? []).filter(file =>
    file.startsWith(`${DESKTOP.cwd}/src/`) && /\.[cm]?[jt]sx?$/.test(file)
    && needsDatabaseTests([file], entrypoints));
  // Deleted/moved-out source cannot be followed by an import graph. Unknown
  // event ranges likewise keep the complete DB tier instead of guessing.
  const fullDb = !changedFiles || relatedFiles.some(file => !allFiles.includes(file))
    || changedFiles.some(file => file.startsWith(`${DESKTOP.cwd}/src/`)
      && needsDatabaseTests([file], entrypoints)
      && (file.includes('/fixtures/') || !/\.[cm]?[jt]sx?$/.test(file)));
  const runs = ['migration', 'db'].map(tier => {
    const config = tier === 'db' && !fullDb
      ? { ...dbConfig, include: CORE_DB_INCLUDE } : DESKTOP.tiers[tier];
    checkIncludeCoverage(DESKTOP, tier, config, allFiles);
    const { selected } = checkTestFiles(DESKTOP, tier, config, allFiles);
    if (tier === 'migration' && !selected.includes(`${DESKTOP.cwd}/${REPLAY}`)) {
      throw new Error('Migration tier must select migrationReplay.test.ts');
    }
    const report = path.join(reportDir, `${tier}.json`);
    const command = {
      ...config.command,
      args: [...config.command.args, '--maxWorkers=2', '--reporter=default', '--reporter=json', `--outputFile=${report}`],
    };
    return { tier, report, selected, pnpmArgs: buildPnpmArgs(root, DESKTOP, command, config, selected) };
  });
  if (!fullDb && relatedFiles.length) {
    const config = { ...dbConfig, command: {
      ...dbConfig.command,
      args: ['run', '--config', path.join(root, 'scripts/vitest-database-ci.config.mjs'), '--maxWorkers=2'],
    } };
    const selected = selectFilesForTier(DESKTOP, config, allFiles);
    runs.push({ tier: 'db-related', selected,
      pnpmArgs: buildPnpmArgs(root, DESKTOP, config.command, config, selected, relatedFiles) });
  }
  return runs;
}

export function assertMigrationReplayRan(report) {
  const suites = report?.testResults?.filter(suite =>
    typeof suite.name === 'string' && suite.name.replaceAll('\\', '/').endsWith(`/${REPLAY}`));
  if (report?.success !== true || !suites?.length) throw new Error('Migration replay report is missing or unsuccessful');
  for (const suite of suites) {
    if (suite.status !== 'passed' || !suite.assertionResults?.length
      || suite.assertionResults.some(result => result.status !== 'passed')) {
      throw new Error('Migration replay must execute and pass every case; skipped/pending/todo cases do not satisfy the gate');
    }
  }
}

export function runDatabaseTests(root = ROOT, changedFiles) {
  requireDatabasePlatform();
  const env = { ...process.env };
  const removed = stripAgentEnvPollutants(env);
  if (removed.length) console.log(`ENV ignored for tests: ${removed.join(', ')}`);
  const reportDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-db-ci-'));
  try {
    const files = readAllFiles(path.join(root, DESKTOP.cwd)).map(file => `${DESKTOP.cwd}/${file}`);
    for (const run of databaseTestRuns(root, files, reportDir, changedFiles)) {
      console.log(`Database CI: ${run.tier}, ${run.selected.length} ${run.tier === 'db-related' ? 'candidate files' : 'test files'}`);
      const invocation = resolveTestInvocation(run.pnpmArgs, { env });
      const result = spawnSync(invocation.command, invocation.args, {
        cwd: path.join(root, DESKTOP.cwd), stdio: 'inherit', shell: invocation.shell,
        windowsVerbatimArguments: invocation.windowsVerbatimArguments,
        env: { ...env, ...invocation.env },
      });
      if (result.error) throw result.error;
      if (result.status !== 0) throw new Error(`Database ${run.tier} tests failed (${result.signal ?? result.status})`);
      if (run.tier === 'migration') assertMigrationReplayRan(JSON.parse(fs.readFileSync(run.report, 'utf8')));
    }
  } finally {
    fs.rmSync(reportDir, { recursive: true, force: true });
  }
}

function main() {
  const mode = process.argv[2];
  if (!['detect', 'run'].includes(mode)) throw new Error('Usage: node scripts/ci-database-tests.mjs detect|run');
  const event = process.env.GITHUB_EVENT_PATH
    ? JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8')) : {};
  const result = detectDatabaseChanges({ eventName: process.env.GITHUB_EVENT_NAME, event, head: process.env.GITHUB_SHA });
  if (mode === 'run') return runDatabaseTests(ROOT, result.files);
  console.log(`Database CI required=${result.required}: ${result.reason}`);
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `required=${result.required}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) { console.error(error); process.exitCode = 1; }
}
