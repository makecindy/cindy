import path from 'node:path';
import os from 'node:os';
import {createServer} from 'node:net';
import type {Logger} from '@cindy/maker-core';
import type {BrowserControlRuntime,BrowserProxyRoute} from '@cindy/browser-control-runtime';
import {createBrowserControlRuntime,refreshBrowserRuntimeConfigDir} from '@cindy/browser-control-runtime';
import {ExternalChromeBackend} from '@cindy/app-runtime/browserBackend/external-chrome-backend';
import {buildManagedConfig,managedBrowserGuardIdentity} from '@cindy/app-runtime/browserManagedConfig';
import {createBrowserMcpHostDeps} from '@cindy/app-runtime/browserMcpHost';
import {createBrowserRecipeLoader} from '@cindy/app-runtime/browserRecipeLoader';
import {createBrowserRecipeWriter} from '@cindy/app-runtime/browserRecipeWriter';
import {createInlineImageCompressor} from '@cindy/app-runtime/inlineImageCompressor';
import type {TerminalSecrets,TerminalDurableSecrets} from '../contracts.js';
import {TerminalBrowserRuntime} from '../plugins/browser.js';
import {atomicPrivateWrite,privateDirectory,readPrivateFile} from '../platform.js';

// The original browser dispatcher has one process-wide configuration. A Node
// account host must finish disposal before a different owner can claim it.
let activeOwner:symbol|undefined;
export class TerminalBrowserTools {
  readonly deps;
  private readonly identity=Symbol('browser-owner');
  private readonly directory:string;
  private readonly binary:TerminalBrowserRuntime;
  private pending?:Promise<ExternalChromeBackend>;
  private previousDirectory?:string;
  private closed=false;
  constructor(private options:{profileDir:string;logger:Logger;secrets:TerminalSecrets;assertCurrent():void;uploadRoots(id:string):Promise<string[]>}){
    this.directory=path.join(options.profileDir,'browser-runtime');
    this.binary=new TerminalBrowserRuntime({root:this.directory});
    const recipes=createBrowserRecipeLoader({userDataPath:()=>{this.current();return options.profileDir;},log:options.logger});
    const writer=createBrowserRecipeWriter({userRecipesDir:recipes.userRecipesDir,log:options.logger,openPath:async()=>{throw new Error('OPEN_PATH_UNAVAILABLE');}});
    const runtime:BrowserControlRuntime={call:async request=>{this.current();const backend=await this.backend();this.current();const result=await backend.call(request);this.current();return result;}};
    const secrets=options.secrets as Partial<TerminalDurableSecrets>;
    this.deps=createBrowserMcpHostDeps({runtime,runtimeDir:()=>this.directory,temporaryDir:()=>os.tmpdir(),backend:()=> 'external',
      setBackend:async kind=>{this.current();if(kind!=='external')throw new Error('BROWSER_BACKEND_REQUIRES_GUI');return kind;},
      resolveSessionUploadRoots:id=>{this.current();return options.uploadRoots(id);},loadRecipes:recipes.loadUserBrowserRecipes,saveRecipe:writer.writeUserRecipe,
      readSecret:id=>{this.current();if(!secrets.getSync)throw new Error('DURABLE_SECRET_STORE_REQUIRED');return secrets.getSync(id);},
      writeSecret:(id,value)=>{this.current();if(!secrets.setSync)throw new Error('DURABLE_SECRET_STORE_REQUIRED');try{secrets.setSync(id,value);return true;}catch{return false;}},
      compressInlineImage:createInlineImageCompressor({log:options.logger}).compressInlineImage,logger:options.logger,
    });
  }
  private current(){if(this.closed)throw new Error('BROWSER_HOST_CLOSED');this.options.assertCurrent();}
  private backend(){
    if(!this.pending){const pending=this.prepare();this.pending=pending;void pending.catch(()=>{if(this.pending===pending)this.pending=undefined;});}
    return this.pending;
  }
  private async port(){
    const file=path.join(this.directory,'host-cdp-port');
    const saved=await readPrivateFile(file);
    if(saved){const port=Number(saved.toString());if(Number.isSafeInteger(port)&&port>1024&&port<=65535)return port;throw new Error('BROWSER_PORT_INVALID');}
    const server=createServer();
    const port=await new Promise<number>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',()=>resolve((server.address() as {port:number}).port));});
    await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
    this.current();await atomicPrivateWrite(file,String(port));return port;
  }
  private async prepare(){
    this.current();await privateDirectory(this.directory);
    const [cdpPort,executablePath]=await Promise.all([this.port(),this.binary.installed()]);this.current();
    if(activeOwner&&activeOwner!==this.identity)throw new Error('BROWSER_OWNER_TRANSITION_PENDING');
    if(activeOwner!==this.identity){this.previousDirectory=process.env.XDT_BROWSER_RUNTIME_DIR;activeOwner=this.identity;}
    process.env.XDT_BROWSER_RUNTIME_DIR=this.directory;refreshBrowserRuntimeConfigDir();
    const createRuntime=(route:BrowserProxyRoute)=>{
      const config=buildManagedConfig({cdpPort,...(executablePath?{executablePath}:{}),...(route.mode==='proxied'?{proxyServer:route.server,proxyAllowedHostnames:route.allowedHostnames}:{})});
      config.browser!.headless=true;
      return createBrowserControlRuntime({config,logSink:(level,scope,args)=>this.options.logger[level](`[${scope}]`,{details:args})});
    };
    const identity=managedBrowserGuardIdentity({runtimeDir:this.directory,useRealProfile:false,cdpPort});
    return new ExternalChromeBackend(createRuntime({mode:'direct'}),this.options.logger,{createRuntime,...identity});
  }
  async close(){
    if(this.closed)return;this.closed=true;
    try{await this.pending?.then(backend=>backend.dispose()).catch(()=>{});await this.binary.close();}
    finally{if(activeOwner===this.identity){activeOwner=undefined;if(this.previousDirectory===undefined)delete process.env.XDT_BROWSER_RUNTIME_DIR;else process.env.XDT_BROWSER_RUNTIME_DIR=this.previousDirectory;refreshBrowserRuntimeConfigDir();}}
  }
}
