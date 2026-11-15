#!/usr/bin/env node
// Native startup stage only. Queries geometry, never captures desktop pixels.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const option = name => process.argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const desktop = fileURLToPath(new URL('..', import.meta.url)), root = path.resolve(desktop, '../..');
assert.equal(process.platform, 'darwin');
assert.ok(option('baseline-dir'), '--baseline-dir required');
const temp = await mkdtemp(path.join(os.tmpdir(), 'cindy-startup-perf-'));
const summary = raw => { const v = [...raw].sort((a,b)=>a-b); return { p50:v[Math.floor(v.length/2)], p95:v[Math.ceil(v.length*.95)-1] }; };
const results = [];
try {
  for (const side of ['before', 'after']) {
    const original = await readFile(path.join(side === 'before' ? option('baseline-dir') : root, 'apps/desktop/native/region-screenshot/macos-snapshot.swift'), 'utf8');
    // Reproduce the rejected batching experiment without changing production.
    // The measured cold-start improvement was not stable enough to retain it.
    const candidate = side === 'before' ? original : original.replace(
      'emit(["id": id, "windows": onScreenWindows()])',
      'emit(["id": id, "windows": onScreenWindows(), "pid": NSWorkspace.shared.frontmostApplication.map { Int($0.processIdentifier) } ?? NSNull(), "screens": screenInsets()])');
    const source = path.join(temp, `${side}.swift`); await writeFile(source, candidate);
    execFileSync('swiftc', [source, '-O', '-o', path.join(temp, side)]);
  }
  for (const side of ['before', 'after', 'after', 'before']) {
    const raw = [], warm = [];
    for (let i=0;i<15;i++) {
      const started = performance.now();
      const child = spawn(path.join(temp, side), [], { stdio: ['pipe', 'pipe', 'pipe'] });
      const lines = createInterface({ input: child.stdout });
      let nextId = 0;
      const pending = new Map();
      const fail = error => { for (const task of pending.values()) task.reject(error); pending.clear(); };
      child.on('error', fail); child.stdin.on('error', fail); child.stdout.on('error', fail); child.stderr.resume();
      child.on('exit', () => fail(new Error('helper exited')));
      lines.on('line', line => {
        try { const value=JSON.parse(line); pending.get(value.id)?.resolve(value); pending.delete(value.id); }
        catch (error) { fail(error); child.kill(); }
      });
      const ask = payload => new Promise((resolve,reject) => {
        const id=++nextId; const timer=setTimeout(()=>{pending.delete(id);reject(new Error('helper timeout'));child.kill();},5000);
        pending.set(id,{resolve:v=>{clearTimeout(timer);resolve(v);},reject:e=>{clearTimeout(timer);reject(e);}});
        child.stdin.write(JSON.stringify({id,...payload})+'\n');
      });
      const snapshot = async () => {
        if(side==='after') return ask({op:'windows',snapshot:true});
        const windows=await ask({op:'windows'}), front=await ask({op:'frontmost'}), screens=await ask({op:'screens'});
        return {...windows,pid:front.pid,screens:screens.screens};
      };
      try {
        const result=await snapshot(); raw.push(performance.now()-started);
        assert.ok(Array.isArray(result.windows) && Array.isArray(result.screens));
        assert.ok(result.pid===null || Number.isInteger(result.pid));
        const start=performance.now(); await snapshot(); warm.push(performance.now()-start);
      } finally {
        if (child.exitCode === null && child.signalCode === null) { const exit=once(child,'exit'); child.stdin.end(); await exit; }
        lines.close();
      }
    }
    const row={side,raw,warm,cold:summary(raw),queries:summary(warm)};results.push(row);
    console.log(JSON.stringify({side,cold:row.cold,queries:row.queries}));
  }
  if(option('output')) await writeFile(path.resolve(option('output')),JSON.stringify({generatedAt:new Date().toISOString(),platform:process.platform,arch:process.arch,
    candidate:'Batch three startup queries; rejected, production unchanged',
    scope:'Native process spawn + initial geometry snapshot, excluding Electron/system capture/overlay. Warm second query shown separately; no persistent helper proposed.',results},null,2)+'\n');
} finally { await rm(temp,{recursive:true,force:true}); }
