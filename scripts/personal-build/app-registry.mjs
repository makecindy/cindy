/** LaunchServices and PlugInKit registration are separate from file retention and TCC grants. Never reset TCC. */
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
const tool='/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister';
const pluginkit='/usr/bin/pluginkit';
const execute=args=>execFileSync(tool,args,{encoding:'utf8',maxBuffer:64*1024*1024,timeout:args[0]==='-dump'?60000:15000,killSignal:'SIGKILL'});
const executePluginkit=args=>execFileSync(pluginkit,args,{encoding:'utf8',maxBuffer:16*1024*1024,timeout:15000,killSignal:'SIGKILL'});
const listProcessesDefault=()=>execFileSync('/bin/ps',['-axo','pid=,comm='],{encoding:'utf8',maxBuffer:8*1024*1024,timeout:10000,killSignal:'SIGKILL'});
export function parseRegisteredApps(dump, bundleId) {
  const paths=[];
  for(const block of dump.split(/^-{10,}\s*$/m)) {
    const identifier=/^identifier:\s+(.+?)\s*$/m.exec(block)?.[1];
    const location=/^path:\s+(.+?)\s*$/m.exec(block)?.[1]?.replace(/\s+\(0x[0-9a-f]+\)$/i,'');
    if(identifier===bundleId && location?.startsWith('/'))paths.push(location);
  }
  return [...new Set(paths)];
}
export function parseRegisteredExtensions(output, extensionId) {
  const paths=[];
  for(const line of String(output||'').split(/\r?\n/)) {
    const parts=line.split('\t');
    if(parts.length<4)continue;
    const id=/^\s*[+\-!?]?\s*([^\s(]+)(?:\([^)]*\))?\s*$/.exec(parts[0])?.[1];
    const location=parts.slice(3).join('\t').trim();
    if(id===extensionId && location.startsWith('/'))paths.push(location);
  }
  return [...new Set(paths)];
}
export function appExtensions(app) {
  const dir=path.join(app,'Contents/PlugIns');
  if(!fs.existsSync(dir))return [];
  return fs.readdirSync(dir,{withFileTypes:true})
    .filter(entry=>entry.name.endsWith('.appex')&&(entry.isDirectory()||entry.isSymbolicLink()))
    .map(entry=>path.join(dir,entry.name))
    .sort();
}
export function extensionHostApp(extensionPath) {
  if(!extensionPath?.endsWith('.appex'))return null;
  const pluginsDir=path.dirname(extensionPath), contentsDir=path.dirname(pluginsDir);
  if(path.basename(pluginsDir)!=='PlugIns' || path.basename(contentsDir)!=='Contents')return null;
  return path.dirname(contentsDir);
}
export function stopExtensionProcesses(extensionPath, {listProcesses=listProcessesDefault, kill=(pid,sig)=>process.kill(pid,sig)}={}) {
  if(!extensionPath?.endsWith('.appex'))return [];
  const prefixes=new Set([`${extensionPath}/Contents/MacOS/`]);
  try { prefixes.add(`${fs.realpathSync(extensionPath)}/Contents/MacOS/`); } catch { /* Extension may already be moved or removed. */ }
  const signaled=[];
  for(const line of String(listProcesses()||'').split(/\r?\n/)) {
    const match=/^\s*(\d+)\s+(.+?)\s*$/.exec(line);
    if(!match)continue;
    const pid=Number(match[1]), comm=match[2];
    if(!Number.isSafeInteger(pid)||pid<=0)continue;
    if(![...prefixes].some(prefix=>comm.startsWith(prefix)))continue;
    try { kill(pid,'SIGTERM'); signaled.push(pid); }
    catch(error) { if(error?.code!=='ESRCH')throw error; }
  }
  return signaled;
}
function removePluginkitEntry(extensionPath, runPlugin) {
  try { runPlugin(['-r',extensionPath]); }
  catch(error) {
    const detail=`${error?.stderr||''}\n${error?.stdout||''}\n${error?.message||''}`;
    if(!/no plugin at/i.test(detail))throw error;
  }
}
function runSteps(steps) {
  const errors=[];
  for(const step of steps) {
    try { step(); } catch(error) { errors.push(error); }
  }
  if(errors.length===1)throw errors[0];
  if(errors.length>1)throw Error(errors.map(error=>error?.message||String(error)).join('; '));
}
export function registeredApps(bundleId, run=execute) { return parseRegisteredApps(run(['-dump']),bundleId); }
export function registeredExtensions(extensionId, run=executePluginkit) { return parseRegisteredExtensions(run(['-m','-v','-A','-D','-i',extensionId]),extensionId); }
export function appRegistry(run=execute, {runPlugin=executePluginkit, listExtensions=appExtensions, stopExtension=stopExtensionProcesses}={}) {
  const registerExtension=(ext,{refresh=false}={})=>runSteps([
    ()=>runPlugin(['-a',ext]),
    ...(refresh ? [()=>stopExtension(ext)] : []),
  ]);
  const unregisterExtension=ext=>runSteps([
    ()=>removePluginkitEntry(ext,runPlugin),
    ()=>stopExtension(ext),
  ]);
  const register=(app,{refreshExtensions=false}={})=>{
    let extensions=[];
    const steps=[()=>run(['-f',app])];
    try { extensions=listExtensions(app); } catch(error) { steps.push(()=>{ throw error; }); }
    for(const ext of extensions)steps.push(()=>registerExtension(ext,{refresh:refreshExtensions}));
    runSteps(steps);
  };
  const unregister=app=>{
    let extensions=[];
    const steps=[];
    try { extensions=listExtensions(app); } catch(error) { steps.push(()=>{ throw error; }); }
    for(const ext of extensions)steps.push(()=>unregisterExtension(ext));
    steps.push(()=>run(['-u',app]));
    runSteps(steps);
  };
  return {
    register,
    unregister,
    registerExtension,
    unregisterExtension,
    retire:(backup,app,{refreshExtensions=false}={})=>runSteps([
      ()=>unregister(backup),
      ()=>register(app,{refreshExtensions}),
    ]),
  };
}
/** Explicit repair only: inspect every duplicate before removing its registration. Never delete
 * bundles or unregister a running copy. paths must come from the exact-ID registry query.
 * Managed retired copies may have old/ad-hoc signatures: unregistering does not execute them. */
