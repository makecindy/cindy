import React,{useEffect,useState} from 'react';
import { Box,Text,useInput,useWindowSize } from 'ink';
import type { GhostSetupInteractionSnapshot,GhostSetupInteractionStep,GhostSetupInteractionCommand } from '@cindy/plugin-runtime/ghostSetupInteractionBridge';
import { createPluginSecretPresentation,createPluginConnectionPresentation } from '@cindy/plugin-runtime/shared/pluginOauth';
import { Input,terminalText } from './input.js';
import { useInputState } from './state.js';
import { getMessages,type Locale } from './i18n.js';

const copy:Record<Locale,{host:string;token:string;cancel:string;connect:string}>={
  en:{host:'Host',token:'Token',cancel:'Cancel setup',connect:'Connect'},'zh-CN':{host:'域名',token:'令牌',cancel:'取消配置',connect:'连接'},'zh-TW':{host:'網域',token:'權杖',cancel:'取消設定',connect:'連線'},ja:{host:'ホスト',token:'トークン',cancel:'設定をキャンセル',connect:'接続'},ko:{host:'호스트',token:'토큰',cancel:'설정 취소',connect:'연결'},
};
export type PluginSetupSubmission={kind:'oauth'|'secret'|'connection';ghostId:string;action:{requestId:string;actionId:string;expectedRevision:number};presentation?:unknown;value?:unknown};
export function PluginSetupView({request,locale,busy,back,resolve,submit,authorization}:{
  request:GhostSetupInteractionSnapshot;locale:Locale;busy:boolean;back():void;
  resolve(command:GhostSetupInteractionCommand):void;submit(value:PluginSetupSubmission):void;
  authorization?:{url:string;userCode?:string};
}){
  const t=getMessages(locale),text=copy[locale],{rows}=useWindowSize();
  const [selected,setSelected,selectedNow]=useInputState(0);
  const [form,setForm]=useState<GhostSetupInteractionStep>();
  const [value,setValue]=useState(''),[host,setHost]=useState(''),[token,setToken]=useState(false);
  const steps=request.steps;
  const clear=()=>{setValue('');setHost('');setToken(false);setForm(undefined);};
  useEffect(()=>{clear();},[request.revision]);
  const send=(step:GhostSetupInteractionStep,entry?:unknown)=>{
    const action=step.action;if(!action)return;
    const base={ghostId:request.ghost.id,action:{requestId:request.requestId,actionId:action.id,expectedRevision:request.revision}};
    if(action.kind==='inline_form')submit({...base,kind:'secret',value:entry,presentation:createPluginSecretPresentation(request,step,action.form.fields[0])});
    else if(action.kind==='manage_connection')submit({...base,kind:'connection',value:entry,presentation:createPluginConnectionPresentation(request,step)});
    else if(action.kind==='oauth_connect')submit({...base,kind:'oauth'});
    else resolve({kind:'plugin_setup',action:'run_action',actionId:action.id,expectedRevision:request.revision});
    clear();
  };
  useInput((input,key)=>{
    if(key.eventType==='release')return;
    if(key.escape){if(form)clear();else back();return;}
    if(key.ctrl&&input==='x'){clear();resolve({kind:'plugin_setup',action:'cancel',expectedRevision:request.revision});return;}
    if(busy||form)return;
    if(key.upArrow)setSelected(value=>Math.max(0,value-1));
    if(key.downArrow)setSelected(value=>Math.min(steps.length-1,value+1));
    if(key.return){const step=steps[selectedNow.current];if(!step?.action||!['pending','failed'].includes(step.phase))return;if(['inline_form','manage_connection'].includes(step.action.kind)){setForm(step);setToken(step.action.kind==='inline_form');}else send(step);}
  });
  const count=Math.max(1,rows-12),start=Math.max(0,Math.min(selected,steps.length-count));
  return <Box flexDirection="column" gap={1}>
    <Text bold>{terminalText(request.ghost.name)}</Text>
    {form?<>
      <Text>{terminalText(form.title)}</Text>
      <Text dimColor>{terminalText(form.action?.kind==='inline_form'?form.action.form.fields[0].label:token?text.token:text.host)}</Text>
      <Input value={value} onChange={next=>setValue(next.slice(0,form.action?.kind==='inline_form'?form.action.form.fields[0].maxLength:token?4096:512))} secret={token} active={!busy} onCancel={clear} onSubmit={value=>{if(form.action?.kind==='manage_connection'&&!token){setHost(value);setValue('');setToken(true);}else send(form,form.action?.kind==='manage_connection'?{host,token:value}:value);}}/>
    </>:steps.slice(start,start+count).map((step,index)=><Box key={step.id} flexDirection="column"><Text bold={selected===start+index}>{selected===start+index?'› ':'  '}{['satisfied','completed'].includes(step.phase)?'✓ ':''}{terminalText(step.title)}</Text>{selected===start+index&&<Text dimColor>{terminalText(step.description)}</Text>}</Box>)}
    {authorization&&<Box flexDirection="column"><Text>{terminalText(authorization.url)}</Text>{authorization.userCode&&<Text bold>{terminalText(authorization.userCode)}</Text>}</Box>}
    {busy&&<Text dimColor>{t.working}</Text>}
    <Text dimColor>Esc · {t.back}   Ctrl+X · {text.cancel}</Text>
  </Box>;
}
