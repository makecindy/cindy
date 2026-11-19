import {migrationSource} from '../personal-build/database-upgrade.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync,spawn} from 'node:child_process';
import {once} from 'node:events';
import {createRequire} from 'node:module';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {preflightSharedStartup,startupApproval} from '../personal-build/startup-preflight.mjs';
import {restartWithSupervisorLock,launchSelected,releaseDescriptor} from '../personal-build/automatic.mjs';
import {reconcileRunning} from '../personal-build/reconcile-running.mjs';
import {activatePreparedCandidate} from '../personal-build/activation-stages.mjs';
import {RecoveryJournal} from '../personal-build/recovery.mjs';

// Script integration tier: actual Git/shared policy, SQLite migration and process failures.
// Regression: isolated smoke passed but shared launch rejected after the old process stopped.
// Existing recovery tests do not execute the SQL backup/apply and launch-failure sequence.
const candidate=fileURLToPath(new URL('../../',import.meta.url));
const require=createRequire(path.join(candidate,'package.json'));
const Database=require('better-sqlite3');
const git=(cwd,...args)=>execFileSync('git',args,{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
const temporary=()=>fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'personal-handoff-test-')));
const mkdir=p=>fs.mkdirSync(p,{recursive:true});

// PR #11122: journal-only tests missed the command rejecting its own two allowed repairs.
// Minimum input: blocked checkout + one committed policy repair changes dataCode.
// Script integration tier (real Git); stop at an intentional policy rejection, before any DB/live
// process access. Also prove an unrelated script is rejected before that policy runs.
// Full file measured at 4.1s locally, including the SQLite/process drill.
test('reconcile-running permits only the reviewed policy repairs to reach shared preflight',async()=>{
  const dir=temporary();
  try{
    const app=path.join(dir,'app');mkdir(path.join(app,'scripts'));
    git(app,'init');git(app,'config','user.name','Test');git(app,'config','user.email','test@example.invalid');git(app,'config','commit.gpgsign','false');
    fs.writeFileSync(path.join(app,'scripts/dev-migration-policy.mjs'),'export function assertSharedDevMigrationPolicy(){throw Error("policy reached");}\n');
    fs.writeFileSync(path.join(app,'scripts/personal-migration-allowlist.json'),'{}\n');
    git(app,'add','.');git(app,'commit','-m','failed candidate');
    const failed=releaseDescriptor(app),state=path.join(dir,'state'),root=path.join(state,'automatic');
    const store=new RecoveryJournal(path.join(root,'journal.json'));
    store.init({id:'old',directory:path.join(dir,'old'),verified:true});
    store.beginManual(failed,{prepared:true,stopped:true,manualRequested:true,smokeVerified:true,profileVerified:true});
    store.recoverInterrupted();
    const original=store.read(),config=path.join(dir,'config.json');
    fs.writeFileSync(config,JSON.stringify({version:1,name:'test',region:'global',app:{checkout:dir,repository:'test/app'},
      runtime:{mode:'shared',clientDir:app,stagingDir:path.join(dir,'stage'),stateDir:state,dataDir:path.join(dir,'profile')}}));
    for(const file of ['scripts/dev-migration-policy.mjs','scripts/personal-migration-allowlist.json','scripts/unrelated.mjs']){
      fs.appendFileSync(path.join(app,file),'\n');git(app,'add','.');git(app,'commit','-m',file);
      assert.notEqual(releaseDescriptor(app).dataCode,failed.dataCode);
      await assert.rejects(reconcileRunning({config,app,out:path.join(dir,'receipt.json'),'expected-pid':42}),
        file.endsWith('unrelated.mjs')?/beyond the reviewed startup-policy repair/:/Shared startup preflight rejected.*policy reached/s);
      assert.deepEqual(store.read(),original);
      assert.equal(fs.existsSync(path.join(root,'supervisor.lock')),false);
      assert.equal(fs.existsSync(path.join(dir,'receipt.json')),false);
    }
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
async function processFixture(fail=false){
  const child=spawn(process.execPath,['-e',fail?'process.exit(7)':'process.send("ready");setInterval(()=>{},1000);'],{stdio:['ignore','ignore','ignore','ipc']});
  if(fail){const [code]=await once(child,'exit');assert.equal(code,7);throw Error('fixture startup exit 7');}
  await once(child,'message');return child;
}
async function stop(child){if(child&&child.exitCode===null&&child.signalCode===null){const exited=once(child,'exit');child.kill('SIGTERM');await exited;}}

test('failure before spawn retains safe old-version recovery and original error when recording fails',async()=>{
  const dir=temporary();let restored;
  try {
    const store=new RecoveryJournal(path.join(dir,'journal.json'));
    const old={id:'old',directory:path.join(dir,'old'),verified:true},next={id:'new',directory:path.join(dir,'new')};
    store.init(old);store.beginManual(next,{prepared:true,stopped:true,manualRequested:true,smokeVerified:true,profileVerified:true});
    const failure=Error('before spawn failure');
    await assert.rejects(activatePreparedCandidate(store,next,{
      launch:()=>{store.rejectBeforeLaunch(failure.message);throw failure;},
      record:stage=>{if(stage==='failed')throw Error('receipt unavailable');},
    }),e=>e===failure&&e.recordingError==='receipt unavailable');
    assert.equal(store.read().phase,'recovering');
    const current=await launchSelected({runtime:{dataDir:path.join(dir,'profile')}},store,{
      snapshot:()=>({unknown:false,pid:null}),hasLaunchRunner:()=>false,verifyRelease:()=>{},
      start:()=>({}),waitReady:async()=>{restored=await processFixture();return restored.pid;},stopLaunch:()=>{},
    });
    assert.equal(current.pid,restored.pid);assert.equal(store.read().phase,'stable');assert.equal(store.read().good.id,'old');
  }finally{await stop(restored);fs.rmSync(dir,{recursive:true,force:true});}
});

test('actual shared policy rejects before stopping a live process; committed approval binds both checks',async()=>{
  const dir=temporary();let old;
  try{
    git(dir,'init');git(dir,'config','user.name','Test');git(dir,'config','user.email','test@example.invalid');git(dir,'config','commit.gpgsign','false');
    mkdir(path.join(dir,'scripts'));mkdir(path.join(dir,'apps/desktop/drizzle/meta'));
    fs.copyFileSync(path.join(candidate,'scripts/dev-migration-policy.mjs'),path.join(dir,'scripts/dev-migration-policy.mjs'));
    fs.writeFileSync(path.join(dir,'apps/desktop/drizzle/0000_initial.sql'),'SELECT 1;');
    const journal=path.join(dir,'apps/desktop/drizzle/meta/_journal.json');fs.writeFileSync(journal,JSON.stringify({entries:[{tag:'0000_initial'}]}));
    git(dir,'add','.');git(dir,'commit','-m','main');git(dir,'update-ref','refs/remotes/origin/main','HEAD');
    const extra='apps/desktop/drizzle/0001_extra.sql';fs.writeFileSync(path.join(dir,extra),'SELECT 2;');fs.writeFileSync(journal,JSON.stringify({entries:[{tag:'0000_initial'},{tag:'0001_extra'}]}));git(dir,'add','.');git(dir,'commit','-m','unmerged');
    const c={runtime:{mode:'shared',node:process.execPath}},release={directory:dir,head:git(dir,'rev-parse','HEAD')};
    old=await processFixture();let stopCount=0;
    await assert.rejects(restartWithSupervisorLock(path.join(dir,'supervisor.lock'),old.pid,{
      prepare:()=>preflightSharedStartup(c,release),observe:()=>({pid:old.pid,ready:true}),
      stop:()=>{stopCount++;},activate:()=>{throw Error('must not activate');},record:()=>{},
    }),/Shared startup preflight rejected/);
    assert.equal(stopCount,0);assert.equal(old.exitCode,null);
    fs.writeFileSync(path.join(dir,'scripts/personal-migration-allowlist.json'),JSON.stringify({journalTags:['0001_extra'],blobs:{[extra]:git(dir,'rev-parse',`HEAD:${extra}`)}}));
    git(dir,'add','.');git(dir,'commit','-m','approve exact migration');release.head=git(dir,'rev-parse','HEAD');
    // The public policy still refuses unmerged SQL even with a pinned record.
    assert.throws(()=>preflightSharedStartup(c,release),/Shared startup preflight rejected/);
    git(dir,'update-ref','refs/remotes/origin/main','HEAD');
    const plan={migrationSource:{kind:'frozen-pr'},startupApproval:startupApproval(dir)};
    assert.equal(preflightSharedStartup(c,release,plan).shared,true);
    fs.appendFileSync(path.join(dir,'scripts/personal-migration-allowlist.json'),'\n');
    assert.throws(()=>preflightSharedStartup(c,release,plan),/committed and unchanged/);
  }finally{await stop(old);fs.rmSync(dir,{recursive:true,force:true});}
});

test('real SQLite migration and process failure preserve backup; repaired process can reconcile journal',async()=>{
  const dir=temporary();let old,repaired;
  try{
    const esbuild=require('esbuild');
    const runner=path.join(dir,'migration.mjs'),worker=path.join(dir,'worker.mjs');
    await esbuild.build({entryPoints:[path.join(candidate,'apps/desktop/src/main/localDb/migrationRunner.ts')],outfile:runner,bundle:true,platform:'node',format:'esm'});
    await esbuild.build({entryPoints:[new URL('../personal-build/database-worker.mjs',import.meta.url).pathname],outfile:worker,bundle:true,platform:'node',format:'esm',alias:{'@personal/migrations':path.join(candidate,'apps/desktop/src/main/localDb/migrationRunner.ts'),'@personal/leases':path.join(candidate,'apps/desktop/src/main/localDb/schemaMigrationLease.ts')}});
    const m=await import(pathToFileURL(runner));
    const baseline=path.join(dir,'old'),next=path.join(dir,'new'),profile=path.join(dir,'profile');
    const oldDir=path.join(baseline,'apps/desktop/drizzle'),newDir=path.join(next,'apps/desktop/drizzle');mkdir(oldDir);mkdir(newDir);mkdir(profile);
    const initial='CREATE TABLE sessions (id INTEGER PRIMARY KEY); INSERT INTO sessions VALUES (1);';
    for(const d of [oldDir,newDir])fs.writeFileSync(path.join(d,'0000_initial.sql'),initial);
    fs.writeFileSync(path.join(newDir,'0001_extra.sql'),'ALTER TABLE sessions ADD snoozed_until INTEGER;');
    const file=path.join(profile,'cindy-test.db');const db=new Database(file);db.exec('CREATE TABLE migration_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE migration_history (seq INTEGER PRIMARY KEY, file_name TEXT NOT NULL, content_hash TEXT NOT NULL, applied_at INTEGER NOT NULL)');m.runMigrationReplay(db,{drizzleDir:oldDir});m.prepareMigrationRuntimeManifest(file,oldDir,0);db.close();
    const oldRelease={id:'old',directory:baseline,verified:true},release={id:'new',directory:next};
    const plan={authorized:true,dataDir:profile,candidate:release,baseline:oldRelease,pending:m.createMigrationRuntimeManifest(newDir).migrations.slice(1),rehearsalDir:path.join(profile,'personal-upgrade-backups/rehearse'),backupDir:path.join(profile,'personal-upgrade-backups/before')};
    const planFile=path.join(dir,'plan.json');
    // Resolve the installed dependency rather than assuming this checkout owns node_modules.
    const dependencyRoot=path.dirname(path.dirname(require.resolve('better-sqlite3/package.json')));
    const action=a=>{fs.writeFileSync(planFile,JSON.stringify(plan));return JSON.parse(execFileSync(process.execPath,[worker,planFile,a],{encoding:'utf8',env:{...process.env,NODE_PATH:dependencyRoot},stdio:['ignore','pipe','pipe']}));};
    plan.rehearsal=action('rehearse');plan.databases=plan.rehearsal.databases;
    let now=1;const store=new RecoveryJournal(path.join(dir,'journal.json'),{now:()=>now});store.init(oldRelease);
    old=await processFixture();let stopped=false;const phases=[];
    await assert.rejects(restartWithSupervisorLock(path.join(dir,'supervisor.lock'),old.pid,{
      prepare:()=>action('preflight'),observe:()=>({pid:stopped?null:old.pid,ready:!stopped,unknown:false}),
      stop:async()=>{await stop(old);stopped=true;},record:()=>{},activate:async()=>{
        store.beginManual(release,{prepared:true,stopped:true,manualRequested:true,smokeVerified:true,profileVerified:true});
        return activatePreparedCandidate(store,release,{databasePlan:plan,migrate:()=>action('apply'),launch:()=>processFixture(true),record:s=>phases.push(s)});
      },
    }),/fixture startup exit 7/);
    assert.equal(store.read().phase,'blocked');assert.deepEqual(phases,['database-preflight','database-applying','database-applied','launching','failed']);
    assert.equal(action('verify-applied').ready,true);
    const originalId=plan.candidate.id;
    plan.candidate.id='different';
    assert.throws(()=>action('verify-applied'),/receipt does not match/);
    plan.candidate.id=originalId;
    const migrated=new Database(file,{readonly:true});assert.equal(m.checkMigrationCompatibility(migrated,newDir,file).compatible,true);assert.equal(migrated.prepare('SELECT count(*) n FROM sessions').get().n,1);migrated.close();
    const backup=path.join(plan.backupDir,'cindy-test.db'),saved=new Database(backup,{readonly:true});assert.equal(m.checkMigrationCompatibility(saved,oldDir,backup).compatible,true);saved.close();
    assert.throws(()=>store.reconcileRunning(release,{healthy:true}),/current database/);
    repaired=await processFixture();now+=120000;
    store.reconcileRunning(release,{releaseId:release.id,pid:repaired.pid,databaseCompatible:true,sharedPreflight:true,healthy:true,observedMs:120000,requiredMs:120000});
    assert.equal(store.read().phase,'stable');assert.equal(store.read().good.id,'new');assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'known-good.json'))).id,'new');
  }finally{await stop(old);await stop(repaired);fs.rmSync(dir,{recursive:true,force:true});}
});

