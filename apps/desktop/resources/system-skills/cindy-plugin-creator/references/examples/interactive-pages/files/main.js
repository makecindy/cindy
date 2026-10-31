// 使用前将 api.example.com 地址和 ghost.json 的 hosts / inject.hosts 换成自己的后端。
// Every section is optional: 不需要可以删（连同清单工具、权限及页面按钮）。
const BASE='https://api.example.com';
const IMAGE='iVBORw0KGgoAAAANSUhEUgAAAQAAAAEACAIAAADTED8xAAAE4UlEQVR4nO3TgW0dNxREUVfCStJ/KWkjgQMEjh0JlkQu55NzgFPALt/cb+OPP6HWt/gXQJAAqCYAqgmAagKgmgCoJgCqCYBqAqCaAKgmAKoJgGoCoJoAqCYAqgmAagKgmgCoJgCqCYBqAqCaAKgmAKoJgGoCoJoAqCYAqgmAagKgmgCoJgCqCYBqAqCaAKgmAKoJgGoCoJoAqCYAqgmAagKgmgCoJgCqCYBqAqCaAKgmAKoJgGoCoJoAqCYAqgmAagKgmgCoJgCqCYBqAqCaAKgmAKoJgGoCoJoAqCYAqgmAagJ41l9jzIv/xcUEsN6S0YthDwGs8ejoxfAcAUyJ7F4JCwngi+Kjl8ESAvic+MqVsJYAPio+axk8QQAfEl+zBh4igN+Ij1gGjxLAu+LDlcEGAnhbfK8a2EMAv4rPVAY7CeAn8XVqYDMB/BDfpQb2E8B38TnKIEUAvevXwBBAfH+vIH6FoOoA4st7HfFbpPQGEN/cq4lfJKI0gPjaXlP8Lvs1BhDf2SuLX2ezugDiC3t98Rvt1BVAfFuniF9qGwEggA7xVZ0lfq89WgKI7+lE8attUBFAfEnnit/uaQJAAFeLb+h08Qs+6vIA4uu5Q/yOzxEAArhUfDc3iV/zIQJAADeKL+Y+8Zs+4c4A4lu5VfyyywkAAdwlvpK7xe+7lgAQwF3iE7lb/L5r3RZAfB8N4ldeSAAI4BbxZfSI33oVASCAW8Rn0SN+61XuCSC+iTbxiy8hAARwhfgg2sQvvoQAEMD54mvoFL/7PAEggPPFp9Apfvd5AkAAh4vvoFn8+pMEgAAOFx9Bs/j1JwkAARwuPoJm8etPEgACOFx8BM3i158kAARwuPgImsWvP0kACOBw8RE0i19/kgAQwOHiI2gWv/4kASCAw8VH0Cx+/UkCQACHi4+gWfz6kwSAAA4XH0Gz+PUnCQABHC4+gmbx608SAAI4XHwEzeLXn3RDAEMD1v9VAkAA54tPoVP87vMEgACuEF9Dm/jFlxAAArhCfBBt4hdfQgAI4BbxTfSI33oVASCAW8Rn0SN+61WuCmBowPo/SQAI4C7xfdwtft+1BIAA7hKfyN3i913rwgCGBqz/wwSAAG4U38p94jd9wrUBDA1Y/wcIAAHcK76bO8Tv+BwBIICrxddzuvgFH3V/AEMD1v8+ASCAAvElnSh+tQ1aAhgasP63FAUwNGD9/yMABNAkvq3XF7/RTnUBDA1Y/380BjA0YP3/Kg1gaMD6/9EbwNBA/fpHeQBDA93rHwIY9Q3E3z9LAN/FV2j9KQL4IT5H099PAD+J79L6NxPAr+LrtP6dBPC2+ExNfw8BvCu+V+vfQAC/ER+u6T9KAB8SH7HpP0QAHxVfs/U/QQCfE5+16a8lgC+Kr9zulxDAlPjoTX+SANaw+0MJYD2jP4gAnmX0L04AVBMA1QRANQFQTQBUEwDVBEA1AVBNAFQTANUEQDUBUE0AVBMA1QRANQFQTQBUEwDVBEA1AVBNAFQTANUEQDUBUE0AVBMA1QRANQFQTQBUEwDVBEA1AVBNAFQTANUEQDUBUE0AVBMA1QRANQFQTQBUEwDVBEA1AVBNAFQTANUEQDUBUE0AVBMA1QRANQFQTQBUEwDVBEA1AVBNAFQTANUEQDUBUE0AVBMA1QRANQFQ7W++Exe9JUPSOQAAAABJRU5ErkJggg==';
const streams=new Map(); let form={title:'我的记录',saved:0}; let selected=[];
function checked(r){if(!r||r.ok===false)throw new Error(r?.errorCode||r?.message||'宿主操作失败');return r;}
function clean(s){const safe=String(s??'').replace(/Bearer\s+\S+/gi,'[已隐藏凭证]').replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,'[已隐藏 JWT]');let result='',bytes=0;for(const c of safe){const n=c.codePointAt(0);const size=n<128?1:n<2048?2:n<65536?3:4;if(bytes+size>2048)break;result+=c;bytes+=size;}return result;}
function output(data,links=[]){return {content:[{type:'text',text:'页面操作已完成'},...links],_meta:{showcase:data}};}
function link(uri,name,mimeType){return {type:'resource_link',uri,name,mimeType};}
function response(r,request){return {request,status:r.status??null,errorCode:r.ok===false?clean(r.errorCode||r.message):undefined,body:clean(r.body),truncated:!!r.truncated||String(r.body??'').length>2048};}
function safeFile(f){return {name:f.name,size:f.size,mimeType:f.mimeType,ref:f.ref};}
async function net(m,args){return cindy.fetch({...args,callId:m.callId});}
// 动态内容。不需要可以删。默认模拟可信后端，不联网、不需要凭证。
// 接真实后端时把此函数换成 cindy.fetch（带 callId，检查 ok/status 后解析 body），
// 并在 ghost.json 的 network 中声明域名和凭证，见手册 §4.7。
// HTML 等同于插件自身代码：只接可信来源；外部文本交给页面 textContent，不能拼进 HTML。
async function mockDynamicBackend(intent,callId){
 if(intent==='overview')return {html:'<h4>今日概览</h4><p>还有一项待完成，可以切换明细查看。</p>',data:{view:'overview',completed:2,total:3}};
 if(intent==='details')return {html:'<h4>待办明细</h4><ul><li>整理资料 · 已完成</li><li>核对数据 · 已完成</li><li>生成摘要 · 待完成</li></ul>',data:{view:'details',completed:2,total:3}};
 throw new Error('请选择概览或明细');
}
cindy.onHostMessage(async m=>{
 if(m.type!=='tool-call')return;
 const a=m.args||{};let out;
 try{
  // 基础。不需要可以删。
  if(m.tool==='open_showcase')out=output({ready:true,title:form.title,hint:'按钮的结果只在页面展示。'});
  else if(m.tool==='save_form'){form={title:String(a.title||'').slice(0,160),saved:form.saved+1};out=output(form);}
  else if(m.tool==='dynamic_content'){const r=await mockDynamicBackend(a.intent,m.callId);out={content:[{type:'text',text:'内容已更新'}],structuredContent:r.data,_meta:{html:r.html}};}
  else if(m.tool==='model_only')out=output({modelOnly:true});
  // 文件。不需要可以删。
  else if(m.tool==='file_action'){
   if(a.action==='pick'){
    const r=checked(await cindy.pick({mode:'file',into:a.kind==='attachment'?'library':'media',path:'imports',accept:a.kind==='image'?['image/*']:a.kind==='video'?['video/*']:[],multiple:false,callId:m.callId}));
    selected=(r.files||[]).map(safeFile);out=output({files:selected},selected.filter(f=>f.ref).map(f=>link(f.ref,f.name,f.mimeType)));
   }else if(a.action==='begin'){
    if(!Number.isInteger(a.size)||a.size<1||a.size>16*1024*1024)throw new Error('演示拖放限 16 MiB；更大文件请用系统选择框');
    const name=String(a.name||'file');const prefix=Date.now()+'-';
    const safeName=name.replace(/[^a-zA-Z0-9_.-]/g,'_').slice(-(64-prefix.length)).replace(/[.]+$/,'')||'file';const path='imports/'+prefix+safeName;
    const r=checked(await cindy.library({op:'writeBegin',path,totalBytes:a.size}));streams.set(r.streamId,{path,name,size:a.size,mimeType:String(a.mimeType||'application/octet-stream')});out=output({streamId:r.streamId});
   }else if(a.action==='chunk'){
    if(!streams.has(a.streamId))throw new Error('导入已失效');checked(await cindy.library({op:'writeChunk',streamId:a.streamId,seq:a.seq,content:a.data,encoding:'base64'}));out=output({accepted:true,seq:a.seq});
   }else if(a.action==='abort'){
    checked(await cindy.library({op:'writeAbort',streamId:a.streamId}));streams.delete(a.streamId);out=output({aborted:true});
   }else if(a.action==='commit'){
    const f=streams.get(a.streamId);if(!f)throw new Error('导入已失效');const r=checked(await cindy.library({op:'writeCommit',streamId:a.streamId}));streams.delete(a.streamId);
    const links=[link('library:'+r.path,f.name,f.mimeType)];
    if(f.mimeType.startsWith('image/')){const b=checked(await cindy.library({op:'read',path:r.path,encoding:'base64'}));const d=checked(await cindy.send({type:'cindy-request',kind:'deposit_media',data:b.content,callId:m.callId}));links.push(link(d.url,f.name,f.mimeType));}
    selected=links.map(l=>({ref:l.uri,name:l.name,mimeType:l.mimeType,size:f.size}));out=output({bytes:f.size,sha256:r.sha256},links);
   }else throw new Error('未知文件操作');
  }else if(m.tool==='download_file'){
   const r=await net(m,{url:BASE+'/files/download',as:'library',path:'downloads/backend.txt'});
   const summary=response(r,{method:'GET',path:'/files/download',as:'library'});
   if(r.library){const read=checked(await cindy.library({op:'read',path:r.library.path}));summary.body=clean(read.content);summary.truncated=true;summary.file=r.library;}
   out=output(summary,r.library?[link(r.library.ref,'backend.txt','text/plain')]:[]);
  }else if(m.tool==='save_file')out=output(checked(await cindy.library({op:'saveAs',path:'downloads/backend.txt',name:'showcase-backend.txt'})));
  else if(m.tool==='upload_file'){
   let upload,uploadDir;
   if(a.kind==='hash'){
    let f=selected.find(f=>f.ref?.startsWith('cindy-media://'));
    if(!f){const d=checked(await cindy.send({type:'cindy-request',kind:'deposit_media',data:IMAGE,callId:m.callId}));f={ref:d.url};}
    upload={hashes:[f.ref.split('/').pop().split('.')[0]],field:'file'};
   }else if(a.kind==='directory'){
    const r=checked(await cindy.pick({mode:'directory',deposit:true,title:'选择要上传到已配置后端的目录',callId:m.callId}));uploadDir={token:r.dir_deposit.token};
   }else{
    checked(await cindy.library({op:'write',path:'exports/processed.txt',content:'在本机处理：'+form.title+'\n'+('sample-data\n'.repeat(600000))}));upload={library:['exports/processed.txt'],field:'file'};
   }
   const r=await net(m,{url:BASE+'/files/upload',method:'POST',...(upload?{upload}:{uploadDir})});
   out=output(response(r,{method:'POST',path:'/files/upload',kind:a.kind||'library'}));
  }
  // 宿主能力。不需要可以删。
  else if(m.tool==='write_task')out=output(checked(await cindy.fs({op:'write',root:'workdir',path:'tmp/ui-showcase-page.txt',content:'用户在交互页面点击写入演示。\n',callId:m.callId})));
  else if(m.tool==='kv_demo'){
   const prev=await(await fetch('/kv')).json();const next={...prev,demoCount:Number(prev.demoCount||0)+1};const w=await fetch('/kv',{method:'PUT',body:JSON.stringify(next)});
   if(!w.ok)throw new Error('保存参数失败 '+w.status);out=output({demoCount:next.demoCount});
  }else if(m.tool==='read_settings'){
   const r=await(await fetch('/kv')).json();out=output({displayName:typeof r.displayName==='string'?r.displayName.slice(0,100):'尚未在插件详情中设置',demoCount:Number(r.demoCount||0)});
  }else if(m.tool==='legacy_cards'||m.tool==='image_card'){
   const d=checked(await cindy.send({type:'cindy-request',kind:'deposit_media',data:IMAGE,callId:m.callId}));
   if(m.tool==='legacy_cards')cindy.send({type:'card-update',callId:m.callId,html:'<div style="padding:16px"><h3>旧版 HTML 聊天卡</h3><p>静态展示与交互页面可并存。</p><img width="160" src="'+d.url+'"></div>',height:250});
   out={note:'旧卡片演示，由模型 ghost_call 路径展示。',xdt_image_urls:[d.url]};
  }
  // 联网。不需要可以删。只回受控后端摘要，绝不返回 headers / secret / JWT。
  else if(m.tool==='network_probe'){
   const path=a.kind==='unauthorized'?'/files/unauthorized':'/files/report';
   const r=await net(m,{url:BASE+path,method:'GET'});
   const summary=response(r,{method:'GET',path});
   out=output(summary);
  }else if(m.tool==='slow_task'){
   for(let i=1;i<=20;i++){await new Promise(r=>setTimeout(r,400));cindy.send({type:'tool-progress',callId:m.callId,progress:i,total:20,message:'本机演示步骤 '+i+'/20'});}out=output({completed:20});
  }else throw new Error('未知工具');
  cindy.send({type:'tool-result',callId:m.callId,ok:true,result:out});
 }catch(e){cindy.send({type:'tool-result',callId:m.callId,ok:true,result:{isError:true,content:[{type:'text',text:clean(e.message||'操作失败')}],_meta:{showcase:{error:clean(e.message||'操作失败')}}}});}
});
