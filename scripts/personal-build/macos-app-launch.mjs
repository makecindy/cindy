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
  const child=spawn('/usr/bin/open',macAppArgs(app,process.argv.slice(3),process.cwd(),terminal.stdout.trim()),{
    stdio:'inherit',env:{...process.env,CINDY_PERSONAL_LAUNCH_SERVICES:'1'},
  });
  child.once('error',e=>{console.error(e.message);process.exitCode=1});
  child.once('exit',code=>{process.exitCode=code??1});
}
