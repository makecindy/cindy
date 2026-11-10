/** Fixed physical macOS app location. Called only by an authorized, stopped-instance activation. */
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {treeIdentity, verifyRuntime} from './runtime-store.mjs';
import {acquire} from './lock.mjs';
import {durableWrite} from './recovery.mjs';

const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const exists = file => { try { fs.lstatSync(file); return true; } catch(e) { if(e.code === 'ENOENT') return false; throw e; } };
const check = (ok, reason) => { if (!ok) throw Error(reason); };
function verifyApp(app, receipt, verifySignature) {
  check(fs.lstatSync(app).isDirectory() && !fs.lstatSync(app).isSymbolicLink(), 'Personal installation must be a physical app directory');
  check(treeIdentity(app) === receipt.digest, 'Installed personal runtime changed; inspect before replacing it');
  verifySignature(app, receipt.signingIdentity);
}
export function verifyInstalledRuntime(runtime, app, verifySignature) {
  const receipt = verifyRuntime(runtime, verifySignature);
  const installed = read(app + '.personal-install.json');
  check(installed.key === runtime.key && installed.digest === runtime.digest, 'Installed personal runtime does not match the selected release');
  verifyApp(app, receipt, verifySignature);
  return app;
}
/** Finish a recorded filesystem transition, not a business/data rollback. Never overwrite unknown files. */
function finishTransition(app, file, {isRunning, verifySignature, rename}) {
  const t = read(file), parent = path.dirname(app), prefix = '.' + path.basename(app) + '.';
  check(t.version === 1 && t.app === app && [t.stage,t.backup].every(p => path.dirname(p) === parent && path.basename(p).startsWith(prefix)), 'Invalid personal installation transition');
  if (exists(app)) {
    // New bundle was renamed before the process stopped: only finish its metadata.
    if (treeIdentity(app) === t.next.digest) {
      verifyApp(app,t.next,verifySignature);
      durableWrite(app+'.personal-install.json',t.next); fs.unlinkSync(file); return;
    }
    check(t.previous, 'An unknown application occupies the installation path');
    verifyApp(app,t.previous,verifySignature);
    check(!isRunning(app), 'Personal app is still running; no replacement');
    check(!exists(t.backup), 'Previous app backup already exists; inspect transition');
    verifyApp(t.stage,t.next,verifySignature);
    rename(app,t.backup);
  }
  check(!isRunning(app), 'Personal app is still running; no replacement');
  verifyApp(t.stage,t.next,verifySignature);
  rename(t.stage,app);
  verifyApp(app,t.next,verifySignature);
  durableWrite(app+'.personal-install.json',t.next);
  fs.unlinkSync(file);
}
export function installFixedRuntime(runtime, app, {isRunning, verifySignature, rename = fs.renameSync}) {
  check(path.isAbsolute(app) && app.endsWith('.app'), 'An absolute personal .app path is required');
  const receipt = verifyRuntime(runtime,verifySignature);
  check(!app.startsWith(runtime.directory + path.sep) && !runtime.directory.startsWith(app + path.sep), 'Installation must be outside the immutable runtime store');
  fs.mkdirSync(path.dirname(app),{recursive:true,mode:0o700});
  app = path.join(fs.realpathSync(path.dirname(app)),path.basename(app));
  const transition=app+'.personal-transition.json', metadata=app+'.personal-install.json';
  // Serializes separate profiles targeting the same destination too. No stale lock is silently removed.
  const unlock=acquire(app+'.personal-install.lock');
  try {
    if(exists(transition)) finishTransition(app,transition,{isRunning,verifySignature,rename});
    let previous = null;
    if(exists(app)) {
      check(exists(metadata),'Refusing to replace an unmanaged application');
      previous=read(metadata); verifyApp(app,previous,verifySignature);
      check(previous.inputs.bundleId === receipt.inputs.bundleId && previous.signingIdentity === receipt.signingIdentity,
        'Personal app identity changed; an explicit identity migration is required');
      if(previous.key === runtime.key) return verifyInstalledRuntime(runtime,app,verifySignature);
    } else check(!exists(metadata),'Managed app is missing; inspect before installing');
    check(!isRunning(app),'Personal app is still running; no replacement');
    const suffix=randomUUID(), prefix=path.join(path.dirname(app),'.'+path.basename(app)+'.');
    const stage=prefix+'stage-'+suffix, backup=prefix+'previous-'+suffix;
    try {
      fs.cpSync(path.join(runtime.directory,'Cindy.app'),stage,{recursive:true,verbatimSymlinks:true});
      verifyApp(stage,receipt,verifySignature);
    } catch(e) { fs.rmSync(stage,{recursive:true,force:true}); throw e; }
    durableWrite(transition,{version:1,app,stage,backup,previous,next:receipt});
    finishTransition(app,transition,{isRunning,verifySignature,rename});
    return app;
  } finally { unlock(); }
}
