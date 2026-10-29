#!/usr/bin/env node
// Explicit native integration benchmark; no display access or user image files.
// The baseline JPEG body is taken verbatim from the selected pre-change helper.
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
const exec = promisify(execFile);
const option = name => process.argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const root = fileURLToPath(new URL('../../..', import.meta.url));
const relative = 'apps/desktop/native/remote-desktop/macos-capture.m';
assert.equal(process.platform, 'darwin', 'Requires macOS');
const samples = Number(option('samples') ?? 20);
assert(Number.isInteger(samples) && samples > 0 && samples <= 100);
const temp = await mkdtemp(path.join(os.tmpdir(), 'cindy-demand-perf-'));
let child;
const summary = raw => { const sorted = [...raw].sort((a,b)=>a-b); return { p50:sorted[Math.floor(sorted.length/2)], p95:sorted[Math.ceil(sorted.length*.95)-1] }; };
try {
  const baseline = option('baseline-dir')
    ? await readFile(path.join(option('baseline-dir'), relative), 'utf8')
    : (await exec('git', ['show', `8c15788c0a4c20cf9dcd20f2ccd8c63a857faeb0:${relative}`], { cwd:root })).stdout;
  const start = baseline.indexOf('CIImage *image = [CIImage imageWithIOSurface:surface];');
  const end = baseline.indexOf('latest = jpeg.length <= limit ? jpeg : nil;', start);
  assert(start >= 0 && end > start, 'Baseline must contain the original eager encoder');
  const codec = baseline.slice(start, end) + 'return jpeg.length <= limit ? jpeg : nil;';
  const fixture = await readFile(new URL('./fixtures/region-capture/macos-demand.m', import.meta.url), 'utf8');
  const source = path.join(temp, 'benchmark.m'), binary = path.join(temp, 'benchmark');
  await writeFile(source, `#define main captureHelperMain\n#include ${JSON.stringify(path.join(root, relative))}\n#undef main\n` +
    `static NSData *baselineEncode(CIContext *context, CGColorSpaceRef color, IOSurfaceRef surface, double quality, long frameLimit, BOOL overlay) {\n${codec}\n}\n${fixture}`);
  await exec('xcrun', ['clang', source, '-fobjc-arc', '-fblocks', '-O2',
    ...['Foundation','AppKit','CoreGraphics','CoreImage','IOSurface','ImageIO','IOKit','ScreenCaptureKit','CoreMedia','CoreVideo'].flatMap(name=>['-framework',name]),
    '-o', binary], { timeout:120000 });
  const rows = [];
  child = spawn(binary, [String(samples)], { stdio:['ignore','pipe','inherit'] });
  const completed = new Promise((resolve,reject)=>{ child.once('error',reject); child.once('exit',code=>code===0 ? resolve() : reject(new Error(`Native checks exited ${code}`))); });
  // Attach immediately so a native assertion failure cannot become unhandled.
  void completed.catch(()=>{});
  const timeout = setTimeout(()=>child.kill('SIGKILL'), 180000);
  try {
    for await (const line of createInterface({ input:child.stdout })) {
      const row = JSON.parse(line); rows.push(row);
      console.log(JSON.stringify(row.roundMs ? {...row,roundMs:summary(row.roundMs),requestMs:summary(row.requestMs)} : row));
    }
    await completed;
  } finally { clearTimeout(timeout); }
  const report = { generatedAt:new Date().toISOString(), platform:process.platform, arch:process.arch,
    cpu:os.cpus()[0].model, baseline:option('baseline-dir') ?? '8c15788c0a4c20cf9dcd20f2ccd8c63a857faeb0',
    scope:'Synthetic IOSurfaces, actual native codec and frame slot. 3 system updates per requested frame; not measured desktop FPS or app CPU.', rows };
  if(option('output')) await writeFile(path.resolve(option('output')), JSON.stringify(report,null,2)+'\n');
} finally {
  if(child && child.exitCode===null && child.signalCode===null) child.kill('SIGKILL');
  await rm(temp, { recursive:true, force:true });
}
