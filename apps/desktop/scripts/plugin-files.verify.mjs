/** Real Electron, isolated profile. Dialog stubs exist only inside this verifier. */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { build } from 'esbuild';
const root = await mkdtemp(path.join(os.tmpdir(), 'cindy-plugin-files-'));
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
try {
  await build({ bundle: true, platform: 'node', format: 'cjs', outfile: path.join(root, 'verify.cjs'), external: ['electron'],
    stdin: { resolveDir: scriptDir, contents: `
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { app, dialog, net } from 'electron';
import { GhostPickSlot } from '../src/main/cindy-brain/pickSlot.ts';
import { GhostPipeDispatcher } from '../src/main/cindy-brain/pipeDispatcher.ts';
import { importPickedFiles } from '../src/main/cindy-brain/pickedFiles.ts';
import { LibraryVault } from '../src/main/cindy-brain/libraryVault.ts';
import { GhostNetworkSlot } from '../src/main/cindy-brain/networkSlot.ts';
const root=process.env.CINDY_FILES_VERIFY_DIR;
app.setPath('userData',path.join(root,'profile'));
let server;
void app.whenReady().then(async()=>{
  const selected=path.join(root,'selected.txt');await fs.writeFile(selected,'user input');
  const vault=new LibraryVault({rootDir:()=>path.join(root,'library'),ghostId:'fixture'});await vault.open();
  let owner='A';const assertCurrent=()=>{assert.equal(owner,'A');};
  const ghost={enabled:true,manifest:{id:'fixture',name:'Fixture',pick:true,library:true,network:{hosts:['fixture.example']}}};
  const originalDialog=dialog.showOpenDialog;
  dialog.showOpenDialog=async()=>({canceled:false,filePaths:[selected]});
  const slot=new GhostPickSlot({getGhost:()=>ghost,getMutationTarget:()=>owner,showDirectoryDialog:async()=>null,
    showFileDialog:async()=>{const r=await dialog.showOpenDialog({properties:['openFile']});return r.canceled?null:r.filePaths;},
    depositDir:()=>({ok:false,message:'not used'}),
    importFiles:(id,paths,input)=>importPickedFiles({tempRoot:root,usageBytes:async()=>0,deposit:async()=>{throw new Error('not used');},
      importLibrary:async(_id,input)=>{const r=await vault.importStream(input);return r.ok?{...r,ref:'library:'+r.path}:r;}
    },id,paths,input),
  });
  let picked;
  try{picked=await slot.handleRequest('fixture',{mode:'file',into:'library'});}finally{dialog.showOpenDialog=originalDialog;}
  assert.equal(picked.ok,true);assert.equal(picked.files[0].path,undefined);
  // Regression: cancellation while the native picker is pending must not start
  // an import or mint a ticket. Real dispatcher/slot, test-process dialog only.
  ghost.manifest.tools=[{name:'pick',description:'Pick'}];
  const dispatcher=new GhostPipeDispatcher({getGhost:()=>ghost,runtimeStateOf:()=> 'running',spawn:async()=>({ok:true}),sendToGhost:()=>true});
  let choose;const pendingPanel=new Promise(resolve=>{choose=resolve;});
  let imports=0,tickets=0,attempt=0;
  const cancelledSlot=new GhostPickSlot({getGhost:()=>ghost,getMutationTarget:()=>owner,now:()=>++attempt*4000,
    getPendingCallSignal:(id,call)=>dispatcher.getPendingCallSignal(id,call),holdCall:(id,call,budget)=>dispatcher.holdCall(id,call,budget),releaseCall:(id,call)=>dispatcher.releaseCall(id,call),
    showDirectoryDialog:async()=>null,showFileDialog:()=>pendingPanel,
    importFiles:async()=>{imports++;throw new Error('late import');},depositDir:()=>{tickets++;return {ok:false,message:'late ticket'};}});
  const abort=new AbortController();
  const running=dispatcher.callGhostTool({ghostId:'fixture',tool:'pick',args:{},callId:'panel',signal:abort.signal});
  const selecting=cancelledSlot.handleRequest('fixture',{mode:'file',into:'library',callId:'panel',deposit:true});
  abort.abort();assert.equal((await selecting).errorCode,'CANCELLED');assert.equal((await running).ok,false);
  assert.equal((await cancelledSlot.handleRequest('fixture',{mode:'file',into:'library'})).errorCode,'BUSY');
  choose([selected]);await new Promise(resolve=>setImmediate(resolve));
  assert.equal(imports,0);assert.equal(tickets,0);
  const imported=picked.files[0].ref.slice('library:'.length);
  assert.equal(await fs.readFile(path.join(root,'library',imported),'utf8'),'user input');
  let posts=0, uploaded='';
  server=http.createServer(async(req,res)=>{
    if(req.method==='POST'){posts++;for await(const chunk of req)uploaded+=chunk;res.setHeader('Content-Type','application/json');res.end('{"received":true}');}
    else{res.setHeader('Content-Type','application/octet-stream');res.write('streamed ');res.end('download');}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin='http://127.0.0.1:'+server.address().port;
  const phases=[];
  const network=new GhostNetworkSlot({getGhost:()=>ghost,readSecret:()=>null,getLoginEmail:()=>null,
    captureRequestGuard:()=>assertCurrent,createTransferProgress:()=> (...value)=>phases.push(value),
    fetchImpl:(url,init)=>net.fetch(origin+new URL(url).pathname,init),fetchPublicImpl:()=>{throw new Error('not used');},
    isSupportedMediaMime:()=>false,saveGhostMedia:()=>{throw new Error('not used');},readGhostMedia:async()=>null,
    takeDirDeposit:()=>null,writeSaveDeposit:async()=>null,
    readLibraryFile:async(_id,relative)=>{const safe=await vault.resolveExistingFile(relative);if(!safe)return new Response(null,{status:404});return new Response(await fs.readFile(safe));},
    saveLibraryStream:async(_id,input)=>{const r=await vault.importStream(input);return r.ok?{...r,ref:'library:'+r.path}:r;},
  });
  const downloaded=await network.handleFetchRequest('fixture',{url:'https://fixture.example/download',as:'library',path:'download.txt'});
  assert.equal(downloaded.ok,true);assert.equal(downloaded.library.bytes,17);
  assert.equal(await fs.readFile(path.join(root,'library','download.txt'),'utf8'),'streamed download');
  const uploadedResult=await network.handleFetchRequest('fixture',{url:'https://fixture.example/upload',method:'POST',upload:{library:[imported]}});
  assert.equal(uploadedResult.ok,true);assert.equal(posts,1);assert.ok(uploaded.includes('user input'));
  assert.ok(phases.some(([bytes,,message])=>bytes===17&&message==='正在保存文件'));
  assert.ok(phases.some(([bytes,total,message])=>bytes===undefined&&total===undefined&&message==='正在上传'));
  await vault.invalidate();
  console.log('PLUGIN_FILES_VERDICT=passed (real Electron; production pick/import/vault/network slots; test-only dialog and loopback routing; no production settings)');
}).catch(error=>{console.error(error);process.exitCode=1;}).finally(()=>{server?.closeAllConnections();server?.close();app.exit(process.exitCode??0);});
` } });
  const env = { ...process.env, CINDY_FILES_VERIFY_DIR: root }; delete env.ELECTRON_RUN_AS_NODE;
  const code = await new Promise((resolve, reject) => {
    const child = spawn(createRequire(import.meta.url)('electron'), [path.join(root, 'verify.cjs')], { env, stdio: 'inherit', windowsHide: true });
    const timer = setTimeout(() => { child.kill(); reject(new Error('文件能力验证超时，测试进程已停止')); }, 60000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); resolve(code); });
  });
  assert.equal(code, 0, '文件能力验证失败');
} finally { await rm(root, { recursive: true, force: true }); }
