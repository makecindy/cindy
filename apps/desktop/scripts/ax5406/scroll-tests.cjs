// Extended scrolling checks on real MessageStream; synthetic data, isolated HWND.
const fs = require('node:fs');
const path = require('node:path');
module.exports = async (win, output, config = {}) => {
  const js = code => win.webContents.executeJavaScript(code);
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const failures = [], cases = [], navigation = [];
  let capturePhase = 'setup';
  const paintedFrames = [], paintCounts = {};
  win.webContents.beginFrameSubscription(false, frame => {
    if (!/fast-|jumps|thumb-drag|jump-button/.test(capturePhase)) return;
    const count = paintCounts[capturePhase] = (paintCounts[capturePhase] || 0) + 1;
    if (count > 32 || (!capturePhase.endsWith('jump-button') && count % 2)) return;
    const file = `paint-${capturePhase}-${count}.png`;
    fs.writeFileSync(path.join(output,file),frame.toPNG());
    paintedFrames.push({phase:capturePhase,count,file});
  });
  await wait(500);
  if(config.anchoring === 'off') await js(`document.querySelector('[data-scroll-container]').style.overflowAnchor='none'`);
  if(config.mounting === 'full') {
    // Existing keyboard traversal fallback mounts every logical row. No CSS or
    // production source override; useful as a full-mount geometry control.
    await js(`document.querySelector('[data-scroll-container]').dispatchEvent(new KeyboardEvent('keydown',{key:'Tab',bubbles:true}))`);
    await wait(200);
  }
  await js(`(() => {
    const root=document.querySelector('[data-scroll-container]');
    window.scrollAudit={samples:[],phase:'setup',running:true,inputs:0};
    window.scrollAudit.lastScroll=performance.now();
    root.addEventListener('scroll',()=>{window.scrollAudit.lastScroll=performance.now();});
    window.scrollAudit.writes=[];
    const record=(kind,detail)=>{
      if(!/search|jump-button|jumps/.test(window.scrollAudit.phase))return;
      const target=document.querySelector('[data-message-client-id="'+window.scrollAudit.target+'"]');
      window.scrollAudit.writes.push({time:performance.now(),phase:window.scrollAudit.phase,
        kind,detail,top:root.scrollTop,total:root.scrollHeight,nativeAnchoring:getComputedStyle(root).overflowAnchor,target:window.scrollAudit.target,
        targetTop:target?.getBoundingClientRect().top-root.getBoundingClientRect().top,
        stack:kind==='scrollend'?undefined:new Error().stack});
    };
    let proto=root, descriptor;
    while(proto&&!descriptor){descriptor=Object.getOwnPropertyDescriptor(proto,'scrollTop');proto=Object.getPrototypeOf(proto);}
    Object.defineProperty(root,'scrollTop',{configurable:true,get(){return descriptor.get.call(this);},
      set(value){record('scrollTop',value);descriptor.set.call(this,value);}});
    for(const method of ['scrollTo','scrollBy']) {
      const original=root[method];root[method]=function(...args){record(method,args);return original.apply(this,args);};
    }
    const intoView=Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView=function(...args){
      if(root.contains(this))record('scrollIntoView',{id:this.dataset.messageClientId,args});
      if(${JSON.stringify(config.settlement)}==='two-raf'&&root.contains(this)&&args[0]?.block==='center'&&!args[0]?.behavior){
        const phase=window.scrollAudit.phase,target=window.scrollAudit.target;
        requestAnimationFrame(()=>requestAnimationFrame(()=>{
          if(window.scrollAudit.phase===phase&&window.scrollAudit.target===target){record('late-correct',target);intoView.apply(this,args);}
        }));
      }
      if(${JSON.stringify(config.settlement)}==='scroll-to'&&root.contains(this)&&args[0]?.block==='center'&&!args[0]?.behavior){
        const b=this.getBoundingClientRect(),r=root.getBoundingClientRect();
        return root.scrollTo({top:root.scrollTop+b.top-r.top-(root.clientHeight-b.height)/2,behavior:'instant'});
      }
      return intoView.apply(this,args);
    };
    root.addEventListener('scrollend',()=>record('scrollend'));
    window.scrollAudit.measure=()=>{
      const bounds=root.getBoundingClientRect();
      const rows=[...document.querySelector('.msg-stream-items').children].map(e=>{
        const r=e.getBoundingClientRect();return {key:e.dataset.renderItemKey,top:r.top-bounds.top,
          bottom:r.bottom-bounds.top,height:r.height,placeholder:e.hasAttribute('data-message-placeholder')};
      });
      const visible=rows.filter(r=>r.bottom>1&&r.top<root.clientHeight-1&&r.height>0);
      return {time:performance.now(),phase:window.scrollAudit.phase,scrollTop:root.scrollTop,
        height:root.clientHeight,total:root.scrollHeight,nativeAnchoring:getComputedStyle(root).overflowAnchor,mounted:rows.filter(r=>!r.placeholder).length,
        count:rows.length,anchor:visible[0],blank:visible.filter(r=>r.placeholder),
        blankPixels:visible.filter(r=>r.placeholder).reduce((sum,r)=>sum+Math.min(root.clientHeight,r.bottom)-Math.max(0,r.top),0),
        overlaps:rows.slice(1).filter((r,i)=>r.top<rows[i].bottom-1).length};
    };
    function frame(){if(!window.scrollAudit.running)return;
      // Task after the frame callback: avoids measuring before the hook's rAF.
      requestAnimationFrame(()=>{setTimeout(()=>{if(window.scrollAudit.running)window.scrollAudit.samples.push(window.scrollAudit.measure());},0);frame();});
    }frame();
  })()`);
  const phase = name => {capturePhase=name;return js(`window.scrollAudit.phase=${JSON.stringify(name)}`);};
  const snap = async name => {
    const state = await js('window.scrollAudit.measure()');
    fs.writeFileSync(path.join(output, `${name}.png`), (await win.webContents.capturePage()).toPNG());
    if(state.blank.length||state.overlaps)failures.push(`${name}: settled layout anomaly`);
    return state;
  };
  const wheel = async (delta, count, interval=16) => {
    for(let i=0;i<count;i++) {
      win.webContents.sendInputEvent({type:'mouseWheel',x:220,y:180,deltaY:delta,deltaX:0});
      await wait(interval);
    }
  };
  for (const [width,height,dark] of [[1000,420,false],[1000,760,false],[620,1000,true]]) {
    const label=`${width}x${height}-${dark?'dark':'light'}`;
    win.setSize(width,height);
    await js(`window.ax5406Visual.theme(${dark})`); await wait(450);
    await phase(label+'-slow-up'); await wheel(80,80);
    await phase(label+'-slow-down'); await wheel(-80,80);
    await phase(label+'-fast-up'); await wheel(900,70);
    await phase(label+'-fast-down'); await wheel(-900,70);
    await phase(label+'-reverse');
    for(let i=0;i<60;i++)await wheel(i%2? -450:450,1);
    // Explicit wheel leaves follow mode, then large range changes model scrollbar/page jumps.
    await wheel(300,2); await wait(100);
    await phase(label+'-jumps');
    const jumpPositions=await js(`(async()=>{const r=document.querySelector('[data-scroll-container]'),positions=[];
      for(let i=0;i<60;i++) {r.scrollTop=(r.scrollHeight-r.clientHeight)*((i*37%97)/100);
        await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
        positions.push(r.scrollTop);}
      return positions;
    })()`);
    // No blanks is insufficient if stale tail-follow simply undoes every jump.
    if(Math.max(...jumpPositions)-Math.min(...jumpPositions)<1000 || new Set(jumpPositions.map(Math.round)).size<20) {
      failures.push(`${label}-jumps: requested range changes were undone`);
    }
    await phase(label+'-keyboard');
    await js(`(()=>{const r=document.querySelector('[data-scroll-container]');r.tabIndex=0;r.focus({preventScroll:true});})()`);
    for(const key of ['HOME',...Array(12).fill('PAGEDOWN'),...Array(12).fill('PAGEUP'),'END']) {
      win.webContents.sendInputEvent({type:'keyDown',keyCode:key});
      win.webContents.sendInputEvent({type:'keyUp',keyCode:key});await wait(60);
    }
    await wait(450);
    await phase(label+'-search');
    if(config.anchoring === 'search')await js(`document.querySelector('[data-scroll-container]').style.overflowAnchor='none'`);
    for(const id of [420,470,430,490,440]) {
      await js(`window.scrollAudit.target='synthetic-${id}'`);
      await js(`window.ax5406Visual.focus('synthetic-${id}')`);
      const target=await js(`(async()=>{const started=performance.now();let visible=false;
        do {await new Promise(resolve=>setTimeout(resolve,50));
          const e=document.querySelector('[data-message-client-id="synthetic-${id}"]'),root=document.querySelector('[data-scroll-container]');
          const b=e?.getBoundingClientRect(),r=root.getBoundingClientRect();visible=!!b&&!e.hasAttribute('data-message-placeholder')&&b.bottom>r.top&&b.top<r.bottom;
          if(visible&&performance.now()-started>300&&performance.now()-window.scrollAudit.lastScroll>150)break;
        }while(performance.now()-started<3000);
        return {visible,elapsedMs:performance.now()-started};})()`);
      navigation.push({label,id,...target});
      if(!target.visible)failures.push(label+': search target not visible after settling '+id);
      if(id===420)await snap(label+'-search-420');
    }
    await phase(label+'-search-takeover');
    await js(`window.ax5406Visual.focus('synthetic-450')`);await wait(80);
    await wheel(300,4);await wait(400);
    const takeover=await js('window.scrollAudit.measure()');await wait(700);
    const takenOver=await js('window.scrollAudit.measure()');
    if(takeover.anchor?.key!==takenOver.anchor?.key||Math.abs(takeover.anchor?.top-takenOver.anchor?.top)>2)failures.push(label+': cancelled search moved the reading anchor');
    await js('window.ax5406Visual.focus(undefined)');
    if(config.anchoring === 'search')await js(`document.querySelector('[data-scroll-container]').style.removeProperty('overflow-anchor')`);
    await phase(label+'-jump-button');
    await js(`(()=>{const e=[...document.querySelectorAll('button')].find(e=>/new messages|Jump to bottom/.test(e.textContent));if(e)e.click();})()`);
    await wait(1800);
    const pinned=await js('window.scrollAudit.measure()');
    if(pinned.total-pinned.scrollTop-pinned.height>2)failures.push(label+': jump-to-bottom failed');
    await wheel(300,8); await wait(200);
    await phase(label+'-idle'); await wait(400);
    const before=await snap(label+'-reading');await wait(700);
    const after=await js('window.scrollAudit.measure()');
    if(before.anchor?.key!==after.anchor?.key||Math.abs(before.anchor?.top-after.anchor?.top)>2)failures.push(label+': idle reading drift');
    // Exercise a genuine scrollbar-thumb drag, not just scrollTop assignment.
    const drag=await js(`(()=>{const r=document.querySelector('[data-scroll-container]'),b=r.getBoundingClientRect();
      return {x:Math.floor(b.right-3),top:Math.ceil(b.top)+18,track:r.clientHeight-36,
        fraction:r.scrollTop/(r.scrollHeight-r.clientHeight),thumb:Math.max(24,(r.clientHeight-36)*r.clientHeight/r.scrollHeight),start:r.scrollTop};})()`);
    const startY=Math.round(drag.top+(drag.track-drag.thumb)*drag.fraction+drag.thumb/2);
    await phase(label+'-thumb-drag');
    win.webContents.sendInputEvent({type:'mouseMove',x:drag.x,y:startY});
    win.webContents.sendInputEvent({type:'mouseDown',x:drag.x,y:startY,button:'left',clickCount:1});
    for(let i=0;i<40;i++) {
      const y=Math.round(drag.top+drag.track*(.1+.8*((i*7%39)/39)));
      win.webContents.sendInputEvent({type:'mouseMove',x:drag.x,y,movementX:0,movementY:0});await wait(20);
    }
    win.webContents.sendInputEvent({type:'mouseUp',x:drag.x,y:Math.round(drag.top+drag.track*.5),button:'left',clickCount:1});
    await wait(450);const end=await snap(label+'-after-drag');
    cases.push({label,before,after,dragStart:drag.start,dragEnd:end.scrollTop});
    if(Math.abs(end.scrollTop-drag.start)<1000)failures.push(label+': scrollbar drag not verified');
    // Content changes while browsing, followed by another traversal.
    await phase(label+'-mutate-and-scroll');
    await js(`window.ax5406Visual.grow('synthetic-497');window.ax5406Visual.image('synthetic-496');window.ax5406Visual.append()`);
    await wheel(240,35);await wheel(-240,35);
  }
  await phase('final-idle');await wait(500);
  const final=await snap('final');
  const audit=await js('window.scrollAudit.running=false;({samples:window.scrollAudit.samples,writes:window.scrollAudit.writes,errors:window.ax5406Stats.errors})');
  const phases={};
  for(const s of audit.samples) {
    const p=phases[s.phase]??={frames:0,blankFrames:0,overlaps:0,maxBlankPixels:0,minMounted:Infinity,maxMounted:0};
    p.frames++;p.blankFrames+=Number(s.blank.length>0);p.overlaps+=Number(s.overlaps>0);
    p.maxBlankPixels=Math.max(p.maxBlankPixels,s.blankPixels);p.minMounted=Math.min(p.minMounted,s.mounted);p.maxMounted=Math.max(p.maxMounted,s.mounted);
  }
  if(audit.errors.length)failures.push('renderer errors');
  for(const [name,p]of Object.entries(phases))if(p.blankFrames||p.overlaps)failures.push(`${name}: ${p.blankFrames} blank / ${p.overlaps} overlapping frame samples`);
  win.webContents.endFrameSubscription();
  fs.writeFileSync(path.join(output,'scroll-audit.json'),JSON.stringify({cases,phases,failures,navigation,final,paintedFrames,...audit},null,2));
  return {cases,phases,failures,samples:audit.samples.length};
};