export function reconcileRegistrations(app, {paths=[], extensionPaths=[], verify, isRunning, sameBundle, managed=()=>false, registry=appRegistry(), canonical=fs.realpathSync, listExtensions=appExtensions}) {
  verify(app);
  const fixed=canonical(app);
  const fixedExtensions=new Set(listExtensions(app).map(ext=>{ try { return canonical(ext); } catch { return ext; } }));
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
  const unregisterExt=registry.unregisterExtension || (ext=>registry.unregister(ext));
  for(const ext of extensionPaths) {
    if(extensionHostApp(ext)===app)continue;
    try {
      let resolvedExt;
      try { resolvedExt=canonical(ext); }
      catch(error) {
        if(error.code!=='ENOENT')throw error;
        unregisterExt(ext);results.push({path:ext,kind:'extension',state:'unregistered',reason:'missing registered extension'});continue;
      }
      if(fixedExtensions.has(resolvedExt))throw Error('Alias of the fixed extension; preserve registration');
      const host=extensionHostApp(ext);
      if(!host)throw Error('Extension is not inside an application bundle');
      if(isRunning(host))throw Error('Application is running');
      const resolvedHost=canonical(host);
      if(resolvedHost===fixed)throw Error('Alias of the fixed installation; preserve registration');
      if(!sameBundle(host))throw Error('Different application identity');
      if(isRunning(resolvedHost))throw Error('Application is running through another path');
      if(!managed(resolvedHost))verify(host);
      unregisterExt(ext);results.push({path:ext,kind:'extension',state:'unregistered'});
    } catch(error) { results.push({path:ext,kind:'extension',state:'retained',reason:error.message}); }
  }
  let registrationError;
  try { registry.register(app); } catch(error) { registrationError=error.message; }
  return {results,registrationError,ok:!registrationError&&results.every(r=>r.state==='unregistered')};
}
