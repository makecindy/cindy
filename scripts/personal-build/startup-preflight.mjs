import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';

const recordPath = 'scripts/personal-migration-allowlist.json';
const check = (value, message) => {if (!value) throw Error(message);};
const digest = text => createHash('sha256').update(text).digest('hex');
export function startupApproval(directory) {
  const file = path.join(directory, recordPath);
  const bytes = fs.readFileSync(file);
  const committed = execFileSync('git', ['show', `HEAD:${recordPath}`], {cwd:directory, maxBuffer:1024*1024});
  check(bytes.equals(committed), 'Startup migration approval must be committed and unchanged');
  const record = JSON.parse(bytes);
  check(record.blobs && Array.isArray(record.journalTags), 'Invalid startup migration approval');
  return {path:recordPath, sha256:digest(bytes)};
}

/** Calls the candidate's actual shared policy without launching or opening its database. */
export function preflightSharedStartup(c, release, plan) {
  if (c.runtime.mode !== 'shared') return {mode:c.runtime.mode, shared:false};
  if (plan?.migrationSource?.kind === 'frozen-pr') {
    check(JSON.stringify(startupApproval(release.directory)) === JSON.stringify(plan.startupApproval),
      'Migration and shared startup approval differ; prepare a new plan');
  }
  const module = pathToFileURL(path.join(release.directory,'scripts/dev-migration-policy.mjs')).href;
  try {
    execFileSync(c.runtime.node, ['--input-type=module','-e',
      'const m=await import(process.argv[1]);m.assertSharedDevMigrationPolicy(process.argv[2],["--shared"]);',
      module, release.directory], {cwd:release.directory, encoding:'utf8', timeout:15000,
      maxBuffer:1024*1024, env:{...process.env,NODE_OPTIONS:''}, stdio:['ignore','pipe','pipe']});
  } catch (error) {
    throw Error(`Shared startup preflight rejected candidate before shutdown: ${String(error.stderr || error.message).trim()}`);
  }
  return {shared:true, head:release.head, startupApproval:plan?.startupApproval ?? null};
}

/** Inspect the candidate's launch policy with the same redirected stdout as a real switch.
 * Import by file URL so a legacy wrapper cannot enter its CLI (or stop an app).
 */
export function preflightPersonalLauncher(node, directory, fixedApp) {
  const module = pathToFileURL(path.join(directory, 'scripts/restart-desktop-remote.mjs')).href;
  let policy;
  try {
    const result = execFileSync(node, ['--input-type=module', '-e',
      'const m = await import(process.argv[1]); process.stdout.write(JSON.stringify(m.resolveDesktopLaunchPolicy(process.argv.slice(2))));',
      module, '--shared', '--wait-ready', '--reuse-terminal'], {
      cwd:directory, encoding:'utf8', timeout:15000, stdio:['ignore','pipe','pipe'],
      env:{...process.env, NODE_OPTIONS:'', CINDY_PERSONAL_FIXED_APP:fixedApp,
        CINDY_PERSONAL_MONITOR_DIR:'preflight', CINDY_PERSONAL_GENERATION:'preflight'},
    });
    policy = JSON.parse(result);
  } catch (error) {
    const detail = String(error.stderr || error.message).trim();
    throw Error(`Cannot verify personal cold-start support; rebuild the candidate with the updated launcher. ${detail}`, {cause:error});
  }
  check(Number.isSafeInteger(policy?.coldBuildTimeoutMs) && policy.coldBuildTimeoutMs >= 600_000 &&
    policy.reuseTerminal === false, 'Candidate lacks the supervised cold-build interval or independent Terminal; rebuild before switching.');
  return policy;
}
