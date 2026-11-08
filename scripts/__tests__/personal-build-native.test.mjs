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
