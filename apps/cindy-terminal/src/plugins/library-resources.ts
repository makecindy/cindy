import type { RemoteResourceRegistry, RemoteResource, RemoteLocalizedText } from '@cindy/device-link';
import { installedGhostStoragePart } from '@cindy/plugin-runtime/shared/pluginIdentity';
import type { TerminalPlugins } from './host.js';

const copy={
  title:['Plugin libraries','插件作品库','外掛作品庫','プラグインライブラリ','플러그인 라이브러리'],
  relocate:['Move to folder','迁移到文件夹','移至資料夾','フォルダーに移動','폴더로 이동'],
  folder:['Destination folder','目标文件夹','目標資料夾','移動先フォルダー','대상 폴더'],
  defaults:['Move to default location','迁回默认位置','移回預設位置','既定の場所に戻す','기본 위치로 이동'],
  trash:['Move data to trash','将数据移入回收站','將資料移至垃圾桶','データをゴミ箱に移動','데이터를 휴지통으로 이동'],
  confirm:['Move this library to trash?','将此作品库移入回收站？','將此作品庫移至垃圾桶？','このライブラリをゴミ箱に移動しますか？','이 라이브러리를 휴지통으로 이동할까요?'],
  ready:['Available','可用','可用','利用可能','사용 가능'],empty:['Empty','空','空','空','비어 있음'],
  unavailable:['Unavailable','不可用','無法使用','利用不可','사용 불가'],retained:['Retained data','保留的数据','保留的資料','保持されたデータ','보관된 데이터'],
  files:['Files','文件','檔案','ファイル','파일'],
} as const;
const label=(key:keyof typeof copy):RemoteLocalizedText=>{const [fallback,cn,tw,ja,ko]=copy[key];return {fallback,translations:{en:fallback,'zh-CN':cn,'zh-TW':tw,ja,ko}};};
const text=(key:keyof typeof copy,locale='en')=>label(key).translations?.[locale]??label(key).fallback;
const ref=(id:string)=>({collectionId:'plugin-libraries',kind:'plugin-library',id});
const size=(bytes:number)=>bytes<1024?`${bytes} B`:bytes<1024**2?`${(bytes/1024).toFixed(1)} KiB`:bytes<1024**3?`${(bytes/1024**2).toFixed(1)} MiB`:`${(bytes/1024**3).toFixed(1)} GiB`;

export function registerLibraryResources(registry:RemoteResourceRegistry,host:TerminalPlugins){
  const ids=async()=>[...new Set([...(await host.list()).filter(ghost=>ghost.manifest.library).map(installedGhostStoragePart),...await host.library.ids()])];
  const resource=async(id:string,locale?:string):Promise<RemoteResource>=>{
    const row=await host.library.overview(id),action=(name:string)=>`${name}:${row.revision}`;
    return {ref:ref(id),revision:row.revision,display:{title:row.name,subtitle:[text(row.state,locale),row.orphaned?text('retained',locale):''].filter(Boolean).join(' · ')},
      blocks:[{id:'location',primitive:'text',fallbackMarkdown:row.root??text('unavailable',locale)},
        ...(row.bytes===null?[]:[{id:'usage',primitive:'text' as const,fallbackMarkdown:`${text('files',locale)}: ${row.files} · ${size(row.bytes)}`}])],
      actions:row.state==='unavailable'?[]:[
        {id:action('relocate'),label:label('relocate'),fields:[{id:'directory',label:label('folder'),kind:'text',required:true}]},
        ...(row.location==='custom'?[{id:action('default'),label:label('defaults')}]:[]),
        ...(row.state==='ready'?[{id:action('trash'),label:label('trash'),tone:'destructive' as const,confirmation:{title:label('confirm')}}]:[]),
      ],links:[],
    };
  };
  registry.register({collection:{id:'plugin-libraries',resourceKind:'plugin-library',title:label('title'),placement:'settings'},
    list:async(context,request)=>{
      const offset=request.cursor===undefined?0:Number(request.cursor),limit=Math.min(request.limit??100,200);
      if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(limit)||limit<1)throw new Error('INVALID_CURSOR');
      const rows=[];
      for(const id of await ids()){context.assertCurrent?.();const row=await resource(id,request.client.locale);if(!request.query||`${row.display.title} ${id}`.toLowerCase().includes(request.query.toLowerCase()))rows.push(row);}
      return {collectionId:'plugin-libraries',revision:host.version(),items:rows.slice(offset,offset+limit),...(offset+limit<rows.length?{nextCursor:String(offset+limit)}:{})};
    },
    get:async(context,request)=>{context.assertCurrent?.();if(!(await ids()).includes(request.ref.id))throw new Error('PLUGIN_LIBRARY_NOT_FOUND');return resource(request.ref.id,request.client.locale);},
    invoke:async(context,request)=>{
      const id=request.resourceRef?.id,match=/^(relocate|default|trash):([a-f0-9]{64})$/.exec(request.actionId);
      if(!id||!match||!(await ids()).includes(id))throw new Error('PLUGIN_LIBRARY_CHANGED');
      const directory=request.input?.directory;
      if(match[1]==='relocate'&&typeof directory!=='string')throw new Error('PLUGIN_LIBRARY_DIRECTORY_REQUIRED');
      await host.changeLibrary(id,match[2],match[1] as 'relocate'|'default'|'trash',typeof directory==='string'?directory:undefined,context.assertCurrent);
      return {effects:[{kind:'refresh-collection',collectionId:'plugin-libraries'}]};
    },
  });
}
