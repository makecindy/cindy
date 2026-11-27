/** This document owns the App transport. The top Renderer only observes UI state. */
export function mcpAppDirectSandboxDocument(resourceUrl: string, bridgeUrl: string, scheme: 'light' | 'dark' = 'light'): string {
  const encode = (value: string) => JSON.stringify(value).replace(/</g, '\\u003c');
  return `<!doctype html><html><head><meta charset="utf-8"><style>:root{color-scheme:${scheme === 'dark' ? 'dark' : 'light'}}html,body{margin:0;width:100%;height:100%;overflow:hidden;background:transparent}</style></head><body><script>
const frame=document.createElement('iframe');
frame.setAttribute('sandbox','allow-scripts allow-same-origin allow-forms');
frame.setAttribute('allow',"camera 'none'; microphone 'none'; geolocation 'none'; clipboard-write 'none'");
frame.style.cssText='border:0;width:100%;height:100%;display:block';
let after=0,stopped=false,generation=0,initialized=false,initializationTimer,handshakeDelivery;
const localNotice=method=>window.parent.postMessage({jsonrpc:'2.0',method},'*');
// At most one tool that overlaps the initial result or starts immediately after it.
// No request details leave the wrapper. A POST receipt is not the RPC response.
let initialToolId,firstToolStartUntil,initialToolActive=false;
const toolActivity=active=>{
 if(initialToolActive===active)return;
 initialToolActive=active;
 window.parent.postMessage({jsonrpc:'2.0',method:'ui/notifications/sandbox-initial-tool-active',params:{active}},'*');
};
const state=(message,fromHost=false)=>{
 // App notifications cannot assert Host-owned context such as display mode.
 if(['ui/notifications/initialized','ui/notifications/size-changed','ui/notifications/sandbox-escape'].includes(message.method)||(fromHost&&message.method==='ui/notifications/host-context-changed'))
  window.parent.postMessage(message,'*');
};
const fail=error=>{
 if(stopped)return;
 stopped=true;clearTimeout(initializationTimer);
 const notice={jsonrpc:'2.0',method:'ui/notifications/sandbox-failed'};
 if(error?.message==='MCP_PLUGIN_UNAVAILABLE'||error?.message==='MCP_APP_SERVER_CHANGED')notice.params={code:error.message};
 window.parent.postMessage(notice,'*');
};
async function invoke(input){
 const response=await fetch(${encode(bridgeUrl)},{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input)});
 if(response.status===410)throw new Error((await response.json()).code);
 if(!response.ok)throw new Error('MCP_APP_VIEW_UNAVAILABLE');
 return response.json();
}
window.addEventListener('message',event=>{
 const message=event.data;
 if(event.source===window.parent){
  if(message?.type==='cindy:sandbox-color-scheme' && Object.keys(message).length===2 &&
     (message.scheme==='light'||message.scheme==='dark'))document.documentElement.style.colorScheme=message.scheme;
  return;
 }
 if(stopped||event.source!==frame.contentWindow)return;
 if(!message||message.jsonrpc!=='2.0'||typeof message.method==='string'&&message.method.startsWith('ui/notifications/sandbox-'))return;
 if(message.method==='ui/initialize'&&initialized){
  generation++;initialized=false;initialToolId=undefined;firstToolStartUntil=undefined;toolActivity(false);
  const current=generation;
  clearTimeout(initializationTimer);
  initializationTimer=setTimeout(()=>{if(generation===current&&!initialized)fail();},45000);
 }
 if(message.method==='ui/initialize')localNotice('ui/notifications/sandbox-handshake-started');
 if(message.method==='ui/notifications/initialized'){initialized=true;clearTimeout(initializationTimer);}
 state(message);
 const current=generation;
 const handshake=message.method==='ui/initialize'||message.method==='ui/notifications/initialized';
 const send=async()=>{
  if(stopped||!handshake&&generation!==current)return;
  if(initialized&&message.method==='tools/call'&&initialToolId===undefined&&
     (Number.isSafeInteger(message.id)||typeof message.id==='string'&&message.id.length<=128)&&
     (firstToolStartUntil===undefined||performance.now()<firstToolStartUntil)){
   initialToolId=message.id;
   if(firstToolStartUntil!==undefined)toolActivity(true);
  }
  await invoke({op:'message',message});
 };
 // Await handshake receipts, not long-running tool calls, before the next document.
 const delivery=handshakeDelivery?handshakeDelivery.then(send):send();
 if(handshake){
  handshakeDelivery=delivery;
  void delivery.then(()=>{if(handshakeDelivery===delivery)handshakeDelivery=undefined;},()=>{});
 }
 void delivery.catch(fail);
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
   if(event.generation!==undefined&&event.generation!==generation)continue;
   if(event.openLink){
    let success=false;
    try{await invoke({op:'open-link',linkId:event.openLink.id,url:event.openLink.url});success=true;}catch{}
    if(event.generation!==undefined&&event.generation!==generation)continue;
    await invoke({op:'link-result',linkId:event.openLink.id,success});
  }else{
   const reply=event.message;
   if(['ui/notifications/tool-result','ui/notifications/tool-cancelled'].includes(reply?.method)){
    localNotice('ui/notifications/sandbox-result-delivered');
    if(event.generation===generation&&firstToolStartUntil===undefined){
     firstToolStartUntil=performance.now()+500;
     if(initialToolId!==undefined)toolActivity(true);
    }
   }
   state(reply,true);frame.contentWindow.postMessage(reply,'*');
   if(initialToolId!==undefined&&event.generation===generation&&reply?.method===undefined&&
      reply?.id===initialToolId&&('result' in reply||'error' in reply)){
    initialToolId=undefined;
    if(initialToolActive){firstToolStartUntil=0;toolActivity(false);}
   }
  }
  }
  if(!events.length&&!stopped)await new Promise(resolve=>setTimeout(resolve,250));
 }}catch(error){fail(error);}
}
frame.src=${encode(resourceUrl)};
document.body.appendChild(frame);
void poll();
</script></body></html>`;
}
