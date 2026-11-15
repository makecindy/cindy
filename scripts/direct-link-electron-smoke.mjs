// Two real Electron clients, production isolated renderer/preload/main adapter,
// loopback WS fixture. No account, app installation or developer data is used.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(new URL('../apps/desktop/package.json', import.meta.url));
const { build } = require('esbuild');
const { WebSocketServer } = require('ws');
const temp = await mkdtemp(path.join(os.tmpdir(), 'cindy-direct-electron-'));
const mainDir = path.join(temp, 'main'), renderer = path.join(temp, 'renderer', 'capture');
const children = [], peers = new Map(), physical = [];
const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
await new Promise(resolve => server.once('listening', resolve));
const url = `ws://127.0.0.1:${server.address().port}`;
server.on('connection', socket => {
  let source;
  socket.on('message', text => {
    const e = JSON.parse(String(text));
    physical.push({ ...e, source });
    if (e.kind === 'hello') {
      source = e.payload.deviceName; peers.set(source, socket);
      socket.send(JSON.stringify({ v: 1, kind: 'hello-ack', payload: { serverProtocolVersion: 1, deviceId: source, userId: 'fixture' } }));
    } else if (e.kind === 'ping') socket.send(JSON.stringify({ v: 1, kind: 'pong' }));
    else peers.get(e.dst)?.send(JSON.stringify({ ...e, src: source }));
  });
});
try {
  await mkdir(mainDir); await mkdir(path.join(renderer, 'assets'), { recursive: true });
  await mkdir(path.join(temp, 'desktop')); await mkdir(path.join(temp, 'viewer'));
  const shared = { bundle: true, platform: 'node', format: 'cjs', external: ['electron'],
    define: { DESKTOP_CAPTURE_VITE_DEV_SERVER_URL: 'undefined', DESKTOP_CAPTURE_VITE_NAME: '"capture"' } };
  const main = await build({ ...shared, write: false, plugins: [{ name: 'fixture-logger', setup(builder) {
    builder.onLoad({ filter: /[\\/]main[\\/]logger\.ts$/ }, () => ({ contents:
      'export const createLogger = () => ({debug(){},info(){},warn(){},error(){}});', loader: 'ts' }));
  } }], stdin: { resolveDir: root, contents: `
    import { app, protocol } from 'electron';
    import WebSocket from 'ws';
    import { DeviceLinkClient } from './packages/device-link/src/client.ts';
    import { desktopDirectRuntime } from './apps/desktop/src/main/device-link/directLink.ts';
    const name=app.commandLine.getSwitchValue('smoke-role'), url=app.commandLine.getSwitchValue('smoke-ws'), data=app.commandLine.getSwitchValue('smoke-data');
    app.setPath('userData',data);
    protocol.registerSchemesAsPrivileged([{scheme:'cindy-desktop-capture',privileges:{standard:true,secure:true,supportFetchAPI:true}}]);
    let client, count=0;
    process.stdin.on('data',()=>{client?.stop();app.quit();});
    app.whenReady().then(async()=>{
      client=new DeviceLinkClient({directRuntime:desktopDirectRuntime,getWsUrl:()=>url,getToken:async()=> 'fixture',
        getHello:()=>({deviceName:name,platform:process.platform,appVersion:'1',remoteControlEnabled:true,busy:false}),
        createWebSocket:(u,headers)=>new WebSocket(u,{headers}),
        logger:{debug(){},info(){},warn(...a){console.error(...a)},error(...a){console.error(...a)}},
        timing:{requestTimeoutMs:20000,transportRetryIntervalMs:500}});
      client.onFrame(e=>{
        if(e.kind==='link-open')client.sendLinkAccept(e.src,e.id,{appVersion:'1',allowlistHash:'fixture'});
        if(e.kind==='invoke'){
          count++;const action=e.payload.args?.[0];
          if(action==='break')desktopDirectRuntime.suspend();
          client.sendInvokeResult(e.src,e.id,{ok:true,result:action==='large'?'局域网😀'.repeat(80000):count});
        }
      });
      const wait=async(fn)=>{const until=Date.now()+25000;while(!fn()){if(Date.now()>until)throw Error('Electron smoke timeout');await new Promise(r=>setTimeout(r,20));}};
      client.start();await wait(()=>client.getStatus()==='online');
      if(name==='desktop'){console.log('HOST_READY');return;}
      await client.openLink('desktop',{controllerName:'Desktop viewer',protocolVersion:1,appVersion:'1'});
      await wait(()=>client.getPeerPath('desktop')==='direct');
      console.log('DIRECT_READY');
      await client.invoke('desktop',{channel:'maker:remote-agent:v1',args:['warmup']});
      await new Promise(r=>setTimeout(r,150));
      const first=await client.invoke('desktop',{channel:'maker:remote-agent:v1',args:['large']});
      if(first.result!=='局域网😀'.repeat(80000))throw Error('corrupt result');
      console.log('DIRECT_RESULT');
      const second=await client.invoke('desktop',{channel:'maker:remote-agent:v1',args:['break']});
      if(second.result!==3)throw Error('duplicated execution');
      console.log('ELECTRON_SMOKE_OK');client.stop();app.quit();
    }).catch(e=>{console.error(e);client?.stop();app.exit(1);});
  ` } });
  await writeFile(path.join(mainDir, 'index.js'), main.outputFiles[0].text);
  await build({ ...shared, entryPoints: [path.join(root, 'apps/desktop/src/preload/desktopCapturePreload.ts')],
    outfile: path.join(mainDir, 'desktopCapturePreload.js') });
  await build({ bundle: true, platform: 'browser', format: 'iife', outfile: path.join(renderer, 'assets', 'direct.js'),
    stdin: { resolveDir: root, contents: `import {startDirectLinkHost} from './apps/desktop/src/capture-renderer/directLinkHost.ts'; startDirectLinkHost(window.directLinkHost);` } });
  await writeFile(path.join(renderer, 'index.html'), '<!doctype html><script src="./assets/direct.js"></script>');
  function launch(name) {
    let stdout = '', stderr = '';
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(require('electron'), [path.join(mainDir, 'index.js'), `--smoke-role=${name}`, `--smoke-ws=${url}`, `--smoke-data=${path.join(temp, name)}`],
      { windowsHide: true, env, stdio: ['pipe', 'pipe', 'pipe'] });
    children.push(child);
    child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    const done = new Promise((resolve, reject) => {
      child.on('error', reject); child.on('exit', code => code === 0 ? resolve() : reject(new Error(`${name}: ${code}\n${stderr.slice(-5000)}\n${stdout}`)));
    });
    // Attach a rejection handler immediately even while waiting for HOST_READY.
    void done.catch(() => {});
    return { child, done, output: () => stdout, errors: () => stderr };
  }
  const host = launch('desktop');
  const until = Date.now() + 30_000;
  while (!host.output().includes('HOST_READY')) {
    if (Date.now() > until || host.child.exitCode !== null) throw new Error(`host not ready (${host.child.exitCode}): ${host.output()} ${host.errors()}`);
    await new Promise(r => setTimeout(r, 30));
  }
  const viewer = launch('viewer');
  const timer = setTimeout(() => { for (const c of children) c.kill(); }, 60_000);
  try { await viewer.done; } finally { clearTimeout(timer); }
  assert.match(viewer.output(), /DIRECT_READY/); assert.match(viewer.output(), /ELECTRON_SMOKE_OK/);
  const relayReplays = physical.filter(e => e.kind === 'invoke').length;
  // Closing before its ACK can replay the second request with its original sequence.
  // The fixture's result=3 proves that this copy did not execute the command twice.
  assert.ok(relayReplays <= 1, 'only the interrupted request may replay through relay');
  assert.equal(physical.filter(e => e.kind === 'invoke-result').length, 1, 'only the interrupted result should fall back to relay');
  host.child.stdin.write('stop\n'); await host.done;
  console.log(JSON.stringify({ nativeProcesses: 2, directUtf8Bytes: 1_040_000, relayReplays,
    relayFallbackResults: 1, executions: 3, result: 'passed' }, null, 2));
} finally {
  for (const child of children) if (child.exitCode === null) child.kill();
  for (const socket of server.clients) socket.terminate();
  await new Promise(resolve => server.close(resolve));
  // Only the unique directory created above is recursively removed.
  if (path.dirname(path.resolve(temp)) === path.resolve(os.tmpdir()) && path.basename(temp).startsWith('cindy-direct-electron-'))
    await rm(temp, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
}
