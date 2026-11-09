/** LaunchServices registration is separate from file retention and TCC grants. Never reset TCC. */
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
const tool='/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister';
const execute=args=>execFileSync(tool,args,{encoding:'utf8',maxBuffer:64*1024*1024});
export function parseRegisteredApps(dump, bundleId) {
  const paths=[];
  for(const block of dump.split(/^-{10,}\s*$/m)) {
    const identifier=/^identifier:\s+(.+?)\s*$/m.exec(block)?.[1];
    const location=/^path:\s+(.+?)\s*$/m.exec(block)?.[1]?.replace(/\s+\(0x[0-9a-f]+\)$/i,'');
    if(identifier===bundleId && location?.startsWith('/'))paths.push(location);
  }
  return [...new Set(paths)];
}
export function registeredApps(bundleId, run=execute) { return parseRegisteredApps(run(['-dump']),bundleId); }
export function appRegistry(run=execute) {
  return {
    register:app=>run(['-f',app]),
    unregister:app=>run(['-u',app]),
    retire:(backup,app)=>{run(['-u',backup]);run(['-f',app]);},
  };
}
/** Explicit repair only: inspect every duplicate before removing its registration. Never delete
 * bundles, unregister a running copy, or touch another identifier/certificate. */
export function reconcileRegistrations(app, {paths, verify, isRunning, sameBundle, registry=appRegistry(), canonical=fs.realpathSync}) {
  verify(app);
  const fixed=canonical(app);
  const results=[];
  for(const copy of paths) {
    if(copy===app)continue;
    try {
      if(canonical(copy)===fixed)throw Error('Alias of the fixed installation; preserve registration');
      if(!sameBundle(copy))throw Error('Different application identity');
      if(isRunning(copy))throw Error('Application is running');
      verify(copy);registry.unregister(copy);results.push({path:copy,state:'unregistered'});
    } catch(error) { results.push({path:copy,state:'retained',reason:error.message}); }
  }
  registry.register(app);
  return {results,ok:results.every(r=>r.state==='unregistered')};
}
