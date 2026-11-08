/** Native capabilities for personal source builds; never patch an installed/live app. */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
const receiptPath = root => path.join(root, 'apps/desktop/resources/personal-native.json');
const digest = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
export function sdkSupported(version) {
  const [major, minor] = String(version).trim().split('.').map(Number);
  return major > 27 || major === 27 && minor >= 3;
}
export function nativeIdentity(root) {
  const file = receiptPath(root);
  if (!fs.existsSync(file)) return null;
  const report = JSON.parse(fs.readFileSync(file));
  if (report.version !== 1 || !['built', 'unsupported'].includes(report.state)) throw Error('Invalid native capability report');
  for (const [relative, hash] of Object.entries(report.files || {})) {
    if (path.isAbsolute(relative) || relative.split(/[\\/]/).includes('..') || digest(path.join(root, relative)) !== hash) throw Error(`Native capability changed: ${relative}`);
  }
  if (report.state === 'built' && Object.keys(report.files || {}).length < 3) throw Error('Incomplete native capability inventory');
  return digest(file);
}
export function detachRuntime(app) {
  const realApp = fs.realpathSync(app), temporary = realApp+'.personal-native';
  if (fs.existsSync(temporary) || fs.existsSync(realApp+'.before-native')) throw Error('Incomplete native preparation; inspect retained candidate');
  fs.cpSync(realApp,temporary,{recursive:true,verbatimSymlinks:true});
  fs.renameSync(realApp,realApp+'.before-native'); fs.renameSync(temporary,realApp);
}
export function prepareNativeCapabilities(root) {
  const file = receiptPath(root);
  if (fs.existsSync(file)) { nativeIdentity(root); return JSON.parse(fs.readFileSync(file)); }
  const save = report => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify({version:1, ...report}, null, 2)+'\n'); return report; };
  if (process.platform !== 'darwin' || process.arch !== 'arm64' || !sdkSupported(os.release())) {
    return save({state:'unsupported', reason:'Live Activities require macOS 27.3 on Apple silicon', files:{}});
  }
  // Respect an explicit toolchain. Otherwise use a locally installed compatible Xcode.
  const candidates = process.env.DEVELOPER_DIR ? [process.env.DEVELOPER_DIR] : [null, ...fs.readdirSync('/Applications').filter(n => /^Xcode.*\.app$/.test(n)).sort().map(n => `/Applications/${n}/Contents/Developer`)];
  let env, sdk;
  for (const developer of candidates) {
    const trial = {...process.env, ...(developer ? {DEVELOPER_DIR:developer} : {})};
    const p = spawnSync('xcrun', ['--sdk','macosx','--show-sdk-version'], {env:trial,encoding:'utf8'});
    if (p.status === 0 && sdkSupported(p.stdout)) { env=trial; sdk=p.stdout.trim(); break; }
  }
  if (!env) throw Error('Live Activity capability missing: install/select macOS SDK 27.3 or newer before personal upgrade');
  const run = (cmd,args) => execFileSync(cmd,args,{cwd:root,env,stdio:'inherit'});
  const desktop = path.join(root,'apps/desktop');
  const app = path.join(root,'node_modules/electron/dist/Electron.app');
  const processList = execFileSync('ps',['-axo','command='],{encoding:'utf8'});
  if (processList.includes(app+'/Contents/MacOS/Electron')) throw Error('Native preparation requires a stopped candidate');
  // Electron may be hard-linked to pnpm's store. Copy before modifying its plist/signature.
  detachRuntime(app);
  // Some developer Electron distributions omit resource seals. Seal the base
  // runtime before adding the separately sandbox-signed WidgetKit extension.
  run('codesign',['--force','--deep','--sign','-','--preserve-metadata=entitlements',app]);
  const native = path.join(desktop,'native/agent-island');
  run('git',['lfs','pull','--include=apps/desktop/native/agent-island/**','--exclude=']);
  const resources = path.join(desktop,'resources/tools/agent-island'); fs.mkdirSync(resources,{recursive:true});
  const helper = path.join(resources,'xdt-macos-agent-island-helper');
  run('xcrun',['swiftc','-O','-target','arm64-apple-macos14.0',path.join(native,'macos-agent-island-helper.swift'),'-o',helper]);
  for (const entry of ['mascots','sounds','running-agent.gif']) fs.cpSync(path.join(native,entry),path.join(resources,entry),{recursive:true});
  const build = path.join(native,'live-activity/build.mjs');
  const addon = path.join(resources,'cindy-agent-activity.node');
  run(process.execPath,[build,'addon',addon,'arm64']);
  if (!fs.existsSync(addon)) throw Error('Required Live Activity addon was skipped');
  const packagedResources = path.join(app,'Contents/Resources/tools/agent-island');
  fs.cpSync(resources,packagedResources,{recursive:true});
  run(process.execPath,[build,'extension',app,'arm64']);
  const extension = path.join(app,'Contents/PlugIns/CindyAgentActivity.appex');
  if (!fs.existsSync(extension)) throw Error('Required Live Activity widget extension was skipped');
  // Preserve the extension's sandbox signature; do not use --deep to re-sign it.
  run('codesign',['--force','--sign','-',app]);
  run('codesign',['--verify','--deep','--strict',app]);
  const files = {};
  const collect = p => { for (const e of fs.readdirSync(p,{withFileTypes:true})) { const f=path.join(p,e.name); if(e.isDirectory())collect(f); else if(e.isFile())files[path.relative(root,f)]=digest(f); } };
  collect(resources); collect(extension); collect(packagedResources);
  for(const f of [path.join(app,'Contents/Info.plist'),path.join(app,'Contents/Resources/cindy-live-activity-silent.caf')])files[path.relative(root,f)]=digest(f);
  const report=save({state:'built',sdk,developerDir:env.DEVELOPER_DIR || null,files});
  console.log('PERSONAL_NATIVE_CAPABILITY=live-activity:built'); return report;
}
