import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {sdkSupported,nativeIdentity,detachRuntime,personalBundleId,preparePersonalInput} from '../personal-build/native-capabilities.mjs';
test('Live Activity SDK gate rejects old/invalid SDKs and accepts newer SDKs',()=>{
 for(const v of ['27.0','27.2','26.9','','invalid']) assert.equal(sdkSupported(v),false,v);
 for(const v of ['27.3','27.3.1','28.0']) assert.equal(sdkSupported(v),true,v);
});
test('native capability identity detects removed/replaced artifacts and rejects incomplete receipts',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'personal-native-test-'));
 try {
  assert.equal(nativeIdentity(root),null);
  const file=path.join(root,'apps/desktop/resources/personal-native.json');fs.mkdirSync(path.dirname(file),{recursive:true});
  const files={};for(const name of ['addon','extension','plist']){fs.writeFileSync(path.join(root,name),name);files[name]=createHash('sha256').update(name).digest('hex');}
  const save=files=>fs.writeFileSync(file,JSON.stringify({version:1,state:'built',files}));save(files);
  const identity=nativeIdentity(root);assert.equal(identity.length,64);
  fs.writeFileSync(path.join(root,'addon'),'replacement');assert.throws(()=>nativeIdentity(root),/changed/);
  fs.writeFileSync(path.join(root,'addon'),'addon');assert.equal(nativeIdentity(root),identity);
  save({addon:files.addon});assert.throws(()=>nativeIdentity(root),/Incomplete/);
  save(files);fs.unlinkSync(path.join(root,'extension'));assert.throws(()=>nativeIdentity(root));
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('runtime copy preserves signed framework links and breaks shared file hard links',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'personal-runtime-test-'));
 try {
  const app=path.join(root,'Electron.app');fs.mkdirSync(path.join(app,'Versions/A'),{recursive:true});
  const store=path.join(root,'store');fs.writeFileSync(store,'original');fs.linkSync(store,path.join(app,'Versions/A/binary'));
  fs.symlinkSync('A',path.join(app,'Versions/Current'));fs.symlinkSync('Versions/Current/binary',path.join(app,'binary'));
  detachRuntime(app);
  assert.equal(fs.readlinkSync(path.join(app,'binary')),'Versions/Current/binary');
  assert.equal(fs.readlinkSync(path.join(app,'Versions/Current')),'A');
  fs.writeFileSync(path.join(app,'binary'),'changed');assert.equal(fs.readFileSync(store,'utf8'),'original');
  assert.equal(fs.readFileSync(app+'.before-native/binary','utf8'),'original');
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('mac app launch preserves argv, waits for exit, and resolves the project before LaunchServices changes cwd',async()=>{
 const {macAppArgs}=await import('../personal-build/macos-app-launch.mjs');
 const args=macAppArgs('/tmp/Personal App.app',['.','--flag','a b'],'/tmp/project','/dev/ttys123');
 assert.deepEqual(args,['-W','-n','-a','/tmp/Personal App.app','-o','/dev/ttys123','--stderr','/dev/ttys123','--args','/tmp/project','--flag','a b']);
 assert.throws(()=>macAppArgs('/tmp/App.app',['.'],'/tmp','/tmp/not-terminal'));
});

test('personal bundle identity is stable across releases and separates named profiles and regions',()=>{
 assert.equal(personalBundleId('me','global'),personalBundleId('me','global'));
 assert.notEqual(personalBundleId('me','global'),personalBundleId('me','cn'));
 assert.notEqual(personalBundleId('me','global'),personalBundleId('another','global'));
 assert.match(personalBundleId('a b/复杂','global'),/^app\.cindy\.personal\.[a-f0-9]{16}$/);
});

// Value: production prepare/select must reuse a signed shell for distinct business releases,
// retain the previous shell and refuse tampering/live replacement. Existing tests only covered
// per-checkout copies. Minimal fixture: two runtime keys, one active shell. Tier: filesystem integration.
test('runtime reuse, failure isolation, live selection guard and previous-version retention',async()=>{
 const {prepareRuntime,selectRuntime,verifyRuntime}=await import('../personal-build/runtime-store.mjs');
 const store=fs.mkdtempSync(path.join(os.tmpdir(),'personal-runtime-store-'));
 try {
  let builds=0;
  const options={store,inputs:{electron:'1',native:'a'},signingIdentity:'fixture',
   build:app=>{builds++;fs.mkdirSync(app);fs.writeFileSync(path.join(app,'binary'),'runtime');},verifySignature:()=>{}};
  const first=prepareRuntime(options), same=prepareRuntime(options);
  assert.deepEqual(first,same);assert.equal(builds,1);
  const link=selectRuntime(first,{isRunning:()=>false,verifySignature:()=>{}});
  const second=prepareRuntime({...options,inputs:{electron:'2',native:'a'}});
  assert.equal(fs.realpathSync(link),path.join(first.directory,'Cindy.app'));
  assert.throws(()=>selectRuntime(second,{isRunning:()=>true,verifySignature:()=>{}}),/still in use/);
  selectRuntime(second,{isRunning:()=>false,verifySignature:()=>{}});
  assert.equal(fs.realpathSync(link),path.join(second.directory,'Cindy.app'));
  verifyRuntime(first);
  assert.throws(()=>prepareRuntime({...options,inputs:{electron:'bad'},build:()=>{throw Error('signing failed');}}),/signing failed/);
  assert.equal(fs.realpathSync(link),path.join(second.directory,'Cindy.app'));
  fs.writeFileSync(path.join(first.directory,'Cindy.app/binary'),'tampered');
  assert.throws(()=>prepareRuntime(options),/runtime changed/);
 }finally{fs.rmSync(store,{recursive:true,force:true});}
});

// Fixed installation must keep one physical app path, refuse replacement while running,
// and resume an interrupted rename without deleting the old bundle or touching user data.
// Existing cache tests only covered a symlink. Tier: filesystem integration, injected rename failure.
test('fixed installation reuses its path and resumes a failed switch with old runtime retained',async()=>{
 const {prepareRuntime}=await import('../personal-build/runtime-store.mjs');
 const {installFixedRuntime,verifyInstalledRuntime,preflightFixedRuntime}=await import('../personal-build/fixed-install.mjs');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'personal-fixed-install-'));
 try {
  const prepare=(v,identity='fixture')=>prepareRuntime({store:path.join(dir,'store'),inputs:{bundleId:'personal-test',version:v},signingIdentity:identity,
   build:app=>{fs.mkdirSync(app);fs.writeFileSync(path.join(app,'binary'),v);},verifySignature:()=>{}});
  const first=prepare('one'), second=prepare('two');
  const app=path.join(fs.realpathSync(dir),'Applications','Cindy Personal.app');
  const options={isRunning:()=>false,verifySignature:()=>{}};
  installFixedRuntime(first,app,options);
  assert.deepEqual(preflightFixedRuntime(second,app,{...options,requirement:()=> 'same designated requirement'}),{installed:true,sameRequirement:true});
  // Same certificate/bundle ID is insufficient: reject changed designated requirements before quit.
  assert.throws(()=>preflightFixedRuntime(second,app,{...options,requirement:where=>where === app ? 'old' : 'new'}),/signing requirement changed/);
  assert.equal(fs.lstatSync(app).isSymbolicLink(),false);
  const before=fs.statSync(path.join(app,'binary')).mtimeMs;
  installFixedRuntime(first,app,{...options,isRunning:()=>true});
  assert.equal(fs.statSync(path.join(app,'binary')).mtimeMs,before);
  assert.throws(()=>installFixedRuntime(second,app,{...options,isRunning:()=>true}),/still running/);
  assert.throws(()=>installFixedRuntime(prepare('three','different'),app,options),/identity changed/);
  let renames=0;
  assert.throws(()=>installFixedRuntime(second,app,{...options,rename:(a,b)=>{if(++renames===2)throw Error('power interrupted');fs.renameSync(a,b);}}),/power interrupted/);
  assert.equal(fs.existsSync(app),false);
  const pending=JSON.parse(fs.readFileSync(app+'.personal-transition.json'));
  assert.equal(fs.readFileSync(path.join(pending.backup,'binary'),'utf8'),'one');
  assert.equal(path.dirname(pending.backup),path.join(fs.realpathSync(dir),'store','install-backups'));
  assert.ok(!pending.backup.endsWith('.app'));
  installFixedRuntime(second,app,options);
  assert.equal(verifyInstalledRuntime(second,app,()=>{}),app);
  assert.equal(fs.readFileSync(path.join(app,'binary'),'utf8'),'two');
  assert.equal(fs.existsSync(app+'.personal-transition.json'),false);
  assert.equal(fs.readFileSync(path.join(pending.backup,'binary'),'utf8'),'one');
  // A crash after publishing the new directory must only finish metadata on retry,
  // even if that app has since started. Never move the running bundle again.
  const third=prepare('three');let moves=0;
  assert.throws(()=>installFixedRuntime(third,app,{...options,rename:(a,b)=>{fs.renameSync(a,b);if(++moves===2)throw Error('after promotion');}}),/after promotion/);
  const inode=fs.statSync(app).ino;
  installFixedRuntime(third,app,{...options,isRunning:()=>true});
  assert.equal(fs.statSync(app).ino,inode);
  verifyInstalledRuntime(third,app,()=>{});
  // OS registration failures must never strand the installation or its recovery.
  const fourth=prepare('four');const registrations=[];
  installFixedRuntime(fourth,app,{...options,registry:{unregister:()=>{throw Error('registry unavailable');},register:fixed=>registrations.push(fixed)}});
  assert.equal(fs.existsSync(app+'.personal-transition.json'),false);
  assert.deepEqual(registrations,[app]);
  const metadata=JSON.parse(fs.readFileSync(app+'.personal-install.json'));
  assert.deepEqual(metadata.registrationPending.errors,['registry unavailable']);
  verifyInstalledRuntime(fourth,app,()=>{});
  // Recovery to the old runtime also completes even if indexing remains unavailable.
  installFixedRuntime(third,app,{...options,registry:{unregister:()=>{throw Error('registry unavailable');},register:()=>{throw Error('index offline');}}});
  verifyInstalledRuntime(third,app,()=>{});
  assert.equal(fs.existsSync(app+'.personal-transition.json'),false);
  const foreign=path.join(dir,'Other.app');fs.mkdirSync(foreign);fs.writeFileSync(path.join(foreign,'keep'),'mine');
  assert.throws(()=>installFixedRuntime(first,foreign,options),/unmanaged/);
  assert.equal(fs.readFileSync(path.join(foreign,'keep'),'utf8'),'mine');
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

// Regression: a renamed Electron shell omitted Finder associations entirely.
// These are optional handlers, not a takeover of the official app's default.
test('personal shell accepts task URLs, folders and cartridges without claiming session-share files', async()=>{
 const {personalOpenTypes}=await import('../personal-build/native-capabilities.mjs');
 for(const region of ['global','cn']) {
  const p=personalOpenTypes(region);
  assert.deepEqual(p.CFBundleURLTypes[0].CFBundleURLSchemes,['cindy','xdt-maker']);
  assert.ok(p.CFBundleDocumentTypes.some(t=>t.LSItemContentTypes.includes('public.folder')));
  const cartridge=p.CFBundleDocumentTypes.find(t=>t.CFBundleTypeExtensions?.includes('cindy'));
  assert.ok(cartridge);
  assert.equal(cartridge.LSHandlerRank,'Alternate');
  assert.equal(cartridge.LSItemContentTypes[0],p.UTImportedTypeDeclarations[0].UTTypeIdentifier);
  assert.ok(!p.CFBundleDocumentTypes.some(t=>t.CFBundleTypeExtensions?.includes('cshare')));
 }
 assert.throws(()=>personalOpenTypes('unknown'),/Invalid/);
});

// Regression: native preparation omitted the input executable, forcing a profile
// cache build with an unrelated ad-hoc identity. Filesystem integration with a
// fake compiler checks the production build entry and cleanup on compiler failure.
test('personal preparation embeds the input helper and propagates build failure',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'personal-input-build-'));
 try {
  for(const [file,text] of [
   ['packages/remote-credentials-native/Sources/DesktopNativeCaller/DesktopNativeCaller.swift','caller fixture'],
   ['apps/desktop/native/remote-desktop/macos-input.swift','input fixture'],
  ]) {const p=path.join(root,file);fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,text);}
  const app=path.join(root,'Cindy.app');let temporary;
  preparePersonalInput(root,app,(cmd,args)=>{
   assert.equal(cmd,'xcrun');assert.deepEqual(args.slice(0,4),['swiftc','-D','DESKTOP_INPUT_PERSONAL','-O']);
   temporary=path.dirname(args[4]);assert.equal(fs.readFileSync(args[4],'utf8'),'caller fixture\ninput fixture');
   fs.writeFileSync(args.at(-1),'compiled fixture');
  });
  assert.equal(fs.readFileSync(path.join(app,'Contents/Resources/tools/remote-desktop/cindy-macos-desktop-input'),'utf8'),'compiled fixture');
  assert.equal(fs.existsSync(temporary),false);
  assert.throws(()=>preparePersonalInput(root,app,(_cmd,args)=>{
   temporary=path.dirname(args[4]);throw Error('compiler failed');
  }),/compiler failed/);
  assert.equal(fs.existsSync(temporary),false);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});

