/** Integration: real page transport plus the production service must preserve
 * plugin JSON. The old invoke stub hid its loss. Also exercise browser-native
 * BroadcastChannel across real owner/instance partitions, not an in-memory bus.
 * This fixture never starts Cindy or changes an installed plugin. */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { build } from 'esbuild';

const scripts = fileURLToPath(new URL('../..', import.meta.url));
const temporary = await mkdtemp(path.join(os.tmpdir(), 'cindy-native-page-'));
await mkdir(path.join(temporary, 'plugin/ui'), { recursive: true });
await writeFile(path.join(temporary, 'host.html'), '<!doctype html><body></body>');
await writeFile(path.join(temporary, 'plugin/ui/view.html'), '<!doctype html><body><script src="view.js"></script></body>');
await writeFile(path.join(temporary, 'plugin/ui/view.js'), `
window.pageResult={};
(async()=>{
 try {
  pageResult.context=await cindy.ui.read();
  pageResult.capabilities=await cindy.ui.capabilities();
  pageResult.before=await cindy.ui.appearance.read();
  pageResult.visibilityBefore=await cindy.ui.visibility.read();
  try { pageResult.action=await cindy.ui.invoke({actionId:'save',values:{name:'sample'},data:{query:{ids:['one']}}}); }
  catch { pageResult.actionDenied=true; }
  try { pageResult.after=await cindy.ui.appearance.set({uiFont:{size:16}}); }
  catch { pageResult.appearanceDenied=true; }
  try { pageResult.visibilityAfter=await cindy.ui.visibility.set({workspace:false}); }
  catch { pageResult.visibilityDenied=true; }
  pageResult.done=true;
 } catch(error) { pageResult.error=String(error); }
})();
`);

await build({ bundle: true, platform: 'node', format: 'cjs', external: ['electron'],
  entryPoints: [fileURLToPath(new URL('../../../src/preload/ghostPreload.ts', import.meta.url))],
  outfile: path.join(temporary, 'ghostPreload.cjs') });

