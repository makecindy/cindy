#!/usr/bin/env node
// Explicit Electron benchmark: production live-region entry, synthetic sources.
// No screen access, clipboard, user profile or save-dialog automation.
import { build } from 'esbuild';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const option = name => process.argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const desktop = fileURLToPath(new URL('..', import.meta.url));
const root = path.resolve(desktop, '../..');
const baseline = option('baseline-dir');
if (process.platform !== 'darwin') throw new Error('Requires macOS');
if (option('side') && !['before', 'after'].includes(option('side'))) throw new Error('--side must be before or after');
if (!baseline) throw new Error('--baseline-dir is required');
const temp = await mkdtemp(path.join(os.tmpdir(), 'cindy-native-perf-'));
try {
  for (const side of ['before', 'after']) {
    const contents = await readFile(path.join(side === 'before' ? baseline : root, 'apps/desktop/src/main/region-screenshot/liveCapture.ts'), 'utf8');
    await build({ stdin: { contents, loader: 'ts', resolveDir: path.join(desktop, 'src/main/region-screenshot') },
      bundle: true, platform: 'node', format: 'cjs', outfile: path.join(temp, `${side}.cjs`),
      plugins: [{ name: 'synthetic-capture-only', setup(b) {
        b.onResolve({ filter: /^electron$/ }, args => args.namespace === 'fixture' ? { path: 'electron', external: true } : { path: 'electron', namespace: 'fixture' });
        b.onResolve({ filter: /remote-desktop\/nativeCapture$/ }, () => ({ path: 'native', namespace: 'fixture' }));
        b.onResolve({ filter: /remote-desktop\/captureSource$/ }, () => ({ path: 'sources', namespace: 'fixture' }));
        b.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path: name }) => ({ contents: name === 'electron'
          ? `const electron = require('electron'); exports.nativeImage = electron.nativeImage; exports.screen = electron.screen;
             exports.desktopCapturer = { getSources: async () => globalThis.captureFixture.sources };`
          : name === 'native' ? `exports.NativeDesktopCapture = class { async frame() { return { jpeg: globalThis.captureFixture.jpeg }; } stop() {} };`
            : 'exports.enumerateDesktopSources = async operation => operation();', loader: 'js' }));
      } }], external: ['electron'], logLevel: 'silent' });
  }
  await build({ entryPoints: [path.join(desktop, 'src/main/region-screenshot/encodeImage.ts')],
    bundle: true, platform: 'node', format: 'cjs', outfile: path.join(temp, 'encode.cjs'),
    plugins: [{ name: 'installed-sharp', setup(b) { b.onResolve({ filter: /^sharp$/ }, () => ({ path: createRequire(import.meta.url).resolve('sharp'), external: true })); } }], logLevel: 'silent' });
  const entry = path.join(temp, 'main.cjs');
  await writeFile(entry, `const { app, nativeImage } = require('electron');
const fs = require('node:fs'); const assert = require('node:assert/strict');
const crypto = require('node:crypto');
app.setPath('userData', ${JSON.stringify(path.join(temp, 'profile'))});
const summary = raw => { const v = [...raw].sort((a,b)=>a-b); return { p50: v[Math.floor(v.length/2)], p95: v[Math.ceil(v.length*.95)-1] }; };
app.whenReady().then(async () => {
  const report = { generatedAt: new Date().toISOString(), platform: process.platform, arch: process.arch,
    electron: process.versions.electron, capture: [], save: [] };
  const data = Buffer.alloc(3840*2160*4);
  for (let i=0;i<data.length;i+=4) { data[i]=(i*13+(i>>>12))%256; data[i+1]=(i>>>8)%256; data[i+2]=(i>>>16)%256; data[i+3]=255; }
  const image = nativeImage.createFromBitmap(data, { width:3840, height:2160 });
  globalThis.captureFixture = { jpeg: image.toJPEG(90).toString('base64'), sources:[{display_id:'1',thumbnail:image}] };
  const display={id:1,bounds:{x:0,y:0,width:1920,height:1080},scaleFactor:2};
  const modules = { before: require('./before.cjs'), after: require('./after.cjs') };
  if (!['save','parity'].includes(${JSON.stringify(option('only'))})) for (const [mode,selection] of [
    ['gif',{x:13,y:17,width:400,height:250}],
    ['video',{x:13,y:17,width:960,height:540}],
    ['scroll',{x:13,y:17,width:1600,height:1000}],
    ['gif',{x:13,y:17,width:1200,height:800}],
  ]) {
    let baseline;
    for (const side of ['before','after','after','before']) {
      const capture = new modules[side].RegionVideoCapture({}); const raw=[];
      let frame;
      for(let i=-3;i<30;i++) {
        const start=performance.now();
        frame=mode==='scroll' ? await modules[side].captureLiveRegion(display,selection,mode) : await capture.frame(display,selection,mode);
        if(i>=0)raw.push(performance.now()-start);
      }
      const value={width:frame.width,height:frame.height,pixels:Buffer.from(frame.data)};
      if(!baseline)baseline=value; else assert.deepEqual(value,baseline,'Every returned BGRA byte must match');
      capture.stop();
      const row={side,mode,selection,raw,...summary(raw),bytes:frame.data.length,hash:crypto.createHash('sha256').update(frame.data).digest('hex')};
      report.capture.push(row); console.log(JSON.stringify({...row,raw:undefined}));
    }
  }
  report.regression=[];
  for(const [scale,alpha] of [[2,0],[2,127],[1.5,255]]) {
    const pixels=Buffer.alloc(800*600*4);
    for(let i=0;i<pixels.length;i+=4){pixels[i]=Math.floor((i%256)*alpha/255);pixels[i+1]=Math.floor(((i>>>5)%256)*alpha/255);pixels[i+2]=alpha;pixels[i+3]=alpha;}
    globalThis.captureFixture.sources=[{display_id:'1',thumbnail:nativeImage.createFromBitmap(pixels,{width:800,height:600})}];
    const display={id:1,bounds:{x:0,y:0,width:400,height:300},scaleFactor:scale};
    const selection={x:13.5,y:17.25,width:200.25,height:150.5};
    const before=await modules.before.captureLiveRegion(display,selection,'scroll');
    const after=await modules.after.captureLiveRegion(display,selection,'scroll');
    assert.deepEqual(after,before,'Alpha/mixed-density region crop must match');
    report.regression.push({scale,alpha,width:after.width,height:after.height,identical:true});
  }
  // Encoding is synchronous even though fs.writeFile is async. Measure that
  // separately; never include a native dialog or pretend to measure disk speed.
  if (${JSON.stringify(option('only'))} !== 'parity') for (const [width,height] of ${option('memory') ? '[[1600,10000]]' : '[[1920,1080],[3840,2160],[1600,10000]]'}) {
    const pixels=Buffer.alloc(width*height*4); for(let i=0;i<pixels.length;i+=4){pixels[i]=i%256;pixels[i+1]=(i>>>9)%256;pixels[i+2]=(i>>>17)%256;pixels[i+3]=255;}
    let source;
    for(const format of ${option('memory') ? "['png']" : "['png','jpeg']"}) for(const side of ${JSON.stringify(option('side') ? [option('side'), option('side')] : ['before','after','after','before'])}) {
      const raw=[],synchronous=[],timerDelay=[];let bytes;
      for(let i=0;i<10;i++) {
        source=nativeImage.createFromBitmap(pixels,{width,height});
        const start=performance.now();
        const timer=new Promise(resolve=>setTimeout(()=>resolve(performance.now()-start),0));
        const pending=side==='before' ? (format==='png'?source.toPNG():source.toJPEG(92)) : require('./encode.cjs').encodeScreenshotImage(source,format==='jpeg');
        synchronous.push(performance.now()-start);
        bytes=await pending;raw.push(performance.now()-start);timerDelay.push(await timer);
      }
      // Independent Electron decoding checks every BGRA output byte. JPEG keeps
      // the exact encoder, so compare encoded bytes as well.
      if(format==='png') assert.deepEqual(nativeImage.createFromBuffer(bytes).toBitmap(),source.toBitmap(),'PNG pixels');
      else assert.deepEqual(bytes,source.toJPEG(92),'JPEG bytes');
      const row={side,width,height,format,raw,synchronous,timerDelay,...summary(raw),mainThread:summary(synchronous),timer:summary(timerDelay),bytes:bytes.length};
      report.save.push(row);console.log(JSON.stringify({...row,raw:undefined,synchronous:undefined,timerDelay:undefined}));
    }
  }
  for(const alpha of [0,1,127,254]) {
    const pixels=Buffer.alloc(2000*1000*4,alpha),source=nativeImage.createFromBitmap(pixels,{width:2000,height:1000});
    assert.deepEqual(await require('./encode.cjs').encodeScreenshotImage(source),source.toPNG(),'Transparent PNG must keep original encoding');
  }

  fs.writeFileSync(${JSON.stringify(path.join(temp, 'result.json'))},JSON.stringify(report,null,2));
  app.quit();
}).catch(error=>{console.error(error);app.exit(1);});`);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(PATH|SYSTEMROOT|WINDIR|TEMP|TMP|TMPDIR|DISPLAY|LANG|LC_ALL)$/i.test(key)));
  const executable = createRequire(import.meta.url)('electron');
  const { stdout, stderr } = await promisify(execFile)(option('memory') ? '/usr/bin/time' : executable,
    option('memory') ? ['-l', executable, entry] : [entry], { env, timeout: 180000, maxBuffer: 1024 * 1024 });
  console.log(stdout);
  const report = JSON.parse(await readFile(path.join(temp, 'result.json'), 'utf8'));
  if (option('memory')) {
    report.memory = { side: option('side'), maximumResidentSetBytes: Number(stderr.match(/(\d+)\s+maximum resident set size/)?.[1]),
      scope: 'macOS time -l maximum RSS of isolated Electron main process, including synthetic fixture allocations and native codec caches; not the interactive Cindy app peak.' };
    if (!Number.isFinite(report.memory.maximumResidentSetBytes)) throw new Error('Could not read time -l maximum RSS');
    console.log(JSON.stringify(report.memory));
  }
  if (option('output')) await writeFile(path.resolve(option('output')), JSON.stringify(report, null, 2) + '\n');
} finally { await rm(temp, { recursive: true, force: true }); }
