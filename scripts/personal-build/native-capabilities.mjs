/** Native capabilities for personal source builds; never patch an installed/live app. */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {prepareRuntime, verifyRuntime, treeIdentity} from './runtime-store.mjs';
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
  if (![1,2].includes(report.version) || !['built', 'unsupported'].includes(report.state)) throw Error('Invalid native capability report');
  for (const [relative, hash] of Object.entries(report.files || {})) {
    if (path.isAbsolute(relative) || relative.split(/[\\/]/).includes('..') || digest(path.join(root, relative)) !== hash) throw Error(`Native capability changed: ${relative}`);
  }
  if (report.state === 'built' && Object.keys(report.files || {}).length < 3) throw Error('Incomplete native capability inventory');
  if (report.runtime) verifyRuntime(report.runtime, verifyDeveloperSignature);
  return digest(file);
}
export function detachRuntime(app) {
  const realApp = fs.realpathSync(app), temporary = realApp+'.personal-native';
  if (fs.existsSync(temporary) || fs.existsSync(realApp+'.before-native')) throw Error('Incomplete native preparation; inspect retained candidate');
  fs.cpSync(realApp,temporary,{recursive:true,verbatimSymlinks:true});
  fs.renameSync(realApp,realApp+'.before-native'); fs.renameSync(temporary,realApp);
}
export function personalBundleId(name, region) {
  return 'app.cindy.personal.' + createHash('sha256').update(JSON.stringify([name, region])).digest('hex').slice(0, 16);
}
function resolveNativeToolchain() {
  // Respect an explicit toolchain. Otherwise use a locally installed compatible Xcode.
  const candidates = process.env.DEVELOPER_DIR ? [process.env.DEVELOPER_DIR] : [null, ...fs.readdirSync('/Applications').filter(n => /^Xcode.*\.app$/.test(n)).sort().map(n => `/Applications/${n}/Contents/Developer`)];
  let env, sdk;
  for (const developer of candidates) {
    const trial = {...process.env, ...(developer ? {DEVELOPER_DIR:developer} : {})};
    const p = spawnSync('xcrun', ['--sdk','macosx','--show-sdk-version'], {env:trial,encoding:'utf8'});
    if (p.status === 0 && sdkSupported(p.stdout)) { env=trial; sdk=p.stdout.trim(); break; }
  }
  if (!env) throw Error('Live Activity capability missing: install/select macOS SDK 27.3 or newer before personal upgrade');
  return {env, sdk};
}
/** Finder associations must be sealed before signing, just like the Forge package. */
export function personalOpenTypes(region = 'global') {
  if (!['global', 'cn'].includes(region)) throw Error('Invalid personal app region');
  const prefix = region === 'cn' ? 'com.xd.cindycn' : 'com.xd.cindy';
  return {
    CFBundleURLTypes: [{CFBundleURLName:'Cindy Deep Link', CFBundleURLSchemes:['cindy','xdt-maker']}],
    CFBundleDocumentTypes: [
      {CFBundleTypeName:'Folder', CFBundleTypeRole:'Editor', LSHandlerRank:'Alternate', LSItemContentTypes:['public.folder']},
      {CFBundleTypeName:'Cindy Cartridge', CFBundleTypeRole:'Viewer', LSHandlerRank:'Alternate',
        LSItemContentTypes:[`${prefix}.cindy`], CFBundleTypeExtensions:['cindy']},
    ],
    UTImportedTypeDeclarations: [{UTTypeIdentifier:`${prefix}.cindy`, UTTypeDescription:'Cindy Cartridge',
      UTTypeConformsTo:['public.data'], UTTypeTagSpecification:{'public.filename-extension':['cindy'],
        'public.mime-type':['application/x-xd-cindy']}}],
  };
}
export function prepareNativeCapabilities(root, {name = 'personal', region = 'global', runtimeApp, signingIdentity} = {}) {
  const file = receiptPath(root);
  if (fs.existsSync(file)) { nativeIdentity(root); return JSON.parse(fs.readFileSync(file)); }
  const save = report => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify({version:1, ...report}, null, 2)+'\n'); return report; };
  if (process.platform !== 'darwin' || process.arch !== 'arm64' || !sdkSupported(os.release())) {
    return save({state:'unsupported', reason:'Live Activities require macOS 27.3 on Apple silicon', files:{}});
  }
  const {env, sdk} = resolveNativeToolchain();
  const run = (cmd,args) => execFileSync(cmd,args,{cwd:root,env,stdio:'inherit'});
  const desktop = path.join(root,'apps/desktop');
  const sourceApp = path.join(root,'node_modules/electron/dist/Electron.app');
  const app = runtimeApp || sourceApp;
  const processList = execFileSync('ps',['-axo','command='],{encoding:'utf8'});
  if (processList.includes(app+'/Contents/MacOS/Electron')) throw Error('Native preparation requires a stopped candidate');
  // Electron may be hard-linked to pnpm's store. Copy before modifying its plist/signature.
  if (runtimeApp) fs.cpSync(sourceApp, app, {recursive:true, verbatimSymlinks:true});
  else detachRuntime(app);
  const bundleId = personalBundleId(name, region);
  run('/usr/libexec/PlistBuddy',['-c',`Set :CFBundleIdentifier ${bundleId}`,path.join(app,'Contents/Info.plist')]);
  run('/usr/libexec/PlistBuddy',['-c','Set :CFBundleName Cindy Personal',path.join(app,'Contents/Info.plist')]);
  // macOS prefers DisplayName over Name. Keep executable/helper and credential
  // identities intact; branding must be sealed before signing the app.
  run('/usr/libexec/PlistBuddy',['-c','Set :CFBundleDisplayName Cindy',path.join(app,'Contents/Info.plist')]);
  run('/usr/libexec/PlistBuddy',['-c','Set :CFBundleIconFile cindy.icns',path.join(app,'Contents/Info.plist')]);
  // Import structured fields without replacing Electron's existing plist or signing a live app.
  execFileSync('python3', ['-c', 'import json,plistlib,sys; p=sys.argv[1]; d=plistlib.load(open(p,"rb")); d.update(json.load(sys.stdin)); plistlib.dump(d,open(p,"wb"))',
    path.join(app,'Contents/Info.plist')], {input:JSON.stringify(personalOpenTypes(region))});
  fs.copyFileSync(path.join(desktop,'resources/icon.icns'),path.join(app,'Contents/Resources/cindy.icns'));
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
  if (signingIdentity) signDeveloperRuntime(app, signingIdentity);
  run('codesign',['--verify','--deep','--strict',app]);
  const files = {};
  const collect = p => { for (const e of fs.readdirSync(p,{withFileTypes:true})) { const f=path.join(p,e.name); if(e.isDirectory())collect(f); else if(e.isFile())files[path.relative(root,f)]=digest(f); } };
  collect(resources);
  if (!runtimeApp) { collect(extension); collect(packagedResources);
  for(const f of [path.join(app,'Contents/Info.plist'),path.join(app,'Contents/Resources/cindy.icns'),path.join(app,'Contents/Resources/cindy-live-activity-silent.caf')])files[path.relative(root,f)]=digest(f);
  }
  const report=save({state:'built',bundleId,sdk,developerDir:env.DEVELOPER_DIR || null,files});
  console.log('PERSONAL_NATIVE_CAPABILITY=live-activity:built'); return report;
}