// Registration is not filesystem retention: even a renamed .bundle can remain registered.
// Exercise exact bundle-ID selection and the production unregister/register order without system writes.
test('LaunchServices retirement removes the old path then re-registers the stable installation',async()=>{
 const {parseRegisteredApps,appRegistry}=await import('../personal-build/app-registry.mjs');
 const dump='--------------------\npath: /tmp/old.bundle (0x123)\nidentifier: app.cindy.personal.fixture\n--------------------\npath: /tmp/official.app (0x456)\nidentifier: com.xd.cindy\n';
 assert.deepEqual(parseRegisteredApps(dump,'app.cindy.personal.fixture'),['/tmp/old.bundle']);
 const calls=[];appRegistry(args=>calls.push(args)).retire('/tmp/old.bundle','/tmp/Personal.app');
 assert.deepEqual(calls,[['-u','/tmp/old.bundle'],['-f','/tmp/Personal.app']]);
});

test('registry repair preserves running, foreign and unverifiable copies',async()=>{
 const {reconcileRegistrations}=await import('../personal-build/app-registry.mjs');
 const removed=[],registered=[];
 const result=reconcileRegistrations('/fixed.app',{paths:['/fixed.app','/old.bundle','/running.app','/foreign.app','/tampered.app'],
  canonical:copy=>copy,
  verify:copy=>{if(copy==='/tampered.app')throw Error('invalid signature');},
  isRunning:copy=>copy==='/running.app',sameBundle:copy=>copy!=='/foreign.app',
  registry:{unregister:copy=>removed.push(copy),register:copy=>registered.push(copy)}});
 assert.deepEqual(removed,['/old.bundle']);assert.deepEqual(registered,['/fixed.app']);
 assert.equal(result.ok,false);assert.equal(result.results.filter(r=>r.state==='retained').length,3);
});

