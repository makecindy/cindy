import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {managedConfig} from './managed.mjs';
import {acquire} from './lock.mjs';
import {RecoveryJournal,durableWrite} from './recovery.mjs';
import {verifyInterface} from './interface-assets.mjs';
import {releaseDescriptor} from './automatic.mjs';
import {preflightSharedStartup} from './startup-preflight.mjs';

const read=f=>JSON.parse(fs.readFileSync(f,'utf8'));
const check=(v,m)=>{if(!v)throw Error(m);};
const run=(node,args,cwd)=>execFileSync(node,args,{cwd,encoding:'utf8',timeout:30000,maxBuffer:4*1024*1024,env:{...process.env,NODE_OPTIONS:''}}).trim();
export async function reconcileRunning(options) {
  const c=managedConfig(options.config), root=path.join(c.runtime.stateDir,'automatic');
  check(c.runtime.mode==='shared' && c.automatic?.enabled!==true,'Manual shared recovery only');
  const pid=Number(options['expected-pid']), directory=fs.realpathSync(options.app), out=path.resolve(options.out);
  check(Number.isSafeInteger(pid)&&pid>0,'Expected live PID required');
  check(!fs.existsSync(out),'Recovery receipt exists; inspect it instead of repeating');
  const unlock=acquire(path.join(root,'supervisor.lock'));
  try {
    const store=new RecoveryJournal(path.join(root,'journal.json')), original=store.read();
    const release=releaseDescriptor(directory);
    check(original.phase==='blocked'&&original.failed?.directory===directory,'Not the failed checkout');
    // dataCode includes scripts, including the two permitted repairs below. The ancestor +
    // exact changed-file allowlist checks every tracked path more strictly here; keep the
    // ordinary release/automatic-upgrade fingerprint unchanged.
    for(const key of ['migrations','runtime','plugins','localPlugins'])
      check(original.failed[key]===release[key],`Recovery changed ${key}; needs separate validation`);
    run('git',['merge-base','--is-ancestor',original.failed.head,release.head],directory);
    const changes=run('git',['diff','--name-only',original.failed.head,release.head],directory).split('\n').filter(Boolean);
    check(changes.every(f=>['scripts/dev-migration-policy.mjs','scripts/personal-migration-allowlist.json'].includes(f)),
      'Recovery contains changes beyond the reviewed startup-policy repair');
    check(run('git',['status','--porcelain','--untracked-files=no'],directory)==='','Tracked recovery files are dirty');
    if (original.failed.assetDigest) {
      release.assetDigest = original.failed.assetDigest;
      verifyInterface(directory, release.assetDigest);
    }
    preflightSharedStartup(c,release);
    const require=createRequire(path.join(directory,'package.json'));
    const helper=out+'.readonly.mjs';check(!fs.existsSync(helper),'Recovery helper exists');
    await require('esbuild').build({entryPoints:[fileURLToPath(new URL('./current-database-worker.mjs',import.meta.url))],
      outfile:helper,bundle:true,platform:'node',format:'esm',target:'node22',
      alias:{'@personal/migrations':path.join(directory,'apps/desktop/src/main/localDb/migrationRunner.ts')}});
    const dbCheck=()=>JSON.parse(run(c.runtime.node,[helper,directory,c.runtime.dataDir],directory));
    const database=dbCheck();
    const monitorDir=path.join(root,'launches');
    const monitors=fs.readdirSync(monitorDir).map(n=>path.join(monitorDir,n)).filter(p=>{
      try{return read(path.join(p,'host-owner.json')).pid===pid;}catch{return false;}
    });
    check(monitors.length===1,'Expected exactly one monitor for the live process');
    const monitor=monitors[0],owner=read(path.join(monitor,'host-owner.json'));
    let lastObserved;
    const observe=()=>{
      const report=JSON.parse(run(c.runtime.node,[path.join(directory,'scripts/desktop-whoami.mjs'),'--json','--user-data-dir',c.runtime.dataDir],directory));
      check(report.processScan?.ok,'Process scan unavailable');
      const i=report.instances?.find(i=>i.pid===pid&&i.commit===release.head&&i.commitVerified&&i.rootDir===directory&&i.userDataDir===c.runtime.dataDir&&i.region===c.region&&i.ready);
      check(i,'Repaired instance changed or is not ready');
      const heartbeat=read(path.join(monitor,'heartbeat.json')), age=Date.now()-heartbeat.at;
      check(heartbeat.pid===pid&&heartbeat.generation===owner.generation&&age>=0&&age<=10000&&heartbeat.ready&&
        (!release.assetDigest || (heartbeat.interactive === true && heartbeat.assetDigest === release.assetDigest))&&
        (c.automatic?.requireRemote===false||heartbeat.remoteReady),'Unhealthy or stale repaired instance');
      check(releaseDescriptor(directory).id===release.id,'Checkout changed during observation');
      const now=Date.now();
      check(lastObserved===undefined||(now>=lastObserved&&now-lastObserved<=15000),'Recovery health observation was interrupted');
      lastObserved=now;
    };
    const requiredMs=Math.max(120000,(c.automatic?.probationSeconds??120)*1000),started=Date.now();
    observe();
    while(Date.now()-started<requiredMs){await new Promise(r=>setTimeout(r,5000));observe();}
    dbCheck();observe();
    check(JSON.stringify(store.read())===JSON.stringify(original),'Journal changed during reconciliation');
    check(!fs.existsSync(out+'.before.json'),'Recovery backup exists');
    durableWrite(out+'.before.json',{journal:original,knownGood:read(path.join(root,'known-good.json')),status:read(path.join(root,'status.json'))});
    const evidence={releaseId:release.id,pid,generation:owner.generation,databaseCompatible:true,sharedPreflight:true,
      healthy:true,observedMs:Date.now()-started,requiredMs};
    store.reconcileRunning(release,evidence);
    durableWrite(path.join(root,'status.json'),{phase:'stable',at:Date.now(),releaseId:release.id,pid,reconciled:true,supervised:false});
    const result={reconciled:true,head:release.head,pid,database,evidence,supervised:false,restarted:false};
    durableWrite(out,result);return result;
  } finally {unlock();}
}
