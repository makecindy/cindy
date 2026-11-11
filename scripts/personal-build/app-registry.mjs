/** LaunchServices registration is separate from file retention and TCC grants. Never reset TCC. */
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
const tool='/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister';
const execute=args=>execFileSync(tool,args,{encoding:'utf8',maxBuffer:64*1024*1024,timeout:args[0]==='-dump'?60000:15000,killSignal:'SIGKILL'});
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
 * bundles or unregister a running copy. paths must come from the exact-ID registry query.
 * Managed retired copies may have old/ad-hoc signatures: unregistering does not execute them. */
export function reconcileRegistrations(app, {paths, verify, isRunning, sameBundle, managed=()=>false, registry=appRegistry(), canonical=fs.realpathSync}) {
  verify(app);
  const fixed=canonical(app);
  const results=[];
  for(const copy of paths) {
    if(copy===app)continue;
    try {
      if(isRunning(copy))throw Error('Application is running');
      let resolved;
      try { resolved=canonical(copy); }
      catch(error) {
        if(error.code!=='ENOENT')throw error;
        registry.unregister(copy);results.push({path:copy,state:'unregistered',reason:'missing registered path'});continue;
      }
      if(resolved===fixed)throw Error('Alias of the fixed installation; preserve registration');
      if(!sameBundle(copy))throw Error('Different application identity');
      if(isRunning(resolved))throw Error('Application is running through another path');
      if(!managed(resolved))verify(copy);
      registry.unregister(copy);results.push({path:copy,state:'unregistered'});
    } catch(error) { results.push({path:copy,state:'retained',reason:error.message}); }
  }
  let registrationError;
  try { registry.register(app); } catch(error) { registrationError=error.message; }
  return {results,registrationError,ok:!registrationError&&results.every(r=>r.state==='unregistered')};
}