test('explicit source approval is bound to a frozen selected PR and exact migration tree', () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'personal-migration-source-'));
  const git=(...args)=>execFileSync('git',args,{cwd:dir,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
  try {
    git('init'); git('config','user.name','Test');git('config','user.email','test@example.invalid');git('config','commit.gpgsign','false');
    fs.mkdirSync(path.join(dir,'apps/desktop/drizzle'),{recursive:true});
    const sql=path.join(dir,'apps/desktop/drizzle/0000_initial.sql');
    fs.writeFileSync(sql,'SELECT 1;');git('add','.');git('commit','-m','main');const baseSha=git('rev-parse','HEAD');
    const build={upgradeSnapshot:{repositories:{app:{baseSha,selected:[]}}}};
    assert.deepEqual(migrationSource(dir,build),{kind:'main',sha:baseSha});
    fs.writeFileSync(path.join(dir,'apps/desktop/drizzle/0001_next.sql'),'SELECT 2;');git('add','.');git('commit','-m','pr');const sha=git('rev-parse','HEAD');
    build.upgradeSnapshot.repositories.app.selected=[{number:42,sha}];
    assert.throws(()=>migrationSource(dir,build),/explicit frozen-PR approval/);
    assert.throws(()=>migrationSource(dir,build,123),/not in the frozen selection/);
    assert.deepEqual(migrationSource(dir,build,42),{kind:'frozen-pr',number:42,sha});
    fs.writeFileSync(path.join(dir,'unrelated.txt'),'unchanged migrations');git('add','.');git('commit','-m','other pr');
    assert.equal(migrationSource(dir,build,42).sha,sha);
    fs.writeFileSync(sql,'SELECT 3;');git('add','.');git('commit','-m','changed migration');
    assert.throws(()=>migrationSource(dir,build,42),/differs from the approved PR/);
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
