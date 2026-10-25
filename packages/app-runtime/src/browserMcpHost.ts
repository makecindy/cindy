import path from 'node:path';
import {browserUploadDirectory,type BrowserControlRuntime} from '@cindy/browser-control-runtime';
import type {BrowserMcpDeps} from '@cindy/mcps';
import type {createBrowserRecipeLoader} from './browserRecipeLoader.js';
import type {createBrowserRecipeWriter} from './browserRecipeWriter.js';
import {createRecipeFileBroker} from './browserUploadPolicy.js';
import {artifactSessionRoot} from './browserArtifactPaths.js';
import {resolveBrowserScreenshot} from './browserScreenshotResolver.js';
import {hasSecretPages,isSecretPage} from '@cindy/remote-agent/input-handoff/secretTaint';

export function createBrowserMcpHostDeps<TLogger extends NonNullable<BrowserMcpDeps['logger']>>(host:{
  runtime:BrowserControlRuntime;
  runtimeDir():string|undefined;temporaryDir():string;
  backend():'external'|'rsb-webview';setBackend(kind:'external'|'rsb-webview'):Promise<'external'|'rsb-webview'>;
  resolveSessionUploadRoots(id:string):Promise<string[]>;
  loadRecipes:ReturnType<typeof createBrowserRecipeLoader>['loadUserBrowserRecipes'];
  saveRecipe:ReturnType<typeof createBrowserRecipeWriter>['writeUserRecipe'];
  readSecret(id:string):string|null;writeSecret(id:string,value:string):boolean;
  compressInlineImage:NonNullable<BrowserMcpDeps['compressInlineImage']>;
  logger:TLogger;
}){
  const secretId=(key:string)=>{
    if(!['spotify','xiaoyuzhou'].includes(key))throw new Error('Unknown browser recipe credential');
    return `browser-recipe-${key}`;
  };
  return {
    recipeFiles:async(sessionId?:string)=>{
      const sessionRoots=sessionId?await host.resolveSessionUploadRoots(sessionId):[];
      const roots=sessionId?[artifactSessionRoot(path.join(host.temporaryDir(),'cindy-browser-artifacts'),sessionId),...sessionRoots]:[];
      return createRecipeFileBroker(roots,sessionRoots,sessionId?(host.backend()==='external'?artifactSessionRoot(browserUploadDirectory,sessionId):roots[0]):undefined);
    },
    recipeSecrets:{read:(key:string)=>host.readSecret(secretId(key)),write:(key:string,value:string)=>host.writeSecret(secretId(key),value)},
    setBackend:host.setBackend,
    getUserRecipes:()=>host.loadRecipes(),saveUserRecipe:host.saveRecipe,
    getRuntime:()=>host.runtime,
    resolveScreenshot:(result:Parameters<typeof resolveBrowserScreenshot>[0])=>resolveBrowserScreenshot(result,{runtimeDir:host.runtimeDir()}),
    compressInlineImage:host.compressInlineImage,
    supportsResourceDownloads:()=>host.backend()==='rsb-webview',supportsSemanticQueries:()=>host.backend()==='rsb-webview',
    pageReadsRestricted:async({profile,targetId}:{profile?:string;targetId?:string})=>{
      if(!hasSecretPages())return false;
      const listed=await host.runtime.call({action:'tabs',...(profile?{profile}:{})});
      if(!listed.ok)return true;
      const tabs=(listed.data as {tabs?:Array<{targetId?:unknown;url?:unknown}>}|undefined)?.tabs??[];
      return tabs.filter(tab=>!targetId||tab.targetId===targetId).some(tab=>typeof tab.url==='string'&&isSecretPage(tab.url));
    },
    logger:host.logger,
  };
}
