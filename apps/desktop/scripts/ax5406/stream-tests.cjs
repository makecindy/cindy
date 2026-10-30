// Actual MessageStream, incremental synthetic chunks; no model/backend call.
const fs = require('node:fs');
const path = require('node:path');
module.exports = async (win, output, config) => {
  const js = code => win.webContents.executeJavaScript(code);
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const failures = [], geometryWarnings = [], cases = [], paintedFrames = [], paintAudit = [];
  let phase = 'setup', paints = 0;
  win.webContents.beginFrameSubscription(false, frame => {
    if (phase === 'setup') return;
    paints++;
    let markerPixels = null;
    if (config.streamProbe === 'on') {
      const bitmap=frame.toBitmap(), size=frame.getSize();
      markerPixels=0;
      for(let y=Math.max(0,size.height-12);y<size.height;y++)for(let x=0;x<size.width;x++){
        const p=(y*size.width+x)*4;
        if(bitmap[p]===255&&bitmap[p+1]===0&&bitmap[p+2]===255&&bitmap[p+3]===255)markerPixels++;
      }
      paintAudit.push({phase,count:paints,time:Date.now(),markerPixels});
    }
    const missingMarker=config.streamProbe==='on'&&/-follow$|-resume$|-finish$/.test(phase)&&markerPixels===0;
    if (!missingMarker && (paints > 120 || (paints % 20 && !(phase.endsWith('-resume') && paints <= 8)))) return;
    const file = `stream-${phase}-${paints}.png`;
    fs.writeFileSync(path.join(output, file), frame.toPNG());
    paintedFrames.push(file);
  });
  await wait(600);
  await js(`(() => {
    const root=document.querySelector('[data-scroll-container]');
    window.streamAudit={running:true,samples:[],phase:'setup'};
    window.streamAudit.measure=()=>{
      const rect=root.getBoundingClientRect();
      const rows=[...document.querySelector('.msg-stream-items').children].map(e=>{
        const b=e.getBoundingClientRect();return {key:e.dataset.renderItemKey,top:b.top-rect.top,
          bottom:b.bottom-rect.top,placeholder:e.hasAttribute('data-message-placeholder')};
      });
      const visible=rows.filter(r=>r.bottom>1&&r.top<root.clientHeight-1);
      return {phase:window.streamAudit.phase,time:performance.now(),top:root.scrollTop,
        distance:root.scrollHeight-root.clientHeight-root.scrollTop,anchor:visible[0],rows,
        blank:visible.filter(r=>r.placeholder).length,
        overlap:rows.slice(1).filter((r,i)=>r.top<rows[i].bottom-1).length};
    };
    function frame(){if(!window.streamAudit.running)return;
      requestAnimationFrame(()=>{setTimeout(()=>{if(window.streamAudit.running)window.streamAudit.samples.push(window.streamAudit.measure());},0);frame();});
    }frame();
  })()`);
  if (config.streamProbe === 'on') await js(`(() => {
    const root=document.querySelector('[data-scroll-container]'),content=root.firstElementChild;
    const marker=document.createElement('span');marker.setAttribute('aria-hidden','true');
    marker.style.cssText='position:absolute;bottom:0;left:0;width:12px;height:3px;background:rgb(255,0,255);pointer-events:none;overflow-anchor:none;z-index:2147483647';
    content.append(marker);
    window.streamAudit.timeline=[];
    const record=kind=>{
      if(!/-follow$|-resume$|-finish$/.test(window.streamAudit.phase))return;
      window.streamAudit.timeline.push({kind,time:performance.now(),wallTime:Date.now(),phase:window.streamAudit.phase,
        top:root.scrollTop,distance:root.scrollHeight-root.clientHeight-root.scrollTop,
        markerBottom:marker.getBoundingClientRect().bottom-root.getBoundingClientRect().bottom});
    };
    let owner=root,descriptor;while(owner&&!descriptor){descriptor=Object.getOwnPropertyDescriptor(owner,'scrollTop');owner=Object.getPrototypeOf(owner);}
    Object.defineProperty(root,'scrollTop',{configurable:true,get:descriptor.get,set(value){descriptor.set.call(this,value);record('scroll-write');}});
    const mo=new MutationObserver(()=>record('mutation'));mo.observe(document.querySelector('.msg-stream-items'),{subtree:true,childList:true,characterData:true});
    const ro=new ResizeObserver(()=>record('resize-after-owner'));ro.observe(content);
    function frame(){if(!window.streamAudit.running){mo.disconnect();ro.disconnect();return;}
      requestAnimationFrame(()=>{record('rAF-before-layout');frame();});}frame();
  })()`);
  const setPhase = async value => {phase=value;paints=0;await js(`window.streamAudit.phase=${JSON.stringify(value)}`);};
  const snap = async name => {
    const state=await js('window.streamAudit.measure()');
    fs.writeFileSync(path.join(output,`${name}.png`),(await win.webContents.capturePage()).toPNG());
    return state;
  };
  const chunks = (from, count, interval) => js(`(async()=>{
    for(let i=${from};i<${from+count};i++){
      const text='chunk'+String(i).padStart(4,'0')+' '+
        (i%12===0?'**Incremental bold** and *emphasis*. ':'Streaming output, wrapping and layout. ')+
        'Chinese: '+String.fromCharCode(0x4e2d,0x6587,0x8f93,0x51fa)+' '+(i%4===3?'\\n\\n':'');
      window.ax5406Visual.streamChunk(text);
      await new Promise(resolve=>setTimeout(resolve,${interval}));
    }
  })()`);
  const endKey = async () => {
    await js(`(()=>{const r=document.querySelector('[data-scroll-container]');r.tabIndex=0;r.focus({preventScroll:true});})()`);
    win.webContents.sendInputEvent({type:'keyDown',keyCode:'END'});
    win.webContents.sendInputEvent({type:'keyUp',keyCode:'END'});
    await wait(700);
  };
  for(const [width,height,dark] of [[1000,760,false],[620,1000,true],[1000,420,false]]){
    const label=`${width}x${height}-${dark?'dark':'light'}`;
    await setPhase('setup');win.setSize(width,height);
    await js(`window.ax5406Visual.theme(${dark});window.ax5406Visual.streamStart()`);
    await wait(600);await endKey();
    await setPhase(label+'-follow');
    await chunks(0,120,30);await wait(250);
    const followed=await snap(label+'-follow');
    if(followed.distance>2)failures.push(label+': streaming lost tail follow');
    // Continue generating while a real wheel input takes over.
    await setPhase(label+'-takeover');
    const streaming=chunks(120,160,30);
    await wait(250);
    for(let i=0;i<8;i++){
      win.webContents.sendInputEvent({type:'mouseWheel',x:220,y:160,deltaY:240,deltaX:0});await wait(40);
    }
    await wait(400);
    const before=await snap(label+'-reading-before');
    await setPhase(label+'-reading');
    await streaming;await wait(300);
    const after=await snap(label+'-reading-after');
    const anchor=after.rows.find(r=>r.key===before.anchor?.key);
    if(before.distance<500)failures.push(label+': wheel takeover did not leave tail');
    if(!anchor||Math.abs(anchor.top-before.anchor.top)>2)failures.push(label+': streaming moved reading anchor');
    await endKey();
    await setPhase(label+'-resume');await chunks(280,120,10);await wait(300);
    const resumed=await snap(label+'-resume');
    if(resumed.distance>2)failures.push(label+': resumed follow lost tail');
    await setPhase(label+'-finish');
    await js('window.ax5406Visual.streamFinish()');await wait(650);
    const finished=await snap(label+'-finish');
    const tokens=await js(`(()=>{const e=document.querySelector('[data-message-client-id="synthetic-${config.rows-1}"]');
      return [...(e?.textContent||'').matchAll(/chunk(\\d{4})/g)].map(m=>Number(m[1]));})()`);
    if(tokens.length!==400||tokens.some((v,i)=>v!==i))failures.push(label+': streamed chunks lost or reordered');
    if(finished.distance>2)failures.push(label+': completion moved away from tail');
    cases.push({label,before,after,followed,resumed,finished,tokenCount:tokens.length});
  }
  const audit=await js('window.streamAudit.running=false;({samples:window.streamAudit.samples,timeline:window.streamAudit.timeline,errors:window.ax5406Stats.errors})');
  const phases={};
  for(const s of audit.samples){const p=phases[s.phase]??={samples:0,blank:0,overlap:0,maxBottomDistance:0};
    p.samples++;p.blank+=Number(s.blank>0);p.overlap+=Number(s.overlap>0);p.maxBottomDistance=Math.max(p.maxBottomDistance,s.distance);}
  for(const [name,p]of Object.entries(phases)){
    if(p.blank||p.overlap)failures.push(`${name}: ${p.blank} blank / ${p.overlap} overlaps`);
    if(/-follow$|-resume$|-finish$/.test(name)&&p.maxBottomDistance>2){
      const detail=`${name}: transient tail gap ${p.maxBottomDistance}px`;
      geometryWarnings.push(detail);
      // A task between DOM commit and ResizeObserver is not a painted frame.
      // Without the native-paint probe keep the original conservative failure.
      if(config.streamProbe!=='on')failures.push(detail);
    }
  }
  if(audit.errors.length)failures.push('renderer errors');
  let paintVerification;
  if(config.streamProbe==='on'){
    const following=paintAudit.filter(p=>/-follow$|-resume$|-finish$/.test(p.phase));
    const missing=following.filter(p=>!p.markerPixels);
    const negativeControl=paintAudit.filter(p=>p.phase.endsWith('-reading')&&!p.markerPixels);
    const resize=audit.timeline.filter(e=>e.kind==='resize-after-owner');
    paintVerification={followingFrames:following.length,missingMarkerFrames:missing.length,
      negativeControlFrames:negativeControl.length,postResizeSamples:resize.length,
      postResizeGaps:resize.filter(e=>e.distance>2).length};
    if(!following.some(p=>p.markerPixels>0)||!negativeControl.length)failures.push('paint probe controls not verified');
    for(const c of cases)for(const suffix of ['follow','resume','finish']){
      if(!following.some(p=>p.phase===c.label+'-'+suffix))failures.push(c.label+'-'+suffix+': no native paint evidence');
    }
    if(missing.length)failures.push(`${missing.length} actually painted frames away from bottom`);
    if(!resize.length||paintVerification.postResizeGaps)failures.push('post-compensation bottom position failed');
  }
  win.webContents.endFrameSubscription();
  fs.writeFileSync(path.join(output,'stream-audit.json'),JSON.stringify({cases,phases,failures,geometryWarnings,paintVerification,paintedFrames,paintAudit,...audit},null,2));
  return {failures,geometryWarnings,paintVerification,phases,cases:cases.map(c=>({label:c.label,tokenCount:c.tokenCount})),samples:audit.samples.length};
};
