/** Explicit Electron integration check; never launches or restarts Cindy. */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import http from 'node:http';
import process from 'node:process';
import { setTimeout, clearTimeout } from 'node:timers';
import { build } from 'esbuild';
import { startMockAppServer, createMockAppServer } from './mcp-apps-mock.mjs';
import { hostSdkFixture } from './mcp-apps-host-sdk-fixture.mjs';
import { pluginUiFixture } from './plugin-ui-fixture.mjs';
import { authorFixture } from './plugin-author-fixture.mjs';
import { createRawAppServer } from './mcp-apps-raw-fixture.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const temporary = await mkdtemp(path.join(os.tmpdir(), 'cindy-mcp-app-sandbox-'));
const independent = process.argv.includes('--raw');
const authorMode = process.argv.find(arg => arg.startsWith('--author='))?.split('=')[1];
const hostSdk = process.argv.includes('--host-sdk');
const bom = process.argv.includes('--bom');
const pluginView = process.argv.includes('--plugin') || !!authorMode || hostSdk || bom;
const remoteView = process.argv.includes('--remote');
const measureMetrics = process.argv.includes('--metrics');
const assets = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.url === '/asset.js') {
    res.setHeader('Content-Type', 'text/javascript');
    res.end('window.allowedAssetLoaded=true;');
  } else if (req.url === '/sdk-external.js') {
    res.setHeader('Content-Type', 'text/javascript');
    res.end('import { App } from "@modelcontextprotocol/ext-apps";window.externalSdkLoaded=typeof App==="function";window.externalSdkResolve();');
  } else if (req.url === '/frame') {
    res.setHeader('Content-Type', 'text/html');
    res.end('<!doctype html><body>Declared frame domain</body>');
  } else res.end('declared-domain');
});
await new Promise((resolve) => assets.listen(0, '127.0.0.1', resolve));
const allowed = 'http://127.0.0.1:' + assets.address().port;
const endpoint = await startMockAppServer({
  createServer: independent
    ? () =>
        createRawAppServer({
          csp: {
            connectDomains: [allowed],
            resourceDomains: [allowed],
            frameDomains: [allowed],
            baseUriDomains: [allowed],
          },
        })
    : createMockAppServer,
});
try {
  if (pluginView) await writeFile(path.join(temporary, 'fixture.txt'), 'host-only-file');
  if (pluginView) {
    const fixture = hostSdk ? hostSdkFixture(allowed) : authorMode ? await authorFixture(authorMode, temporary) : await pluginUiFixture(independent, independent ? allowed : undefined, true);
    if (bom) fixture.html = String.fromCharCode(0xfeff) + fixture.html;
    await writeFile(path.join(temporary, 'plugin.json'), JSON.stringify(fixture));
  }
  await writeFile(
    path.join(temporary, 'preload.cjs'),
    "require('electron').contextBridge.exposeInMainWorld('testHost', {invoke: input => require('electron').ipcRenderer.invoke('test:mcp-app', input)});",
    'utf8',
  );
  const renderer = await build({
    bundle: true,
    write: false,
    format: 'iife',
    stdin: {
      resolveDir: scriptDir,
      contents: `
    import { McpAppController } from '@cindy/maker-shared/mcp-app-controller';
    window.testState = {sizes:[]};
    let frame;
    const controller = new McpAppController((_id,input)=>window.testHost.invoke(input),'task','card',
      message=>frame?.contentWindow?.postMessage(message,'*'),message=>{
        if(message.method==='ui/notifications/initialized')window.testState.initialized=true;
        if(message.method==='ui/notifications/size-changed'){window.testState.size=message.params;window.testState.sizes.push(message.params);if(frame)frame.style.height=(${authorMode === 'files'}?message.params.height:Math.min(1200,message.params.height))+'px';}
        if(message.method==='ui/notifications/host-context-changed'&&message.params.displayMode)window.testState.mode=message.params.displayMode;
      },error=>{window.testState.error=String(error);});
    window.testController=controller;
    window.addEventListener('message',event=>{
      if(event.source!==frame?.contentWindow)return;
      if(event.data?.method==='ui/notifications/sandbox-proxy-ready')controller.sandboxReady('cindy-mcp-app://'+controller.document.viewId+'-view/resource');
      else controller.receive(event.data);
    });
    controller.open({platform:'desktop',theme:'light',styles:{variables:{'--color-background-primary':'rgb(248,248,246)','--color-text-primary':'rgb(0,0,0)','--color-background-secondary':'rgb(238,238,235)','--color-border-primary':'rgb(160,160,158)'}}}).then(doc=>{
      frame=document.createElement('iframe');frame.sandbox='allow-scripts allow-same-origin allow-forms';frame.src='cindy-mcp-app://'+doc.viewId+'/sandbox';frame.style='width:700px;height:550px';document.body.appendChild(frame);
    });
  `,
    },
  });
  await writeFile(
    path.join(temporary, 'host.html'),
    '<!doctype html><html><body><script>' +
      renderer.outputFiles[0].text.replace(/<\/script/gi, '<\\/script') +
      '</script></body></html>',
    'utf8',
  );
  await build({
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: path.join(temporary, 'verify.cjs'),
    external: ['electron'],
    plugins: [
      { name: 'host-sdk-raw', setup(builder) {
        builder.onResolve({ filter: /ext-apps\/app-with-deps\?raw$/ }, () => ({ path: createRequire(import.meta.url).resolve('@modelcontextprotocol/ext-apps/app-with-deps'), namespace: 'sdk-raw' }));
        builder.onLoad({ filter: /.*/, namespace: 'sdk-raw' }, async args => ({ contents: await readFile(args.path, 'utf8'), loader: 'text' }));
      } },
      {
        name: 'test-only-owner',
        setup(builder) {
          builder.onResolve({ filter: /localDb\/client\/current\.js$/ }, () => ({
            path: 'test-owner',
            namespace: 'test-owner',
          }));
          builder.onLoad({ filter: /.*/, namespace: 'test-owner' }, () => ({
            contents: 'export const getCurrentDbClientSnapshot=()=>globalThis.mcpTestOwner;',
          }));
        },
      },
    ],
    stdin: {
      resolveDir: scriptDir,
      contents: `
    import assert from 'node:assert/strict';
    import { readFileSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
    import { open as openFile } from 'node:fs/promises';
    import { saveAppDownload } from '../src/main/mcp-apps/downloadFile.ts';
    import { buildRangedFileResponse } from '../src/main/cindy-media/rangeResponse.ts';
    import { runInNewContext } from 'node:vm';
    import { LibraryVault } from '../src/main/cindy-brain/libraryVault.ts';
    import { GhostPipeDispatcher } from '../src/main/cindy-brain/pipeDispatcher.ts';
    import { createPluginAppTransport } from '../src/main/mcp-apps/pluginServer.ts';
    import { pluginAppResult, pluginModelResult } from '../src/main/mcp-apps/pluginCards.ts';
    import http from 'node:http';
    import { app, BrowserWindow, protocol, ipcMain, net, nativeImage } from 'electron';
    import { McpAppsHost, appServerRevision } from '../src/main/mcp-apps/host.ts';
    import { AppConnection } from '../src/main/mcp-apps/connection.ts';
    import { createAppServerProxy } from '../src/main/mcp-apps/serverProxy.ts';
    import { setMcpAppsHost, registerAppServer } from '../src/main/mcp-apps/runtime.ts';
    import { Client } from '@modelcontextprotocol/sdk/client/index.js';
    import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
    import { createHash } from 'node:crypto';
    import { appCsp } from '../src/main/mcp-apps/protocol.ts';
    import { handleMcpAppOperation, handleMcpAppFrameOperation } from '../src/main/mcp-apps/operations.ts';
    import { RemoteMcpAppViews } from '../src/main/mcp-apps/remoteViews.ts';
    import { mcpAppSchemePrivilege, registerMcpAppProtocol, supplyMcpAppDocument, removeMcpAppDocument, setMcpAppFileReader } from '../src/main/mcp-apps/sandboxProtocol.ts';
    app.setPath('userData',process.env.CINDY_MCP_APP_TEST_DIR+'/profile');
    protocol.registerSchemesAsPrivileged([mcpAppSchemePrivilege]);
    globalThis.mcpTestOwner={};
    let window, host, connection, forbidden, modelFacade, modelClient, stableCatalog, stableInstructions, runtimeMetrics, requests=0, stage='initialize';
    const wait=async predicate=>{const end=Date.now()+10000;while(Date.now()<end){if(await predicate())return;await new Promise(resolve=>setTimeout(resolve,25));}throw new Error('MCP App browser check timed out: '+stage);};
    void app.whenReady().then(async()=>{
      forbidden=http.createServer((_req,res)=>{requests++;res.setHeader('Access-Control-Allow-Origin','*');res.end('forbidden');});
      await new Promise(resolve=>forbidden.listen(0,'127.0.0.1',resolve));
      const denied='http://127.0.0.1:'+forbidden.address().port+'/exfil';
      const independent=process.env.CINDY_MCP_APP_TEST_RAW==='1';
      const authorMode=process.env.CINDY_MCP_APP_TEST_AUTHOR;
      const allowed=process.env.CINDY_MCP_APP_TEST_ALLOWED;
      let config={id:'example',url:process.env.CINDY_MCP_APP_TEST_URL,transport:'http'};
      const pluginMode=process.env.CINDY_MCP_APP_TEST_PLUGIN==='1';let executePlugin;
      let authorVault; const loaderCalls=[], sdkDispatched=[]; let loaderResultOverride;
      const loaderImageUri='cindy-media://blobs/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.png', loaderImage=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAIAAAASFvFNAAAAEElEQVR4nGP4z8AAQQxwFgBB0gX7h/C5SAAAAABJRU5ErkJggg==','base64');
      const authorLibraryRoot=process.env.CINDY_MCP_APP_TEST_DIR+'/author-library';
      if(pluginMode){
        const fixture=JSON.parse(readFileSync(process.env.CINDY_MCP_APP_TEST_DIR+'/plugin.json','utf8'));
        const ghost={manifest:fixture.manifest,dir:process.env.CINDY_MCP_APP_TEST_DIR,enabled:true,approval:{state:'approved',revision:'fixture'}};
        if(authorMode==='files'){authorVault=new LibraryVault({rootDir:()=>authorLibraryRoot,ghostId:ghost.manifest.id});await authorVault.open();}
        let handler;
        const dispatcher=new GhostPipeDispatcher({getGhost:()=>ghost,runtimeStateOf:()=>'running',spawn:async()=>({ok:true}),
          sendToGhost:(_id,payload)=>{if(payload.type==='tool-call')sdkDispatched.push(payload.args?.text);handler(payload);return true;}});
        runInNewContext(fixture.main,{setTimeout,cindy:{library:request=>{assert.ok(authorVault);assert.ok(['writeBegin','writeChunk','writeCommit','writeAbort'].includes(request.op));return authorVault[request.op](request);},onHostMessage:fn=>{handler=fn;},send:payload=>payload.type==='tool-progress'?dispatcher.handleToolProgress(ghost.manifest.id,payload):dispatcher.handleToolResult(ghost.manifest.id,payload)}});
        executePlugin=async(name,args,onProgress)=>{const reply=await dispatcher.callGhostTool({ghostId:ghost.manifest.id,tool:name,args,onProgress});assert.equal(reply.ok,true);if(authorMode==='loader'){loaderCalls.push({name,args});return loaderResultOverride??reply.result;}return reply.result;};
        config={id:'example',url:'',transport:'in-process',plugin:{instance:ghost.manifest.id,revision:'fixture',packageSha256:'fixture',title:ghost.manifest.name,trust:'unverified',domains:independent||process.env.CINDY_MCP_APP_TEST_HOST_SDK==='1'?[allowed]:[],assertCurrent(){},
          createTransport:()=>createPluginAppTransport({instance:ghost.manifest.id,revision:'fixture',tools:ghost.manifest.tools,ui:ghost.manifest.mcpApps?.ui,hosts:ghost.manifest.network?.hosts,assertCurrent(){},readHtml:()=>fixture.html,
            call:(grant,args)=>executePlugin(grant.tool,args,grant.onProgress)})}};
      }
      connection=new AppConnection(config);const client=await connection.getClient();
      let sdkUpstreamSignal; const sdkIds=[];
      if(process.env.CINDY_MCP_APP_TEST_HOST_SDK==='1'){
        const call=client.callTool.bind(client);
        client.callTool=(params,schema,options)=>{if(params.arguments?.text==='old-upstream')sdkUpstreamSignal=options.signal;return call(params,schema,options);};
      }
      const tool=(await connection.tools()).find(tool=>tool.name===(authorMode==='loader'?'open_view':authorMode==='files'?'open_showcase':authorMode?'open_view':independent?'open_metrics':'draft_form'));
      if(process.env.CINDY_MCP_APP_TEST_HOST_SDK==='1' && process.env.CINDY_MCP_APP_TEST_REMOTE!=='1') tool._meta['cindy/attachments']=[{type:'resource_link',name:'fixture.txt',uri:'library:fixture.txt'}];
      // A conversation image handed over with ghost_call.attachments; the generated page reads it from hostContext.
      if(authorMode==='loader') tool._meta['cindy/attachments']=[{type:'resource_link',name:'fixture.png',uri:loaderImageUri,mimeType:'image/png'}];
      const args=authorMode==='loader'?{intent:'请打开一个可以查看和编辑记录的页面'}:independent?{threshold:75}:{title:'AI draft',body:'Review before creating'};
      const result=pluginMode?await executePlugin(tool.name,args):await client.callTool({name:tool.name,arguments:args});
      let record={version:1,serverId:'example',serverRevision:appServerRevision(config),resourceUri:tool._meta.ui.resourceUri,tool,arguments:args,result:authorMode==='loader'?pluginAppResult(result):result};
      if(authorMode==='loader'){assert.ok(result._meta.view.html.includes('<style>'));assert.deepEqual(Object.keys(pluginModelResult(result)),['content']);}
      let turns=0, receivedImages=[], pageApprovals=0, approvalGate, sdkApprovalSignal, sdkReleaseApproval;
      host=new McpAppsHost({downloadFile:pluginMode?input=>saveAppDownload({...input,showSaveDialog:async name=>process.env.CINDY_MCP_APP_TEST_DIR+'/saved-'+name}):undefined,pluginFiles:pluginMode?{
        describe:async(_instance,uri)=>{if(authorVault&&uri.startsWith('library:')){const file=await authorVault.stat({path:uri.slice('library:'.length)});return file.ok&&file.kind==='file'?{mimeType:'text/plain',size:file.bytes}:null;}if(uri===loaderImageUri)return {mimeType:'image/png',size:loaderImage.length};return uri==='library:fixture.txt'?{mimeType:'text/plain',size:14}:uri==='cindy-media://blobs/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png'?{mimeType:'image/png',size:8}:null;},
        read:async(_instance,uri,request)=>{
          if(uri===loaderImageUri)return new Response(loaderImage,{headers:{'Content-Type':'image/png','Content-Length':String(loaderImage.length)}});
          if(uri!=='library:fixture.txt')return new Response(null,{status:404});
          const file=await openFile(process.env.CINDY_MCP_APP_TEST_DIR+'/fixture.txt','r');
          return buildRangedFileResponse({file,totalSize:14,mimeType:'text/plain',rangeHeader:request.headers.get('range'),cacheControl:'no-store',signal:request.signal});
        }
      }:undefined,owner:()=>globalThis.mcpTestOwner,config:()=>config,readCard:async()=>record,writeCard:async(_s,_c,value)=>{record=value;},authorizeTool:async(_s,_t,args,signal)=>{pageApprovals++;if(args.text==='old-document'){sdkApprovalSignal=signal;await new Promise(resolve=>sdkReleaseApproval=resolve);}if(approvalGate)await approvalGate;},sendMessage:async(_s,_r,_c,_guard,files)=>{turns++;receivedImages=files??[];},disposeDocument:removeMcpAppDocument});
      if(process.env.CINDY_MCP_APP_TEST_HOST_SDK==='1'){
        const dispatch=host.dispatch.bind(host);
        host.dispatch=(caller,session,id,message)=>{if(message.method==='tools/call'&&message.params.name==='echo')sdkIds.push({text:message.params.arguments.text,id:message.id});return dispatch(caller,session,id,message);};
      }
      if(process.env.CINDY_MCP_APP_TEST_BOM==='1'){
        const open=host.open.bind(host);host.open=async(...args)=>{const doc=await open(...args);assert.equal(doc.html.charCodeAt(0),0xfeff);assert.equal(typeof doc.sdk?.source,'string');return doc;};
      }
      setMcpAppFileReader((id,token,request)=>host.readPluginFile(id,token,request));
      if(process.env.CINDY_MCP_APP_TEST_METRICS==='1'){
        setMcpAppsHost(host);registerAppServer(config.id,()=>config);
        const initialRecord=record;
        modelFacade=createAppServerProxy(()=>config,{agentKind:'codex',sessionId:'task',workingDir:''});
        modelClient=new Client({name:'metrics-model-boundary',version:'1'},{});
        const [modelTransport,facadeTransport]=InMemoryTransport.createLinkedPair();
        const initializedAt=performance.now();
        await modelFacade.connect(facadeTransport);await modelClient.connect(modelTransport);
        const facadeInitializeMs=performance.now()-initializedAt;
        stableCatalog=JSON.stringify(await modelClient.listTools());stableInstructions=modelClient.getInstructions();
        assert.equal(stableInstructions,client.getInstructions());
        const times={direct:[],facade:[]};let modelResultBytes=0,directResultBytes=0;
        for(let i=0;i<30;i++){
          let started=performance.now();
          const direct=await client.callTool({name:tool.name,arguments:args});times.direct.push(performance.now()-started);
          started=performance.now();
          const viaFacade=await modelClient.callTool({name:tool.name,arguments:args});times.facade.push(performance.now()-started);
          const expected={...direct};delete expected._meta;assert.deepEqual(viaFacade,expected);
          assert.equal(JSON.stringify(await modelClient.listTools()),stableCatalog);
          assert.equal(modelClient.getInstructions(),stableInstructions);
          directResultBytes=Buffer.byteLength(JSON.stringify(direct));modelResultBytes=Buffer.byteLength(JSON.stringify(viaFacade));
        }
        const stats=samples=>{const sorted=[...samples].sort((a,b)=>a-b);return {n:samples.length,meanMs:samples.reduce((a,b)=>a+b,0)/samples.length,p95Ms:sorted[Math.ceil(samples.length*.95)-1]};};
        runtimeMetrics={fixture:independent?'raw':'official-sdk',transport:'loopback HTTP plus SDK InMemory caller',storage:'in-memory callbacks',facadeInitializeMs,
          direct:stats(times.direct),facade:stats(times.facade),stableCatalogBytes:Buffer.byteLength(stableCatalog),
          stableCatalogSha256:createHash('sha256').update(stableCatalog).digest('hex'),catalogComparisons:30,resultComparisons:30,directResultBytes,modelResultBytes,
          actualModelCacheRate:null,actualModelTokenUsage:null};
        record=initialRecord;
      }
      record.connectionId=host.registerConnection(connection);
      const sdkRecordSnapshot=JSON.stringify(record);
      registerMcpAppProtocol();
      const remoteViews=new RemoteMcpAppViews({owner:()=>globalThis.mcpTestOwner,closeEpoch:()=>0,
        invoke:async(device,session,input,preSend)=>{
          assert.equal(device,'fixture-device');preSend();
          return handleMcpAppOperation(host,'device:fixture-controller',session,input);
        },openLink:async()=>{}});
      ipcMain.handle('test:mcp-app',async(event,input)=>{
        assert.equal(event.senderFrame,event.sender.mainFrame);
        const caller='renderer:'+event.sender.id;
        if(process.env.CINDY_MCP_APP_TEST_REMOTE==='1')return remoteViews.control(caller,'fixture-device','task',input);
        return handleMcpAppOperation(host,caller,'task',input,{
          supply:(doc)=>supplyMcpAppDocument(doc,caller,raw=>handleMcpAppFrameOperation(host,caller,'task',doc.viewId,raw,async()=>{})),
        });
      });
      window=new BrowserWindow({show:false,width:800,height:700,webPreferences:{preload:process.env.CINDY_MCP_APP_TEST_DIR+'/preload.cjs',sandbox:true,contextIsolation:true,nodeIntegration:false,nodeIntegrationInSubFrames:false,nodeIntegrationInWorker:false,webSecurity:true,allowRunningInsecureContent:false,experimentalFeatures:false,plugins:false,navigateOnDragDrop:false}});
      window.webContents.setWindowOpenHandler(()=>({action:'deny'}));
      await window.loadFile(process.env.CINDY_MCP_APP_TEST_DIR+'/host.html');
      try { await wait(()=>window.webContents.executeJavaScript('window.testState.initialized===true')); }
      catch (error) { console.log('Frame state',window.webContents.mainFrame.framesInSubtree.map(frame=>frame.url),await window.webContents.executeJavaScript('window.testState')); throw error; }
      assert.deepEqual(await window.webContents.executeJavaScript(
        'Object.keys(window.testController.document).sort()'),['prefersBorder','transport','viewId']);
      assert.equal(await window.webContents.executeJavaScript(
        'window.testController.document.transport'),'sandbox');
      const inner=()=>window.webContents.mainFrame.framesInSubtree.find(frame=>frame.url.includes('-view/resource'));
      assert.equal(await window.webContents.executeJavaScript(
        "window.testHost.invoke({op:'message',viewId:window.testController.document.viewId,message:{jsonrpc:'2.0',id:'forged',method:'tools/list'}}).then(()=>false,()=>true)"),true);
      if (process.env.CINDY_MCP_APP_TEST_HOST_SDK==='1') {
        stage='host SDK first generated page';
        await wait(()=>inner()?.executeJavaScript('window.pageState?.ready===true'));
        assert.equal(await inner().executeJavaScript('window.pageState.page'),1);
        assert.equal(await inner().executeJavaScript('window.loaderCompatMode'), 'CSS1Compat');
        assert.equal(await inner().executeJavaScript('window.computedSdkLoaded&&window.externalSdkLoaded'),true);
        assert.equal(await inner().executeJavaScript('typeof window.App'),'undefined');
        assert.equal(record.sdk,undefined);
        const attachment=process.env.CINDY_MCP_APP_TEST_REMOTE!=='1'
          ? await inner().executeJavaScript('window.sdkApp.getHostContext().toolInfo.tool._meta["cindy/attachments"][0]._meta["cindy/file"].url') : undefined;
        stage='host SDK pending approval and second page';
        // Hold an old request in approval, then replace the whole document. Both
        // official App instances allocate the same first tools/call ID.
        await inner().executeJavaScript('void window.sdkApp.callServerTool({name:"echo",arguments:{text:"old-document"}}).catch(()=>{});');
        await wait(()=>!!sdkApprovalSignal);
        await window.webContents.executeJavaScript('window.testController.context({theme:"dark"})');
        await inner().executeJavaScript('document.querySelector("#next").click()');
        await wait(()=>inner().executeJavaScript('window.pageState?.page===2&&window.pageState.ready'));
        assert.equal(sdkApprovalSignal.aborted,true);
        sdkReleaseApproval();
        const answer=await inner().executeJavaScript('window.sdkApp.callServerTool({name:"echo",arguments:{text:"new-document"}})');
        assert.equal(answer.content[0].text,'new-document');
        assert.equal(sdkDispatched.includes('old-document'),false,'released old approval cannot dispatch main.js');
        assert.equal(sdkIds.find(x=>x.text==='old-document').id,sdkIds.find(x=>x.text==='new-document').id);
        assert.equal(await inner().executeJavaScript('window.pageState.theme'),'dark');
        for (const page of [3,4]) {
          stage='host SDK generated page '+page;
          if(page===4){
            await inner().executeJavaScript('void window.sdkApp.callServerTool({name:"echo",arguments:{text:"old-upstream"}}).catch(()=>{});');
            await wait(()=>!!sdkUpstreamSignal);
          }
          await inner().executeJavaScript('document.querySelector("#next").click()');
          await wait(()=>inner().executeJavaScript('window.pageState?.page==='+page+'&&window.pageState.ready'));
          if(page===4){
            assert.equal(sdkUpstreamSignal.aborted,true);
            const result=await inner().executeJavaScript('window.sdkApp.callServerTool({name:"echo",arguments:{text:"new-upstream"}})');
            assert.equal(result.content[0].text,'new-upstream');
            assert.equal(sdkIds.find(x=>x.text==='old-upstream').id,sdkIds.find(x=>x.text==='new-upstream').id);
          }
          assert.deepEqual(await inner().executeJavaScript('({inputs:pageState.inputs,results:pageState.results})'),{inputs:0,results:0});
        }
        stage='host SDK implicit document.write';
        await inner().executeJavaScript('(async()=>{const r=await window.sdkApp.callServerTool({name:"generate_page",arguments:{page:5}});await window.sdkApp.close();document.write(r._meta.view.html);document.close();})()');
        await wait(()=>inner()?.executeJavaScript('window.pageState?.page===5&&window.pageState.ready'));
        if(attachment){
          assert.equal(await inner().executeJavaScript('window.sdkApp.getHostContext().toolInfo.tool._meta["cindy/attachments"][0]._meta["cindy/file"].url'),attachment);
          assert.equal(await inner().executeJavaScript('fetch('+JSON.stringify(attachment)+').then(r=>r.text())'),'host-only-file');
        }
        // G5 regression, integration tier: the generated page's real submit handler
        // must reach the tool via the SDK, while default submission stays CSP-blocked.
        stage='host SDK form click';
        await inner().executeJavaScript('document.querySelector("#bridged input").value="form-click";document.querySelector("#bridged button").click()');
        await wait(()=>inner().executeJavaScript('window.pageState.formResult==="form-click"'));
        assert.ok(sdkDispatched.includes('form-click'));
        assert.equal(await inner().executeJavaScript('window.pageState.defaultPreventedAtHandler'),false,'page submit handler must run before the Host fallback');
        stage='host SDK form Enter';
        await inner().executeJavaScript('document.querySelector("#bridged input").value="form-enter";document.querySelector("#bridged input").focus()');
        // Hidden BrowserWindows do not receive native sendInputEvent key presses on
        // macOS. CDP dispatches a real browser key event without stealing OS focus.
        window.webContents.debugger.attach('1.3');
        try {
          await window.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled',{enabled:true});
          await window.webContents.debugger.sendCommand('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,text:String.fromCharCode(13)});
          await window.webContents.debugger.sendCommand('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
        } finally { window.webContents.debugger.detach(); }
        await wait(()=>inner().executeJavaScript('window.pageState.formResult==="form-enter"'));
        assert.ok(sdkDispatched.includes('form-enter'));
        stage='host SDK native form no-op';
        const formUrl=inner().url, formRequests=requests;
        await inner().executeJavaScript('document.querySelector("#native").action='+JSON.stringify(denied)+';document.querySelector("#native").addEventListener("submit",event=>{window.nativeSubmitEvent=event;});window.addEventListener("submit",event=>{window.windowDelegatePrevented=event.defaultPrevented;});document.addEventListener("securitypolicyviolation",event=>{if(event.violatedDirective==="form-action")window.pageState.formBlocked=true;});document.querySelector("#native button").click()');
        // Codex 4429797202 / Greptile 4429799871: page window delegation runs before the host fallback.
        assert.equal(await inner().executeJavaScript('window.windowDelegatePrevented'),false);
        assert.equal(await inner().executeJavaScript('window.nativeSubmitEvent.defaultPrevented'),true);
        await inner().executeJavaScript('document.querySelector("#native").submit();new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
        // Codex 4430107408: method=dialog closes its dialog without navigation, by button or submit().
        // Codex 4430274397: a control named "method" must not hide the form method.
        assert.equal(await inner().executeJavaScript('(async()=>{const dialog=document.createElement("dialog"),form=document.createElement("form"),button=document.createElement("button"),clobber=document.createElement("input");form.method="dialog";button.value="ok";clobber.name="method";form.append(clobber,button);dialog.append(form);document.body.append(dialog);const frame=()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));dialog.showModal();button.click();await frame();const clicked=!dialog.open&&dialog.returnValue==="ok";dialog.showModal();form.submit();await frame();return clicked&&!dialog.open;})()'),true);
        assert.ok(inner(),'default submission must not replace the App with a CSP error document');
        assert.equal(await inner().executeJavaScript('window.pageState.formBlocked===true'),false);
        assert.equal(inner().url,formUrl,'default submission must not navigate');
        assert.equal(requests,formRequests,'default submission must not send a network request');
        assert.equal((await inner().executeJavaScript('window.sdkApp.callServerTool({name:"echo",arguments:{text:"after-form"}})')).content[0].text,'after-form');
        console.log('HOST_SDK_FORMS_VERDICT=passed (click, Enter, window delegation first, default submit()/button no-op before CSP, method=dialog closes, card still usable)');
        stage='host SDK theme update';
        await window.webContents.executeJavaScript('window.testController.context({theme:"light"})');
        await wait(()=>inner().executeJavaScript('window.pageState.theme==="light"'));
        // Back-to-back notifications reproduce the SDK's automatic resize racing a manual size.
        stage='host SDK size notification';
        await window.webContents.executeJavaScript('window.testState.sizes=[]');
        await inner().executeJavaScript('window.sdkApp.sendSizeChanged({width:680,height:317}).then(()=>window.sdkApp.sendSizeChanged({width:680,height:318}))');
        // Observe delivery, not a transient last size that autoResize can overwrite.
        await wait(()=>window.webContents.executeJavaScript('[317,318].every(height=>window.testState.sizes.some(size=>size.height===height))'));
        stage='host SDK teardown and reopen';
        const previous=inner(), viewId=await window.webContents.executeJavaScript('window.testController.document.viewId');
        await window.webContents.executeJavaScript('window.testController.close()');
        assert.equal(await previous.executeJavaScript('window.pageState.tornDown'),true);
        assert.equal((await net.fetch('cindy-mcp-app://'+viewId+'-view/resource')).status,404);
        assert.equal((await net.fetch('cindy-mcp-app://'+viewId+'-view/__cindy/sdk/ext-apps/app.js')).status,404);
        if(attachment)assert.equal((await net.fetch(attachment)).status,404);
        await new Promise(resolve=>{window.webContents.once('did-finish-load',resolve);window.reload();});
        await wait(()=>inner()?.executeJavaScript('window.pageState?.page===1&&window.pageState.ready'));
        assert.notEqual(await window.webContents.executeJavaScript('window.testController.document.viewId'),viewId);
        assert.equal(JSON.stringify(record),sdkRecordSnapshot,'replacement must not alter the persisted card');
        console.log('HOST_SDK_VERDICT=passed (official import, loader replacement, repeated replacement, pending approval/upstream cancellation, late result isolation, reused request IDs, latest context, no replay)');
        return;
      }
      if(process.env.CINDY_MCP_APP_TEST_BOM==='1')assert.equal(await inner().executeJavaScript('document.compatMode'),'CSS1Compat');
      if(authorMode==='loader'){
        // Integration tier: authored loader + generated SDK page through the real Host
        // and dispatcher. Old shell coverage lacked document replacement and JSON updates.
        // Minimal failure: initial result -> second connect -> save, then load new content.
        stage='loader generated page';
        await wait(()=>inner()?.executeJavaScript("document.querySelector('#connection')?.textContent==='已连接'"));
        assert.equal(loaderCalls.length,1,'first page must not request the view twice');
        assert.equal(await inner().executeJavaScript("document.querySelector('#content h1').textContent"),'Overview');
        assert.equal(await inner().executeJavaScript("document.querySelector('#content p').textContent"),'已按总览打开。');
        stage='loader conversation attachment after document replacement';
        await wait(()=>inner().executeJavaScript("document.querySelector('#attachments img')?.complete===true"));
        assert.deepEqual(await inner().executeJavaScript("(()=>{const i=document.querySelector('#attachments img');return [i.naturalWidth,i.naturalHeight,i.alt,i.src.includes('/__cindy/files/')];})()"),[3,2,'fixture.png',true]);
        assert.equal(await inner().executeJavaScript("fetch(document.querySelector('#attachments img').src).then(r=>r.status+':'+r.headers.get('content-type'))"),'200:image/png');
        stage='loader local update preserves input';
        await inner().executeJavaScript("document.querySelector('input').value='保留输入';document.querySelector('#refresh').click()");
        await wait(()=>inner().executeJavaScript("document.querySelectorAll('#items li').length===3"));
        assert.equal(await inner().executeJavaScript("document.querySelector('input').value"),'保留输入');
        stage='loader form submit click and real Enter';
        await inner().executeJavaScript("document.querySelector('#record-form button').click()");
        await wait(()=>inner().executeJavaScript("document.querySelector('#result').textContent==='已保存 R-1'"));
        await inner().executeJavaScript("document.querySelector('input').value='第二条';document.querySelector('input').focus()");
        // Real browser Enter through CDP (hidden windows ignore sendInputEvent on macOS);
        // implicit submission must reach the page's submit handler, not a synthetic keydown.
        window.webContents.debugger.attach('1.3');
        try {
          await window.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled',{enabled:true});
          await window.webContents.debugger.sendCommand('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,text:String.fromCharCode(13)});
          await window.webContents.debugger.sendCommand('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
        } finally { window.webContents.debugger.detach(); }
        await wait(()=>inner().executeJavaScript("document.querySelector('#result').textContent==='已保存 R-2'"));
        assert.equal(loaderCalls.filter(call=>call.name==='api_write').length,2);
        stage='loader fragment and persistent script';
        await inner().executeJavaScript("document.querySelector('[data-view=chart]').click()");
        await wait(()=>inner().executeJavaScript("document.querySelector('#content h1').textContent==='Chart'"));
        await inner().executeJavaScript("document.querySelector('#refresh').click()");
        await wait(()=>inner().executeJavaScript("document.querySelectorAll('#items li').length===3"));
        assert.equal(await inner().executeJavaScript("document.querySelectorAll('script[type=module]').length"),1);
        assert.equal(await window.webContents.executeJavaScript("document.querySelector('iframe').sandbox.contains('allow-forms')"),true);
        stage='loader native form fallback';
        const loaderUrl=inner().url, loaderRequests=requests, loaderWrites=loaderCalls.length;
        // Unhandled submit button and form.submit() must be no-ops: no request, no navigation.
        await inner().executeJavaScript("(()=>{const form=document.createElement('form');form.action="+JSON.stringify(denied)+";form.method='post';form.innerHTML='<button>native</button>';document.body.append(form);form.querySelector('button').click();form.submit();form.remove();})()");
        await inner().executeJavaScript('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
        assert.ok(inner(),'native submission must not replace the page');
        assert.equal(inner().url,loaderUrl,'native submit must not navigate');
        assert.equal(requests,loaderRequests,'native submit must not reach the network');
        assert.equal(loaderCalls.length,loaderWrites,'native submit must not call tools');
        // Regression (review): switching content must keep the unconfirmed write key, so
        // resubmitting the same content after an unknown outcome cannot create a duplicate.
        stage='loader write key survives a content switch';
        await inner().executeJavaScript("document.querySelector('input').value='切换前'");
        loaderResultOverride={isError:true,content:[{type:'text',text:'写入结果未知'}]};
        await inner().executeJavaScript("document.querySelector('#record-form button').click()");
        await wait(()=>inner().executeJavaScript("document.querySelector('#result').textContent==='写入结果未知'"));
        loaderResultOverride=undefined;
        await inner().executeJavaScript("document.querySelector('[data-view=form]').click()");
        await wait(()=>inner().executeJavaScript("document.querySelector('#content h1')?.textContent==='Form'"));
        await inner().executeJavaScript("document.querySelector('input').value='切换前';document.querySelector('#record-form button').click()");
        await wait(()=>inner().executeJavaScript("document.querySelector('#result').textContent.startsWith('已保存')"));
        const switchWrites=loaderCalls.filter(call=>call.name==='api_write');
        assert.equal(switchWrites.at(-1).args.idempotencyKey,switchWrites.at(-2).args.idempotencyKey,'same content after a switch reuses the write key');
        stage='loader themes and narrow screen';
        for(const theme of ['light','dark']){
          const variables=theme==='light'?{'--color-background-primary':'rgb(248,248,246)','--color-background-secondary':'rgb(238,238,235)','--color-text-primary':'rgb(38,38,38)','--color-border-primary':'rgb(160,160,158)'}:{'--color-background-primary':'rgb(31,31,30)','--color-background-secondary':'rgb(44,44,42)','--color-text-primary':'rgb(235,235,232)','--color-border-primary':'rgb(100,100,98)'};
          await window.webContents.executeJavaScript('window.testController.context('+JSON.stringify({theme,styles:{variables}})+');document.querySelector("iframe").style.width="320px"');
          await wait(()=>inner().executeJavaScript('document.documentElement.style.colorScheme==='+JSON.stringify(theme)));
          await wait(()=>inner().executeJavaScript('innerWidth<=320'));
          await inner().executeJavaScript('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
          const size=await inner().executeJavaScript('({width:innerWidth,scroll:document.documentElement.scrollWidth})');
          assert.ok(size.scroll<=size.width);
          if(process.env.CINDY_AUTHOR_SCREENSHOTS){mkdirSync(process.env.CINDY_AUTHOR_SCREENSHOTS,{recursive:true});writeFileSync(process.env.CINDY_AUTHOR_SCREENSHOTS+'/loader-'+theme+'.png',(await window.webContents.capturePage()).toPNG());}
        }
        assert.equal(turns,0);
        console.log('AUTHOR_APP_VERDICT=passed (loader; first result, generated SDK, hostContext attachment image, JSON preserves inputs, submit click/real Enter, native submit no-op, fragment, Light/Dark)');
        return;
      }
      if(authorMode==='files'){
        // Integration: the shipped capability example used to have no real View coverage.
        // Minimal input: open_showcase then save_form via its page; assert private results
        // render, model-only is rejected, and both themes fit narrow and wide viewports.
        stage='author capability example';
        await wait(()=>inner()?.executeJavaScript("document.querySelector('#connection').textContent==='已连接'"));
        stage='author form';
        await inner().executeJavaScript("document.querySelector('#title-input').value='已核对的记录';document.querySelector('#form button[data-action]').click()");
        await wait(()=>inner().executeJavaScript("document.querySelector('#form pre').textContent.includes('已核对的记录')"));
        await inner().executeJavaScript("document.querySelector('#denied button[data-action]').click()");
        stage='author visibility result';
        await wait(()=>inner().executeJavaScript("document.querySelector('#denied pre').textContent.includes('MCP_APP_TOOL_NOT_VISIBLE')"));
        assert.equal(await inner().executeJavaScript('typeof window.cindy'),'undefined');
        // Integration: fixed template -> real page tools/call -> shipped main.js -> private HTML
        // plus structured data. Existing form coverage cannot detect a missing dynamic renderer.
        // Minimal input: overview then details; each must replace the visible content without networking.
        stage='author dynamic content';
        await inner().executeJavaScript("document.querySelector('#dynamic .buttons button:first-child').click()");
        await wait(()=>inner().executeJavaScript("document.querySelector('#fragment h4')?.textContent==='今日概览'"));
        assert.equal(await inner().executeJavaScript("document.querySelector('#dynamic-data').textContent"),'已完成 2 / 3 项');
        await inner().executeJavaScript("document.querySelector('#dynamic .buttons button:last-child').click()");
        await wait(()=>inner().executeJavaScript("document.querySelector('#fragment h4')?.textContent==='待办明细'"));
        assert.equal(await inner().executeJavaScript("document.querySelectorAll('#fragment li').length"),3);
        assert.equal(await inner().executeJavaScript("document.querySelector('#fragment').textContent.includes('还有一项待完成')"),false);
        assert.equal(await inner().executeJavaScript("JSON.parse(document.querySelector('#dynamic pre').textContent).response.view"),'details');
        assert.equal(turns,0,'dynamic content must not send a model message');
        console.log('AUTHOR_DYNAMIC_CONTENT=passed (real page -> tools/call -> main.js; overview/details, private HTML and structured data, no model message)');

        // Regression: the shipped page sent seq=0, which the real Library rejects.
        // PR #7924: a 200-character Chinese filename also used to exceed the 64-character segment limit.
        // Drag through the DOM, dispatcher, shipped main.js and actual LibraryVault.
        stage='author drag import';
        await inner().executeJavaScript("(()=>{const transfer=new DataTransfer();transfer.items.add(new File(['x'.repeat(2*1024*1024+3)],'中文'+'a'.repeat(185)+'drag-test.txt',{type:'text/plain'}));document.querySelector('#drop .drop').dispatchEvent(new DragEvent('drop',{dataTransfer:transfer,bubbles:true,cancelable:true}));})()");
        await wait(()=>inner().executeJavaScript("document.querySelector('#drop .drop').getAttribute('aria-busy')==='false'"));
        const imported=await inner().executeJavaScript("document.querySelector('#drop pre').textContent");
        assert.ok(imported.includes('sha256') && imported.includes('2097155') && !imported.includes('STREAM_INVALID'),imported);
        const filename=readdirSync(authorLibraryRoot+'/imports').find(name=>name.endsWith('drag-test.txt'));
        assert.ok(filename,imported);
        assert.equal(readFileSync(authorLibraryRoot+'/imports/'+filename,'utf8'),'x'.repeat(2*1024*1024+3));
        assert.ok(imported.includes(createHash('sha256').update('x'.repeat(2*1024*1024+3)).digest('hex')),imported);
        console.log('AUTHOR_DRAG_IMPORT=passed (real page drop, 200-character Chinese filename, three chunks, committed bytes and SHA match)');

        await window.webContents.executeJavaScript('document.body.style.margin="0";document.querySelector("iframe").style.width="100%";document.querySelector("iframe").style.border="0";document.querySelector("iframe").style.display="block"');
        for(const theme of ['light','dark'])for(const width of [360,800]){
          const variables=theme==='light'?{'--color-background-primary':'rgb(248,248,246)','--color-background-secondary':'rgb(238,238,235)','--color-text-primary':'rgb(38,38,38)','--color-text-secondary':'rgb(102,102,100)','--color-border-primary':'rgb(215,215,212)'}:{'--color-background-primary':'rgb(31,31,30)','--color-background-secondary':'rgb(44,44,42)','--color-text-primary':'rgb(235,235,232)','--color-text-secondary':'rgb(165,165,160)','--color-border-primary':'rgb(60,60,58)'};
          if(!window.webContents.debugger.isAttached())window.webContents.debugger.attach('1.3');
          await window.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:false});
          await window.webContents.executeJavaScript('window.testController.context('+JSON.stringify({theme,styles:{variables},containerDimensions:{width,maxHeight:5000}})+')');
          await wait(()=>inner().executeJavaScript('document.documentElement.style.colorScheme==='+JSON.stringify(theme)));
          await wait(()=>inner().executeJavaScript('window.innerWidth==='+width));
          const size=await inner().executeJavaScript('({height:Math.ceil(document.body.getBoundingClientRect().height),scroll:document.documentElement.scrollWidth,width:innerWidth})');
          assert.ok(size.scroll<=width,JSON.stringify(size));
          await window.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride',{width,height:size.height+2,deviceScaleFactor:1,mobile:false});
          await window.webContents.executeJavaScript('document.querySelector("iframe").style.height='+JSON.stringify((size.height+2)+'px'));
          await inner().executeJavaScript('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
          await wait(()=>inner().executeJavaScript('innerHeight>='+size.height));
          let png;stage='screenshot painted '+theme+' '+width;
          await wait(async()=>{window.webContents.invalidate();png=await window.webContents.debugger.sendCommand('Page.captureScreenshot',{format:'png',captureBeyondViewport:true,fromSurface:true});const bitmap=nativeImage.createFromBuffer(Buffer.from(png.data,'base64')).toBitmap();const pixels=new Set();for(let i=0;i<Math.min(bitmap.length,width*400*4);i+=4)pixels.add(bitmap.readUInt32LE(i));return pixels.size>8;});
          if(process.env.CINDY_AUTHOR_SCREENSHOTS){const file=process.env.CINDY_AUTHOR_SCREENSHOTS+'/files-'+theme+'-'+width+'.png';mkdirSync(process.env.CINDY_AUTHOR_SCREENSHOTS,{recursive:true});writeFileSync(file,Buffer.from(png.data,'base64'));}
          console.log('AUTHOR_LAYOUT='+theme+' width='+width+' height='+size.height+' overflow=false');
        }
        window.webContents.debugger.detach();
        console.log('AUTHOR_APP_VERDICT=passed (files; real pack, Electron, dispatcher, private result, visibility, Light/Dark)');
        return;
      }
      if(authorMode){
        // Integration: shipped raw/SDK author examples must actually initialize and
        // invoke main.js through the production dispatcher, ticket and App host.
        // Minimum failure is a copied example with a wrong resource URI or RPC method.
        stage='author example initial result';
        await wait(()=>inner()?.executeJavaScript("document.querySelector('#title').value==='AI draft'"));
        await wait(()=>window.webContents.executeJavaScript('window.testState.size?.height>0'));
        for(const theme of ['light','dark']){
          await window.webContents.executeJavaScript('window.testController.context('+JSON.stringify({theme})+')');
          await wait(()=>inner().executeJavaScript('document.documentElement.style.colorScheme==='+JSON.stringify(theme)));
        }
        await inner().executeJavaScript("document.querySelector('#title').value='已核对的记录';document.querySelector('#save').click()");
        await wait(()=>inner().executeJavaScript("document.querySelector('#status').textContent.includes('已保存 1 次')"));
        assert.equal(await inner().executeJavaScript("document.querySelector('#title').value"),'已核对的记录');
        assert.equal(await inner().executeJavaScript('typeof window.cindy'),'undefined');
        console.log('AUTHOR_APP_VERDICT=passed ('+authorMode+'; real Electron, standard RPC, main.js, size, Light/Dark)');
        return;
      }
      stage='tool input and result';
      await wait(()=>inner()?.executeJavaScript(independent?"document.querySelector('#status').textContent==='Metrics ready'":"document.querySelector('#status').textContent.includes('核对')"));
      if(independent){
        assert.equal(await inner().executeJavaScript("document.querySelector('#threshold').value"),'75');
        assert.equal(await inner().executeJavaScript("window.rawApp.result._meta.viewOnly"),'independent-view-metadata');
        assert.equal(await inner().executeJavaScript("window.rawApp.initialize.protocolVersion"),'2026-01-26');
        stage='size-changed';
        await wait(()=>window.webContents.executeJavaScript("window.testState.size?.height===420&&document.querySelector('iframe').style.height==='420px'"));
      }else assert.deepEqual(await inner().executeJavaScript("[document.querySelector('#title').value,document.querySelector('#body').value]"),['AI draft','Review before creating']);
      assert.deepEqual(await inner().executeJavaScript("[typeof window.testHost,typeof window.require,typeof window.process]"),['undefined','undefined','undefined']);
      if(pluginMode){
        stage='plugin progress and file grants';
        const probe=await inner().executeJavaScript("new Promise(resolve=>{let progress;const listener=e=>{if(e.data.method==='notifications/progress'&&e.data.params.progressToken==='file-probe')progress=e.data.params;if(e.data.id==='file-probe-call'){removeEventListener('message',listener);resolve({progress,result:e.data.result});}};addEventListener('message',listener);parent.postMessage({jsonrpc:'2.0',id:'file-probe-call',method:'tools/call',params:{name:'file_probe',_meta:{progressToken:'file-probe'}}},'*');})");
        assert.deepEqual(probe.progress,{progress:1,total:2,message:'Reading',progressToken:'file-probe'});
        const fileUrl=probe.result.content[0]._meta['cindy/file'].url;
        assert.ok(fileUrl.startsWith('cindy-mcp-app://'));
        assert.deepEqual(await inner().executeJavaScript('fetch('+JSON.stringify(fileUrl)+',{headers:{Range:"bytes=0-3"}}).then(async r=>[r.status,await r.text()])'),[206,'host']);
        assert.equal(await window.webContents.executeJavaScript('fetch('+JSON.stringify(fileUrl)+').then(r=>r.ok).catch(()=>false)'),false);
        const forged=fileUrl.slice(0,fileUrl.lastIndexOf('/')+1)+'forged';
        assert.equal(await inner().executeJavaScript('fetch('+JSON.stringify(forged)+').then(r=>r.status)'),404);
        const viewRequest=async(id,method,params)=>inner().executeJavaScript('new Promise(resolve=>{const handler=e=>{if(e.data.id==='+JSON.stringify(id)+'){removeEventListener("message",handler);resolve(e.data);}};addEventListener("message",handler);parent.postMessage('+JSON.stringify({jsonrpc:'2.0',id,method,params})+',"*");})');
        assert.ok((await viewRequest('download','ui/download-file',{contents:[{type:'resource_link',name:'fixture.txt',uri:'library:fixture.txt'}]})).result);
        assert.equal(readFileSync(process.env.CINDY_MCP_APP_TEST_DIR+'/saved-fixture.txt','utf8'),'host-only-file');
        assert.ok((await viewRequest('bad-download','ui/download-file',{contents:[{type:'resource_link',name:'secret',uri:'library:other.txt'}]})).error);
        const imageUri=probe.result.content[1].uri;
        assert.ok((await viewRequest('image-message','ui/message',{role:'user',content:[{type:'resource_link',name:'picked.png',uri:imageUri}]})).result);
        assert.equal(receivedImages[0].url,imageUri);assert.equal(receivedImages[0].category,'image');
        assert.ok((await viewRequest('bad-image','ui/message',{role:'user',content:[{type:'resource_link',name:'other.png',uri:imageUri.replace('aaaa','bbbb')}]})).error);
        turns=0;
        await inner().executeJavaScript('(()=>{const input=document.createElement("input");input.type="file";input.id="file-input-probe";document.body.append(input);window.fileDropped=false;input.addEventListener("drop",event=>{event.preventDefault();window.fileDropped=event.dataTransfer.files.length===1;});})()');
        window.webContents.debugger.attach('1.3');
        try {
          const targets=await window.webContents.debugger.sendCommand('Target.getTargets');
          const frameTarget=targets.targetInfos.find(target=>target.url===inner().url);
          const frameSession=frameTarget?(await window.webContents.debugger.sendCommand('Target.attachToTarget',{targetId:frameTarget.targetId,flatten:true})).sessionId:undefined;
          const tree=await window.webContents.debugger.sendCommand('DOM.getDocument',{depth:-1,pierce:true},frameSession);
          const find=node=>node.attributes?.includes('file-input-probe')?node:[...(node.children??[]),...(node.shadowRoots??[]),...(node.contentDocument?[node.contentDocument]:[])].map(find).find(Boolean);
          const input=find(tree.root);assert.ok(input,'sandbox file input must be inspectable');
          await window.webContents.debugger.sendCommand('DOM.setFileInputFiles',{nodeId:input.nodeId,files:[process.env.CINDY_MCP_APP_TEST_DIR+'/fixture.txt']},frameSession);
          assert.equal(await inner().executeJavaScript('document.querySelector("#file-input-probe").files[0].name'),'fixture.txt');
          assert.equal(await inner().executeJavaScript('(()=>{const input=document.querySelector("#file-input-probe");const data=new DataTransfer();data.items.add(input.files[0]);input.dispatchEvent(new DragEvent("drop",{dataTransfer:data,bubbles:true}));return window.fileDropped;})()'),true);
        } finally { window.webContents.debugger.detach(); }
        console.log('PLUGIN_UI_FILES=passed (standard progress, Range, downloads, image message grants, CDP file input, DOM drop; native dialogs and OS drag not exercised)');
      }

      assert.deepEqual(await inner().executeJavaScript("(()=>{const policy=document.permissionsPolicy??document.featurePolicy;return ['camera','microphone','geolocation','clipboard-write'].map(name=>policy.allowsFeature(name));})()"),[false,false,false,false]);
      assert.equal(await inner().executeJavaScript("Notification.requestPermission()"),'denied');
      assert.equal(await inner().executeJavaScript("(()=>{try{window.parent.document.body;return false;}catch{return true;}})()"),true);
      assert.equal(await inner().executeJavaScript("getComputedStyle(document.body).backgroundColor"),'rgb(248, 248, 246)');
      stage='reject App-originated Host context';
      const previousMode=await window.webContents.executeJavaScript('window.testState.mode');
      // A normal request is the ordering barrier. A size notification is not:
      // App SDK autoResize and Host coalescing can replace a synthetic height.
      await inner().executeJavaScript("new Promise(resolve=>{const listener=e=>{if(e.source===parent&&e.data?.id==='context-barrier'){removeEventListener('message',listener);resolve();}};addEventListener('message',listener);parent.postMessage({jsonrpc:'2.0',method:'ui/notifications/host-context-changed',params:{displayMode:'fullscreen'}},'*');parent.postMessage({jsonrpc:'2.0',id:'context-barrier',method:'tools/list',params:{}},'*');})");
      assert.equal(await window.webContents.executeJavaScript('window.testState.mode'),previousMode);
      stage='theme change';
      await window.webContents.executeJavaScript("window.testController.context({theme:'dark',styles:{variables:{'--color-background-primary':'rgb(31,31,30)','--color-text-primary':'rgb(255,255,255)'}}})");
      await wait(async()=>await inner().executeJavaScript("getComputedStyle(document.body).backgroundColor")==='rgb(31, 31, 30)');
      if(independent){
        stage='update-model-context';
        await inner().executeJavaScript("document.querySelector('#threshold').value='88';document.querySelector('#threshold').dispatchEvent(new Event('input'))");
        await wait(async()=> (await host.modelContext('task')).text.includes('88'));assert.equal(turns,0);
        stage='App tool call';await inner().executeJavaScript("document.querySelector('#refresh').click()");
        await wait(()=>inner().executeJavaScript("window.rawApp.result.structuredContent.metrics.threshold===88&&window.rawApp.result.structuredContent.metrics.refreshes===1"));assert.equal(turns,0);
        if(pluginMode){
          for(const trigger of ['click','script']){
            let approve;approvalGate=new Promise(resolve=>{approve=resolve;});
            const before=pageApprovals;
            if(trigger==='click')await inner().executeJavaScript("document.querySelector('#refresh').click()");
            else await inner().executeJavaScript("window.scriptApprovalResult=null;void window.rawApp.request('tools/call',{name:'refresh_metrics',arguments:{threshold:88}}).then(result=>{window.scriptApprovalResult=result;})");
            await wait(()=>pageApprovals===before+1);
            assert.equal(await inner().executeJavaScript('window.rawApp.result.structuredContent.metrics.refreshes'),trigger==='click'?1:2);
            if(trigger==='script')assert.equal(await inner().executeJavaScript('window.scriptApprovalResult'),null);
            approvalGate=undefined;approve();
            await wait(()=>inner().executeJavaScript(trigger==='click'?'window.rawApp.result.structuredContent.metrics.refreshes===2':'window.scriptApprovalResult?.structuredContent.metrics.refreshes===3'));
          }
          console.log('PLUGIN_PAGE_APPROVAL=passed (click and script both await Host approval before execution)');
        }
        stage='ui/message';await inner().executeJavaScript("document.querySelector('#ask').click()");await wait(()=>turns===1);
        stage='display mode';await inner().executeJavaScript("document.querySelector('#mode').click()");await wait(()=>window.webContents.executeJavaScript("window.testState.mode==='fullscreen'"));
        assert.equal(await inner().executeJavaScript("window.rawApp.request('ui/request-display-mode',{mode:'pip'}).then(result=>result.mode)"),'fullscreen');
        stage='Escape from focused App input';
        await inner().executeJavaScript("document.querySelector('#threshold').focus()");
        window.webContents.sendInputEvent({type:'keyDown',keyCode:'Escape'});
        window.webContents.sendInputEvent({type:'keyUp',keyCode:'Escape'});
        await wait(()=>inner().executeJavaScript("window.rawApp.hostContext.displayMode==='inline'"));
        stage='declared connect and resource domains';
        assert.equal(await inner().executeJavaScript('fetch('+JSON.stringify(allowed+'/api')+').then(response=>response.text())'),'declared-domain');
        await inner().executeJavaScript('new Promise((resolve,reject)=>{const script=document.createElement("script");script.src='+JSON.stringify(allowed+'/asset.js')+';script.onload=()=>resolve(true);script.onerror=()=>reject(new Error("Declared script failed"));document.body.appendChild(script);})');
        assert.equal(await inner().executeJavaScript('window.allowedAssetLoaded'),true);
        stage='declared frame domain';await inner().executeJavaScript('(()=>{const frame=document.createElement("iframe");frame.src='+JSON.stringify(allowed+'/frame')+';document.body.appendChild(frame);})()');
        await wait(()=>window.webContents.mainFrame.framesInSubtree.some(frame=>frame.url===allowed+'/frame'));
        const nested=window.webContents.mainFrame.framesInSubtree.find(frame=>frame.url===allowed+'/frame');
        await nested.executeJavaScript('location.href='+JSON.stringify(denied));
        // Chromium may commit an error-page URL for a CSP-blocked frame; the
        // invariant is that no request reaches the undeclared origin.
        await new Promise(resolve=>setTimeout(resolve,150));assert.equal(requests,0);
        assert.equal(await inner().executeJavaScript('(()=>{const base=document.createElement("base");base.href='+JSON.stringify(allowed+'/base/')+';document.head.appendChild(base);return document.baseURI;})()'),allowed+'/base/');
      }else{
        await inner().executeJavaScript("document.querySelector('#title').value='用户核对后的申请';document.querySelector('#title').dispatchEvent(new Event('input'))");
        await wait(async()=> (await host.modelContext('task')).text.includes('用户核对后的申请'));assert.equal(turns,0);
        await inner().executeJavaScript("document.querySelector('#submit').click()");
        await wait(()=>inner().executeJavaScript("document.querySelector('#status').textContent.includes('已创建模拟申请')"));assert.equal(turns,0);
      }
      if(runtimeMetrics){
        const currentContext=await host.modelContext('task');await currentContext.assertCurrent();
        runtimeMetrics.appContextBytes=Buffer.byteLength(currentContext.text);
        assert.ok(currentContext.text);assert.equal(turns,independent?1:0);
        runtimeMetrics.contextUpdatesStartedModelTurns=0;runtimeMetrics.explicitMessageTurns=turns;
        currentContext.consume();assert.equal((await host.modelContext('task')).text,'');runtimeMetrics.contextConsumedOnce=true;
        assert.equal(JSON.stringify(await modelClient.listTools()),stableCatalog);assert.equal(modelClient.getInstructions(),stableInstructions);
        runtimeMetrics.catalogStableAfterAppUpdates=true;
        console.log('MCP_APPS_RUNTIME_METRICS='+JSON.stringify(runtimeMetrics));
      }
      assert.equal(await inner().executeJavaScript('fetch('+JSON.stringify(denied)+').then(()=>false,()=>true)'),true);
      await inner().executeJavaScript("window.parent.postMessage({jsonrpc:'2.0',method:'ui/notifications/sandbox-resource-ready',params:{html:'forged'}},'*')");
      const appFrame=inner();
      const viewId=await window.webContents.executeJavaScript('window.testController.document.viewId');
      await window.webContents.executeJavaScript('window.testController.close()');
      if(independent)assert.equal(await appFrame.executeJavaScript('window.rawApp.teardown'),true);
      assert.equal((await net.fetch('cindy-mcp-app://'+viewId+'-view/resource')).status,404);
      await appFrame.executeJavaScript('location.href='+JSON.stringify(denied));
      await new Promise(resolve=>setTimeout(resolve,150));assert.equal(requests,0);
      const doc={viewId,html:'<!doctype html><body>owner test',csp:appCsp().header,prefersBorder:true};supplyMcpAppDocument(doc);globalThis.mcpTestOwner={};
      assert.equal((await net.fetch('cindy-mcp-app://'+viewId+'-view/resource')).status,404);
      if(process.env.CINDY_MCP_APP_TEST_REMOTE==='1')console.log('MCP_APPS_REMOTE_FRAME_VERDICT=passed (Main-bound remote View, authenticated frame RPC, rejected Renderer forgery, remote teardown)');
      if(pluginMode)console.log('PLUGIN_UI_VERDICT=passed (virtual MCP, real dispatcher, main.js handler, '+(independent?'raw JSON-RPC':'official App SDK')+')');
      console.log(independent?'MCP_APPS_RAW_SANDBOX_VERDICT=passed (SDK-free dashboard, blob/list, tool/message/context, display/size, Light/Dark, declared CSP domains, teardown, owner)':'MCP_APPS_SANDBOX_VERDICT=passed (official App, edit/create, Light/Dark, origins, preload, CSP, navigation, teardown, owner)');
    }).catch(error=>{console.error(error);process.exitCode=1;}).finally(async()=>{
      await modelClient?.close();await modelFacade?.close();await host?.reset();await connection?.close();forbidden?.close();window?.destroy();app.exit(process.exitCode??0);
    });
  `,
    },
  });
  const environment = {
    ...process.env,
    CINDY_MCP_APP_TEST_DIR: temporary,
    CINDY_MCP_APP_TEST_PLUGIN: pluginView ? '1' : '0',
    CINDY_MCP_APP_TEST_URL: endpoint.url,
    CINDY_MCP_APP_TEST_RAW: independent ? '1' : '0',
    CINDY_MCP_APP_TEST_HOST_SDK: hostSdk ? '1' : '0',
    CINDY_MCP_APP_TEST_BOM: bom ? '1' : '0',
    CINDY_MCP_APP_TEST_REMOTE: remoteView ? '1' : '0',
    CINDY_MCP_APP_TEST_METRICS: measureMetrics ? '1' : '0',
    CINDY_MCP_APP_TEST_ALLOWED: allowed,
    CINDY_MCP_APP_TEST_AUTHOR: authorMode ?? "",
  };
  delete environment.ELECTRON_RUN_AS_NODE;
  const electron = createRequire(import.meta.url)('electron');
  const code = await new Promise((resolve, reject) => {
    const child = spawn(electron, [path.join(temporary, 'verify.cjs')], {
      env: environment,
      windowsHide: true,
      stdio: 'inherit',
    });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('隔离沙箱验证超时，测试进程已停止。'));
    }, 60_000);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
  assert.equal(code, 0, '隔离 Electron 沙箱验证失败');
} finally {
  await endpoint.close();
  assets.closeAllConnections();
  await new Promise((resolve) => assets.close(resolve));
  // mkdtemp guarantees a private task directory under os.tmpdir().
  assert.equal(path.dirname(path.resolve(temporary)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(temporary).startsWith('cindy-mcp-app-sandbox-'));
  await rm(temporary, { recursive: true, force: true });
}
