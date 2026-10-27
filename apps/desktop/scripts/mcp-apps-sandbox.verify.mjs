/** Explicit Electron integration check; never launches or restarts Cindy. */
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
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
import { createRawAppServer } from './mcp-apps-raw-fixture.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const temporary = await mkdtemp(path.join(os.tmpdir(), 'cindy-mcp-app-sandbox-'));
const independent = process.argv.includes('--raw');
const remoteView = process.argv.includes('--remote');
const measureMetrics = process.argv.includes('--metrics');
const assets = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.url === '/asset.js') {
    res.setHeader('Content-Type', 'text/javascript');
    res.end('window.allowedAssetLoaded=true;');
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
    window.testState = {};
    let frame;
    const controller = new McpAppController((_id,input)=>window.testHost.invoke(input),'task','card',
      message=>frame?.contentWindow?.postMessage(message,'*'),message=>{
        if(message.method==='ui/notifications/initialized')window.testState.initialized=true;
        if(message.method==='ui/notifications/size-changed'){window.testState.size=message.params;if(frame)frame.style.height=Math.min(1200,message.params.height)+'px';}
        if(message.method==='ui/notifications/host-context-changed'&&message.params.displayMode)window.testState.mode=message.params.displayMode;
      },error=>{window.testState.error=String(error);});
    window.testController=controller;
    window.addEventListener('message',event=>{
      if(event.source!==frame?.contentWindow)return;
      if(event.data?.method==='ui/notifications/sandbox-proxy-ready')controller.sandboxReady('cindy-mcp-app://'+controller.document.viewId+'-view/resource');
      else controller.receive(event.data);
    });
    controller.open({platform:'desktop',theme:'light',styles:{variables:{'--color-background-primary':'rgb(248,248,246)','--color-text-primary':'rgb(0,0,0)'}}}).then(doc=>{
      frame=document.createElement('iframe');frame.sandbox='allow-scripts allow-same-origin';frame.src='cindy-mcp-app://'+doc.viewId+'/sandbox';frame.style='width:700px;height:550px';document.body.appendChild(frame);
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
    import http from 'node:http';
    import { app, BrowserWindow, protocol, ipcMain, net } from 'electron';
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
    import { mcpAppSchemePrivilege, registerMcpAppProtocol, supplyMcpAppDocument, removeMcpAppDocument } from '../src/main/mcp-apps/sandboxProtocol.ts';
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
      const allowed=process.env.CINDY_MCP_APP_TEST_ALLOWED;
      const config={id:'example',url:process.env.CINDY_MCP_APP_TEST_URL,transport:'http'};
      connection=new AppConnection(config);const client=await connection.getClient();
      const tool=(await connection.tools()).find(tool=>tool.name===(independent?'open_metrics':'draft_form'));
      const args=independent?{threshold:75}:{title:'AI draft',body:'Review before creating'};
      const result=await client.callTool({name:tool.name,arguments:args});
      let record={version:1,serverId:'example',serverRevision:appServerRevision(config),resourceUri:tool._meta.ui.resourceUri,tool,arguments:args,result};
      let turns=0;
      host=new McpAppsHost({owner:()=>globalThis.mcpTestOwner,config:()=>config,readCard:async()=>record,writeCard:async(_s,_c,value)=>{record=value;},authorizeTool:async()=>{},sendMessage:async()=>{turns++;},disposeDocument:removeMcpAppDocument});
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
      assert.deepEqual(await inner().executeJavaScript("(()=>{const policy=document.permissionsPolicy??document.featurePolicy;return ['camera','microphone','geolocation','clipboard-write'].map(name=>policy.allowsFeature(name));})()"),[false,false,false,false]);
      assert.equal(await inner().executeJavaScript("Notification.requestPermission()"),'denied');
      assert.equal(await inner().executeJavaScript("(()=>{try{window.parent.document.body;return false;}catch{return true;}})()"),true);
      assert.equal(await inner().executeJavaScript("getComputedStyle(document.body).backgroundColor"),'rgb(248, 248, 246)');
      stage='reject App-originated Host context';
      const previousMode=await window.webContents.executeJavaScript('window.testState.mode');
      await inner().executeJavaScript("window.parent.postMessage({jsonrpc:'2.0',method:'ui/notifications/host-context-changed',params:{displayMode:'fullscreen'}},'*');window.parent.postMessage({jsonrpc:'2.0',method:'ui/notifications/size-changed',params:{height:421}},'*');");
      await wait(()=>window.webContents.executeJavaScript('window.testState.size?.height===421'));
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
    CINDY_MCP_APP_TEST_URL: endpoint.url,
    CINDY_MCP_APP_TEST_RAW: independent ? '1' : '0',
    CINDY_MCP_APP_TEST_REMOTE: remoteView ? '1' : '0',
    CINDY_MCP_APP_TEST_METRICS: measureMetrics ? '1' : '0',
    CINDY_MCP_APP_TEST_ALLOWED: allowed,
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
