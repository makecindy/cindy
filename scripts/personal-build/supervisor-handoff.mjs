/** Cooperative supervisor-only handoff. Never signal the app or remove a live owner's lock. */
import fs from 'node:fs';
import path from 'node:path';
import {durableWrite} from './recovery.mjs';
const read=file=>JSON.parse(fs.readFileSync(file,'utf8'));
const owner=file=>{try{return read(path.join(file,'owner.json'));}catch{return null;}};
const requestFile=(lock,token)=>path.join(lock,`handoff-${token}.json`);
const alive=pid=>{try{process.kill(pid,0);return true;}catch(error){return error.code!=='ESRCH';}};
export function publishSupervisorControl(lock, identity) {
  const held=owner(lock);
  if(!held || held.pid!==process.pid)throw Error('Cannot publish control for another supervisor');
  durableWrite(path.join(lock,'control.json'),{...identity,supervisorPid:held.pid,token:held.token});
}
export function shouldYieldSupervisor(lock, identity, now=Date.now()) {
  const held=owner(lock);
  if(!held || held.pid!==process.pid)return false;
  let request;try{request=read(requestFile(lock,held.token));}catch{return false;}
  return request.action==='release-supervision' && request.supervisorPid===held.pid && request.token===held.token
    && request.appPid===identity.appPid && request.generation===identity.generation
    && request.releaseId===identity.releaseId && Number.isFinite(request.expiresAt)
    && request.expiresAt>=now && request.expiresAt<=now+30000;
}
export async function requestSupervisorRelease(lock, expectedPid, {now=Date.now,wait=ms=>new Promise(r=>setTimeout(r,ms)),timeoutMs=15000}={}) {
  if(!Number.isSafeInteger(expectedPid)||expectedPid<=0)throw Error('A confirmed app PID is required');
  if(!fs.existsSync(lock))return {released:false,reason:'no-supervisor'};
  const held=owner(lock);
  if(!held || !Number.isSafeInteger(held.pid)||held.pid<=0 || !/^[a-f0-9-]{36}$/.test(held.token))throw Error('Unknown supervisor lock; no takeover');
  if(!alive(held.pid))return {released:false,reason:'dead-supervisor; normal lock reclamation required'};
  let control;try{control=read(path.join(lock,'control.json'));}catch{throw Error('This supervisor does not support cooperative handoff; exit only the verified supervisor normally, leaving Cindy running');}
  if(control.supervisorPid!==held.pid || control.token!==held.token || control.appPid!==expectedPid || !control.generation || !control.releaseId)
    throw Error('Supervisor/app identity changed; no takeover');
  const file=requestFile(lock,held.token), expiresAt=now()+timeoutMs;
  if(fs.existsSync(file)) {
    const previous=read(file);
    if(!Number.isFinite(previous.expiresAt)||previous.expiresAt>=now())throw Error('Supervisor handoff already pending');
    fs.unlinkSync(file);
  }
  fs.writeFileSync(file,JSON.stringify({...control,action:'release-supervision',expiresAt}),{flag:'wx',mode:0o600});
  while(now()<expiresAt) {
    const current=owner(lock);
    if(!current || current.token!==held.token)return {released:true,supervisorPid:held.pid};
    await wait(250);
  }
  throw Error('Supervisor did not yield before the deadline; application was not stopped');
}
