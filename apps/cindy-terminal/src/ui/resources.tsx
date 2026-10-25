import React, { useEffect, useRef, useState } from 'react';
import { Box, Text, useInput, useWindowSize } from 'ink';
import wrapAnsi from 'wrap-ansi';
import type {
  RemoteText, RemoteCollectionDescriptor, RemoteCollectionItem, RemoteResource,
  RemoteResourceRef, RemoteActionDescriptor, RemoteActionField, RemoteActionInvokeResponse,
} from '@cindy/device-link';
import type { TerminalClient } from '../contracts.js';
import { getMessages, type Locale } from './i18n.js';
import { Input, terminalText } from './input.js';
import { useInputState } from './state.js';
import { invokeResourceAction } from '../resource-commands.js';
import { ChannelRegistration } from './channel-registration.js';
import { ModelChainEditor } from './model-chain.js';

/** Portable resource controller; business actions remain on the selected host. */
export function Resources({ client, device, locale, initialCollection, initialRef, onTask }: { client: TerminalClient; device?: string; locale: Locale;initialCollection?:string;initialRef?:RemoteResourceRef; onTask(id: string,device?:string): void }) {
  const t=getMessages(locale);
  const { rows, columns }=useWindowSize();
  const [collections,setCollections]=useState<RemoteCollectionDescriptor[]>([]);
  const [collection,setCollection]=useState<RemoteCollectionDescriptor>();
  const [items,setItems]=useState<RemoteCollectionItem[]>([]);
  const [resource,setResource]=useState<RemoteResource>();
  const [selected,setSelected,selectedNow]=useInputState(0);
  const [busy,setBusy,busyNow]=useInputState(false);
  const [error,setError]=useState('');
  const [notice,setNotice]=useState('');
  const [action,setAction,actionNow]=useInputState<RemoteActionDescriptor|undefined>(undefined);
  const [confirmed,setConfirmed,confirmedNow]=useInputState(false);
  const [field,setField,fieldNow]=useInputState(0);
  const [values,setValues,valuesNow]=useInputState<Record<string,unknown>>({});
  const [bodyOffset,setBodyOffset]=useState(0);
  const [input,setInput]=useState('');
  const [choiceQuery,setChoiceQuery,choiceQueryNow]=useInputState('');
  const [cursor,setCursor]=useState<string>();
  const [registration,setRegistration]=useState<string>();
  const epoch=useRef(0);
  const descriptor={protocolVersion:1,primitives:['text','form','actions','session-controls'],locale};
  const txt=(value?:RemoteText)=>terminalText(typeof value==='string'?value:value?.translations?.[locale]??value?.fallback??'');
  async function call<T>(suffix:string,args:Record<string,unknown>):Promise<T>{return client.invoke<T>(`maker:remote-resources:${suffix}`,[{client:descriptor,...args}],device);}
  async function run(work:()=>Promise<void>){setBusy(true);setError('');try{await work();}catch(reason){setError(`${t.error} · ${reason instanceof Error&&/^[A-Z_]+$/.test(reason.message)?reason.message:'RESOURCE_REQUEST_FAILED'}`);}finally{setBusy(false);}}
  async function list(target:RemoteCollectionDescriptor,after?:string){
    const at=epoch.current;
    const result=await call<{items:RemoteCollectionItem[];nextCursor?:string}>('list',{collectionId:target.id,limit:100,...(after?{cursor:after}:{})});
    if(epoch.current!==at)return;
    setCollection(target);setItems(current=>after?[...current,...result.items]:result.items);setCursor(result.nextCursor);setResource(undefined);setSelected(0);
  }
  async function open(ref:RemoteResourceRef){
    const at=epoch.current;
    if(collection?.id!==ref.collectionId){
      let target=collections.find(item=>item.id===ref.collectionId);
      if(!target){const manifest=await call<{collections:RemoteCollectionDescriptor[]}>('manifest',{});if(epoch.current!==at)return;setCollections(manifest.collections);target=manifest.collections.find(item=>item.id===ref.collectionId);}
      if(!target)throw new Error('CAPABILITY_NOT_AVAILABLE_ON_TARGET');
      await list(target);if(epoch.current!==at)return;
    }
    const result=await call<RemoteResource>('get',{ref});
    if(epoch.current!==at)return;
    setResource(result);setSelected(0);setBodyOffset(0);
  }
  async function submit(chosen:RemoteActionDescriptor,inputValues:Record<string,unknown>){
    if(!collection)return;
    if(collection.id==='channels'&&resource?.ref.id==='feishu'&&chosen.id==='connect'){
      if(inputValues.service!=='feishu'&&inputValues.service!=='lark')throw new Error('INVALID_CONFIGURATION');
      setAction(undefined);setValues({});setInput('');setRegistration(inputValues.service);return;
    }
    const result=await invokeResourceAction(client,{client:descriptor,collectionId:resource?.ref.collectionId??collection.id,actionId:chosen.id,...(resource?{resourceRef:resource.ref}:{}),input:inputValues},device);
    setAction(undefined);setInput('');setValues({});
    const target=result.result as {sessionId?:unknown;deviceId?:unknown}|undefined;
    if(target&&typeof target.sessionId==='string'&&typeof target.deviceId==='string'){onTask(target.sessionId,target.deviceId);return;}
    for(const effect of result.effects??[]){
      if(effect.kind==='toast')setNotice(txt(effect.message));
      else if(effect.kind==='navigate'){if(effect.target.kind==='session')onTask(effect.target.sessionId);else await open(effect.target.ref);}
      else if(effect.kind==='refresh-resource'&&resource)await open(effect.ref);
      else if(effect.kind==='refresh-collection'&&effect.collectionId===collection.id){
        const keepsDetail=resource&&result.effects?.some(next=>next.kind==='refresh-resource'&&next.ref.collectionId===resource.ref.collectionId&&next.ref.id===resource.ref.id);
        if(keepsDetail){
          const result=await call<{items:RemoteCollectionItem[];nextCursor?:string}>('list',{collectionId:collection.id,limit:100});
          setItems(result.items);setCursor(result.nextCursor);
        }else await list(collection);
      }
    }
  }
  async function begin(chosen:RemoteActionDescriptor){
    let source=resource;
    if(source){
      const operationBlock=source.blocks?.find(block=>(block.data as {actionId?:string}|undefined)?.actionId===chosen.id)?.id;
      const at=epoch.current;
      const fresh=await call<RemoteResource>('get',{ref:source.ref});
      if(epoch.current!==at)return;
      source=fresh;setResource(fresh);
      const refreshedId=operationBlock?(fresh.blocks?.find(block=>block.id===operationBlock)?.data as {actionId?:string}|undefined)?.actionId:chosen.id;
      const action=fresh.actions?.find(action=>action.id===refreshedId);
      if(!action)throw new Error('ACTION_NOT_AVAILABLE_ON_TARGET');
      chosen=action;
    }
    if(chosen.disabled)return;
    if(chosen.fields?.some(item=>!['text','multiline','secret','toggle','select'].includes(item.kind))){setError(t.notImplemented);return;}
    const block=source?.blocks?.find(block=>block.primitive==='form'&&(block.data as {actionId?:string}|undefined)?.actionId===chosen.id);
    const defaults=(block?.data as {values?:Record<string,unknown>}|undefined)?.values??{};
    setAction(chosen);setConfirmed(!chosen.confirmation);setField(0);setValues(defaults);prepareField(chosen.fields?.[0],defaults);if(chosen.confirmation)setSelected(0);
    if(!chosen.confirmation&&!chosen.fields?.length)await submit(chosen,defaults);
  }
  useEffect(()=>{
    epoch.current++;const at=epoch.current;setCollection(undefined);setResource(undefined);setAction(undefined);setRegistration(undefined);setSelected(0);
    void run(async()=>{const result=await call<{collections:RemoteCollectionDescriptor[]}>('manifest',{});if(epoch.current!==at)return;setCollections(result.collections);const collectionId=initialRef?.collectionId??initialCollection;if(collectionId){const target=result.collections.find(item=>item.id===collectionId);if(!target)throw new Error('CAPABILITY_NOT_AVAILABLE_ON_TARGET');await list(target);if(initialRef)await open(initialRef);}});
    return()=>{epoch.current++;};
  },[device,client,initialCollection,initialRef]);
  useEffect(() => {
    if (collection?.id !== 'local-models' || action || busy) return;
    let closed = false, pending = false;
    const at = epoch.current;
    const refresh = async () => {
      if (pending) return; pending = true;
      try {
        if (resource) {
          const next = await call<RemoteResource>('get', {ref: resource.ref});
          if (!closed && epoch.current === at) { setResource(next); setError(''); }
        } else {
          const next = await call<{items: RemoteCollectionItem[]; nextCursor?: string}>('list', {collectionId: collection.id, limit: 100});
          if (!closed && epoch.current === at) { setItems(next.items); setCursor(next.nextCursor); setError(''); }
        }
      } catch { if (!closed && epoch.current === at) setError(`${t.error} · RESOURCE_REQUEST_FAILED`); }
      finally { pending = false; }
    };
    const timer = setInterval(() => void refresh(), 2000);
    return () => { closed = true; clearInterval(timer); };
  }, [collection?.id, resource?.ref.id, action, busy, client, device]);
  const fieldDescriptor=action?.fields?.[field];
  const modelChainField=confirmed&&collection?.id==='teammates'&&fieldDescriptor?.kind==='multiline'&&['modelChain','taskModel'].includes(fieldDescriptor.id);
  const filteredOptions=fieldDescriptor?.kind==='select'?fieldDescriptor.options?.filter(option=>txt(option.label).toLocaleLowerCase().includes(choiceQuery.toLocaleLowerCase()))??[]:[];
  const choices=action&&!confirmed?[t.cancel,txt(action.confirmation?.confirmLabel)||t.yes]
    :fieldDescriptor?.kind==='toggle'?[t.no,t.yes]
    :fieldDescriptor?.kind==='select'?filteredOptions.map(option=>txt(option.label)):[];
  const actions=(resource?.actions??collection?.actions??[]).filter(action=>!action.id.startsWith('management:'));
  const links=resource?.links??[];
  const lines=resource?[
    ...links.map(link=>({id:link.rel,title:txt(link.label)||t.history,run:()=>{const target=link.target;return target.kind==='session'?onTask(target.sessionId):void run(()=>open(target.ref));}})),
    ...actions.map(item=>({id:item.id,title:txt(item.label)+(item.disabled?' · —':''),run:()=>void run(()=>begin(item))})),
  ]:collection?[
    ...items.map(item=>({id:item.ref.id,title:txt(item.display.title)+(item.display.status?` · ${txt(item.display.status.label)}`:''),run:()=>void run(()=>open(item.ref))})),
    ...actions.map(item=>({id:item.id,title:`+ ${txt(item.label)}`,run:()=>void run(()=>begin(item))})),
    ...(cursor?[{id:'more',title:t.next,run:()=>void run(()=>list(collection,cursor))}]:[]),
  ]:collections.map(item=>({id:item.id,title:txt(item.title),run:()=>void run(()=>list(item))}));
  useEffect(() => { if (!action) setSelected(value => Math.min(value, Math.max(0, lines.length - 1))); }, [lines.length, action]);
  function prepareField(next:RemoteActionField|undefined,defaults:Record<string,unknown>){
    setChoiceQuery('');
    const value=next?defaults[next.id]:undefined;
    setInput(typeof value==='string'?value:'');
    setSelected(next?.kind==='toggle'?(value===true?1:0):next?.kind==='select'?Math.max(0,next.options?.findIndex(option=>option.value===value)??0):0);
  }
  function nextField(value:unknown){
    const current=actionNow.current, index=fieldNow.current, descriptor=current?.fields?.[index];
    if(!current||!descriptor)return;
    if(descriptor.required&&(value===undefined||value===''))return;
    const next={...valuesNow.current,[descriptor.id]:value};
    if(index+1<(current.fields?.length??0)){setValues(next);setField(index+1);prepareField(current.fields?.[index+1],next);}
    else void run(()=>submit(current,next));
  }
  const isText=!!fieldDescriptor&&confirmed&&['text','multiline','secret'].includes(fieldDescriptor.kind);
  useInput((_input,key)=>{
    if(key.eventType==='release')return;
    const current=actionNow.current, currentField=current?.fields?.[fieldNow.current];
    const textActive=currentField&&confirmedNow.current&&['text','multiline','secret'].includes(currentField.kind);
    if(busyNow.current||textActive)return;
    if(currentField?.kind==='select'&&confirmedNow.current){
      if(key.escape&&choiceQueryNow.current){setChoiceQuery('');setSelected(0);return;}
      if(key.backspace||(!key.ctrl&&!key.meta&&!key.tab&&!key.return&&!key.escape&&!key.upArrow&&!key.downArrow&&_input)){
        setChoiceQuery(key.backspace?Array.from(choiceQueryNow.current).slice(0,-1).join(''):choiceQueryNow.current+terminalText(_input));setSelected(0);return;
      }
    }
    if(!action&&resource&&(key.pageUp||key.pageDown)){setBodyOffset(value=>Math.max(0,Math.min(Math.max(0,bodyLines.length-bodyRows),value+(key.pageDown?bodyRows:-bodyRows))));return;}
    if(key.escape){epoch.current++;if(action)setAction(undefined);else if(resource)setResource(undefined);else{setCollection(undefined);setItems([]);}setSelected(0);return;}
    const count=action?choices.length:lines.length;
    if(key.upArrow)setSelected(value=>Math.max(0,value-1));
    if(key.downArrow)setSelected(value=>Math.min(count-1,value+1));
    if(key.return){
      if(current&&!confirmedNow.current){if(selectedNow.current===0)setAction(undefined);else if(current.fields?.length){setConfirmed(true);prepareField(current.fields[0],valuesNow.current);}else void run(()=>submit(current,valuesNow.current));}
      else if(currentField){const option=currentField.options?.filter(option=>txt(option.label).toLocaleLowerCase().includes(choiceQueryNow.current.toLocaleLowerCase()))[selectedNow.current];if(currentField.kind==='toggle'||option)nextField(currentField.kind==='toggle'?selectedNow.current===1:option?.value);}
      else lines[selectedNow.current]?.run();
    }
  },{isActive:!registration&&!modelChainField});
  const bodyRows=Math.max(3,Math.floor(rows/3));
  const bodyLines=wrapAnsi((resource?.blocks??[]).filter(block=>block.primitive!=='form').map(block=>terminalText(block.fallbackMarkdown)).filter(Boolean).join('\n\n'),Math.max(10,columns-4),{hard:true,trim:false}).split('\n');
  const visibleBody=resource&&!action&&bodyLines.some(line=>line.trim())?Math.min(bodyRows,bodyLines.length)+(bodyLines.length>bodyRows?1:0)+1:0;
  const labels=action?choices:lines.map(line=>line.title);
  const searchVisible=!!action&&confirmed&&fieldDescriptor?.kind==='select'&&(fieldDescriptor.options?.length??0)>8;
  const availableRows=Math.max(2,rows-12-visibleBody-(action?2:0)-(searchVisible?2:0));
  const heights=labels.map(label=>wrapAnsi(`› ${label}`,Math.max(10,columns-4),{hard:true,trim:false}).split('\n').length+1);
  let start=0,end=0,usedRows=0;
  for(;end<labels.length;end++){
    const height=heights[end];
    if(end>selected&&usedRows+height>availableRows)break;
    while(start<end&&usedRows+height>availableRows){usedRows-=heights[start++];}
    usedRows+=height;
  }
  if(registration)return <ChannelRegistration client={client} device={device} service={registration} locale={locale} onDone={()=>{setRegistration(undefined);if(resource)void run(()=>open(resource.ref));}}/>;
  if(modelChainField)return <ModelChainEditor key={`${action?.id}-${fieldDescriptor.id}`} client={client} device={device} locale={locale} value={values[fieldDescriptor.id]??'[]'} single={fieldDescriptor.id==='taskModel'} onDone={nextField} onCancel={()=>setAction(undefined)}/>;
  return <Box flexDirection="column" gap={1}>
    <Text bold>{resource?txt(resource.display.title):collection?txt(collection.title):t.resources}{resource?.display.status?` · ${txt(resource.display.status.label)}`:''}{busy?` · ${t.loading}`:''}</Text>
    {visibleBody>0&&<Box flexDirection="column"><Text>{bodyLines.slice(bodyOffset,bodyOffset+bodyRows).join('\n')}</Text>{bodyLines.length>bodyRows&&<Text dimColor>{bodyOffset+1}–{Math.min(bodyOffset+bodyRows,bodyLines.length)} / {bodyLines.length} · PgUp / PgDn</Text>}</Box>}
    {action?<>
      <Text>{!confirmed?txt(action.confirmation?.title):fieldDescriptor?txt(fieldDescriptor.label):txt(action.label)}</Text>
      {searchVisible&&<Text dimColor>{t.search}{choiceQuery?` · ${choiceQuery}`:''}</Text>}
      {!confirmed&&action.confirmation?.body&&<Text>{txt(action.confirmation.body)}</Text>}
      {isText?<Input value={input} onChange={setInput} active={!busy} secret={fieldDescriptor?.kind==='secret'} multiline={fieldDescriptor?.kind==='multiline'} onSubmit={nextField} onCancel={()=>setAction(undefined)} />
        :choices.slice(start,end).map((choice,index)=><Text key={index+start} bold={index+start===selected}>{index+start===selected?'› ':'  '}{choice}</Text>)}
    </>:lines.slice(start,end).map((line,index)=><Text key={line.id} bold={selected===index+start}>{selected===index+start?'› ':'  '}{line.title}</Text>)}
    {!action&&!busy&&!error&&lines.length===0&&<Text dimColor>{t.emptyResources}</Text>}
    {notice&&<Text>{notice}</Text>}{error&&<Text color="red">{error}</Text>}
  </Box>;
}
