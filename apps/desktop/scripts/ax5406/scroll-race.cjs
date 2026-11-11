// Minimal browser-only diagnostic: no React, virtualizer, or application state.
const fs = require('node:fs');
const path = require('node:path');
module.exports = async (win, output) => {
  const results=[];
  for(const anchoring of ['auto','none']) for(const settle of ['immediate','raf','two-raf']) {
    await win.loadURL('data:text/html,'+encodeURIComponent(`<style>body{margin:0}#root{height:600px;overflow:auto;overflow-anchor:${anchoring}}.row{height:300px}</style><div id="root">${Array.from({length:500},(_,i)=>`<div class="row" id="row-${i}">Row ${i}</div>`).join('')}</div>`));
    const result=await win.webContents.executeJavaScript(`(async()=>{
      const root=document.querySelector('#root'),target=document.querySelector('#row-420');
      const samples=[],events=[];let running=true,settled=false;
      function measure(){samples.push({time:performance.now(),top:root.scrollTop,targetTop:target.getBoundingClientRect().top});if(running)requestAnimationFrame(measure);}measure();
      root.scrollTop=20000;
      await new Promise(r=>setTimeout(r,100));
      root.addEventListener('scrollend',()=>{
        events.push({kind:'scrollend',time:performance.now(),top:root.scrollTop});
        if(settled)return;settled=true;
        const correct=()=>{target.scrollIntoView({block:'center',behavior:'instant'});events.push({kind:'correct',time:performance.now(),top:root.scrollTop});};
        if('${settle}'==='immediate')correct();
        else requestAnimationFrame(()=>{if('${settle}'==='raf')correct();else requestAnimationFrame(correct);});
      });
      const started=performance.now();let interrupted=false;
      root.addEventListener('scroll',()=>{
        if(interrupted||performance.now()-started<330)return;interrupted=true;
        // Match a virtual row's height correction during the native scroll event.
        root.getBoundingClientRect();target.getBoundingClientRect();
        document.querySelector('#row-0').style.height='430px';
        events.push({kind:'interrupt',time:performance.now(),top:root.scrollTop});root.scrollTop+=130;
      });
      target.scrollIntoView({block:'center',behavior:'smooth'});
      await new Promise(r=>setTimeout(r,1500));running=false;
      return {events,samples,drift:target.getBoundingClientRect().top-150};
    })()`);
    results.push({anchoring,settle,...result});
  }
  fs.writeFileSync(path.join(output,'scroll-race.json'),JSON.stringify(results,null,2));
  await win.webContents.executeJavaScript('window.ax5406Stats={mutations:6,errors:[]}');
  return {results:results.map(({samples,...r})=>r),failures:results.filter(r=>Math.abs(r.drift)>1).map(r=>r.anchoring+'/'+r.settle+': drift '+r.drift)};
};
