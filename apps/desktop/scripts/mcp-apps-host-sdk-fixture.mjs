/** Integration-only complete documents: no SDK bundling, credentials, or external network. */
export function hostSdkFixture(assets) {
  function generated(page) {
    return '<!doctype html><html><head><title>Generated App</title></head><body><h1>Page '+page+'</h1><button id="next">Next page</button><form id="bridged"><input name="text"><button type="submit">Send</button></form><form id="native" method="post"><button type="submit">Native</button></form><script type="module">'+
      'import { App } from "@modelcontextprotocol/ext-apps";'+
      'const app=new App({name:"Generated",version:"1"});window.sdkApp=app;window.pageState={page:'+page+',inputs:0,results:0};'+
      'app.ontoolinput=()=>window.pageState.inputs++;app.ontoolresult=()=>window.pageState.results++;'+
      'app.onteardown=async()=>{window.pageState.tornDown=true;return {};};app.onhostcontextchanged=()=>{window.pageState.theme=app.getHostContext().theme;};'+
      'app.connect().then(()=>{window.pageState.ready=true;window.pageState.theme=app.getHostContext().theme;});'+
      'document.querySelector("#bridged").addEventListener("submit",async event=>{window.pageState.defaultPreventedAtHandler=event.defaultPrevented;event.preventDefault();const text=new FormData(event.currentTarget).get("text");const result=await app.callServerTool({name:"echo",arguments:{text}});window.pageState.formResult=result.content[0].text;});'+
      'document.querySelector("#next").onclick=async()=>{const r=await app.callServerTool({name:"generate_page",arguments:{page:'+(page+1)+'}});await app.close();document.open();document.write(r._meta.view.html);document.close();};'+
      '</script></body></html>';
  }
  const tools = ['draft_form', 'generate_page', 'echo'].map(name => ({name,description:name,parameters:{type:'object',properties:{page:{type:'number'},text:{type:'string'}}}}));
  return {
    manifest: {schemaVersion:3,id:'host-sdk-fixture',name:'Host SDK fixture',version:'1.0.0',entry:'main.js',minCindyVersion:'0.1.122-beta',tools,network:{hosts:[new URL(assets).hostname]},
      mcpApps:{ui:{resources:[{uri:'ui://fixture/page',file:'ui/page.html',csp:{resourceDomains:[assets]}}],tools:Object.fromEntries(tools.map(({name})=>[name,{resourceUri:'ui://fixture/page',...(name==='draft_form'?{}:{visibility:['app']})}]))}}},
    main: 'let late;const generated='+generated.toString()+';cindy.onHostMessage(message=>{if(message.type!=="tool-call")return;if(message.args.text==="old-upstream"){late=message;return;}if(message.args.text==="new-upstream"&&late){cindy.send({type:"tool-result",callId:late.callId,ok:true,result:{content:[{type:"text",text:"old-upstream"}]}});late=undefined;}const result=message.tool==="echo"?{content:[{type:"text",text:message.args.text}]}:{content:[{type:"text",text:"Page ready"}],_meta:{view:{html:generated(message.args.page||1)}}};cindy.send({type:"tool-result",callId:message.callId,ok:true,result});});',
    html: '<!doctype html><html><head><script>window.externalSdkReady=new Promise(resolve=>window.externalSdkResolve=resolve);</script><script type="module" src="'+assets+'/sdk-external.js"></script></head><body>Loading<script type="module">const {App}=await import(["@modelcontextprotocol","ext-apps"].join("/"));window.computedSdkLoaded=true;await window.externalSdkReady;window.loaderCompatMode=document.compatMode;const app=new App({name:"Loader",version:"1"});app.ontoolresult=async r=>{await app.close();document.open();document.write(r._meta.view.html);document.close();};app.connect();</script></body></html>',
  };
}
