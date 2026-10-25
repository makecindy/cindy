import {fork,type ChildProcess} from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import type {DocsMcpDeps,DocsPdfRenderInput,DocsPdfRenderOutput} from '@cindy/mcps';
import type {Logger} from '@cindy/maker-core';
import {createDocsOutputWriter} from '@cindy/app-runtime/docsOutputWriter';
import {createReviewPdfProcess} from '@cindy/app-runtime/reviewPdfProcess';
import {createPdfInspector} from '@cindy/app-runtime/pdfInspector';
import {createHtmlPdfRenderer,isAllowedResourceUrl,RENDER_VIEWPORT} from '@cindy/app-runtime/htmlPdfPolicy';
import {HeadlessGhostSandbox} from '@cindy/plugin-runtime/headlessSandbox';
import {TerminalBrowserRuntime} from '../plugins/browser.js';
import {RUNTIME_DIRECTORY,terminalNodeExecutable} from '../version.js';

/** Original file commits, PDF parser, request policy and rendering queue.
 * Node child IPC and isolated Chromium contexts replace Electron surfaces. */
export class TerminalDocumentTools {
  readonly deps:DocsMcpDeps;
  private closed=false;
  private readonly children=new Set<ChildProcess>();
  private readonly operations=new Set<Promise<unknown>>();
  private readonly renders=new Set<AbortController>();
  constructor(private options:{profileDir:string;logger:Logger;assertCurrent():void}){
    const writer=createDocsOutputWriter({fork:root=>this.child('docs-output-process.cjs',root,false)});
    const pdf=createReviewPdfProcess({fork:()=>this.child('docs-pdf-process.mjs',os.tmpdir(),true)});
    const inspector=createPdfInspector(pdf.inspectPdfPagesInChild);
    const renderer=createHtmlPdfRenderer(input=>this.render(input));
    this.deps={logger:options.logger,
      writeDocsOutput:input=>this.run(()=>writer.writeDocsOutput({...input,isCurrent:()=>{try{this.current();return input.isCurrent?.()!==false;}catch{return false;}}})),
      inspectPdf:input=>this.run(()=>inspector.inspectPdf(input)),
      renderHtmlToPdf:input=>this.run(()=>renderer.renderHtmlToPdf(input)),
    };
  }
  private current(){if(this.closed)throw new Error('DOCUMENT_HOST_CLOSED');this.options.assertCurrent();}
  private run<T>(work:()=>Promise<T>):Promise<T>{
    this.current();const operation=Promise.resolve().then(work).then(result=>{this.current();return result;});
    this.operations.add(operation);void operation.finally(()=>this.operations.delete(operation)).catch(()=>{});return operation;
  }
  private child(entry:string,cwd:string,pdf:boolean){
    this.current();const env:NodeJS.ProcessEnv={};
    for(const key of ['PATH','SystemRoot','WINDIR','TEMP','TMP','TMPDIR','LANG','LC_ALL'])if(process.env[key]!==undefined)env[key]=process.env[key];
    const child=fork(path.join(RUNTIME_DIRECTORY,entry),[],{cwd,env,execPath:terminalNodeExecutable(),serialization:'advanced',
      execArgv:pdf?['--max-old-space-size=128','--max-semi-space-size=8']:[],stdio:['ignore','ignore',pdf?'ignore':'pipe','ipc']});
    this.children.add(child);child.once('close',()=>this.children.delete(child));
    return {stderr:child.stderr,postMessage:(value:unknown)=>{this.current();child.send(value as object);},
      on:(event:'message'|'exit'|'error',listener:(...args:any[])=>void)=>{
        if(event==='error'&&pdf)child.on('error',error=>listener(error.name,'node',error.message));else child.on(event,listener);
      },kill:()=>child.kill(),
    };
  }
  private async render(input:DocsPdfRenderInput):Promise<DocsPdfRenderOutput>{
    this.current();const abort=new AbortController();this.renders.add(abort);
    const binary=new TerminalBrowserRuntime({root:path.join(this.options.profileDir,'browser-runtime')});
    let sandbox:HeadlessGhostSandbox|undefined,timer:ReturnType<typeof setTimeout>|undefined;
    const failed=new Promise<never>((_resolve,reject)=>{
      abort.signal.addEventListener('abort',()=>reject(abort.signal.reason??new Error('DOCUMENT_RENDER_CANCELLED')),{once:true});
      timer=setTimeout(()=>abort.abort(new Error(`HTML render timeout (${input.timeoutMs}ms)`)),input.timeoutMs);
    });
    try{
      const work=(async()=>{
        const executablePath=await binary.resolve();this.current();abort.signal.throwIfAborted();
        sandbox=new HeadlessGhostSandbox({executablePath,mailRuntimeSource:'',capture:()=>()=>!this.closed&&!abort.signal.aborted,receive:async()=>null});
        const browser=await sandbox.getBrowser();this.current();abort.signal.throwIfAborted();
        const context=await browser.newContext({viewport:RENDER_VIEWPORT,acceptDownloads:false,serviceWorkers:'block',permissions:[]});
        await context.route('**/*',async route=>{
          const request=route.request();
          if(abort.signal.aborted||request.isNavigationRequest()||!await isAllowedResourceUrl(request.url(),'about:blank',request.resourceType()))await route.abort();
          else await route.continue();
        });
        const page=await context.newPage();
        context.on('page',extra=>{if(extra!==page)void extra.close().catch(()=>{});});
        page.on('crash',()=>abort.abort(new Error('DOCUMENT_RENDERER_CRASHED')));
        page.on('framenavigated',frame=>{if(frame===page.mainFrame()&&frame.url()!=='about:blank')abort.abort(new Error('DOCUMENT_NAVIGATION_REFUSED'));});
        page.on('download',download=>{void download.cancel();});
        await page.setContent(input.htmlBytes?Buffer.from(input.htmlBytes).toString('utf8'):input.html??'',{waitUntil:'load',timeout:input.timeoutMs});
        let fontTimer:ReturnType<typeof setTimeout>|undefined;
        const fontsReady=await Promise.race([page.evaluate(()=>document.fonts.ready.then(()=>true)).catch(()=>false),
          new Promise<false>(resolve=>{fontTimer=setTimeout(()=>resolve(false),input.fontTimeoutMs);})]).finally(()=>clearTimeout(fontTimer));
        this.current();abort.signal.throwIfAborted();
        const buffer=await page.pdf({format:input.pageSize,landscape:input.landscape,printBackground:input.printBackground,
          margin:{top:`${input.margins.top}in`,bottom:`${input.margins.bottom}in`,left:`${input.margins.left}in`,right:`${input.margins.right}in`}});
        this.current();abort.signal.throwIfAborted();return {buffer,fontsReady};
      })();
      return await Promise.race([work,failed]);
    }finally{
      clearTimeout(timer);abort.abort();this.renders.delete(abort);await binary.close();await sandbox?.close();
    }
  }
  async close(){if(this.closed)return;this.closed=true;for(const render of this.renders)render.abort(new Error('DOCUMENT_HOST_CLOSED'));
    for(const child of this.children)child.kill();await Promise.allSettled([...this.operations]);}
}