/** Certificate-backed signing of nested code, inside-out; retain extension sandbox entitlements. */
export function signDeveloperRuntime(app, identity) {
  if (!/^[A-F0-9]{40}$/.test(identity)) throw Error('A developer signing certificate is required');
  const sign = (file, preserve = false) => execFileSync('/usr/bin/codesign', ['--force', '--sign', identity,
    ...(preserve ? ['--preserve-metadata=entitlements'] : []), file], {stdio:'inherit'});
  const walk = dir => {
    for (const e of fs.readdirSync(dir, {withFileTypes:true})) {
      const file = path.join(dir, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) { walk(file); if (/\.(app|framework|appex)$/.test(e.name)) sign(file, true); }
      else if (e.isFile()) {
        const fd = fs.openSync(file, 'r'), magic = Buffer.alloc(4); fs.readSync(fd, magic, 0, 4, 0); fs.closeSync(fd);
        if (['feedface','feedfacf','cefaedfe','cffaedfe','cafebabe','bebafeca'].includes(magic.toString('hex'))) sign(file, true);
      }
    }
  };
  walk(app); sign(app, true);
}
export function verifyDeveloperSignature(app, identity) {
  execFileSync('codesign', ['--verify','--deep','--strict', app], {stdio:'pipe'});
  const result = spawnSync('codesign', ['-dv','--verbose=4',app], {encoding:'utf8'});
  if (result.status !== 0 || !/TeamIdentifier=(?!not set)[A-Z0-9]+/.test(result.stderr) || /Signature=adhoc/.test(result.stderr))
    throw Error('Personal runtime lacks a developer identity');
  // Compare the actual leaf certificate without recording credentials or private keys.
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-signature-'));
  try {
    execFileSync('codesign', ['-d', '--extract-certificates='+path.join(temp,'cert'), app], {stdio:'pipe'});
    const actual = createHash('sha1').update(fs.readFileSync(path.join(temp,'cert0'))).digest('hex').toUpperCase();
    if (actual !== identity) throw Error('Personal runtime signing identity changed');
  } finally { fs.rmSync(temp, {recursive:true,force:true}); }
}
export function prepareStableNativeCapabilities(root, options = {}) {
  const file = receiptPath(root);
  if (fs.existsSync(file)) {
    const existing = JSON.parse(fs.readFileSync(file));
    if (!existing.runtime && existing.state === 'built') throw Error('Prepare a new candidate for a stable signed runtime');
    nativeIdentity(root); return existing;
  }
  if (process.platform !== 'darwin' || process.arch !== 'arm64' || !sdkSupported(os.release()))
    return prepareNativeCapabilities(root, options);
  // Use the same certificate resolution as the credential helper, never silently fall back to ad-hoc.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const env = {...process.env, PERSONAL_DATA_DIR:options.dataDir || path.join(os.homedir(),'Library/Application Support/CindyPersonal/unconfigured-profile'),
    PERSONAL_STATE_DIR:options.stateDir || path.join(os.homedir(),'Library/Application Support/CindyPersonal')};
  fs.mkdirSync(env.PERSONAL_STATE_DIR, {recursive:true,mode:0o700});
  const result = spawnSync('/bin/zsh', ['-f','-c','source "$1"; resolve_signing_identity; print -r -- "IDENTITY=${CINDY_REMOTE_CREDENTIALS_SIGNING_IDENTITY:-}"',
    'personal-runtime', path.join(here,'credential-signing.zsh')], {env,encoding:'utf8'});
  const identity = /^IDENTITY=([A-F0-9]{40})$/m.exec(result.stdout)?.[1];
  if (result.status !== 0 || !identity) throw Error('Stable personal builds require a developer signing certificate');
  const store = path.join(env.PERSONAL_STATE_DIR,'runtimes',personalBundleId(options.name || 'personal', options.region || 'global'));
  execFileSync('git',['lfs','pull','--include=apps/desktop/native/agent-island/**','--exclude='],{cwd:root,stdio:'inherit'});
  const names = execFileSync('git',['ls-files','-z','--','apps/desktop/native/agent-island'],{cwd:root,encoding:'utf8'}).split('\0').filter(Boolean);
  names.push('apps/desktop/resources/icon.icns');
  const toolchain = resolveNativeToolchain();
  const inputs = {protocol:1, platform:process.platform, arch:process.arch, node:process.versions.node,
    electronBytes:treeIdentity(path.join(root,'node_modules/electron/dist/Electron.app')),
    electron:fs.readFileSync(path.join(root,'node_modules/electron/dist/version'),'utf8').trim(),
    developerDir:toolchain.env.DEVELOPER_DIR || execFileSync('xcode-select',['-p'],{encoding:'utf8'}).trim(), sdk:toolchain.sdk,
    compiler:execFileSync('xcrun',['swiftc','--version'],{env:toolchain.env,encoding:'utf8'}).trim(),
    bundleId:personalBundleId(options.name || 'personal', options.region || 'global'), signingIdentity:identity,
    sources:names.sort().map(name => [name,digest(path.join(root,name))]),
    builder:digest(fileURLToPath(import.meta.url)), storeBuilder:digest(path.join(here,'runtime-store.mjs'))};
  const runtime = prepareRuntime({store, inputs, signingIdentity:identity,
    build:app => prepareNativeCapabilities(root, {...options,runtimeApp:app,signingIdentity:identity}), verifySignature:verifyDeveloperSignature});
  const resources = path.join(root,'apps/desktop/resources/tools/agent-island');
  fs.cpSync(path.join(runtime.directory,'Cindy.app/Contents/Resources/tools/agent-island'),resources,{recursive:true});
  const files = {};
  const collect = dir => { for (const e of fs.readdirSync(dir,{withFileTypes:true})) {
    const f=path.join(dir,e.name); if(e.isDirectory())collect(f); else if(e.isFile())files[path.relative(root,f)]=digest(f);
  } }; collect(resources);
  const report = {version:2,state:'built',bundleId:inputs.bundleId,runtime,files};
  fs.writeFileSync(file,JSON.stringify(report,null,2)+'\n');
  nativeIdentity(root); return report;
}
