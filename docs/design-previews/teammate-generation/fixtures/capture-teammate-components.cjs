const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
const esbuild=require('esbuild'),postcss=require('postcss'),tailwind=require('tailwindcss');
const {chromium}=require('playwright-core');
const root=process.cwd(),fixture=path.join(root,'docs/design-previews/teammate-generation/fixtures'),renderer=path.join(root,'apps/desktop/src/renderer');
const themes=path.join(root,'tmp/teammate-generation-evidence');
const stubModules={
 '@/components/chat/markdownImageTargets':`export const extractRenderedMarkdownImageTargets=()=>[];`,
 '@/i18n':`import i18n from 'i18next';export {i18n};export default i18n;`,
 '@/features/bots/botStore':`export const useBotProfiles=()=>[];export const useBotUnreadCounts=()=>({});`,
 '@/features/device-link/useDeviceLinkDeviceList':`export const useDeviceLinkDeviceList=()=>[];`,
 '@/contexts/AuthContext':`export const useAuth=()=>({});`,
 '@/lib/logger':`export const createLogger=()=>({info(){},warn(){},error(){},debug(){}});`,
 '@/state/agentIslandActivity':`export const useAgentIslandActivity=()=>null;`,
 '@/features/device-link/remoteSessionActivityStore':`export const useRemoteSessionActivity=()=>null;`,
};
fs.mkdirSync(path.join(root,'tmp/teammate-generation-evidence'),{recursive:true});
(async()=>{
 const cfg=require('tailwindcss/loadConfig')(path.join(root,'apps/desktop/tailwind.config.ts'));
 cfg.content=[path.join(renderer,'features/bots/*.tsx'),path.join(renderer,'components/chat/WorkGroupBlock.tsx'),path.join(renderer,'components/ui/{select,button,spinner}.tsx')];
 cfg.content.push({raw:cp.execFileSync('git',['show','73ae8eaf3772d50173cf5c0aa63666b9d0482e01:apps/desktop/src/renderer/features/bots/BotConnectionStatus.tsx'],{encoding:'utf8'}),extension:'tsx'});
 const css=(await postcss([tailwind(cfg)]).process(fs.readFileSync(path.join(renderer,'styles/generated/tokens.css'),'utf8')+'\n'+fs.readFileSync(path.join(renderer,'styles/globals.css'),'utf8').replace(/^@import.*$/gm,''),{from:undefined})).css;
 const extra=`body{margin:0;background:var(--surface);color:var(--text-primary);font-family:-apple-system,BlinkMacSystemFont,sans-serif}.fixture-caption{font-size:12px;padding:16px 24px;color:var(--text-secondary);border-bottom:1px solid var(--border-default)}.layout{display:flex;height:575px}aside{width:290px;padding:24px 14px;background:var(--sidebar-background,var(--surface-chip));border-right:1px solid var(--border-default)}h2{font-size:18px;font-weight:600;margin:0 10px 22px}main{flex:1;display:flex;flex-direction:column}header{height:66px;padding:20px;display:flex;gap:10px;align-items:center;border-bottom:1px solid var(--border-default)}.messages{padding:28px;flex:1;display:flex;flex-direction:column;gap:26px}.user-bubble{align-self:flex-end;background:var(--surface-chip);padding:12px 18px;border-radius:20px;font-size:15px}.answer{font-size:15px;line-height:1.7}footer{padding:20px 28px}.composer{border:1px solid var(--border-default);background:var(--surface-elevated);border-radius:28px;padding:18px;color:var(--text-tertiary);font-size:14px}.composer span{float:right;color:var(--text-primary)}`;
 const browser=await chromium.launch({headless:true});
 try{for(const before of [true,false]){
  const stage=before?'before':'after',bundle=path.join(root,'tmp/teammate-generation-components',`desktop-${stage}.js`);
  const plugin={name:'isolated-fixture',setup(build){
   build.onResolve({filter:/^@\//},args=>{if(stubModules[args.path])return{path:args.path,namespace:'stub'};return {path:path.join(renderer,args.path.slice(2))+(!path.extname(args.path)?'': '')};});
   // These modules are never rendered in the collapsed work header fixture.
   build.onResolve({filter:/\/AgentActionRow$|^\.\/AgentActionRow$/},()=>({path:'action',namespace:'stub'}));
   build.onResolve({filter:/ThinkingText$/},()=>({path:'thinking-text',namespace:'stub'}));
   build.onResolve({filter:/^\.\/botStore$/},()=>({path:'@/features/bots/botStore',namespace:'stub'}));
   build.onLoad({filter:/.*/,namespace:'stub'},args=>({contents:stubModules[args.path]||(args.path==='thinking-text'?'export const ThinkingText=()=>null;':'export const AgentActionRow=()=>{throw Error("Unexpected expanded tool")};'),loader:'tsx'}));
   build.onLoad({filter:/\.(tsx?|js)$/},args=>{
    let filename=args.path;
    if(!fs.existsSync(filename)){for(const ext of ['.tsx','.ts','.js'])if(fs.existsSync(filename+ext)){filename+=ext;break;}}
    if(before&&['BotConnectionStatus.tsx','CindyDeviceRow.tsx','BotWorkingStatus.tsx','localizeAgentStatus.ts','botConversationPresentation.ts'].includes(path.basename(filename)))return {contents:cp.execFileSync('git',['show',`73ae8eaf3772d50173cf5c0aa63666b9d0482e01:${path.relative(root,filename)}`],{encoding:'utf8'}),loader:filename.endsWith('tsx')?'tsx':'ts',resolveDir:path.dirname(filename)};
   });
  }};
  // Let esbuild's normal resolver handle TS extension lookup after aliases.
  const resolve=plugin.setup;plugin.setup=build=>{const orig=build.onResolve.bind(build);build.onResolve=(opts,cb)=>orig(opts,async args=>{const v=await cb(args);if(v?.path&&v.namespace!=='stub'&&!fs.existsSync(v.path)){for(const ext of ['.tsx','.ts','.js'])if(fs.existsSync(v.path+ext)){v.path+=ext;break;}}return v});resolve(build)};
  await esbuild.build({entryPoints:[path.join(fixture,'desktop-teammate-fixture.tsx')],outfile:bundle,bundle:true,format:'esm',platform:'browser',jsx:'automatic',loader:{'.png':'dataurl','.svg':'dataurl'},define:{__BEFORE__:String(before),'import.meta.env.PROD':'true','import.meta.env.DEV':'false'},plugins:[plugin],logLevel:'warning'});
  for(const scenario of ['working','compacting'])for(const theme of ['light','dark']){
   const page=await browser.newPage({viewport:{width:1040,height:625},deviceScaleFactor:1});const errors=[];page.on('pageerror',e=>errors.push(e.message));
   await page.route('http://fixture.local/**',route=>route.fulfill({contentType:'text/html',body:`<!doctype html><html><head><meta charset="utf-8"><style>${css}${extra}</style></head><body><div id="root"></div><script type="module">${fs.readFileSync(bundle,'utf8').replace(/<\/script/gi,'<\\/script')}</script></body></html>`}));
   await page.goto(`http://fixture.local/?theme=${theme}&scenario=${scenario}`);await page.waitForSelector('[data-testid="bot-working-indicator"]');await page.waitForTimeout(1200);
   if(errors.length)throw Error(errors.join('\n'));
   await page.screenshot({path:path.join(themes,`desktop-${stage}-${theme}${scenario==='compacting'?'-compacting':''}.png`)});
   console.log(stage,theme,await page.locator('body').innerText());await page.close();
  }
 }}finally{await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
