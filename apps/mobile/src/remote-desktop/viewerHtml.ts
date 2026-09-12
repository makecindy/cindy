import { DESKTOP_TRANSFORM_SCRIPT } from "./geometry";
import {
  DESKTOP_KEY_CODES,
  REMOTE_DESKTOP_ICE_SERVERS,
  REMOTE_DESKTOP_NETWORK,
} from "@cindy/device-link";
import { DESKTOP_RTC_SCRIPT } from "./viewerRtc";
import { DESKTOP_NETWORK_STATS_SCRIPT } from "./networkStats";

export function remoteDesktopViewerHtml(
  surface: string,
  foreground: string,
): string {
  // Only theme token colors enter markup. No device names, SDP, or remote HTML.
  const color = (v: string) =>
    /^#[0-9a-f]{3,8}$/i.test(v) ? v : "transparent";
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; media-src blob:; connect-src 'none'"><style>
  *{box-sizing:border-box}html,body{margin:0;width:100%;height:100%;overflow:hidden;background:${color(surface)};touch-action:none;overscroll-behavior:none}#stage{position:absolute;inset:0;overflow:hidden;z-index:0}video,img{position:absolute;max-width:none;pointer-events:none;transform-origin:0 0}video{display:none;z-index:0}#cursor{position:absolute;z-index:3;width:18px;height:18px;border:2px solid ${color(foreground)};border-radius:50%;pointer-events:none;display:none;transform:translate(-50%,-50%)}
  #cursor-image{position:absolute;inset:0;width:100%;height:100%}
  #stage,#stage *{-webkit-user-select:none;user-select:none;-webkit-touch-callout:none;-webkit-user-drag:none}
  video,img{border:0;outline:0}#image{z-index:1}img:not([src]){visibility:hidden}
  :root{--surface:${color(surface)};--foreground:${color(foreground)}}
  #keyboard-input{position:absolute;left:0;bottom:0;width:1px;height:1px;opacity:.01;font-size:16px;pointer-events:none;border:0;padding:0;resize:none}
  #mouse-buttons{position:absolute;inset:0;pointer-events:none;display:none;color:var(--foreground);opacity:.85}
  #mouse-buttons button,#mouse-wheel{pointer-events:auto;touch-action:none;user-select:none;-webkit-user-select:none;color:inherit;background:color-mix(in srgb,var(--surface) 90%,var(--foreground));border:1px solid color-mix(in srgb,var(--foreground) 18%,transparent)}
  .mouse-button{position:absolute;width:56px;height:56px;border-radius:9999px;padding:14px}
  .mouse-button svg{width:100%;height:100%;pointer-events:none}
  .mouse-button[aria-pressed="true"]{background:var(--foreground)!important;color:var(--surface)!important}
  #mouse-left{left:calc(50% - 96px);bottom:16px}#mouse-right{left:calc(50% + 40px);bottom:16px}
  #mouse-wheel{position:absolute;right:12px;bottom:80px;width:56px;height:120px;padding:12px 0;border-radius:9999px;display:flex;flex-direction:column;align-items:center;justify-content:space-between;font-size:20px}
  #mouse-wheel:active{background:var(--foreground);color:var(--surface)}
  #mouse-wheel>*{pointer-events:none}
  #mouse-wheel-grip{width:20px;height:34px}
  @media(max-height:400px){#mouse-wheel{bottom:12px}}
  </style></head><body><div id="stage"><img id="image" alt=""><video id="video" autoplay muted playsinline></video><div id="cursor"><img id="cursor-image" alt=""></div></div>
  <div id="mouse-buttons">
    ${(["left", "right"] as const).map((button) => `<button type="button" id="mouse-${button}" class="mouse-button" aria-pressed="false"><svg viewBox="0 0 24 32" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="2" width="18" height="28" rx="9"/><path d="M12 2v12M3 14h18"/><path d="${button === "left" ? "M11 3C6 3 4 6 4 10v3h7Z" : "M13 3c5 0 7 3 7 7v3h-7Z"}" fill="currentColor" stroke="none"/></svg></button>`).join("")}
    <button type="button" id="mouse-wheel"><span aria-hidden="true">▴</span><svg id="mouse-wheel-grip" viewBox="0 0 20 34" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="1" y="1" width="18" height="32" rx="8"/><path d="M3 10h14M2 17h16M3 24h14"/></svg><span aria-hidden="true">▾</span></button>
  </div><textarea id="keyboard-input" autocapitalize="off" autocomplete="off" autocorrect="off" spellcheck="false" aria-label="Keyboard"></textarea><script>
  const transform=${DESKTOP_TRANSFORM_SCRIPT};
  const networkStats=${DESKTOP_NETWORK_STATS_SCRIPT};
  const net=${JSON.stringify(REMOTE_DESKTOP_NETWORK)},iceServers=${JSON.stringify(REMOTE_DESKTOP_ICE_SERVERS)};
  const validKeys=new Set(${JSON.stringify(DESKTOP_KEY_CODES)});
  ${VIEWER_SCRIPT}
  </script></body></html>`;
}

const VIEWER_SCRIPT = String.raw`
(() => {
  const stage=document.getElementById('stage'), image=document.getElementById('image'), video=document.getElementById('video'), cursor=document.getElementById('cursor');
  let dw=1920,dh=1080,zoom=1,fx=.5,fy=.5,mode='pointer',control=false,pc=null,dc=null,seq=0,generation=0,epoch=null,gestureFrame=null;
  let remoteCursor=null,lastLocalMove=0,localCursorAwake=false;
  let touchCursor=null,touchCursorTimer=null,touchCursorVisible=false;
  const reducedMotion=matchMedia("(prefers-reduced-motion: reduce)");
  const cursorImage=document.getElementById('cursor-image');
  let pending=[],sending=false,cx=.5,cy=.5,drag=false,start=null,last=null,multi=null,hold=null,moved=false;
  const pointers=new Map();
  const mouseButtons=document.getElementById('mouse-buttons'), wheel=document.getElementById('mouse-wheel'), wheelGrip=document.getElementById('mouse-wheel-grip');
  const keyboardInput=document.getElementById('keyboard-input');
  let keyboardEnabled=false,composing=false;
  const keyboardSentinel='\u200b';
  function resetKeyboard(){keyboardInput.value=keyboardSentinel;keyboardInput.setSelectionRange(1,1);}
  function showKeyboard(enabled){
    keyboardEnabled=enabled&&control;
    if(!keyboardEnabled){composing=false;resetKeyboard();keyboardInput.blur();return;}
    if(composing)return;
    // Keep focus inside the native evaluateJavaScript call; WebKit can reject
    // keyboard presentation after requestAnimationFrame loses user activation.
    keyboardInput.blur();resetKeyboard();keyboardInput.focus({preventScroll:true});
  }
  function keyboardKey(code){if(!keyboardEnabled||!control)return;queue({kind:'key',code,down:true});queue({kind:'key',code,down:false});flush();}
  function commitKeyboard(){if(!keyboardEnabled||!control||composing)return;const text=keyboardInput.value.replace(keyboardSentinel,'');if(text){for(let i=0;i<text.length;i+=4096)queue({kind:'text',text:text.slice(i,i+4096)});flush();}resetKeyboard();}
  keyboardInput.addEventListener('compositionstart',()=>{composing=true;});
  keyboardInput.addEventListener('compositionend',()=>{composing=false;commitKeyboard();});
  keyboardInput.addEventListener('input',e=>{if(!e.isComposing)commitKeyboard();});
  keyboardInput.addEventListener('beforeinput',e=>{
    if(composing||e.isComposing)return;
    if(e.inputType==='deleteContentBackward'){e.preventDefault();keyboardKey('Backspace');resetKeyboard();}
    else if(e.inputType==='insertLineBreak'||e.inputType==='insertParagraph'){e.preventDefault();keyboardKey('Enter');resetKeyboard();}
  });
  const heldMouse=new Map();
  let showMouseButtons=false,wheelY=null;
  function resetWheel(){wheelY=null;wheelGrip.style.transform='translateY(0px)';}
  let statsTimer=null,statsSample=null;
  const post=(message)=>window.ReactNativeWebView.postMessage(JSON.stringify({...message,epoch}));
  const clamp=(v)=>Math.max(0,Math.min(1,v));
  let fillHeight=false;
  let panAnimation=null,viewportRightInset=0,viewportLeftInset=0,viewportBottomInset=0,keyboardViewportInset=0;
  let cursorNeedsEntry=true,manualViewMoved=false,followRest=null;
  // Insets guide centering and pan limits without clipping the full-screen
  // video surface or adding an opaque strip beside the Dynamic Island.
  const viewportLeft=()=>fillHeight?viewportLeftInset:0;
  const viewportWidth=()=>Math.max(1,stage.clientWidth-viewportLeft()-(fillHeight?viewportRightInset:0));
  const layout=()=>{const r=transform(viewportWidth(),stage.clientHeight,dw,dh,zoom,fx,fy,fillHeight);
    return {...r,x:(viewportLeft()+viewportWidth()/2)-fx*r.width,y:stage.clientHeight/2-fy*r.height};};
  function panBounds(r){const vw=viewportWidth(),vh=stage.clientHeight;
    // Grow extra resting travel continuously from zero at fit to 180 screen
    // points at maximum zoom. Never count the unused space of a fitting axis.
    const clearance=180*(Math.max(1,Math.min(5,zoom))-1)/4;
    const axis=(viewport,content)=>content<=viewport
      ? {min:(viewport-content)/2-clearance,max:(viewport-content)/2+clearance}
      : {min:viewport-content-clearance,max:clearance};
    const x=axis(vw,r.width),y=axis(vh,r.height);
    const bounds={minX:viewportLeft()+x.min,maxX:viewportLeft()+x.max,minY:y.min,maxY:y.max};
    // A camera position required to expose the cursor is a valid resting point,
    // not elastic overshoot. Preserve it across the next pan/pinch handoff.
    if(followRest){const restX=viewportLeft()+vw/2-followRest.fx*r.width,restY=vh/2-followRest.fy*r.height;
      const weight=followRest.zoom>1?clamp((zoom-1)/(followRest.zoom-1)):1;
      bounds.minX+=Math.min(0,restX-bounds.minX)*weight;bounds.maxX+=Math.max(0,restX-bounds.maxX)*weight;
      bounds.minY+=Math.min(0,restY-bounds.minY)*weight;bounds.maxY+=Math.max(0,restY-bounds.maxY)*weight;}
    return bounds;}
  const bounded=(v,min,max)=>Math.max(min,Math.min(max,v));
  // Convert displayed overshoot back to finger travel before the next delta,
  // so reversing direction unwinds smoothly without an edge jump.
  function rubber(v,min,max,inverse=false){const edge=bounded(v,min,max),d=v-edge;
    const reach=40+10*(Math.max(1,Math.min(5,zoom))-1);
    return edge+Math.sign(d)*(inverse?reach*Math.abs(d)/Math.max(1,reach-Math.abs(d)):reach*Math.abs(d)/(reach+Math.abs(d)));}
  function place(x,y,r){fx=((viewportLeft()+viewportWidth()/2)-x)/r.width;fy=(stage.clientHeight/2-y)/r.height;}
  function cursorViewport(){
    const hotX=remoteCursor?.hotX??9,hotY=remoteCursor?.hotY??9;
    const w=remoteCursor?.width??18,h=remoteCursor?.height??18;
    const left=viewportLeft(),right=left+viewportWidth(),bottom=Math.max(1,stage.clientHeight-viewportBottomInset);
    // Keep the entire cursor, including its hotspot offset, clear of chrome.
    const minX=Math.min(right-1,left+8+hotX),minY=Math.min(bottom-1,8+hotY);
    return {minX,maxX:Math.max(minX,right-8-(w-hotX)),minY,maxY:Math.max(minY,bottom-8-(h-hotY))};
  }
  function moveTouchpad(dx,dy){
    stopPanAnimation();const r=layout(),v=cursorViewport();
    if(cursorNeedsEntry){
      // Re-enter at the nearest visible edge; do not pull a manually positioned
      // desktop back to the old off-screen cursor before applying this movement.
      cx=clamp((bounded(r.x+cx*r.width,v.minX,v.maxX)-r.x)/r.width);
      cy=clamp((bounded(r.y+cy*r.height,v.minY,v.maxY)-r.y)/r.height);
      cursorNeedsEntry=false;
    }
    cx=clamp(cx+dx/r.width);cy=clamp(cy+dy/r.height);
    const x=r.x+cx*r.width,y=r.y+cy*r.height;
    if(zoom>1||r.width>viewportWidth()||r.height>stage.clientHeight-viewportBottomInset){
      place(r.x+bounded(x,v.minX,v.maxX)-x,r.y+bounded(y,v.minY,v.maxY)-y,r);
      followRest={fx,fy,zoom};
    }
    manualViewMoved=false;
  }
  function stopPanAnimation(){if(panAnimation!==null)cancelAnimationFrame(panAnimation);panAnimation=null;}
  function settlePan(){stopPanAnimation();
    const r=layout(),b=panBounds(r),x=bounded(r.x,b.minX,b.maxX),y=bounded(r.y,b.minY,b.maxY);
    if(x===r.x&&y===r.y)return;
    if(reducedMotion.matches){place(x,y,r);render();return;}
    const started=performance.now();
    const tick=now=>{const t=Math.min(1,(now-started)/280),ease=1-Math.pow(1-t,3);
      place(r.x+(x-r.x)*ease,r.y+(y-r.y)*ease,r);render();
      panAnimation=t<1?requestAnimationFrame(tick):null;};panAnimation=requestAnimationFrame(tick);
  }
  function render(){const r=layout();
    const touchFeedback=control&&mode==='touch'&&touchCursorVisible;
    const cursorX=mode==='touch'&&touchCursor?touchCursor.x:cx;
    const cursorY=mode==='touch'&&touchCursor?touchCursor.y:cy;
    cursor.style.transition=mode==='touch'&&!touchFeedback&&!reducedMotion.matches?'opacity 120ms ease-out':'none';for(const el of [image,video]){el.style.width=r.width+'px';el.style.height=r.height+'px';el.style.left=r.x+'px';el.style.top=r.y+'px';}if(remoteCursor){
      cursor.style.width=remoteCursor.width+'px';cursor.style.height=remoteCursor.height+'px';
      cursor.style.border='0';cursor.style.borderRadius='0';cursor.style.transform='none';
      cursor.style.left=(r.x+cursorX*r.width-remoteCursor.hotX)+'px';cursor.style.top=(r.y+cursorY*r.height-remoteCursor.hotY)+'px';
      cursor.style.display='block';
      cursor.style.opacity=(mode==='touch'?touchFeedback:(remoteCursor.visible||(control&&mode==='pointer'&&localCursorAwake)))?'1':'0';
    }else{
      cursor.style.opacity=(mode==='touch'?!touchFeedback:false)?'0':'1';cursor.style.width='18px';cursor.style.height='18px';cursor.style.border='2px solid var(--foreground)';
      cursor.style.borderRadius='50%';cursor.style.transform='translate(-50%,-50%)';
      cursor.style.left=(r.x+cursorX*r.width)+'px';cursor.style.top=(r.y+cursorY*r.height)+'px';
      cursor.style.display=control&&(mode==='pointer'||mode==='touch')?'block':'none';
    }}
  // Literal source is required: Hermes function.toString() yields bytecode.
  function validCursor(v){
    return !!v && typeof v==='object' && typeof v.visible==='boolean' &&
      [v.x,v.y,v.width,v.height,v.hotX,v.hotY].every(Number.isFinite) &&
      v.x>=0&&v.x<=1&&v.y>=0&&v.y<=1&&v.width>0&&v.width<=256&&v.height>0&&v.height<=256&&
      v.hotX>=0&&v.hotX<=v.width&&v.hotY>=0&&v.hotY<=v.height&&
      typeof v.png==='string'&&v.png.length<=65536&&/^iVBORw0KGgo[A-Za-z0-9+/]*={0,2}$/.test(v.png);
  }
  function receiveCursor(value){
    if(value===null){if(remoteCursor){remoteCursor={...remoteCursor,visible:false};render();}return;}
    if(!validCursor(value))return;
    if(!remoteCursor||remoteCursor.png!==value.png)cursorImage.src='data:image/png;base64,'+value.png;
    // Keep delayed host coordinates from pulling the local touchpad backwards.
    if(!remoteCursor||!control||mode!=='pointer'||(!pointers.size&&performance.now()-lastLocalMove>200)){
      cx=value.x;cy=value.y;
    }
    if(value.visible)localCursorAwake=false;
    remoteCursor=value;render();
  }
  function resetCursor(){clearTimeout(touchCursorTimer);touchCursorVisible=false;touchCursor=null;localCursorAwake=false;remoteCursor=null;cursorImage.removeAttribute('src');render();}
  function queue(event){if(!control)return;
    // Remote visibility can remain hidden after synthetic mouse movement. Wake
    // the local touchpad cursor until the host reports a visible cursor again.
    if(event.kind==='move'&&mode==='pointer')localCursorAwake=true;
    if(event.kind==='key'||event.kind==='text'){localCursorAwake=false;render();}
    if(event.kind==='move'||event.kind==='button')lastLocalMove=performance.now();const tail=pending[pending.length-1];
    if(event.kind==='move'&&tail?.kind==='move')pending[pending.length-1]=event;
    // Coalesce only adjacent scrolls, preserving button/key ordering. Bound the
    // accumulated distance so a delayed ACK cannot replay a large scroll backlog.
    else if(event.kind==='scroll'&&tail?.kind==='scroll'){tail.dx=Math.max(-2000,Math.min(2000,tail.dx+event.dx));tail.dy=Math.max(-2000,Math.min(2000,tail.dy+event.dy));}
    else pending.push(event);
    if(pending.length>64){pending=[{kind:'release'}];control=false;post({type:'inputOverflow'});}}
  function flush(){if(!pending.length||sending)return;const events=pending.splice(0,64),sequence=++seq;if(pc?.connectionState==='connected'&&dc&&dc.readyState==='open'&&dc.bufferedAmount<16384){dc.send(JSON.stringify({sequence,events}));}else{sending=true;post({type:'input',sequence,events});}}
  setInterval(()=>{
    // Hold displacement controls speed, even without further pointer moves.
    // Skip missed ticks while awaiting ACK instead of building a scroll backlog.
    if(wheelY?.moved&&!sending){const offset=Math.max(-24,Math.min(24,wheelY.y-wheelY.start));if(Math.abs(offset)>4)scrollMouse(Math.sign(offset)*(Math.abs(offset)-4)*1.5);}
    flush();
  },33);
  function release(){clearTimeout(hold);if(gestureFrame!==null)cancelAnimationFrame(gestureFrame);gestureFrame=null;if(control){queue({kind:'release'});flush();}heldMouse.clear();resetWheel();updateMouseButtons();drag=false;pointers.clear();start=null;last=null;multi=null;}
  function updateMouseButtons(){mouseButtons.style.display=showMouseButtons&&control?'block':'none';for(const [name,button] of [['left',0],['right',2]])document.getElementById('mouse-'+name).setAttribute('aria-pressed',String(heldMouse.has(button)));}
  for(const [name,button] of [['left',0],['right',2]]){
    const el=document.getElementById('mouse-'+name);
    el.addEventListener('pointerdown',e=>{e.preventDefault();if(!control||!showMouseButtons||heldMouse.has(button))return;clearTimeout(hold);el.setPointerCapture(e.pointerId);heldMouse.set(button,e.pointerId);queue({kind:'button',button,down:true,x:cx,y:cy});flush();updateMouseButtons();});
    const up=e=>{e.preventDefault();if(heldMouse.get(button)!==e.pointerId)return;heldMouse.delete(button);queue({kind:'button',button,down:false,x:cx,y:cy});flush();updateMouseButtons();};
    el.addEventListener('pointerup',up);el.addEventListener('pointercancel',up);el.addEventListener('lostpointercapture',up);
    el.addEventListener('click',e=>{if(e.detail===0&&control&&showMouseButtons){click(button);flush();}});
  }
  const scrollMouse=dy=>{if(control&&showMouseButtons&&Number.isFinite(dy)){queue({kind:'scroll',dx:0,dy:Math.max(-2000,Math.min(2000,dy))});}};
  wheel.addEventListener('pointerdown',e=>{e.preventDefault();if(!control||!showMouseButtons||wheelY)return;wheel.setPointerCapture(e.pointerId);wheelY={id:e.pointerId,y:e.clientY,start:e.clientY,moved:false};});
  // A small dead zone preserves middle clicks; displacement drives the timer.
  wheel.addEventListener('pointermove',e=>{if(!wheelY||wheelY.id!==e.pointerId)return;e.preventDefault();wheelGrip.style.transform='translateY('+Math.max(-24,Math.min(24,e.clientY-wheelY.start))+'px)';wheelY.y=e.clientY;if(Math.abs(e.clientY-wheelY.start)>4)wheelY.moved=true;});
  wheel.addEventListener('pointerup',e=>{if(!wheelY||wheelY.id!==e.pointerId)return;e.preventDefault();if(!wheelY.moved&&control&&showMouseButtons){click(1);flush();}resetWheel();});
  const cancelWheel=e=>{if(wheelY?.id===e.pointerId)resetWheel();};
  wheel.addEventListener('pointercancel',cancelWheel);wheel.addEventListener('lostpointercapture',cancelWheel);
  wheel.addEventListener('click',e=>{if(e.detail===0&&control&&showMouseButtons){click(1);flush();}});
  wheel.addEventListener('keydown',e=>{if(e.key==='ArrowUp'||e.key==='ArrowDown'){e.preventDefault();scrollMouse(e.key==='ArrowUp'?-120:120);}});
  function insideDesktop(p){const r=layout();return p.x>=r.x&&p.x<=r.x+r.width&&p.y>=r.y&&p.y<=r.y+r.height;}
  function point(p){const r=layout();return{x:clamp((p.x-r.x)/r.width),y:clamp((p.y-r.y)/r.height)};}
  function click(button=0){if(control&&mode==='touch'){clearTimeout(touchCursorTimer);touchCursor={x:cx,y:cy};touchCursorVisible=true;render();touchCursorTimer=setTimeout(()=>{touchCursorVisible=false;render();},450);}queue({kind:'button',button,down:true,x:cx,y:cy});queue({kind:'button',button,down:false,x:cx,y:cy});}
  function pan(dx,dy){manualViewMoved=true;cursorNeedsEntry=true;stopPanAnimation();const r=layout(),b=panBounds(r);place(rubber(rubber(r.x,b.minX,b.maxX,true)+dx,b.minX,b.maxX),rubber(rubber(r.y,b.minY,b.maxY,true)+dy,b.minY,b.maxY),r);render();}
  function pair(){const [a,b]=[...pointers.values()];return{x:(a.x+b.x)/2,y:(a.y+b.y)/2,d:Math.hypot(a.x-b.x,a.y-b.y)};}
  function movePair(){gestureFrame=null;if(pointers.size<2||!multi)return;const next=pair(),span=Math.abs(next.d-multi.d),travel=Math.hypot(next.x-multi.x,next.y-multi.y);
    if(multi.kind!=='pinch'){
      const pinchSlop=Math.max(6,Math.min(12,multi.d*.04));
      if(span>=pinchSlop&&span>travel*.65){
        // A parallel scroll may deliver its two pointer updates in different
        // frames. Confirm separation briefly before taking over as a pinch.
        if(!multi.candidate)multi.candidate={at:Date.now(),d:next.d,zoom,anchor:point(next)};
        if(Date.now()-multi.candidate.at>=40){
          if(multi.kind==='scroll'){multi.d=multi.candidate.d;multi.zoom=multi.candidate.zoom;multi.anchor=multi.candidate.anchor;}
          multi.kind='pinch';multi.candidate=null;
        }else{gestureFrame=requestAnimationFrame(movePair);return;}
      }else{multi.candidate=null;if(!multi.kind&&travel>8&&travel>span)multi.kind='scroll';}
    }
    if(multi.kind==='pinch'){manualViewMoved=true;cursorNeedsEntry=true;zoom=Math.max(1,Math.min(5,multi.zoom*next.d/Math.max(1,multi.d)));const r=layout();fx=multi.anchor.x+((viewportLeft()+viewportWidth()/2)-next.x)/r.width;fy=multi.anchor.y+(stage.clientHeight/2-next.y)/r.height;const moved=layout(),b=panBounds(moved);place(rubber(moved.x,b.minX,b.maxX),rubber(moved.y,b.minY,b.maxY),moved);}
    else if(multi.kind==='scroll'){const dx=next.x-multi.lastX,dy=next.y-multi.lastY;if(control&&mode!=='pan')queue({kind:'scroll',dx:Math.max(-2000,Math.min(2000,-dx)),dy:Math.max(-2000,Math.min(2000,-dy))});else pan(dx,dy);}
    if(multi.kind){multi.lastX=next.x;multi.lastY=next.y;}render();
  }
  stage.addEventListener('pointerdown',e=>{
    e.preventDefault();stopPanAnimation();stage.setPointerCapture(e.pointerId);pointers.set(e.pointerId,{x:e.clientX,y:e.clientY});
    if(pointers.size===1){cursorNeedsEntry=true;start={x:e.clientX,y:e.clientY};last=start;moved=false;
      hold=setTimeout(()=>{if(control&&mode!=='pan'&&!moved&&pointers.size===1&&!heldMouse.size&&(mode!=='touch'||insideDesktop(start))){if(mode==='touch'){const p=point(start);cx=p.x;cy=p.y;}queue({kind:'button',button:0,down:true,x:cx,y:cy});drag=true;}},400);
    }else {clearTimeout(hold);if(drag)queue({kind:'release'});drag=false;start=null;const p=pair();multi={...p,lastX:p.x,lastY:p.y,zoom,anchor:point(p),kind:null};}
  });
  stage.addEventListener('pointermove',e=>{
    if(!pointers.has(e.pointerId))return;e.preventDefault();pointers.set(e.pointerId,{x:e.clientX,y:e.clientY});
    if(pointers.size>=2){if(gestureFrame===null)gestureFrame=requestAnimationFrame(movePair);return;}
    if(!start||!last)return;const now={x:e.clientX,y:e.clientY},dx=now.x-last.x,dy=now.y-last.y;last=now;
    if(Math.hypot(now.x-start.x,now.y-start.y)>6){moved=true;clearTimeout(hold);}
    if(!control||mode==='pan'||(mode==='touch'&&!drag&&!heldMouse.size)){pan(dx,dy);return;}
    if(mode==='pointer'){moveTouchpad(dx,dy);}else{const p=point(now);cx=p.x;cy=p.y;}
    queue({kind:'move',x:cx,y:cy});render();
  });
  function up(e){if(!pointers.has(e.pointerId))return;clearTimeout(hold);
    if(pointers.size>=2&&multi){
      pointers.set(e.pointerId,{x:e.clientX,y:e.clientY});
      if(gestureFrame!==null)cancelAnimationFrame(gestureFrame);
      movePair();
      if(gestureFrame!==null)cancelAnimationFrame(gestureFrame);gestureFrame=null;
    }
    pointers.delete(e.pointerId);
    if(drag){queue({kind:'button',button:0,down:false,x:cx,y:cy});drag=false;}
    else if(start&&!moved&&control&&mode!=='pan'&&!heldMouse.size&&e.type==='pointerup'&&(mode!=='touch'||insideDesktop({x:e.clientX,y:e.clientY}))){if(mode==='touch'){const p=point({x:e.clientX,y:e.clientY});cx=p.x;cy=p.y;}click();}
    start=null;last=null;multi=null;render();if(!pointers.size&&manualViewMoved)settlePan();
  }
  stage.addEventListener('pointerup',up);stage.addEventListener('pointercancel',()=>{release();settlePan();});
  document.addEventListener('contextmenu',e=>e.preventDefault());
  // Scope selection suppression to the desktop surface, preserving the hidden
  // textarea's native keyboard/IME editing and programmatic selection.
  stage.addEventListener('selectstart',e=>e.preventDefault());
  stage.addEventListener('dragstart',e=>e.preventDefault());
  const normalizedKey=code=>/^(Shift|Control|Alt|Meta)Right$/.test(code)?code.replace(/Right$/,'Left'):code;
  document.addEventListener('keydown',e=>{if(control&&validKeys.has(normalizedKey(e.code))){e.preventDefault();queue({kind:'key',code:normalizedKey(e.code),down:true});}});
  document.addEventListener('keyup',e=>{if(control&&validKeys.has(normalizedKey(e.code))){e.preventDefault();queue({kind:'key',code:normalizedKey(e.code),down:false});}});
  window.addEventListener('blur',()=>{release();settlePan();});new ResizeObserver(()=>{release();settlePan();render();}).observe(stage);
  // Keep one bounded frame in this document only; never persist desktop pixels.
  // Snapshot before detaching the track. A JPEG fallback already lives in image.
  function retainFrame(){
    if(!videoPresented||video.style.display!=='block'||video.readyState<2||!video.videoWidth||!video.videoHeight)return;
    const canvas=document.createElement('canvas');
    try{const scale=Math.min(1,1280/Math.max(video.videoWidth,video.videoHeight));canvas.width=Math.max(1,Math.round(video.videoWidth*scale));canvas.height=Math.max(1,Math.round(video.videoHeight*scale));const context=canvas.getContext('2d');if(context){context.drawImage(video,0,0,canvas.width,canvas.height);image.src=canvas.toDataURL('image/jpeg',.7);}}catch{/* Keep the previous compatibility frame if WebKit cannot read video. */}finally{canvas.width=0;canvas.height=0;}
  }
  ${DESKTOP_RTC_SCRIPT}
  function reportPresentation(){post({type:'presentation',active:video.webkitPresentationMode==='picture-in-picture'||document.pictureInPictureElement===video});}
  video.addEventListener('webkitpresentationmodechanged',reportPresentation);
  video.addEventListener('enterpictureinpicture',reportPresentation);
  video.addEventListener('leavepictureinpicture',reportPresentation);
  function receive(event){let message;try{message=JSON.parse(event.data);}catch{return;}
    switch(message.type){
      case 'presentation':
        try {
          if(message.enabled){
            release();showKeyboard(false);
            if(video.webkitSupportsPresentationMode?.('picture-in-picture'))video.webkitSetPresentationMode('picture-in-picture');
            else if(video.requestPictureInPicture)video.requestPictureInPicture().catch(()=>post({type:'presentationFailed'}));
            else post({type:'presentationFailed'});
          }else if(video.webkitSetPresentationMode)video.webkitSetPresentationMode('inline');
          else if(document.pictureInPictureElement)document.exitPictureInPicture().catch(()=>{});
        }catch{post({type:'presentationFailed'});}break;
      case 'videoSettings':video.muted=!message.audio;retries=0;connect();break;
      case 'keyboard':showKeyboard(message.enabled===true);break;
      case 'resume':if(video.srcObject)video.play().catch(()=>{});break;
      case 'releaseInput':release();break;
      case 'theme':if(/^#[0-9a-f]{3,8}$/i.test(message.surface)){document.body.style.background=message.surface;document.documentElement.style.background=message.surface;document.documentElement.style.setProperty('--surface',message.surface);}if(/^#[0-9a-f]{3,8}$/i.test(message.foreground)){cursor.style.borderColor=message.foreground;document.documentElement.style.setProperty('--foreground',message.foreground);}break;
      case 'mouseButtons':{
        const before=layout(),keepHorizontal=fillHeight&&(message.keyboardOpen===true||keyboardViewportInset>0);
        let sideInsetsChanged=false;
        if(Number.isFinite(message.bottomInset))viewportBottomInset=Math.max(0,Math.min(stage.clientHeight-1,message.bottomInset));
        if(Number.isFinite(message.leftInset)){const inset=Math.max(0,Math.min(stage.clientWidth-1,message.leftInset));sideInsetsChanged=sideInsetsChanged||inset!==viewportLeftInset;viewportLeftInset=inset;}
        if(Number.isFinite(message.rightInset)){const inset=Math.max(0,Math.min(stage.clientWidth-1,message.rightInset));sideInsetsChanged=sideInsetsChanged||inset!==viewportRightInset;viewportRightInset=inset;}
        // Hiding the side toolbar changes the viewport center. Keep the image's
        // actual horizontal position instead of following that center sideways.
        if(keepHorizontal){const r=layout();place(before.x,r.y,r);}
        const keyboardInset=fillHeight&&message.keyboardOpen===true?viewportBottomInset:0;
        if(keyboardInset!==keyboardViewportInset){
          const wasOpen=keyboardViewportInset>0;keyboardViewportInset=keyboardInset;
          if(fillHeight&&(keyboardInset>0||wasOpen)){
            stopPanAnimation();const r=layout(),v=cursorViewport(),x=r.x+cx*r.width;
            // Center vertically; move sideways only enough to expose the cursor.
            place(r.x+bounded(x,v.minX,v.maxX)-x,(v.minY+v.maxY)/2-cy*r.height,r);
            cursorNeedsEntry=false;manualViewMoved=false;
          }
        }
        if(keepHorizontal){followRest={fx,fy,zoom};render();}
        else if(sideInsetsChanged){settlePan();render();}
        if(!message.enabled){for(const button of heldMouse.keys())queue({kind:'button',button,down:false,x:cx,y:cy});heldMouse.clear();resetWheel();flush();}for(const [edge,value] of [['bottom',message.bottomInset],['right',message.rightInset]])if(Number.isFinite(value)&&value>=0&&value<=4096)mouseButtons.style[edge]=value+'px';showMouseButtons=message.enabled===true;for(const name of ['left','right','wheel'])if(typeof message.labels?.[name]==='string')document.getElementById('mouse-'+name).setAttribute('aria-label',message.labels[name]);updateMouseButtons();break;
      }
      case 'init':followRest=null;cursorNeedsEntry=true;stopPanAnimation();resetCursor();control=false;release();pending=[];sending=false;seq=0;epoch=message.epoch;dw=message.width;dh=message.height;fillHeight=message.fillHeight===true;video.muted=!message.audio;trickleIce=message.trickleIce===true;retries=0;render();connect();break;
      case 'viewport':fillHeight=message.fillHeight===true;release();render();break;
      case 'answer':if(message.epoch===epoch)void receiveAnswer(message);break;
      case 'iceConfig':if(message.epoch===epoch)void receiveIceConfig(message);break;
      case 'ice':if(message.epoch===epoch)void receiveIce(message);break;
      case 'fallback':if(message.epoch===epoch&&message.attemptId===attemptId)failRtc('host',message.retry!==false);break;
      case 'frame':{if('cursor' in message)receiveCursor(message.cursor);else resetCursor();const frameEpoch=epoch;image.onload=()=>{if(epoch===frameEpoch)post({type:'framePresented'});};image.src='data:image/jpeg;base64,'+message.jpeg;break;}
      case 'control':release();control=message.enabled;if(!control)showKeyboard(false);pending=[];updateMouseButtons();render();break;
      case 'mode':release();if(message.mode!=='pointer')followRest=null;settlePan();clearTimeout(touchCursorTimer);touchCursorVisible=false;mode=message.mode;render();break;
      case 'fit':followRest=null;cursorNeedsEntry=true;manualViewMoved=false;stopPanAnimation();zoom=1;fx=.5;fy=.5;render();break;
      case 'rightClick':click(2);break;
      case 'events':for(const e of message.events)queue(e);flush();break;
      case 'ack':if(message.epoch===epoch&&message.sequence===seq)sending=false;break;
      case 'stop':showKeyboard(false);control=false;release();pending=[];sending=false;epoch=null;closeRtc(message.preserveFrame===true);updateMouseButtons();render();break;
    }
  }
  window.addEventListener('message',receive);document.addEventListener('message',receive);render();post({type:'ready'});
})();`;
