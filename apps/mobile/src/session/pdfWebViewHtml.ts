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
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=5"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data: blob:; worker-src blob:"><style>${MOBILE_PDF_CSS}
html,body{margin:0;background:${colors.surface};color:${colors.textPrimary}}#pages{padding:12px;box-sizing:border-box}.page{position:relative;margin:0 auto 12px;background:white;box-shadow:0 1px 3px #0002}.page canvas{display:block;width:100%;height:100%}.textLayer{position:absolute;inset:0;overflow:clip;line-height:1;opacity:1}.textLayer :is(span,br){color:transparent;position:absolute;white-space:pre;transform-origin:0 0;cursor:text}.textLayer ::selection{background:Highlight;color:transparent}.hit{background:Highlight!important}
</style></head><body><main id="pages"></main><script>${MOBILE_PDF_JS.replace(/<\/script/gi, "<\\/script")}
const send=(value)=>window.ReactNativeWebView?.postMessage(JSON.stringify(value));
const decode=(value)=>Uint8Array.from(atob(value),c=>c.charCodeAt(0));
const assets=${scriptValue(MOBILE_PDF_BINARY_ASSETS)};
class LocalBinaryDataFactory{async fetch({kind,filename}){const value=assets[kind]?.[filename];if(!value)throw new Error('Missing bundled PDF resource');return decode(value);}}
let pdf,task,passwordReply,zoom=1,current=1,generation=0,searchGeneration=0;
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
function go(page){current=Math.max(1,Math.min(pdf.numPages,page));entries[current-1]?.element.scrollIntoView();status();}
window.__cindyPdfCommand=async function(command){
 if(command.type==='password'){passwordReply?.(command.value);return;}
 if(!pdf)return;
 if(command.type==='page')go(command.value);
 if(command.type==='zoom'){zoom=Math.max(0.25,Math.min(4,command.value));redraw();}
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
