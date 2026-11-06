#!/usr/bin/env node
// Explicit interactive macOS benchmark. Covers one display with generated
// pixels, runs real pre/post capture helpers, then closes all owned processes.
// Images stay in memory; no clipboard access or screenshot upload.
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
const exec = promisify(execFile);
const option = name => process.argv.find(arg=>arg.startsWith(`--${name}=`))?.slice(name.length+3);
const root = fileURLToPath(new URL('../../..', import.meta.url));
const relative = 'apps/desktop/native/remote-desktop/macos-capture.m';
assert.equal(process.platform,'darwin');
const temp = await mkdtemp(path.join(os.tmpdir(),'cindy-live-perf-'));
const children = [];
const report = { generatedAt:new Date().toISOString(), rows:[] };
const summary = raw => { const v=[...raw].sort((a,b)=>a-b); return { p50:v[Math.floor(v.length/2)],p95:v[Math.ceil(v.length*.95)-1] }; };
function connection(executable,args) {
  const child = spawn(executable,args,{stdio:'pipe'}); children.push(child);
  let pending, stderr='';
  child.stderr.on('data',chunk=>{stderr+=chunk;});
  const queue=[];
  const fail=error=>{ pending?.reject(error);pending=null; };
  child.once('error',fail);child.stdin.on('error',fail);
  const exit=once(child,'exit'); void exit.catch(()=>{});
  child.once('exit',(code,signal)=>fail(new Error(`Native helper exited code=${code} signal=${signal}`)));
  createInterface({input:child.stdout}).on('line',line=>{
    if(pending){const task=pending;pending=null;task.resolve(line);}else queue.push(line);
  });
  return { child, exit, stderr:()=>stderr, read(timeout=10000) {
    if(queue.length)return Promise.resolve(queue.shift());
    assert(!pending,'Only one frame request may be in flight');
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{pending=null;reject(new Error('Native response timeout'));},timeout);
      pending={resolve:value=>{clearTimeout(timer);resolve(value);},reject:error=>{clearTimeout(timer);reject(error);}};
    });
  }};
}
async function request(client,bytes){const value=client.read();client.child.stdin.write(bytes);return value;}
async function close(client) {
  if(client.child.exitCode!==null||client.child.signalCode!==null)return;
  const timer=setTimeout(()=>client.child.kill('SIGKILL'),2000);
  client.child.stdin.end();
  try{await client.exit;}finally{clearTimeout(timer);}
}
try {
  const baseline=(await exec('git',['show',`8c15788c0a4c20cf9dcd20f2ccd8c63a857faeb0:${relative}`],{cwd:root})).stdout;
  const before=path.join(temp,'before.m');await writeFile(before,baseline);
  for(const [side,source] of [['before',before],['after',path.join(root,relative)]]) {
    await exec('xcrun',['clang',source,'-fobjc-arc','-fblocks','-O2',
      ...['Foundation','AppKit','CoreGraphics','CoreImage','IOSurface','ImageIO','IOKit','ScreenCaptureKit','CoreMedia','CoreVideo'].flatMap(name=>['-framework',name]),
      '-o',path.join(temp,side)],{timeout:120000});
  }
  await exec('xcrun',['swiftc',path.join(root,'apps/desktop/scripts/fixtures/region-capture/macos-recording-pattern.swift'),'-O','-o',path.join(temp,'pattern')],{timeout:120000});
  const fixture=connection(path.join(temp,'pattern'),[]);
  report.display=JSON.parse(await fixture.read());
  console.log(JSON.stringify({display:report.display}));
  await delay(300); // Explicit live integration: wait for WindowServer composition.
  await request(fixture,'moving\n');
  for(const side of ['before','after','after','before']) {
    const client=connection('/usr/bin/time',['-l',path.join(temp,side),String(report.display.display),
      side==='after'?'cursor-overlay-demand':'cursor-overlay','30','0.9','3840','3000000']);
    const cold=performance.now();
    const first=JSON.parse(await request(client,'f'));
    assert(first.jpeg && Buffer.from(first.jpeg,'base64').subarray(0,2).equals(Buffer.from([255,216])));
    const coldMs=performance.now()-cold;
    const raw=[],sizes=[];const start=performance.now();
    for(let i=0;i<30;i++) {
      const tick=performance.now();
      const frame=JSON.parse(await request(client,'f'));
      assert(frame.jpeg);
      raw.push(performance.now()-tick);sizes.push(Buffer.byteLength(frame.jpeg,'base64'));
      await delay(Math.max(0,100-(performance.now()-tick)));
    }
    const sampleMs=performance.now()-start;
    // Pause while the source keeps changing, then request another frame.
    await delay(1000);
    const resumed=JSON.parse(await request(client,'f'));assert(resumed.jpeg);
    // A truly static display remains available without waiting for a new update.
    await request(fixture,'static\n');await delay(150);
    const staticA=JSON.parse(await request(client,'f'));
    const staticB=JSON.parse(await request(client,'f'));
    assert.equal(staticB.jpeg,staticA.jpeg);
    await close(client);
    const timing=client.stderr().match(/([\d.]+) real\s+([\d.]+) user\s+([\d.]+) sys/);
    assert(timing,client.stderr());
    const rss=client.stderr().match(/(\d+)\s+maximum resident set size/);
    const row={side,coldMs,raw,requestMs:summary(raw),sampleMs,frames:30,
      actualRequestsPerSecond:30000/sampleMs,cpuSeconds:Number(timing[2])+Number(timing[3]),
      realSeconds:Number(timing[1]),maxRssBytes:rss?Number(rss[1]):null,meanJpegBytes:sizes.reduce((a,b)=>a+b,0)/sizes.length,
      staticSha256:createHash('sha256').update(Buffer.from(staticA.jpeg,'base64')).digest('hex'),staticRepeatIdentical:true};
    report.rows.push(row);console.log(JSON.stringify({...row,raw:undefined}));
    await request(fixture,'moving\n');
  }
  await close(fixture);
  report.scope='Actual system capture + native encoding + base64/pipe; generated moving desktop. Excludes Electron crop, GIF/video encoding. CPU includes cold start, 3 seconds sampled recording, 1 second pause and static repeat.';
  if(option('output'))await writeFile(path.resolve(option('output')),JSON.stringify(report,null,2)+'\n');
} finally {
  for(const child of children.reverse()) {
    if(child.exitCode!==null||child.signalCode!==null)continue;
    const ended=once(child,'exit');const timer=setTimeout(()=>child.kill('SIGKILL'),2000);
    child.stdin.end();try{await ended;}finally{clearTimeout(timer);}
  }
  await rm(temp,{recursive:true,force:true});
}
