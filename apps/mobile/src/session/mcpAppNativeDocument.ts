import { Directory, File, Paths } from "expo-file-system";
import { getRandomBytes } from "expo-crypto";
import {
  mcpAppSandboxDocument,
  HOST_APP_SDK_PATH,
  CINDY_VIEW_STATE_SDK_PATH,
  CINDY_VIEW_STATE_REACT_SDK_PATH,
  type McpAppDocument,
} from "@cindy/maker-shared/mcp-apps";
import native from "../../modules/cindy-html-preview/src/CindyHtmlPreviewModule";

export interface McpAppNativeDocument {
  source: { uri: string };
  resourceUrl: string;
  documentUrls: readonly string[];
  close(): Promise<void>;
}
let swept = false;

// Only geometry leaves the resource. The existing sandbox checks its window and
// origin; the native View consumes this notification locally, before MCP routing.
export const MCP_APP_FOCUS_SCRIPT = `<script data-cindy-mobile-focus>
(()=>{
 let scheduled=false;
 const caretRect=(active,field)=>{
  if(active.tagName==='TEXTAREA'){
   // A textarea has no DOM selection range. Measure its text in a hidden mirror
   // with the same wrapping/typography, then account for its internal scroll.
   const mirror=document.createElement('div');
   try{
    const css=getComputedStyle(active);
    mirror.style.all='initial';
    for(const key of ['fontFamily','fontSize','fontWeight','fontStyle','fontStretch','fontVariant','lineHeight','letterSpacing','wordSpacing','textIndent','textAlign','textTransform','tabSize','direction','wordBreak','paddingTop','paddingRight','paddingBottom','paddingLeft'])mirror.style[key]=css[key];
    Object.assign(mirror.style,{position:'fixed',top:'0',left:'0',width:active.clientWidth+'px',height:'auto',minHeight:'0',maxHeight:'none',minWidth:'0',maxWidth:'none',boxSizing:'border-box',border:'0',margin:'0',visibility:'hidden',pointerEvents:'none',whiteSpace:active.wrap==='off'?'pre':'pre-wrap',overflowWrap:'break-word'});
    const offset=active.selectionDirection==='backward'?active.selectionStart:active.selectionEnd;
    mirror.textContent=active.value.slice(0,offset);
    const marker=document.createElement('span');
    marker.style.all='unset';
    marker.textContent=active.value.slice(offset)||'\u200b';
    mirror.appendChild(marker);
    document.body.appendChild(mirror);
    const range=document.createRange();
    range.setStart(marker.firstChild,0);range.collapse(true);
    const caret=range.getBoundingClientRect();
    if(caret.height>0){
     const scale=active.offsetHeight?field.height/active.offsetHeight:1;
     const innerTop=field.top+active.clientTop*scale;
     const innerBottom=innerTop+active.clientHeight*scale;
     const top=Math.max(innerTop,Math.min(innerBottom-caret.height*scale,innerTop+(caret.top-mirror.getBoundingClientRect().top-active.scrollTop)*scale));
     return {top,bottom:Math.min(innerBottom,top+caret.height*scale)};
    }
   }finally{mirror.remove();}
  }else if(active.isContentEditable){
   const selection=window.getSelection();
   if(selection&&selection.focusNode&&active.contains(selection.focusNode)){
    const range=document.createRange();
    range.setStart(selection.focusNode,selection.focusOffset);range.collapse(true);
    const caret=range.getBoundingClientRect();
    if(caret.height>0)return caret;
    // Empty lines (including a new <div><br></div> after Enter) can have a
    // zero-height collapsed range. Measure the adjacent leaf's line instead.
    const node=selection.focusNode;
    const after=node.childNodes[selection.focusOffset];
    let leaf=node.nodeType===3?node:(after||node.childNodes[selection.focusOffset-1]);
    while(leaf&&leaf.childNodes.length)leaf=after?leaf.firstChild:leaf.lastChild;
    if(leaf){
     if(leaf.nodeType===3&&leaf.textContent.length){
      const offset=node===leaf?Math.min(selection.focusOffset,leaf.textContent.length-1):after?0:leaf.textContent.length-1;
      range.setStart(leaf,offset);range.setEnd(leaf,offset+1);
     }else{range.selectNode(leaf);}
     const line=range.getBoundingClientRect();
     if(line.height>0)return line;
    }
    const block=node.nodeType===1?node:node.parentElement;
    if(block){
     const css=getComputedStyle(block),box=block.getBoundingClientRect();
     const top=box.top+(parseFloat(css.borderTopWidth)||0)+(parseFloat(css.paddingTop)||0);
     return {top,bottom:top+(parseFloat(css.lineHeight)||parseFloat(css.fontSize)*1.2||16)};
    }
   }
  }
  return field;
 };
 const report=()=>{
  scheduled=false;
  const active=document.activeElement;
  const editable=active&&(active.matches('input:not([type=button]):not([type=submit]):not([type=checkbox]):not([type=radio]),textarea')||active.isContentEditable);
  let rect=editable?active.getBoundingClientRect():null;
  if(rect){try{
   const field=rect;
   rect=caretRect(active,field);
   if(active.isContentEditable&&/^(auto|scroll|hidden|clip)$/.test(getComputedStyle(active).overflowY)){
    // Internal scrolling can move the selection outside the visible editor.
    // Keep the outer list anchored to the editor, not its clipped content.
    const scale=active.offsetHeight?field.height/active.offsetHeight:1;
    const innerTop=field.top+active.clientTop*scale;
    const innerBottom=innerTop+active.clientHeight*scale;
    const height=rect.bottom-rect.top;
    const top=Math.max(innerTop,Math.min(innerBottom-height,rect.top));
    rect={top,bottom:Math.min(innerBottom,top+height)};
   }
  }catch{}}
  parent.postMessage({jsonrpc:'2.0',method:'ui/notifications/cindy-mobile-focus',params:rect?{top:rect.top,bottom:rect.bottom}:null},'*');
 };
 const schedule=()=>{if(!scheduled){scheduled=true;requestAnimationFrame(report);}};
 document.addEventListener('focusin',schedule);
 document.addEventListener('focusout',schedule);
 document.addEventListener('input',schedule);
 document.addEventListener('selectionchange',schedule,true);
 document.addEventListener('select',schedule,true);
 document.addEventListener('keyup',schedule);
 document.addEventListener('scroll',schedule,true);
 window.addEventListener('resize',schedule);
})();
</script>`;

