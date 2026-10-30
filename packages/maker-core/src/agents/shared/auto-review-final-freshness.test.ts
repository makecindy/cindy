import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import ts from 'typescript';
import { withAutoReviewContext, type AutoReviewDelegate } from './auto-review-decision.js';

// Exercise each production review closure while the final Host read is suspended.
for (const engine of ['claude-code', 'codex', 'pi']) {
 const source = readFileSync(new URL(`../${engine}/index.ts`, import.meta.url), 'utf8');
 const start = source.indexOf('    const reviewAutoAction =');
 const closure = source.slice(start, source.indexOf('\n    };', start) + 7);
 const script = ts.transpileModule(`
 let currentAutoReviewIntent = 'Run tests';
 let currentAutoReviewAuthority = undefined;
 let autoReviewDirectoryGeneration = 0;
 let persistencePending = false;
 const directoryPermissionsPendingPersistence = () => persistencePending;
 ${closure}
 return {run:()=>reviewAutoAction({kind:'exec',command:'npm test'},['/work'],['/work'],'linux'),
 invalidate:(kind)=>{if(kind==='intent') currentAutoReviewIntent='Do not publish';
 if(kind==='cache') autoReviewDecisionCache.clear();
 if(kind==='directory') autoReviewDirectoryGeneration++;
 if(kind==='persistence') persistencePending=true;}};
 `, {compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
 describe(`${engine} final Auto runtime fence`,()=>{
  it.each(['unchanged','intent','cache','directory',...(engine==='pi'?['persistence']:[])])('checks %s after the last Host await',async kind=>{
   let calls=0, release!:()=>void, entered!:()=>void;
   const waiting=new Promise<void>(resolve=>{entered=resolve;});
   const barrier=new Promise<void>(resolve=>{release=resolve;});
   const delegate:AutoReviewDelegate=async()=>({verdict:'allow'});
   delegate.prepareRequest=async request=>{if(++calls===2){entered();await barrier;}return request;};
   const record=vi.fn();
   const deps={withAutoReviewContext,opts:{sessionId:'s',workingDir:'/work'},mutableProviderId:undefined,mutableModel:'m',mutableCatalogModel:'m',
    autoReviewActionContext:{precedingBlockedActions:[],record},autoReviewDecisionCache:new Map(),
    resolveAutoReviewDecision:vi.fn(async()=>({verdict:'allow'})),runtimeWorkspaceRoots:()=>['/work'],runtimeWritableRoots:()=>['/work'],
    sessionReviewPlatform:'linux',mutableExtraDirs:[],mutableWritableDirs:[]};
   const runtime=new Function(...Object.keys(deps),script).call({deps:{reviewAutoPermissionAction:delegate}},...Object.values(deps));
   const result=runtime.run();await waiting;
   expect(record).not.toHaveBeenCalled();runtime.invalidate(kind);release();
   expect((await result).verdict).toBe(kind==='unchanged'?'allow':'block');
   expect(record).toHaveBeenCalledTimes(kind==='unchanged'?1:0);
  });
 });
}
