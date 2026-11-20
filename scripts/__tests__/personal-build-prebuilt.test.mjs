import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {interfaceDigest, verifyInterface} from '../personal-build/interface-assets.mjs';
import {activatePreparedCandidate} from '../personal-build/activation-stages.mjs';
import {RecoveryJournal} from '../personal-build/recovery.mjs';
import {readHeartbeat} from '../personal-build/automatic.mjs';

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'personal-interface-'));
  t.after(() => fs.rmSync(dir, {recursive:true, force:true}));
  return dir;
}

test('prebuilt release rejects missing, substituted and linked assets', t => {
  const dir = fixture(t);
  const tree = path.join(dir, 'apps/desktop/.vite');
  const entries = ['build/index.js', 'build/preload.js', 'renderer/desktop_capture/index.html', 'renderer/main_window/index.html'];
  for (const entry of entries) {
    const file = path.join(tree,entry);
    fs.mkdirSync(path.dirname(file),{recursive:true});
    fs.writeFileSync(file,entry);
  }
  const digest = interfaceDigest(dir);
  verifyInterface(dir,digest);
  const page = path.join(tree,entries.at(-1));
  fs.appendFileSync(page,'changed');
  assert.throws(() => verifyInterface(dir,digest),/changed/);
  fs.unlinkSync(page);
  assert.throws(() => verifyInterface(dir,digest),/ENOENT/);
  fs.symlinkSync(path.join(tree,entries[0]),page);
  assert.throws(() => verifyInterface(dir,digest),/Unexpected/);
});

test('a launched process needs a mounted renderer in every prebuilt health sample', t => {
  const dir = fixture(t), run = {dir, generation:'trial', assetDigest:'tested'};
  for (const interactive of [undefined,true,false]) {
    fs.writeFileSync(path.join(dir,'heartbeat.json'),JSON.stringify({
      protocol:1,generation:'trial',pid:42,at:1000,ready:true,remoteReady:true,interactive,assetDigest:'tested',
    }));
    assert.equal(readHeartbeat(run,42,{now:1001}).healthy,interactive === true);
  }
});

for (const outcome of ['recovers','fails again','incompatible','cleanup incomplete']) {
  test('post-migration startup retry: ' + outcome, async t => {
    const dir=fixture(t), store=new RecoveryJournal(path.join(dir,'journal.json'));
    const release={directory:path.join(dir,'candidate'), id:'candidate',assetDigest:'checked'};
    store.init({directory:path.join(dir,'old'), id:'old',verified:true});
    store.beginManual(release,{prepared:true,stopped:true,manualRequested:true,smokeVerified:true,profileVerified:true});
    let migrations=0, launches=0, verifications=0;
    const result=activatePreparedCandidate(store,release,{
      databasePlan:{backupDir:dir}, migrate:()=>{migrations++;}, record:()=>{},
      verifyRetry:()=>{verifications++; if(outcome==='incompatible') throw Error('schema changed');},
      launch:candidate=>{
        launches++;
        assert.equal(candidate.id,release.id);
        if (launches===2 && outcome==='recovers') {
          const {generation}=store.read(), health={generation,id:release.id,healthy:true,processAlive:true};
          store.observe(health,0);store.observe(health,0);return 'running';
        }
        store.reject('startup failed');
        throw Object.assign(Error('failed'),{cleanedStartupFailure:outcome!=='cleanup incomplete'});
      },
    });
    if (outcome==='recovers') {
      assert.equal(await result,'running');
      assert.equal(store.read().good.id,release.id);
    } else {
      await assert.rejects(result);
      assert.equal(store.read().phase,'blocked');
    }
    assert.equal(migrations,1);
    assert.equal(launches,['recovers','fails again'].includes(outcome) ? 2 : 1);
    assert.equal(verifications,outcome==='cleanup incomplete' ? 0 : 1);
    if(outcome==='fails again') assert.throws(()=>store.retryMigratedStartup(release,dir),/only once/);
  });
}
