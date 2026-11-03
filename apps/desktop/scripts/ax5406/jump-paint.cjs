// Real MessageStream build, synthetic props. Native compositor frame acceptance.
// Run with Electron: jump-paint.cjs <config.json>; all output stays outside the repo.
const { app, BrowserWindow } = require('electron');
const fs = require('fs'), path = require('path');
const cfg = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
app.setPath('userData', path.join(cfg.output, 'profile'));
app.commandLine.appendSwitch('disable-renderer-accessibility');
app.commandLine.appendSwitch('disable-background-timer-throttling');
const report = { cases: [], failures: [], errors: [], controls: [], versions: process.versions };
const save = () => fs.writeFileSync(path.join(cfg.output, 'audit.json'), JSON.stringify(report, null, 2));
const wait = ms => new Promise(r => setTimeout(r, ms));
let win, active = null, frameId = 0, bounds;
const js = code => win.webContents.executeJavaScript(code);
function inspect(frame) {
  const bitmap = frame.toBitmap(), size = frame.getSize(), rows = new Map();
  const sx = size.width / bounds.windowWidth, sy = size.height / bounds.windowHeight;
  let blank = 0;
  for (let y = Math.ceil(bounds.top * sy); y < Math.min(size.height, Math.floor(bounds.bottom * sy)); y++) {
    for (let x = Math.ceil((cfg.light ? bounds.markerX + 6 : bounds.left) * sx); x < Math.min(size.width, Math.floor((cfg.light ? bounds.markerX + 8 : bounds.right) * sx)); x++) {
      const n = (y * size.width + x) * 4, b = bitmap[n], g = bitmap[n + 1], r = bitmap[n + 2];
      if (r === 255 && g === 0 && b === 255) blank++;
      if (x < Math.ceil((bounds.markerX + 6) * sx) || x >= Math.floor((bounds.markerX + 8) * sx) ||
          [r,g,b].some(v=>v<32||v>228||(v-32)%28!==0)) continue;
      const id = (r-32)/28 + ((g-32)/28)*8 + ((b-32)/28)*64;
      if (id >= 500) continue;
      let row = rows.get(id);
      if (!row) { row = { id, top: y / sy, bottom: y / sy, pixels: 0 }; rows.set(id, row); }
      row.bottom = y / sy; row.pixels++;
    }
  }
  // A legitimate first row may expose only a 2–4px sliver after its height is
  // measured. Exact palette matches inside the stripe suffice in that case.
  return { blank, rows: [...rows.values()].filter(r => r.pixels >= 2), size };
}
async function install() {
  bounds = await js(`(() => {
    const root=document.querySelector('[data-scroll-container]'),r=root.getBoundingClientRect();
    const s=document.createElement('style');s.id='jump-probe';
    // Scan away from the rounded corners added by search highlighting. At x=1
    // the unchanged row appears to shrink 6px at both ends when it is highlighted.
    s.textContent=Array.from({length:500},(_,i)=>'.msg-stream-items>[data-render-item-key="msg-synthetic-'+i+'"]{background-image:linear-gradient(to right,rgb('+(32+28*(i%8))+','+(32+28*(Math.floor(i/8)%8))+','+(32+28*Math.floor(i/64))+') 0 8px,transparent 8px)!important}').join('')+
      '.msg-stream-items>[data-message-placeholder]{background-image:linear-gradient(rgb(255,0,255),rgb(255,0,255))!important}';document.head.append(s);
    const ticker=document.createElement('div');ticker.style.cssText='position:fixed;right:0;top:0;width:6px;height:6px;z-index:2147483647;pointer-events:none';document.body.append(ticker);
    window.jumpAudit={samples:[],active:false};let n=0;
    function tick(){ticker.style.background=n++%2?'rgb(1,2,3)':'rgb(4,5,6)';
      if(window.jumpAudit.active){const rows=[...document.querySelector('.msg-stream-items').children].map(e=>{const b=e.getBoundingClientRect();return{id:e.dataset.messageClientId,top:b.top,bottom:b.bottom,height:b.height,placeholder:e.hasAttribute('data-message-placeholder')}});
        window.jumpAudit.samples.push({time:Date.now(),top:root.scrollTop,distance:root.scrollHeight-root.clientHeight-root.scrollTop,rows:rows.filter(e=>e.height>0&&e.bottom>r.top+1&&e.top<r.bottom-1),overlaps:rows.slice(1).filter((e,i)=>e.top<rows[i].bottom-1).length});}requestAnimationFrame(tick);}tick();
    return{left:r.left,right:r.right-16,top:r.top+1,bottom:r.bottom-1,markerX:document.querySelector('.msg-stream-items').getBoundingClientRect().left,windowWidth:innerWidth,windowHeight:innerHeight};
  })()`);
  if(cfg.trace) await js(`(()=>{
    const root=document.querySelector('[data-scroll-container]');window.jumpTrace=[];
    const sample=(kind,detail)=>{if(!window.jumpAudit.active)return;const e=document.querySelector('[data-message-client-id="synthetic-470"]'),b=e?.getBoundingClientRect();window.jumpTrace.push({at:Date.now(),kind,detail,scrollTop:root.scrollTop,total:root.scrollHeight,targetTop:b?.top,targetHeight:b?.height,targetAbsolute:b?b.top+root.scrollTop:null});};
    const original=Element.prototype.scrollIntoView;Element.prototype.scrollIntoView=function(...args){sample('intoView-before',{id:this.dataset.messageClientId,args,top:this.getBoundingClientRect().top,height:this.getBoundingClientRect().height,stack:new Error().stack});const value=original.apply(this,args);sample('intoView-after');return value};
    root.addEventListener('scrollend',()=>sample('scrollend'));
    const ro=new ResizeObserver(()=>sample('resize'));ro.observe(document.querySelector('.msg-stream-items'));
    function frame(){sample('rAF');requestAnimationFrame(frame)}frame();
  })()`);
}
function onFrame(frame) {
  if (!active) return;
  const at = Date.now(), decoded = inspect(frame), file = `frame-${String(++frameId).padStart(6, '0')}.png`;
  // Persist every delivered frame: no sampling or dropped "uninteresting" frames.
  if (!cfg.light) fs.writeFileSync(path.join(cfg.output, file), frame.toPNG());
  active.frames.push({ at, file, ...decoded });
}
async function control(kind) {
  active = { frames: [] };
  // Keep both negative controls literal: never interpolate CSS into renderer code.
  if (kind === 'placeholder') {
    await js(`(()=>{const s=document.createElement('style');s.id='negative-control';s.textContent='.msg-stream-items>[data-message-client-id="synthetic-499"]{background-image:linear-gradient(rgb(255,0,255),rgb(255,0,255))!important}';document.head.append(s)})()`);
  } else if (kind === 'empty viewport') {
    await js(`(()=>{const s=document.createElement('style');s.id='negative-control';s.textContent='.msg-stream-items>*{visibility:hidden!important}';document.head.append(s)})()`);
  } else {
    throw Error('Unknown native paint control: ' + kind);
  }
  await wait(180);
  const frames = active.frames;
  const detected = kind === 'placeholder' ? frames.some(f => f.blank > 16) : frames.some(f => !f.rows.length);
  report.controls.push({ kind, detected, frames: frames.length });
  if (!detected) throw Error('Native paint control failed: ' + kind);
  active = null; await js(`document.getElementById('negative-control').remove()`); await wait(100);
}
function sameRows(a, b) {
  return a.length === b.length && a.every((r, i) => r.id === b[i].id && Math.abs(r.top - b[i].top) <= 2 && Math.abs(r.bottom - b[i].bottom) <= 2);
}
async function runCase(label, kind, value) {
  await js('window.jumpAudit.samples=[];window.jumpAudit.active=true');
  if(cfg.trace)await js('window.jumpTrace=[]');
  const c = { label, kind, value, frames: [] }; active = c;
  const start = await js(`(()=>{const root=document.querySelector('[data-scroll-container]');
    const started=Date.now();let target=${kind === 'focus' ? value : 499};
    if(${JSON.stringify(kind)}==='instant'){
      root.dispatchEvent(new WheelEvent('wheel',{deltaY:-100,bubbles:true}));
      const top=(root.scrollHeight-root.clientHeight)*${Number(value)};
      const b=root.getBoundingClientRect();target=Number([...document.querySelector('.msg-stream-items').children].find(e=>{const r=e.getBoundingClientRect();return r.height>0&&r.bottom-b.top+root.scrollTop>top+32})?.dataset.messageClientId?.split('-').at(-1));root.scrollTop=top;
    }else if(${JSON.stringify(kind)}==='focus')window.ax5406Visual.focus('synthetic-'+target);
    else {const button=[...document.querySelectorAll('button')].find(e=>/new messages|Jump to bottom/.test(e.textContent));if(!button)throw Error('No jump to bottom button');button.click();}
    return{started,target};})()`);
  Object.assign(c, start);
  await wait(kind === 'instant' ? 1000 : 2600);
  c.dom = await js('window.jumpAudit.active=false;window.jumpAudit.samples');
  if(cfg.trace)c.trace=await js('window.jumpTrace');
  active = null;
  c.frames = c.frames.filter(f => f.at >= c.started);
  const ready = f => f.blank <= 16 && f.rows.some(r => r.id === c.target);
  const first = c.frames.find(ready), last = c.frames.at(-1);
  c.firstTargetPaintMs = first ? first.at - c.started : null;
  let stableIndex = c.frames.length - 1;
  while (stableIndex > 0 && sameRows(c.frames[stableIndex - 1].rows, last.rows) && ready(c.frames[stableIndex - 1])) stableIndex--;
  c.stablePaintMs = last && ready(last) ? c.frames[stableIndex].at - c.started : null;
  c.stableObservedMs = last && c.stablePaintMs !== null ? last.at - c.frames[stableIndex].at : 0;
  c.blankPaints = c.frames.filter(f => f.blank > 16 || !f.rows.length).map(f => f.file);
  c.targetLostPaints = first ? c.frames.filter(f => f.at > first.at && !f.rows.some(r => r.id === c.target)).map(f => f.file) : [];
  // A correct final landing can hide an overshoot followed by a visible snap.
  // Check the actual painted trajectory too, excluding <=4px raster jitter.
  const targetFrames = c.frames.map(f => ({ ...f, targetRow: f.rows.find(r => r.id === c.target) })).filter(f => f.targetRow);
  c.reversals = [];
  if (targetFrames.length) for (const edge of ['top', 'bottom']) {
    const direction = Math.sign(targetFrames.at(-1).targetRow[edge] - targetFrames[0].targetRow[edge]);
    for (let i = 1; i < targetFrames.length; i++) {
      // At the viewport cut, text can cover the last few stripe pixels. That
      // clipped endpoint is not the row's edge; use its other, exposed edge.
      // Keep genuine reversals away from the cut (including the 416px repro).
      const cut = edge === 'top' ? bounds.top : bounds.bottom;
      if ([targetFrames[i - 1], targetFrames[i]].every(f => Math.abs(f.targetRow[edge] - cut) < 24)) continue;
      const delta = targetFrames[i].targetRow[edge] - targetFrames[i - 1].targetRow[edge];
      if (direction ? direction * delta < -4 : Math.abs(delta) > 4) c.reversals.push({
        edge, delta, before: targetFrames[i - 1].file, after: targetFrames[i].file,
        atMs: targetFrames[i].at - c.started,
      });
    }
  }
  const finalDOM = c.dom.at(-1);
  c.finalTargetVisible = !!finalDOM?.rows.some(r => r.id === 'synthetic-' + c.target && !r.placeholder);
  c.finalDistance = finalDOM?.distance;
  c.maxFrameIntervalMs = Math.max(0, ...c.frames.slice(1).map((f, i) => f.at - c.frames[i].at));
  if (c.firstTargetPaintMs === null || !c.finalTargetVisible || c.stableObservedMs < 200 || c.frames.length < 8) report.failures.push(label + ': target/stability not verified');
  if (c.blankPaints.length) report.failures.push(label + ': native blank/placeholder paint');
  if (c.targetLostPaints.length) report.failures.push(label + ': target disappeared after arrival');
  if (c.reversals.length) report.failures.push(label + ': target reversed direction before settling');
  if (kind === 'bottom' && c.finalDistance > 2) report.failures.push(label + ': bottom not reached');
  if (c.dom.some(s => s.overlaps)) report.failures.push(label + ': overlapping DOM rows');
  report.cases.push(c); save();
  console.log(JSON.stringify({ label, target: c.target, firstMs: c.firstTargetPaintMs, stableMs: c.stablePaintMs, paints: c.frames.length, blanks: c.blankPaints.length, lost: c.targetLostPaints.length }));
}
async function run() {
  win = new BrowserWindow({ width:1280,height:800,useContentSize:true,show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false} });
  win.webContents.on('render-process-gone', (_e, d) => { report.crash=d; save(); app.exit(2); });
  win.webContents.on('console-message', (_e,d) => { if(d.level==='error')report.errors.push(d.message); });
  win.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  for (const [width,height,dark] of (cfg.matrices || [[1280,800,false],[960,640,false],[620,1000,false],[1280,800,true],[960,640,true],[620,1000,true]])) {
    win.setContentSize(width,height);
    await win.loadFile(path.join(cfg.build,'component/component.html'),{query:{rows:'500',seed:'5407',workload:'visual',scroll:'off',accessibility:'off'}});
    win.showInactive(); await wait(500);
    await js(`window.ax5406Visual.theme(${dark});window.ax5406Visual.streamFinish()`);await wait(200);
    await install(); report.bounds ??= []; report.bounds.push(bounds); win.webContents.beginFrameSubscription(false,onFrame);await wait(150);
    if (!report.controls.length) {
      await control('placeholder');
      await control('empty viewport');
    }
    const prefix=`${width}x${height}-${dark?'dark':'light'}`;
    for (const [i,f] of [.15,.8,.3,.9].entries())await runCase(prefix+'-instant-'+i,'instant',f);
    for (const id of [430,100,470]) {
      await runCase(prefix+'-focus-'+id,'focus',id);
      await runCase(prefix+'-bottom-'+id,'bottom',0);
    }
    win.webContents.endFrameSubscription();
  }
  report.completed=true;report.passed=!report.failures.length&&!report.errors.length;save();win.destroy();app.exit(report.passed?0:3);
}
setTimeout(()=>{report.failures.push('harness timeout');save();app.exit(2)},240000);
app.whenReady().then(run).catch(e=>{report.error=e.stack;save();app.exit(2)});
