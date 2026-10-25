import { readFile } from 'node:fs/promises';
import type { RemoteResourceRegistry, RemoteCollectionItem, RemoteActionDescriptor, RemoteLocalizedText } from '@cindy/device-link';
import type { TerminalCapabilities } from './capabilities.js';
import type { TerminalConfiguration } from '../configuration.js';

const labels={
  skills:['Skills','Skills','Skills','スキル','스킬'],mcp:['MCP servers','MCP 服务器','MCP 伺服器','MCP サーバー','MCP 서버'],
  create:['Create','创建','建立','作成','만들기'],edit:['Edit','编辑','編輯','編集','편집'],remove:['Remove','移除','移除','削除','삭제'],
  enable:['Enable','启用','啟用','有効にする','활성화'],disable:['Disable','停用','停用','無効にする','비활성화'],
  name:['Name','名称','名稱','名前','이름'],id:['ID','ID','ID','ID','ID'],url:['URL','地址','網址','URL','URL'],
  token:['Access token','访问令牌','存取權杖','アクセストークン','액세스 토큰'],transport:['Transport','传输协议','傳輸協定','トランスポート','전송 방식'],
  headers:['Headers (JSON)','请求头（JSON）','請求標頭（JSON）','ヘッダー（JSON）','헤더(JSON)'],
  import:['Add skill folder','添加 Skill 文件夹','加入 Skill 資料夾','スキルフォルダーを追加','스킬 폴더 추가'],path:['Folder or SKILL.md','文件夹或 SKILL.md','資料夾或 SKILL.md','フォルダーまたは SKILL.md','폴더 또는 SKILL.md'],
  description:['Description','描述','描述','説明','설명'],body:['Instructions','指令','指令','指示','지시'],scope:['Scope','作用范围','作用範圍','範囲','범위'],
  user:['All my tasks','我的所有任务','我的所有任務','自分のすべてのタスク','내 모든 작업'],project:['This project','此项目','此專案','このプロジェクト','이 프로젝트'],
  directory:['Project folder','项目目录','專案目錄','プロジェクトフォルダー','프로젝트 폴더'],
  confirm:['Remove this entry?','移除此配置？','移除此設定？','この設定を削除しますか？','이 설정을 삭제할까요?'],
} as const;
const label=(key:keyof typeof labels):RemoteLocalizedText=>{const [fallback,cn,tw,ja,ko]=labels[key];return {fallback,translations:{en:fallback,'zh-CN':cn,'zh-TW':tw,ja,ko}};};
const object=(value:unknown):Record<string,unknown>=>{if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('INVALID_ARGUMENT');return value as Record<string,unknown>;};
const form=(edit=false):RemoteActionDescriptor=>({id:edit?'edit':'create',label:label(edit?'edit':'create'),fields:[
  ...(!edit?[{id:'id',kind:'text',label:label('id'),required:true}]:[]),{id:'name',kind:'text',label:label('name'),required:true},
  {id:'transport',kind:'select',label:label('transport'),required:true,options:[{value:'http',label:'HTTP'},{value:'sse',label:'SSE'}]},
  {id:'url',kind:'text',label:label('url'),required:true},{id:'scope',kind:'select',label:label('scope'),required:true,options:[{value:'user',label:label('user')},{value:'project',label:label('project')}]},{id:'workingDir',kind:'text',label:label('directory')},{id:'token',kind:'secret',label:label('token')},{id:'headers',kind:'secret',label:label('headers')},
]});
export function registerCapabilityResources(registry:RemoteResourceRegistry,capabilities:TerminalCapabilities,configuration:TerminalConfiguration){
  const invoke=(channel:string,args:unknown[],assertCurrent?:()=>void)=>capabilities.invoke(channel,args,{source:'local',assertCurrent});
  const mcpItems=async():Promise<RemoteCollectionItem[]>=>{
    const {servers}=await invoke('maker:mcp:custom:list',[]) as {servers:Array<{id:string;name:string;url:string;transport:string;scope:string;workingDir?:string;enabled:boolean}>};
    return servers.map(server=>({ref:{collectionId:'mcp',kind:'mcp-server',id:server.id},revision:String(capabilities.revision()),display:{title:server.name,subtitle:server.url},links:[],actions:[form(true),{id:server.enabled?'disable':'enable',label:label(server.enabled?'disable':'enable')},{id:'remove',label:label('remove'),tone:'destructive',confirmation:{title:label('confirm')}}],blocks:[{id:'edit',primitive:'form',fallbackMarkdown:'',data:{actionId:'edit',values:{id:server.id,name:server.name,url:server.url,transport:server.transport,scope:server.scope,workingDir:server.workingDir??''}}}]}));
  };
  registry.register({collection:{id:'mcp',resourceKind:'mcp-server',title:label('mcp'),placement:'settings',actions:[form()]},
    list:async()=>({collectionId:'mcp',revision:String(capabilities.revision()),items:await mcpItems()}),
    get:async(_context,request)=>{const row=(await mcpItems()).find(row=>row.ref.id===request.ref.id);if(!row)throw new Error('MCP_NOT_FOUND');return row;},
    invoke:async(context,request)=>{
      if(request.actionId==='configuration:open')return {effects:[],result:configuration.open({...object(request.input),collectionId:'mcp',...(request.resourceRef?{resourceId:request.resourceRef.id}:{})},{source:'remote',deviceId:context.controllerDeviceId,assertCurrent:context.assertCurrent})};
      if(['create','edit'].includes(request.actionId)){
        throw new Error('PROTECTED_INPUT_REQUIRED');
      }else if(request.resourceRef&&request.actionId==='remove')await invoke('maker:mcp:custom:delete',[request.resourceRef.id],context.assertCurrent);
      else if(request.resourceRef&&['enable','disable'].includes(request.actionId))await invoke('terminal:mcp:set-enabled',[request.resourceRef.id,request.actionId==='enable'],context.assertCurrent);
      else throw new Error('INVALID_ACTION');
      return {effects:[{kind:'refresh-collection',collectionId:'mcp'}]};
    },
  });
  const scopeFields=[{id:'scope',kind:'select',label:label('scope'),required:true,options:[{value:'user',label:label('user')},{value:'project',label:label('project')}]},{id:'workingDir',kind:'text',label:label('directory')}];
  const skillActions:RemoteActionDescriptor[]=[{id:'import',label:label('import'),fields:[{id:'path',kind:'text',label:label('path'),required:true},...scopeFields]},{id:'create',label:label('create'),fields:[{id:'name',kind:'text',label:label('name'),required:true},{id:'description',kind:'text',label:label('description'),required:true},{id:'body',kind:'multiline',label:label('body'),required:true},...scopeFields]}];
  const skillItems=async():Promise<RemoteCollectionItem[]>=>{const {items}=await capabilities.listSkills();return items.map(skill=>({ref:{collectionId:'skills',kind:'skill',id:skill.id},revision:String(capabilities.revision()),display:{title:skill.name,subtitle:`${skill.engine} · ${skill.scope}`},links:[],actions:[{id:skill.enabled?'disable':'enable',label:label(skill.enabled?'disable':'enable')},...(skill.managed?[{id:'remove',label:label('remove'),tone:'destructive',confirmation:{title:label('confirm')}}]:[])]}));};
  registry.register({collection:{id:'skills',resourceKind:'skill',title:label('skills'),placement:'settings',actions:skillActions},
    list:async(_context,request)=>{const rows=await skillItems();const offset=request.cursor?Number(request.cursor):0;if(!Number.isSafeInteger(offset)||offset<0)throw new Error('INVALID_CURSOR');const limit=Math.min(request.limit??100,100);return {collectionId:'skills',revision:String(capabilities.revision()),items:rows.slice(offset,offset+limit),...(offset+limit<rows.length?{nextCursor:String(offset+limit)}:{})};},
    get:async(_context,request)=>{const item=(await skillItems()).find(item=>item.ref.id===request.ref.id);const skill=(await capabilities.listSkills()).items.find(skill=>skill.id===request.ref.id);if(!item||!skill)throw new Error('SKILL_NOT_FOUND');const file=skill.mdPath;if(!file)return item;const text=await readFile(file,'utf8');if(text.length>1024*1024)throw new Error('SKILL_TOO_LARGE');return {...item,blocks:[{id:'instructions',primitive:'text',fallbackMarkdown:text}]};},
    invoke:async(context,request)=>{if(request.actionId==='create'||request.actionId==='import')await invoke(`terminal:skills:${request.actionId}`,[request.input??{}],context.assertCurrent);else if(request.resourceRef&&request.actionId==='remove')await invoke('terminal:skills:remove',[request.resourceRef.id],context.assertCurrent);else if(request.resourceRef&&['enable','disable'].includes(request.actionId))await invoke('terminal:skills:set-enabled',[request.resourceRef.id,request.actionId==='enable'],context.assertCurrent);else throw new Error('INVALID_ACTION');return {effects:[{kind:'refresh-collection',collectionId:'skills'}]};},
  });
}