// Android's WebStorage.deleteOrigin does not clear localStorage and has no
// completion callback. Run in the new App origin, before any untrusted HTML,
// and do not navigate to that HTML until IndexedDB deletion has completed.
export const MCP_APP_STORAGE_BOOTSTRAP = `<!doctype html><meta charset="utf-8"><script>
(async()=>{
  localStorage.clear();
  sessionStorage.clear();
  const databases=await indexedDB.databases();
  await Promise.all(databases.map(({name})=>new Promise((resolve,reject)=>{
    if(typeof name!=='string'){resolve();return;}
    const request=indexedDB.deleteDatabase(name);
    request.onsuccess=()=>resolve();
    request.onerror=request.onblocked=()=>reject(new Error('MCP_APP_STORAGE_RESET_FAILED'));
  })));
  location.replace('/resource.html');
})().catch(()=>{});
</script>`;

/** Reuse the installed loopback server; different ports give proxy and App distinct origins. */
export async function prepareMcpAppNativeDocument(
  document: McpAppDocument,
  bridgeKey: string,
): Promise<McpAppNativeDocument> {
  if (!native?.appHostAvailable || !native.startApp) throw new Error("MCP_APP_NATIVE_UPDATE_REQUIRED");
  const server = native;
  const start = native.startApp.bind(native);
  if (!swept) {
    swept = true;
    const parent = new Directory(Paths.cache, "mcp-apps");
    if (parent.exists) {
      for (const child of parent.list()) {
        if (child instanceof Directory && /^[a-f0-9]{48}$/.test(child.name)) {
          try {
            child.delete();
          } catch {
            /* OS cache eviction remains the fallback. */
          }
        }
      }
    }
  }
  const token = () =>
    Array.from(getRandomBytes(24), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
  const resourceToken = token();
  const proxyToken = token();
  const directory = new Directory(Paths.cache, "mcp-apps", resourceToken);
  directory.create({ intermediates: true });
  const root = decodeURIComponent(directory.uri.slice("file://".length));
  const started: string[] = [];
  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= (async () => {
      try {
        const stopped = await Promise.allSettled(
          started.map((value) => server.stop(value)),
        );
        const failed = stopped.find((result) => result.status === "rejected");
        if (failed?.status === "rejected") throw failed.reason;
      } finally {
        if (directory.exists) directory.delete();
      }
    })());
  try {
    const sdkSource = typeof document.sdk?.source === "string" ? document.sdk.source : undefined;
    const resource = new File(directory, "0");
    resource.create();
    const entries: string[][] = [["initialize.html", "2", "text/html"], ["resource.html", "0", "text/html"]];
    if (sdkSource !== undefined) {
      const sdk = new File(directory, "3");
      sdk.create();
      sdk.writeSync(sdkSource);
      entries.push([HOST_APP_SDK_PATH.slice(1), "3", "text/javascript"]);
    }
    const candidate = document.sdk?.addons?.['cindy/view-state'];
    const addon = sdkSource !== undefined && typeof candidate?.source === 'string' && typeof candidate?.reactSource === 'string'
      ? candidate : undefined;
    if (addon) {
      const core = new File(directory, "4"); core.create(); core.writeSync(addon.source);
      const react = new File(directory, "5"); react.create(); react.writeSync(addon.reactSource);
      entries.push([CINDY_VIEW_STATE_SDK_PATH.slice(1), "4", "text/javascript"], [CINDY_VIEW_STATE_REACT_SDK_PATH.slice(1), "5", "text/javascript"]);
    }
    const bootstrap = new File(directory, "2");
    bootstrap.create();
    bootstrap.writeSync(MCP_APP_STORAGE_BOOTSTRAP);
    started.push(resourceToken);
    const resourceUrl = await start(
      root,
      "initialize.html",
      resourceToken,
      document.csp,
      entries,
    );
    const html = (await import("@cindy/maker-shared/mcp-app-sdk")).withHostAppSdk(
      document.html, new URL(HOST_APP_SDK_PATH, resourceUrl).href,
      addon ? { coreUrl: new URL(CINDY_VIEW_STATE_SDK_PATH, resourceUrl).href, reactUrl: new URL(CINDY_VIEW_STATE_REACT_SDK_PATH, resourceUrl).href } : undefined,
      MCP_APP_FOCUS_SCRIPT,
    );
    resource.writeSync(html);
    const resourceOrigin = new URL(resourceUrl).origin;
    const proxy = new File(directory, "1");
    proxy.create();
    proxy.writeSync(mcpAppSandboxDocument(bridgeKey, resourceUrl));
    const csp = `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-src ${resourceOrigin}; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'`;
    started.push(proxyToken);
    const proxyUrl = await start(root, "proxy.html", proxyToken, csp, [
      ["proxy.html", "1", "text/html"],
    ]);
    if (new URL(proxyUrl).origin === resourceOrigin)
      throw new Error("MCP_APP_INVALID_ORIGIN");
    return {
      source: { uri: proxyUrl },
      resourceUrl,
      // Each server bootstraps its HttpOnly cookie then redirects to its one manifest entry.
      documentUrls: [
        proxyUrl,
        new URL("/proxy.html", proxyUrl).href,
        resourceUrl,
        new URL("/initialize.html", resourceUrl).href,
        new URL("/resource.html", resourceUrl).href,
      ],
      close,
    };
  } catch (error) {
    await close().catch(() => {});
    throw error;
  }
}