test('registry repair never unregisters an alias of the fixed application',async t=>{
 const {reconcileRegistrations}=await import('../personal-build/app-registry.mjs');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'registry-alias-'));
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const app=path.join(dir,'Fixed.app'),alias=path.join(dir,'Alias.app');
 fs.mkdirSync(app);fs.symlinkSync(app,alias);
 const removed=[];
 const result=reconcileRegistrations(app,{paths:[alias],verify:()=>{},isRunning:()=>false,sameBundle:()=>true,
  registry:{unregister:copy=>removed.push(copy),register:()=>{}}});
 assert.deepEqual(removed,[]);assert.equal(result.ok,false);
 assert.match(result.results[0].reason,/Alias/);
});

test('registry repair retires managed ad-hoc copies and missing entries without touching foreign apps',async()=>{
 const {reconcileRegistrations}=await import('../personal-build/app-registry.mjs');
 const removed=[];
 const result=reconcileRegistrations('/fixed.app',{
  paths:['/state/old.bundle','/state/foreign.bundle','/external/ad-hoc.app','/missing.app','/state/running.bundle'],
  canonical:copy=>{if(copy==='/missing.app')throw Object.assign(Error('missing'),{code:'ENOENT'});return copy;},
  managed:copy=>copy.startsWith('/state/'),sameBundle:copy=>copy!=='/state/foreign.bundle',
  isRunning:copy=>copy==='/state/running.bundle',verify:copy=>{if(copy!=='/fixed.app')throw Error('certificate differs');},
  registry:{unregister:copy=>removed.push(copy),register:()=>{}}});
 assert.deepEqual(removed,['/state/old.bundle','/missing.app']);
 assert.equal(result.results.filter(r=>r.state==='retained').length,3);
 assert.equal(result.ok,false);
});