await build({
  bundle: true, platform: 'node', format: 'cjs', external: ['electron'],
  outfile: path.join(temporary, 'verify.cjs'),
  plugins: [
    { name: 'host-sdk-raw', setup(builder) {
      builder.onResolve({ filter: /ext-apps\/app-with-deps\?raw$/ }, () => ({ path: createRequire(import.meta.url).resolve('@modelcontextprotocol/ext-apps/app-with-deps'), namespace: 'sdk-raw' }));
      builder.onLoad({ filter: /.*/, namespace: 'sdk-raw' }, async args => ({ contents: await readFile(args.path, 'utf8'), loader: 'text' }));
    } },
    { name: 'test-owner', setup(builder) {
      builder.onResolve({ filter: /localDb\/client\/current\.js$/ }, () => ({ path: 'owner', namespace: 'test-owner' }));
      builder.onLoad({ filter: /.*/, namespace: 'test-owner' }, () => ({ contents: 'export const getCurrentDbClientSnapshot=()=>globalThis.testOwner;' }));
    } },
  ],
  stdin: { resolveDir: scripts, contents: `
    import assert from 'node:assert/strict';
    import { app, BrowserWindow, protocol, session } from 'electron';
    import { mcpAppSchemePrivilege, registerMcpAppProtocol, mountNativeUiPageDocument, unmountRemoteAppDocument } from '../src/main/mcp-apps/sandboxProtocol.ts';
    import { createPluginUiPageBridge } from '../src/main/cindy-brain/pluginUiPageBridge.ts';
    import { readPluginUiPageFile } from '../src/main/cindy-brain/pluginUiPageResources.ts';
    import { PluginUiService } from '../src/main/cindy-brain/pluginUiService.ts';
    import { ownerScopedGhostPartitionForInstalledGhost } from '../src/main/cindy-brain/ghostWebviewPartition.ts';
    import { PLUGIN_UI_CAPABILITIES } from '@cindy/maker-shared';
    app.setPath('userData',process.env.CINDY_NATIVE_PAGE_TEST+'/profile');
    protocol.registerSchemesAsPrivileged([mcpAppSchemePrivilege,
      {scheme:'cindy-ghost',privileges:{standard:true,secure:true,supportFetchAPI:true}}]);
    globalThis.testOwner={};
    const wait=async check=>{const end=Date.now()+12000;let error;while(Date.now()<end){try{if(await check())return;}catch(e){error=e;}await new Promise(resolve=>setTimeout(resolve,50));}throw error||new Error('native page check timed out');};
    void app.whenReady().then(async()=>{
      registerMcpAppProtocol();
      const window=new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});
      await window.loadFile(process.env.CINDY_NATIVE_PAGE_TEST+'/host.html');
      const caller='renderer:'+window.webContents.id;
      const ghost={dir:process.env.CINDY_NATIVE_PAGE_TEST+'/plugin',ui:{version:1,contributions:[{id:'view',point:'composer.tools',scope:'session',page:'ui/view.html'}]}};
      const source={ghost,contributionId:'view',assertCurrent:()=>{}};
      let actions=0,writes=0,visibilityWrites=0;
      const instance={id:'page-plugin',token:'approved-runtime',ui:ghost.ui};
      const service=new PluginUiService({
        current:id=>id===instance.id?instance:null,wake:async()=>true,
        authorize:async()=>({current:()=>true,allows:id=>id===instance.id}),changed:()=>{},
        send:(id,message)=>{
          queueMicrotask(()=>{
            if(message.type==='ui-view-request')service.handle(id,{type:'ui-view-result',
              requestId:message.requestId,viewId:message.viewId,
              content:{controls:[],blocks:[],actions:[{id:'save',label:'Save'}],fallbackMarkdown:''}});
            if(message.type==='event'&&message.name==='ui-action'){
              actions++;
              service.handle(id,{type:'ui-action-result',invocationId:message.invocationId,viewId:message.viewId,
                result:{status:'completed',data:{name:message.values.name,items:[{id:'one',selected:true}],input:message.data}}});
            }
          });return true;
        }
      });
      service.reconcile([instance]);service.handle(instance.id,{type:'ui-register',contributionId:'view'});
      const controller='local:'+window.webContents.id;
      const view=(await service.read(controller,{sessionId:'task',point:'composer.tools',capabilities:PLUGIN_UI_CAPABILITIES})).views[0];
      const bound=await service.bindPage(controller,'task',view.viewId,view.revision);
      async function mount(readOnly){
        const bridge=createPluginUiPageBridge({current:bound.current,
          read:bound.read,capabilities:bound.capabilities,invoke:bound.invoke,
          appearance:async input=>{if(input.kind==='set')writes++;return {ok:true,data:{revision:input.kind}};},
          visibility:async input=>{if(input.kind==='set')visibilityWrites++;return {ok:true,data:{workspace:input.kind!=='set'}};}
        },{readOnly});
        const entry=await readPluginUiPageFile(source,{kind:'entry'});
        const id=mountNativeUiPageDocument({html:entry.bytes.toString(),entry:entry.path},caller,bridge.handle,
          async path=>{const asset=await readPluginUiPageFile(source,{kind:'asset',path});return new Response(asset.bytes,{headers:{'Content-Type':asset.mimeType}});},bridge.dispose);
        await window.webContents.executeJavaScript('window.failed=false;window.addEventListener("message",e=>{if(e.source===document.querySelector("iframe")?.contentWindow&&e.data?.method==="ui/notifications/sandbox-failed")window.failed=true;});(()=>{const f=document.createElement("iframe");f.sandbox="allow-scripts allow-same-origin allow-forms";f.src='+JSON.stringify('cindy-mcp-app://'+id+'/sandbox')+';document.body.appendChild(f);})()');
        const inner=()=>window.webContents.mainFrame.framesInSubtree.find(frame=>frame.url==='cindy-mcp-app://'+id+'-view/resource');
        await wait(async()=>inner()&&await inner().executeJavaScript('window.pageResult?.done===true'));
        return {id,inner};
      }
      const page=await mount(false);
      const result=await page.inner().executeJavaScript('window.pageResult');
      assert.equal(result.context.scope.sessionId,'task');assert.deepEqual(result.capabilities.pages,['html']);
      assert.equal(result.before.revision,'read');assert.equal(result.action.data.name,'sample');assert.equal(result.after.revision,'set');
      assert.deepEqual(result.action.data.items,[{id:'one',selected:true}]);
      assert.deepEqual(result.action.data.input,{query:{ids:['one']}});
      assert.equal(result.visibilityBefore.workspace,true);assert.equal(result.visibilityAfter.workspace,false);
      assert.equal(actions,1);assert.equal(writes,1);assert.equal(visibilityWrites,1);
      assert.equal(await page.inner().executeJavaScript('fetch("https://example.invalid/").then(()=>false,()=>true)'),true);
      unmountRemoteAppDocument(page.id,caller);
      await wait(()=>window.webContents.executeJavaScript('window.failed===true'));
      await window.webContents.executeJavaScript('document.querySelector("iframe").remove()');
      const historical=await mount(true);
      const history=await historical.inner().executeJavaScript('window.pageResult');
      assert.equal(history.actionDenied,true);assert.equal(history.appearanceDenied,true);assert.equal(history.visibilityDenied,true);
      assert.equal(history.visibilityBefore.workspace,true);
      assert.equal(actions,1);assert.equal(writes,1);assert.equal(visibilityWrites,1);
      unmountRemoteAppDocument(historical.id,caller);
      const owner={mode:'cloud',dataOwnerId:'fixture-owner',generation:1};
      const installed={manifest:{id:'channel-plugin'},namespace:null,dir:'/fixture/plugin',approval:{state:'approved',revision:'receipt'}};
      const partitions=new Set();
      async function pluginPage(plugin,account,viewMode){
        const partition=ownerScopedGhostPartitionForInstalledGhost(plugin,account);
        if(!partitions.has(partition)){
          partitions.add(partition);
          session.fromPartition(partition).protocol.handle('cindy-ghost',()=>new Response('<!doctype html><body></body>',
            {headers:{'Content-Type':'text/html'}}));
        }
        const page=new BrowserWindow({show:false,webPreferences:{partition,sandbox:true,contextIsolation:true,
          nodeIntegration:false,nodeIntegrationInSubFrames:false,nodeIntegrationInWorker:false,webSecurity:true,
          allowRunningInsecureContent:false,experimentalFeatures:false,plugins:false,navigateOnDragDrop:false,
          preload:process.env.CINDY_NATIVE_PAGE_TEST+'/ghostPreload.cjs',
          ...(viewMode?{additionalArguments:['--cindy-plugin-tab-view']}:{})}});
        await page.loadURL('cindy-ghost://channel-plugin/'+(viewMode?'view.html':'__boot__'));
        return page;
      }
      const logic=await pluginPage(installed,owner,false);
      const tab=await pluginPage(installed,owner,true);
      const otherOwner=await pluginPage(installed,{...owner,dataOwnerId:'other-owner'},true);
      const otherInstance=await pluginPage({...installed,namespace:'example'},owner,true);
      for(const guest of [tab,otherOwner,otherInstance]){
        assert.deepEqual(await guest.webContents.executeJavaScript('Object.keys(cindy.ui)'),['view']);
        await guest.webContents.executeJavaScript('window.messages=[];window.channel=new BroadcastChannel("fixture-data");channel.onmessage=e=>messages.push(e.data);void 0');
      }
      await logic.webContents.executeJavaScript('window.channel=new BroadcastChannel("fixture-data");channel.onmessage=e=>{channel.postMessage({type:"result",requestId:e.data.requestId,data:{items:[{id:"one"}]}});channel.postMessage({type:"updated",revision:2});};void 0');
      await tab.webContents.executeJavaScript('channel.postMessage({requestId:"from-view",query:{id:"one"}})');
      await wait(async()=>await tab.webContents.executeJavaScript('messages.length===2'));
      assert.deepEqual(await tab.webContents.executeJavaScript('messages'),[
        {type:'result',requestId:'from-view',data:{items:[{id:'one'}]}},{type:'updated',revision:2}]);
      for(const guest of [otherOwner,otherInstance])assert.deepEqual(await guest.webContents.executeJavaScript('messages'),[]);
      for(const guest of [logic,tab,otherOwner,otherInstance])guest.destroy();
      console.log('NATIVE_PAGE_VERDICT=passed (real Electron, production action service, JSON round trip, BroadcastChannel result/update, owner/instance isolation, historical read-only, close)');
      window.destroy();app.exit(0);
    }).catch(error=>{console.error(error);app.exit(1);});
  ` },
});
const environment = { ...process.env, CINDY_NATIVE_PAGE_TEST: temporary };
delete environment.ELECTRON_RUN_AS_NODE;
const electron = createRequire(import.meta.url)('electron');
const result = await new Promise((resolve, reject) => {
  const child = spawn(electron, [path.join(temporary, 'verify.cjs')], { env: environment, stdio: 'inherit' });
  const timer = setTimeout(() => { child.kill(); reject(new Error('隔离页面验证超时')); }, 30000);
  child.once('error', error => { clearTimeout(timer); reject(error); });
  child.once('exit', (code, signal) => { clearTimeout(timer); resolve({ code, signal }); });
});
assert.equal(result.code, 0, `隔离页面验证失败：${result.signal ?? result.code}`);
