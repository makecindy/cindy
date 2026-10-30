/** This document owns the App transport. The top Renderer only observes UI state. */
export function mcpAppDirectSandboxDocument(resourceUrl: string, bridgeUrl: string): string {
  const encode = (value: string) => JSON.stringify(value).replace(/</g, '\\u003c');
  return `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;width:100%;height:100%;overflow:hidden}</style></head><body><script>
const frame=document.createElement('iframe');
frame.setAttribute('sandbox','allow-scripts allow-same-origin');
frame.setAttribute('allow',"camera 'none'; microphone 'none'; geolocation 'none'; clipboard-write 'none'");
frame.style.cssText='border:0;width:100%;height:100%;display:block';
let after=0,stopped=false;
const state=(message,fromHost=false)=>{
 // App notifications cannot assert Host-owned context such as display mode.
 if(['ui/notifications/initialized','ui/notifications/size-changed','ui/notifications/sandbox-escape'].includes(message.method)||(fromHost&&message.method==='ui/notifications/host-context-changed'))
  window.parent.postMessage(message,'*');
};
const fail=()=>{if(stopped)return;stopped=true;window.parent.postMessage({jsonrpc:'2.0',method:'ui/notifications/sandbox-failed'},'*');};
async function invoke(input){
 const response=await fetch(${encode(bridgeUrl)},{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input)});
 if(!response.ok)throw new Error('MCP_APP_VIEW_UNAVAILABLE');
 return response.json();
}
window.addEventListener('message',event=>{
 if(stopped||event.source!==frame.contentWindow)return;
 const message=event.data;
 if(!message||message.jsonrpc!=='2.0'||typeof message.method==='string'&&message.method.startsWith('ui/notifications/sandbox-'))return;
 state(message);
 void invoke({op:'message',message}).catch(fail);
});
window.addEventListener('keydown',event=>{
 if(event.key==='Escape'&&!event.isComposing&&!event.repeat&&!event.ctrlKey&&!event.altKey&&!event.metaKey&&!event.shiftKey)
  state({jsonrpc:'2.0',method:'ui/notifications/sandbox-escape',params:{}});
});
async function poll(){
 try{while(!stopped){
  const events=await invoke({op:'poll',after});
  for(const event of events){
   if(!Number.isSafeInteger(event.seq)||event.seq<=after)continue;
   after=event.seq;
   if(event.openLink){
    let success=false;
    try{await invoke({op:'open-link',linkId:event.openLink.id,url:event.openLink.url});success=true;}catch{}
    await invoke({op:'link-result',linkId:event.openLink.id,success});
   }else{state(event.message,true);frame.contentWindow.postMessage(event.message,'*');}
  }
  if(!events.length&&!stopped)await new Promise(resolve=>setTimeout(resolve,250));
 }}catch{fail();}
}
frame.src=${encode(resourceUrl)};
document.body.appendChild(frame);
void poll();
</script></body></html>`;
}
