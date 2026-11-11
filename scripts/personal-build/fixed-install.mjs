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
// OS indexing is repairable metadata, never a reason to strand an installed app.
function registerInstallation(receipt, backup, app, registry) {
  const next = {...receipt};
  delete next.registrationPending;
  if (!registry) return next;
  const errors=[];
  if (backup) { try { registry.unregister(backup); } catch(error) { errors.push(error.message); } }
  try { registry.register(app); } catch(error) { errors.push(error.message); }
  if(errors.length) next.registrationPending={app,backup,errors,at:Date.now()};
  return next;
}
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
/** Read-only gate, also run before stopping the current instance. A different requirement may
 * invalidate macOS grants; it needs a separate, explicit identity migration. */
export function preflightFixedRuntime(runtime, app, {verifySignature, requirement}) {
  const next = verifyRuntime(runtime, verifySignature);
  check(path.isAbsolute(app) && app.endsWith('.app'), 'An absolute personal .app path is required');
  check(!exists(app + '.personal-transition.json'), 'Unfinished personal installation; recover it before another upgrade');
  if (!exists(app)) return { installed: false };
  check(exists(app + '.personal-install.json'), 'Refusing to replace an unmanaged application');
  const previous = read(app + '.personal-install.json');
  verifyApp(app, previous, verifySignature);
  check(previous.inputs.bundleId === next.inputs.bundleId && previous.signingIdentity === next.signingIdentity,
    'Personal app identity changed; an explicit identity migration is required');
  check(requirement(app) === requirement(path.join(runtime.directory, 'Cindy.app')),
    'Personal app signing requirement changed; review identity migration and permission reauthorization before switching');
  const archiveParent = path.dirname(path.dirname(runtime.directory));
  check(fs.statSync(archiveParent).dev === fs.statSync(path.dirname(app)).dev, 'Personal backup store must be on the installation volume');
  return { installed: true, sameRequirement: true };
}
/** Finish a recorded filesystem transition, not a business/data rollback. Never overwrite unknown files. */
function finishTransition(app, file, {isRunning, verifySignature, rename, backupRoot, registry}) {
  const t = read(file), parent = path.dirname(app), prefix = '.' + path.basename(app) + '.';
  const legacy = t.version === 1 && path.dirname(t.backup) === parent && path.basename(t.backup).startsWith(prefix);
  const archived = t.version === 2 && path.dirname(t.backup) === backupRoot && /^previous-[a-f0-9-]{36}\.bundle$/.test(path.basename(t.backup));
  check(t.app === app && path.dirname(t.stage) === parent && path.basename(t.stage).startsWith(prefix) && (legacy || archived), 'Invalid personal installation transition');
  if (exists(app)) {
    // New bundle was renamed before the process stopped: only finish its metadata.
    if (treeIdentity(app) === t.next.digest) {
      verifyApp(app,t.next,verifySignature);
      durableWrite(app+'.personal-install.json',registerInstallation(t.next,t.previous && exists(t.backup)?t.backup:null,app,registry)); fs.unlinkSync(file); return;
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
  durableWrite(app+'.personal-install.json',registerInstallation(t.next,t.previous?t.backup:null,app,registry));
  fs.unlinkSync(file);
}
export function installFixedRuntime(runtime, app, {isRunning, verifySignature, rename = fs.renameSync, registry}) {
  check(path.isAbsolute(app) && app.endsWith('.app'), 'An absolute personal .app path is required');
  const receipt = verifyRuntime(runtime,verifySignature);
  check(!app.startsWith(runtime.directory + path.sep) && !runtime.directory.startsWith(app + path.sep), 'Installation must be outside the immutable runtime store');
  fs.mkdirSync(path.dirname(app),{recursive:true,mode:0o700});
  app = path.join(fs.realpathSync(path.dirname(app)),path.basename(app));
  const transition=app+'.personal-transition.json', metadata=app+'.personal-install.json';
  // Keep retired bundles outside Applications/LaunchServices discovery. Rename remains atomic.
  const archive = path.join(path.dirname(path.dirname(runtime.directory)), 'install-backups');
  fs.mkdirSync(archive,{recursive:true,mode:0o700});
  const backupRoot = fs.realpathSync(archive);
  check(fs.statSync(backupRoot).dev === fs.statSync(path.dirname(app)).dev, 'Personal backup store must be on the installation volume');
  // Serializes separate profiles targeting the same destination too. No stale lock is silently removed.
  const unlock=acquire(app+'.personal-install.lock');
  try {
    if(exists(transition)) finishTransition(app,transition,{isRunning,verifySignature,rename,backupRoot,registry});
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
    const stage=prefix+'stage-'+suffix, backup=path.join(backupRoot,'previous-'+suffix+'.bundle');
    try {
      fs.cpSync(path.join(runtime.directory,'Cindy.app'),stage,{recursive:true,verbatimSymlinks:true});
      verifyApp(stage,receipt,verifySignature);
    } catch(e) { fs.rmSync(stage,{recursive:true,force:true}); throw e; }
    durableWrite(transition,{version:2,app,stage,backup,previous,next:receipt});
    finishTransition(app,transition,{isRunning,verifySignature,rename,backupRoot,registry});
    return app;
  } finally { unlock(); }
}
