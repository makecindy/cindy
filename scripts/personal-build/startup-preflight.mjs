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
