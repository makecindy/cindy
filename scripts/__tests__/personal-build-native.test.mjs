import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {sdkSupported,nativeIdentity,detachRuntime,personalBundleId} from '../personal-build/native-capabilities.mjs';
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
 const {installFixedRuntime,verifyInstalledRuntime}=await import('../personal-build/fixed-install.mjs');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'personal-fixed-install-'));
 try {
  const prepare=(v,identity='fixture')=>prepareRuntime({store:path.join(dir,'store'),inputs:{bundleId:'personal-test',version:v},signingIdentity:identity,
   build:app=>{fs.mkdirSync(app);fs.writeFileSync(path.join(app,'binary'),v);},verifySignature:()=>{}});
  const first=prepare('one'), second=prepare('two');
  const app=path.join(fs.realpathSync(dir),'Applications','Cindy Personal.app');
  const options={isRunning:()=>false,verifySignature:()=>{}};
  installFixedRuntime(first,app,options);
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
