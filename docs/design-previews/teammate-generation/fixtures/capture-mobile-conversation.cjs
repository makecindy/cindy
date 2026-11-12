const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process'),esbuild=require('esbuild');
const {chromium}=require('playwright-core');
const root=process.cwd(),fixture=path.join(root,'docs/design-previews/teammate-generation/fixtures'),mobile=path.join(root,'apps/mobile/src');
const stubs={
 'expo-router':`export const useRouter=()=>({push:()=>{}});export const useLocalSearchParams=()=>({deviceId:'fixture-host'});export const useFocusEffect=()=>{};`,
 '@/session/remotePathVerdict':`export const peekRemotePathVerdict=()=>null,peekRemotePathVerdictForRender=()=>null,remotePathVerdictKey=()=>'',subscribeRemotePathVerdictChange=()=>()=>{},verifyRemotePathCached=async()=>null;`,
 '@/auth/AuthContext':`export const useAuth=()=>({user:{id:'fixture'},accountGeneration:1,apiFetch:async()=>({})});`,
 '@/device-link/DeviceLinkContext':`export const subscribeRemoteBotChanges=()=>()=>{};export const useDeviceLink=()=>({invoke:async()=>({blocks:[]})});`,
 '@/session/remoteSessionStore':`const activity={phase:'running',workingPhase:new URLSearchParams(location.search).get('scenario')==='compacting'?'compacting':'replying'};export const remoteSessionStore={subscribe:()=>()=>{},getSessionLiveActivity:()=>activity};`,
 '@/session/remoteMedia':`export const resolveMobileRemoteMedia=async()=>({previewable:false});`,
 '@/device-link/mobileMakerTransport':`export const createMobileMakerTransport=()=>({});`,
 '@/config/env':`export const DEVICE_LINK_API_BASE_URL='';`,
 '@/components/MobilePrimitives':`export const MainWindowEmptyState=()=>null;`,
 '@/device-link/remoteResourceCache':`export const isRemoteResourceUnread=()=>false;`,
 '@/i18n':`import i18n from 'i18next';export {i18n};`,
};
const resolve=(v)=>{if(fs.existsSync(v)&&fs.statSync(v).isDirectory())v=path.join(v,'index');if(!fs.existsSync(v))for(const ext of ['.tsx','.ts','.js'])if(fs.existsSync(v+ext))return v+ext;return v};
fs.mkdirSync(path.join(root,'tmp/teammate-generation-evidence'),{recursive:true});
(async()=>{const browser=await chromium.launch({headless:true});try{for(const before of [true,false]){
 const stage=before?'before':'after',bundle=path.join(root,'tmp/teammate-generation-components',`mobile-${stage}.js`);
 await esbuild.build({entryPoints:[path.join(fixture,'mobile-conversation-fixture.tsx')],outfile:bundle,bundle:true,format:'esm',platform:'browser',resolveExtensions:['.web.tsx','.web.ts','.web.js','.tsx','.ts','.js','.json'],jsx:'automatic',loader:{'.png':'dataurl'},define:{__BEFORE__:String(before),__DEV__:'false','process.env.NODE_ENV':'"production"'},plugins:[{name:'mobile-fixture',setup(build){
 build.onResolve({filter:/^expo-router$/},()=>({path:'expo-router',namespace:'stub'}));
 build.onResolve({filter:/^react-native-svg$/},()=>({path:path.join(root,'node_modules/react-native-svg/lib/module/ReactNativeSVG.web.js')}));
 build.onResolve({filter:/^react-native$/},()=>({path:require.resolve('react-native-web')}));
 build.onResolve({filter:/^@\//},args=>stubs[args.path]?{path:args.path,namespace:'stub'}:{path:resolve(path.join(mobile,args.path.slice(2)))});
 build.onResolve({filter:/^\.\/remoteSessionStore$/},()=>({path:'@/session/remoteSessionStore',namespace:'stub'}));
 build.onLoad({filter:/.*/,namespace:'stub'},args=>({contents:stubs[args.path],loader:'tsx',resolveDir:root}));
 build.onLoad({filter:/i18n.*devices\.json$/},args=>before?{contents:cp.execFileSync('git',['show',`235c3953e3afb60447a29a692d5a3b23e28bcd53:${path.relative(root,args.path)}`],{encoding:'utf8'}),loader:'json'}:undefined);
 build.onLoad({filter:/(?:CompanionMessageCard|companionConversationPresentation)\.tsx?$/},args=>before?{contents:cp.execFileSync('git',['show',`235c3953e3afb60447a29a692d5a3b23e28bcd53:${path.relative(root,args.path)}`],{encoding:'utf8'}),loader:'tsx',resolveDir:path.dirname(args.path)}:undefined);
 }}],logLevel:'warning'});
 for(const scenario of ['conversation'])for(const theme of ['light','dark']){const page=await browser.newPage({viewport:{width:420,height:900},deviceScaleFactor:1});const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.route('http://fixture.local/**',route=>route.fulfill({contentType:'text/html',body:`<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0}h2{font-family:-apple-system,sans-serif}</style></head><body><div id="root"></div><script type="module">${fs.readFileSync(bundle,'utf8').replace(/<\/script/gi,'<\\/script')}</script></body></html>`}));await page.goto(`http://fixture.local/?theme=${theme}&scenario=${scenario}`);await page.waitForSelector('#root button');await page.waitForTimeout(300);if(errors.length)throw Error(errors.join('\n'));await page.screenshot({path:path.join(root,`tmp/teammate-generation-evidence/mobile-chat-${stage}-${theme}${scenario==='compacting'?'-compacting':''}.png`)});console.log(stage,theme,'captured');await page.close()}
}}finally{await browser.close()}})().catch(e=>{console.error(e);process.exitCode=1});
