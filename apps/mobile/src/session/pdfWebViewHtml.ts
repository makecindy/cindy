import {
  MOBILE_PDF_JS,
  MOBILE_PDF_CSS,
  MOBILE_PDF_BINARY_ASSETS,
} from "./documentPreviewAssets.generated";

const scriptValue = (value: unknown) =>
  JSON.stringify(value).replace(/</g, "\\u003c");

/** All bytes and fonts are local. PDF actions/links never get a navigation or native bridge. */
export function buildPdfWebViewHtml(
  base64: string,
  colors: { surface: string; textPrimary: string },
): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data: blob:; worker-src blob:"><style>${MOBILE_PDF_CSS}
html,body{margin:0;background:${colors.surface};color:${colors.textPrimary}}#pages{padding:12px;box-sizing:border-box;touch-action:pan-x pan-y}.page{position:relative;margin:0 auto 12px;background:white;box-shadow:0 1px 3px #0002}.page canvas{display:block;width:100%;height:100%}.textLayer{position:absolute;inset:0;overflow:clip;line-height:1;opacity:1}.textLayer :is(span,br){color:transparent;position:absolute;white-space:pre;transform-origin:0 0;cursor:text}.textLayer ::selection{background:Highlight;color:transparent}.hit{background:Highlight!important}
</style></head><body><main id="pages"></main><script>${MOBILE_PDF_JS.replace(/<\/script/gi, "<\\/script")}
const send=(value)=>window.ReactNativeWebView?.postMessage(JSON.stringify(value));
const decode=(value)=>Uint8Array.from(atob(value),c=>c.charCodeAt(0));
const assets=${scriptValue(MOBILE_PDF_BINARY_ASSETS)};
class LocalBinaryDataFactory{async fetch({kind,filename}){const value=assets[kind]?.[filename];if(!value)throw new Error('Missing bundled PDF resource');return decode(value);}}
let pdf,task,passwordReply,zoom=1,current=1,generation=0,searchGeneration=0;
const MIN_ZOOM=1,MAX_ZOOM=5,DOUBLE_TAP_ZOOM=2.5;
const pages=document.getElementById('pages'), entries=[],visible=new Set();
function fittedWidth(ratio){return Math.min(Math.max(1,innerWidth-24),Math.max(1,innerHeight-24)/ratio);}
function status(){send({type:'status',page:current,pages:pdf?.numPages||0,zoom});}
async function paint(entry){
 if(entry.rendering||entry.rendered||!pdf)return;
 const epoch=generation;entry.rendering=true;
 try{
  const page=await pdf.getPage(entry.number);if(epoch!==generation)return;
  const natural=page.getViewport({scale:1});entry.ratio=natural.height/natural.width;const scale=fittedWidth(entry.ratio)/natural.width*zoom;
  const viewport=page.getViewport({scale});entry.element.style.width=viewport.width+'px';entry.element.style.height=viewport.height+'px';
  const ratio=Math.min(devicePixelRatio||1,2,Math.sqrt(4000000/(viewport.width*viewport.height)));
  const canvas=document.createElement('canvas');canvas.width=Math.ceil(viewport.width*ratio);canvas.height=Math.ceil(viewport.height*ratio);entry.element.replaceChildren(canvas);
  const render=page.render({canvasContext:canvas.getContext('2d'),viewport,transform:[ratio,0,0,ratio,0,0],background:'rgb(255,255,255)'});entry.task=render;await render.promise;
  if(epoch!==generation||!visible.has(entry))return;
  const layer=document.createElement('div');layer.className='textLayer';layer.style.setProperty('--scale-factor',viewport.scale);layer.style.setProperty('--total-scale-factor',viewport.scale);entry.element.append(layer);
  const text=await page.getTextContent();if(epoch!==generation)return;
  await new pdfjsLib.TextLayer({textContentSource:text,container:layer,viewport}).render();
  entry.rendered=true;
 }catch(error){if(error?.name!=='RenderingCancelledException')send({type:'error'});}
 finally{entry.rendering=false;if(epoch!==generation&&visible.has(entry))paint(entry);}
}
const observer=new IntersectionObserver(changes=>{for(const change of changes){const entry=entries[Number(change.target.dataset.page)-1];if(!entry)continue;if(change.isIntersecting){visible.add(entry);paint(entry);}else{visible.delete(entry);entry.task?.cancel();entry.element.replaceChildren();entry.rendered=false;}}},{rootMargin:'400px 0px'});
function redraw(){generation++;for(const entry of entries){entry.task?.cancel();entry.rendered=false;entry.element.replaceChildren();entry.element.style.width=fittedWidth(entry.ratio)*zoom+'px';entry.element.style.height=fittedWidth(entry.ratio)*zoom*entry.ratio+'px';}for(const entry of visible)paint(entry);status();}
// 手机缩放只靠手势(不放放大 / 缩小 / 适应按钮):WebView 自带的捏合只会把已画好的
// canvas 拉大而发糊,这里接管双指与双击,松手后按新倍率重新绘制,手指下的内容停在原处。
function anchorAt(x,y){const entry=entries.find(item=>item.element.getBoundingClientRect().bottom>=y)||entries[entries.length-1];if(!entry)return null;const r=entry.element.getBoundingClientRect();return {entry,x,y,rx:(x-r.left)/(r.width||1),ry:(y-r.top)/(r.height||1)};}
function zoomTo(next,anchor){next=Math.max(MIN_ZOOM,Math.min(MAX_ZOOM,next));if(Math.abs(next-zoom)<0.01)return;zoom=next;redraw();if(anchor){const r=anchor.entry.element.getBoundingClientRect();scrollBy(r.left+anchor.rx*r.width-anchor.x,r.top+anchor.ry*r.height-anchor.y);}}
let pinch=null,tap=null,lastTap=null;
const spread=(touches)=>Math.hypot(touches[0].clientX-touches[1].clientX,touches[0].clientY-touches[1].clientY);
addEventListener('touchstart',event=>{
 const touches=event.touches;
 if(touches.length===2&&pdf){
  const x=(touches[0].clientX+touches[1].clientX)/2,y=(touches[0].clientY+touches[1].clientY)/2;
  pinch={distance:spread(touches)||1,scale:1,x0:x,y0:y,anchor:anchorAt(x,y)};tap=null;
  pages.style.transformOrigin=(scrollX+x)+'px '+(scrollY+y)+'px';event.preventDefault();
 }else if(touches.length===1)tap={x:touches[0].clientX,y:touches[0].clientY};
},{passive:false});
addEventListener('touchmove',event=>{
 if(pinch&&event.touches.length===2){event.preventDefault();pinch.scale=Math.max(MIN_ZOOM/zoom,Math.min(MAX_ZOOM/zoom,spread(event.touches)/pinch.distance));const mx=(event.touches[0].clientX+event.touches[1].clientX)/2,my=(event.touches[0].clientY+event.touches[1].clientY)/2;pinch.dx=mx-pinch.x0;pinch.dy=my-pinch.y0;pinch.anchor&&(pinch.anchor.x=mx,pinch.anchor.y=my);pages.style.transform='translate('+(mx-pinch.x0)+'px,'+(my-pinch.y0)+'px) scale('+pinch.scale+')';return;}
 const touch=event.touches[0];if(tap&&touch&&Math.hypot(touch.clientX-tap.x,touch.clientY-tap.y)>10)tap=null;
},{passive:false});
addEventListener('touchend',event=>{
 if(pinch){if(event.touches.length<2){const done=pinch;pinch=null;pages.style.transform='';const before=zoom;zoomTo(zoom*done.scale,done.anchor);if(zoom===before&&(done.dx||done.dy))scrollBy(-done.dx,-done.dy);}return;}
 if(!tap||event.touches.length)return;
 const now=Date.now(),point=tap;tap=null;
 if(lastTap&&now-lastTap.at<300&&Math.hypot(point.x-lastTap.x,point.y-lastTap.y)<30){lastTap=null;event.preventDefault();zoomTo(zoom>MIN_ZOOM+0.01?MIN_ZOOM:DOUBLE_TAP_ZOOM,anchorAt(point.x,point.y));}
 else lastTap={...point,at:now};
},{passive:false});
addEventListener('touchcancel',()=>{if(pinch){pinch=null;pages.style.transform='';}tap=null;});
function go(page){current=Math.max(1,Math.min(pdf.numPages,page));entries[current-1]?.element.scrollIntoView();status();}
window.__cindyPdfCommand=async function(command){
 if(command.type==='password'){passwordReply?.(command.value);return;}
 if(!pdf)return;
 if(command.type==='page')go(command.value);
 if(command.type==='zoom')zoomTo(command.value,null);
 if(command.type==='find'){
  const epoch=++searchGeneration,query=String(command.value).toLocaleLowerCase();let matches=0,first=0;
  for(let number=1;number<=pdf.numPages;number++){if(epoch!==searchGeneration)return;const page=await pdf.getPage(number);const text=(await page.getTextContent()).items.map(item=>item.str||'').join(' ');if(query&&text.toLocaleLowerCase().includes(query)){matches++;if(!first)first=number;}}
  if(first)go(first);send({type:'search',matches});
 }
};
let scrollFrame;addEventListener('scroll',()=>{if(scrollFrame)return;scrollFrame=requestAnimationFrame(()=>{scrollFrame=0;const entry=entries.find(entry=>entry.element.getBoundingClientRect().bottom>24);if(entry&&current!==entry.number){current=entry.number;status();}});},{passive:true});
addEventListener('resize',redraw);
task=pdfjsLib.getDocument({data:decode(${scriptValue(base64)}),BinaryDataFactory:LocalBinaryDataFactory,useWorkerFetch:false,isEvalSupported:false,useWasm:false,isImageDecoderSupported:false,enableXfa:false,canvasMaxAreaInBytes:16000000});
task.onPassword=(update,reason)=>{passwordReply=update;send({type:'password',incorrect:reason===2});};
task.promise.then(async document=>{pdf=document;const first=await pdf.getPage(1),view=first.getViewport({scale:1}),ratio=view.height/view.width;for(let number=1;number<=pdf.numPages;number++){const element=documentOwner.createElement('section');element.className='page';element.dataset.page=number;element.style.width=fittedWidth(ratio)+'px';element.style.height=fittedWidth(ratio)*ratio+'px';const entry={number,element,ratio,rendering:false,rendered:false};entries.push(entry);pages.append(element);observer.observe(element);}status();}).catch(()=>send({type:'error'}));
const documentOwner=window.document;
addEventListener('pagehide',()=>{searchGeneration++;generation++;observer.disconnect();task?.destroy();});
</script></body></html>`;
}
