/** Explicit operator-authorized, append-only SQL upgrade. Unattended switching never uses this. */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { durableWrite } from './recovery.mjs';
import {startupApproval, preflightSharedStartup} from './startup-preflight.mjs';

const check = (v, m) => { if (!v) throw Error(m); };
const sha = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const run = (command, args, cwd) => execFileSync(command, args, { cwd, encoding: 'utf8', timeout: 600000, maxBuffer: 4*1024*1024, env: { ...process.env, NODE_OPTIONS: '' } }).trim();
const drizzle = 'apps/desktop/drizzle';
const git = (dir, ...args) => run('git', args, dir);


/** Explicit exception binds one frozen PR's entire migration tree, never a moving branch. */
export function migrationSource(directory, build, approvedPr) {
  const main = build.upgradeSnapshot.repositories.app.baseSha;
  const tree = git(directory, 'rev-parse', `HEAD:${drizzle}`);
  if (git(directory, 'rev-parse', `${main}:${drizzle}`) === tree) return { kind: 'main', sha: main };
  check(Number.isSafeInteger(approvedPr) && approvedPr > 0, 'Pending migrations require explicit frozen-PR approval');
  const pr = build.upgradeSnapshot.repositories.app.selected.find(p => p.number === approvedPr);
  check(pr && /^[a-f0-9]{40}$/.test(pr.sha), 'Approved migration PR is not in the frozen selection');
  check(git(directory, 'rev-parse', `${pr.sha}:${drizzle}`) === tree, 'Migration tree differs from the approved PR');
  check(git(directory, 'merge-base', '--is-ancestor', pr.sha, 'HEAD') === '', 'Approved PR is not in the candidate');
  return { kind: 'frozen-pr', number: pr.number, sha: pr.sha };
}
function verifyMigrationSource(plan, candidate) {
  check(git(candidate.directory, 'rev-parse', `HEAD:${drizzle}`) === plan.migrationTree, 'Migration tree changed');
  if (!plan.migrationSource || plan.migrationSource.kind === 'main') {
    check(git(candidate.directory, 'rev-parse', `${plan.canonicalMain}:${drizzle}`) === plan.migrationTree, 'Migrations must match the frozen main commit');
    return;
  }
  check(plan.migrationSource.kind === 'frozen-pr' && path.isAbsolute(plan.buildReport), 'Invalid frozen migration source');
  const build = JSON.parse(fs.readFileSync(plan.buildReport, 'utf8'));
  check(build.app.target === candidate.head && build.upgradeSnapshot.repositories.app.baseSha === plan.canonicalMain, 'Approved build changed');
  const selected = migrationSource(candidate.directory, build, plan.migrationSource.number);
  check(JSON.stringify(selected) === JSON.stringify(plan.migrationSource), 'Approved migration source changed');
}

export function validateDatabasePlan(plan, c, baseline, candidate) {
  check(c.automatic.enabled !== true && c.runtime.mode === 'shared', 'Database upgrades require manual shared mode');
  check(plan?.version === 1 && plan.authorized === true && plan.rehearsal?.ready === true, 'Database upgrade needs explicit authorization and completed rehearsal');
  check(plan.baseline.id === baseline.id && plan.candidate.id === candidate.id &&
    plan.baseline.migrations === baseline.migrations && plan.candidate.migrations === candidate.migrations &&
    plan.baseline.directory === baseline.directory && plan.candidate.directory === candidate.directory &&
    plan.dataDir === c.runtime.dataDir && plan.region === c.region && plan.node === c.runtime.node, 'Database upgrade identity changed');
  check(sha(plan.helper) === plan.helperHash, 'Database runner changed after rehearsal');
  verifyMigrationSource(plan, candidate);
  preflightSharedStartup(c, candidate, plan);
  check(git(candidate.directory, 'status', '--porcelain', '--', drizzle) === '', 'Migration resources are dirty');
  check(!candidate.dbScript && plan.pending.length > 0, 'Private database scripts are not supported');
  return plan;
}
export function runDatabasePlan(plan, action) {
  check(sha(plan.helper) === plan.helperHash, 'Database runner changed');
  check(JSON.stringify(JSON.parse(fs.readFileSync(plan.file, 'utf8'))) === JSON.stringify(plan), 'Database plan changed after acceptance');
  return JSON.parse(run(plan.node, [plan.helper, plan.file, action], plan.candidate.directory));
}
export async function prepareDatabasePlan(c, baseline, candidate, build, output, approval = {}) {
  check(c.runtime.mode === 'shared' && c.automatic.enabled !== true, 'Use manual shared mode');
  check(!fs.existsSync(output), 'Database plan already exists');
  const require = createRequire(path.join(candidate.directory, 'package.json'));
  const esbuild = require('esbuild');
  const helper = output + '.runner.mjs';
  check(!fs.existsSync(helper), 'Database runner already exists');
  await esbuild.build({ entryPoints: [fileURLToPath(new URL('./database-worker.mjs', import.meta.url))],
    outfile: helper, bundle: true, platform: 'node', format: 'esm', target: 'node22',
    alias: { '@personal/migrations': path.join(candidate.directory, 'apps/desktop/src/main/localDb/migrationRunner.ts'),
      '@personal/leases': path.join(candidate.directory, 'apps/desktop/src/main/localDb/schemaMigrationLease.ts') } });
  const canonicalMain = build.upgradeSnapshot.repositories.app.baseSha;
  const migrationTree = git(candidate.directory, 'rev-parse', `HEAD:${drizzle}`);
  const source = migrationSource(candidate.directory, build, approval.pr);
  check(source.kind === 'main' || (typeof approval.buildReport === 'string' && path.isAbsolute(approval.buildReport)), 'Frozen PR approval needs the build report');
  const manifest = dir => fs.readdirSync(path.join(dir, drizzle)).filter(n => /^\d{4}_.+\.sql$/.test(n)).sort().map(fileName => ({
    seq: Number(fileName.slice(0,4)), fileName,
    sqlHash: createHash('sha256').update(fs.readFileSync(path.join(dir, drizzle, fileName),'utf8').replace(/\r\n/g,'\n')).digest('hex'),
    scriptHash: fs.existsSync(path.join(dir, drizzle, 'scripts', fileName.replace(/\.sql$/, '.ts'))) ? 'unsupported' : null,
  }));
  const pending = manifest(candidate.directory).slice(manifest(baseline.directory).length);
  const approvalRecord = source.kind === 'frozen-pr' ? startupApproval(candidate.directory) : null;
  preflightSharedStartup(c, candidate, {migrationSource:source, startupApproval:approvalRecord});
  const nonce = randomUUID();
  const plan = { version: 1, authorized: true, authorizedAt: new Date().toISOString(),
    file: path.resolve(output), node: c.runtime.node, dataDir: fs.realpathSync(c.runtime.dataDir), region: c.region,
    baseline, candidate, canonicalMain, migrationTree, startupApproval: approvalRecord, migrationSource: source, buildReport: approval.buildReport, pending, helper, helperHash: sha(helper),
    rehearsalDir: path.join(c.runtime.dataDir,'personal-upgrade-backups',`rehearsal-${nonce}`),
    backupDir: path.join(c.runtime.dataDir,'personal-upgrade-backups',`before-${nonce}`) };
  durableWrite(output, plan);
  const rehearsal = runDatabasePlan(plan, 'rehearse');
  plan.rehearsal = rehearsal; plan.databases = rehearsal.databases;
  validateDatabasePlan(plan, c, baseline, candidate);
  durableWrite(output, plan);
  return plan;
}
