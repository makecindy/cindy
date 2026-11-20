/** Preserve Forge/watchers while giving a native personal build a LaunchServices identity. */
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import fs from 'node:fs';
import {verifyInstalledRuntime} from './fixed-install.mjs';
import {nativeIdentity, verifyDeveloperSignature} from './native-capabilities.mjs';
import {spawn,spawnSync} from 'node:child_process';
export function macAppArgs(app, appArgs, cwd, terminal) {
  if (!path.isAbsolute(app) || !terminal.startsWith('/dev/tty') || !appArgs.length) throw Error('Native personal launch requires an app, project and Terminal');
  return ['-W','-n','-a',app,'-o',terminal,'--stderr',terminal,'--args',path.resolve(cwd,appArgs[0]),...appArgs.slice(1)];
}
export function assertPersonalLaunchActive(env) {
  if (!env.CINDY_PERSONAL_FIXED_APP || !env.CINDY_PERSONAL_MONITOR_DIR || !env.CINDY_PERSONAL_GENERATION) return;
  const cancelled = path.join(env.CINDY_PERSONAL_MONITOR_DIR, 'cancelled.json');
  if (fs.statSync(cancelled, {throwIfNoEntry:false})) throw Error('Personal launch was cancelled; refusing late app launch');
  const status = env.XDT_DESKTOP_DEV_STARTUP_STATUS_FILE;
  if (!status) return;
  let record;
  try { record = JSON.parse(fs.readFileSync(status, 'utf8')); }
  catch (error) {
    // Once readiness is acknowledged, a normal Forge relaunch has no status file.
    if (error.code === 'ENOENT') return;
    throw error;
  }
  if (record.state === 'abandoned') throw Error('Personal startup timed out; refusing late app launch');
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(process.cwd(), '../..');
  if (fs.existsSync(path.join(root, 'apps/desktop/resources/personal-native.json'))) nativeIdentity(root);
  let app = process.argv[2];
  if (process.env.CINDY_PERSONAL_FIXED_APP) {
    const receipt = JSON.parse(fs.readFileSync(path.join(root, 'apps/desktop/resources/personal-native.json')));
    app = verifyInstalledRuntime(receipt.runtime, process.env.CINDY_PERSONAL_FIXED_APP, verifyDeveloperSignature);
  }
  const terminal=spawnSync('/usr/bin/tty',[],{stdio:['inherit','pipe','pipe'],encoding:'utf8'});
  if(terminal.status!==0) throw Error('Native personal launch requires the supervised Terminal');
  assertPersonalLaunchActive(process.env);
  const child=spawn('/usr/bin/open',macAppArgs(app,process.argv.slice(3),process.cwd(),terminal.stdout.trim()),{
    stdio:'inherit',env:{...process.env,CINDY_PERSONAL_LAUNCH_SERVICES:'1'},
  });
  child.once('error',e=>{console.error(e.message);process.exitCode=1});
  child.once('exit',code=>{process.exitCode=code??1});
}
