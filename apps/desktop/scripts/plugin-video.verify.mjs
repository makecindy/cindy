/** Explicit live-provider integration check. Independent Electron; never starts/restarts Cindy. */
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { build } from 'esbuild';
const dir = path.dirname(fileURLToPath(import.meta.url));
const temporary = await mkdtemp(path.join(os.tmpdir(), 'cindy-video-check-'));
const output = path.resolve(process.argv[2] || path.join(os.tmpdir(), 'cindy-video-evidence.json'));
try {
  await build({
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: path.join(temporary, 'main.cjs'),
    external: ['electron'],
    stdin: {
      resolveDir: dir,
      contents: String.raw`
import { app, BrowserWindow, protocol, session } from 'electron';
import { createGhostThemeInjector } from '../src/renderer/cindy-brain/ghostPanelTheme.ts';
import { writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { VIDEO_PLAYER_PATH, VIDEO_PLAYER_SCRIPT_PATH, VIDEO_PLAYER_SCRIPT, VIDEO_RESPONSE_CSP, VIDEO_PERMISSIONS_POLICY, videoPlayerDocument, videoRequestDecision, isVideoPlayerDescendant, isOfficialVideoUrl } from '../src/main/cindy-brain/runtime/pluginVideoPlayer.ts';
app.setPath('userData',process.env.VIDEO_TEST_DIR+'/profile');
protocol.registerSchemesAsPrivileged([{scheme:'cindy-ghost',privileges:{standard:true,secure:true,supportFetchAPI:true}}]);
const prefix='cindy-ghost://video-check/';
const evidence={requests:[],blocked:[],errors:[],checks:{}};
const wait=async(test,ms=15000)=>{const until=Date.now()+ms;while(Date.now()<until){if(await test())return;await new Promise(r=>setTimeout(r,50));}throw Error('verification timed out');};
let host, guest;
app.whenReady().then(async()=>{
 const ses=session.fromPartition('video-check');
 ses.setPermissionRequestHandler((_w,_p,done)=>done(false));ses.setPermissionCheckHandler(()=>false);ses.on('will-download',e=>e.preventDefault());
 ses.webRequest.onBeforeRequest((d,done)=>{
  const remote=isVideoPlayerDescendant(d.frame,prefix)||isOfficialVideoUrl(d.url);
  const decision=videoRequestDecision(d,prefix,true,guest?.getType()==='webview');
  const allowed=decision===null?Boolean(d.url.startsWith(prefix)):decision;
  if(remote)evidence.requests.push({url:new URL(d.url).origin+new URL(d.url).pathname,type:d.resourceType,frame:d.frame?.url,parent:d.frame?.parent?.url,allowed});
  if(!allowed)evidence.blocked.push(new URL(d.url).origin+new URL(d.url).pathname);
  done({cancel:!allowed});
 });
 ses.webRequest.onHeadersReceived((d,done)=>{
  if(!isOfficialVideoUrl(d.url)){done({});return;}
  const headers={...d.responseHeaders};const key=Object.keys(headers).find(k=>k.toLowerCase()==='content-security-policy')||'Content-Security-Policy';headers[key]=[...(headers[key]||[]),VIDEO_RESPONSE_CSP];headers['Permissions-Policy']=[VIDEO_PERMISSIONS_POLICY];done({responseHeaders:headers});
 });
 ses.protocol.handle('cindy-ghost',req=>{
  const url=new URL(req.url);let body,mime='text/html';
  if(url.pathname===VIDEO_PLAYER_PATH) body=videoPlayerDocument(url.searchParams);
  else if(url.pathname===VIDEO_PLAYER_SCRIPT_PATH){body=VIDEO_PLAYER_SCRIPT;mime='text/javascript';}
  else body='<!doctype html><body style="margin:0"><iframe id="player" style="border:0;width:100%;aspect-ratio:16/9" src="'+prefix+'__video_player__/bilibili?bvid=BV1xx411c7mD&page=1"></iframe></body>';
  return new Response(body,{headers:{'Content-Type':mime,'Content-Security-Policy':"default-src 'self'; style-src 'self' 'unsafe-inline'; frame-src "+(url.pathname===VIDEO_PLAYER_PATH?'https://player.bilibili.com':"'self'")}});
 });
 host=new BrowserWindow({width:800,height:600,show:true,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,nodeIntegrationInSubFrames:false,nodeIntegrationInWorker:false,webSecurity:true,allowRunningInsecureContent:false,experimentalFeatures:false,plugins:false,navigateOnDragDrop:false,webviewTag:true}});
 host.webContents.on('did-attach-webview',(_e,g)=>{guest=g;g.setWindowOpenHandler(()=>({action:'deny'}));g.on('console-message',(_e,_level,message)=>{if(evidence.errors.length<50)evidence.errors.push(message);});});
 await host.loadURL('data:text/html,'+encodeURIComponent('<webview src="'+prefix+'panel.html" partition="video-check" webpreferences="sandbox=yes,contextIsolation=yes,nodeIntegration=no" style="position:fixed;inset:0;width:100%;height:100%"></webview>'));
 await wait(()=>guest?.mainFrame.frames.length===1);
 let wrapper=guest.mainFrame.frames[0];await wait(()=>wrapper.executeJavaScript('!!document.querySelector("button")'));
 let themeCss='';
 const injector=createGhostThemeInjector({insertCSS:css=>guest.insertCSS(css),removeInsertedCSS:key=>guest.removeInsertedCSS(key),executeJavaScript:code=>guest.executeJavaScript(code)},()=>themeCss);
 for (const theme of ['light','dark']) {
  host.setContentSize(320,500);
  themeCss=':root{color-scheme:'+theme+';--panel-bg:'+(theme==='light'?'white':'black')+'}';injector.inject();
  await wait(async()=>await wrapper.executeJavaScript('getComputedStyle(document.documentElement).colorScheme')===theme);
  await wait(async()=>await guest.executeJavaScript('innerWidth')===320);
  evidence.checks['insertCSS-theme-'+theme]=await wrapper.executeJavaScript('getComputedStyle(document.body).backgroundColor')===(theme==='light'?'rgb(255, 255, 255)':'rgb(0, 0, 0)');assert(evidence.checks['insertCSS-theme-'+theme]);
  evidence.checks['narrow-'+theme]=await wrapper.executeJavaScript('document.documentElement.scrollWidth<=innerWidth');
  await writeFile(process.env.VIDEO_TEST_OUTPUT+'.'+theme+'.png',(await guest.capturePage()).toPNG());
 }
 injector.dispose();
 host.setContentSize(800,600);await wait(async()=>await guest.executeJavaScript('innerWidth')===800);
 evidence.checks.noRemoteBeforeClick=evidence.requests.length===0;assert(evidence.checks.noRemoteBeforeClick);
 const rect=await wrapper.executeJavaScript('JSON.stringify(document.querySelector("button").getBoundingClientRect().toJSON())');const r=JSON.parse(rect);
 guest.sendInputEvent({type:'mouseDown',x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2),button:'left',clickCount:1});guest.sendInputEvent({type:'mouseUp',x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2),button:'left',clickCount:1});
 await wait(()=>wrapper.frames.length===1);const player=wrapper.frames[0];
 try{await wait(async()=>await player.executeJavaScript('[...document.querySelectorAll("video")].some(v=>v.readyState>=2)'),30000);evidence.video=await player.executeJavaScript('JSON.stringify([...document.querySelectorAll("video")].map(v=>({paused:v.paused,time:v.currentTime,ready:v.readyState,error:v.error?.code})))');}catch(e){evidence.errors.push(String(e));}
 evidence.playerUrl=player.url;
 evidence.playerText=await player.executeJavaScript('document.body.innerText.slice(0,2000)').catch(()=>null);
 await writeFile(process.env.VIDEO_TEST_OUTPUT+'.png',(await guest.capturePage()).toPNG());
 if(await player.executeJavaScript('!!document.querySelector("video")').catch(()=>false)){
  evidence.controls=await player.executeJavaScript('JSON.stringify([...document.querySelectorAll("[class*=play]")].slice(-40).map(e=>({tag:e.tagName,cls:e.className,r:e.getBoundingClientRect().toJSON()})))');
  evidence.activation='official play control with Electron userGesture=true';
  await wait(async()=>await player.executeJavaScript('!!document.querySelector(".bpx-player-ctrl-play")'),15000);
  await player.executeJavaScript('document.querySelector(".bpx-player-ctrl-play").click()', true);
  try{await wait(async()=>await player.executeJavaScript('[...document.querySelectorAll("video")].some(v=>!v.paused&&v.currentTime>2)'),15000);evidence.checks.actualPlayback=true;}catch{evidence.checks.actualPlayback=false;}
 }
 evidence.finalVideo=await player.executeJavaScript('JSON.stringify([...document.querySelectorAll("video")].map(v=>({paused:v.paused,time:v.currentTime,ready:v.readyState,error:v.error?.code})))').catch(()=>null);
 await writeFile(process.env.VIDEO_TEST_OUTPUT+'.png',(await guest.capturePage()).toPNG());
 host.setContentSize(320,500);await wait(async()=>await guest.executeJavaScript('innerWidth')===320);
 await wait(async()=>await player.executeJavaScript('innerWidth')===320);
 evidence.checks.narrowPlaying=await player.executeJavaScript('document.documentElement.scrollWidth<=innerWidth');assert(evidence.checks.narrowPlaying);
 await writeFile(process.env.VIDEO_TEST_OUTPUT+'.narrow-playing.png',(await guest.capturePage()).toPNG());
 host.setContentSize(800,600);await wait(async()=>await guest.executeJavaScript('innerWidth')===800);
 evidence.checks.noHostAccess=await player.executeJavaScript('fetch("cindy-ghost://video-check/wake").then(()=>false,()=>true)');
 assert(evidence.checks.noHostAccess);
 // Close while the verified video is playing, independently of the part-switch check.
 await guest.executeJavaScript('document.querySelector("iframe").remove()');await wait(()=>player.detached && wrapper.detached);assert(await guest.executeJavaScript('document.querySelectorAll("iframe").length===0'));evidence.checks.closeDestroysFrames=true;
 await wait(()=>!guest.isCurrentlyAudible());evidence.checks.closeStopsAudio=true;
 await guest.executeJavaScript('const f=document.createElement("iframe");f.style.cssText="border:0;width:100%;aspect-ratio:16/9";f.src="'+prefix+'__video_player__/bilibili?bvid=BV1xx411c7mD&page=1";document.body.append(f)');
 await wait(()=>guest.mainFrame.frames.length===1);wrapper=guest.mainFrame.frames[0];
 await wait(()=>wrapper.executeJavaScript('!!document.querySelector("button")'));
 guest.sendInputEvent({type:'mouseDown',x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2),button:'left',clickCount:1});guest.sendInputEvent({type:'mouseUp',x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2),button:'left',clickCount:1});
 await wait(()=>wrapper.frames.length===1);const old=wrapper.frames[0];
 await guest.executeJavaScript('document.querySelector("iframe").src="'+prefix+'__video_player__/bilibili?bvid=BV1xx411c7mD&page=2"');
 await wait(()=>{try{return old.detached;}catch{return true;}});evidence.checks.partChangeDestroysOldFrame=true;
 await guest.executeJavaScript('document.querySelector("iframe").remove()');
 assert(evidence.checks.actualPlayback,'official player did not advance');
}).catch(e=>{evidence.errors.push(String(e.stack || e));process.exitCode=1;}).finally(async()=>{await writeFile(process.env.VIDEO_TEST_OUTPUT,JSON.stringify(evidence,null,2));host?.destroy();app.exit(process.exitCode||0);});
`,
    },
  });
  const binary = createRequire(import.meta.url)('electron');
  const code = await new Promise((resolve) => {
    const child = spawn(binary, [path.join(temporary, 'main.cjs')], {
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '',
        VIDEO_TEST_DIR: temporary,
        VIDEO_TEST_OUTPUT: output,
      },
      stdio: 'inherit',
    });
    child.on('error', () => resolve(1));
    child.on('exit', (code) => resolve(code ?? 1));
  });
  console.log('Evidence: ' + output);
  process.exitCode = code || 0;
} finally {
  await rm(temporary, { recursive: true, force: true });
}
