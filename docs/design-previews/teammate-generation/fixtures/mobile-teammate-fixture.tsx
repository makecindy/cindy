import React from 'react';
import { createRoot } from 'react-dom/client';
import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';
import { ThemeOverrideProvider } from '../../../../apps/mobile/src/theme/ThemeProvider';
import { lightColors,darkColors } from '../../../../apps/mobile/src/theme/tokens';
import { TeammateList } from '../../../../apps/mobile/src/session/TeammateList';
import { CompanionWorkingStatus, useCompanionWorkingLabel } from '../../../../apps/mobile/src/session/CompanionWorkingStatus';
import zh from '../../../../apps/mobile/src/i18n/locales/zh-CN/index';
const dark=new URLSearchParams(location.search).get('theme')==='dark';
const compacting=new URLSearchParams(location.search).get('scenario')==='compacting';
await i18next.use(initReactI18next).init({lng:'zh-CN',resources:{'zh-CN':{translation:zh}},interpolation:{escapeValue:false}});
const colors=dark?darkColors:lightColors;
const rows=['Cindy','Mimi','Nova'].map((name,i)=>({key:`host-${i}:${name}`,host:{deviceId:`host-${i}`,deviceName:`Computer ${i}`},item:{ref:{collectionId:'teammates',kind:'bot',id:name},revision:'1',links:[],display:{title:name,preview:i===0?(compacting?'Compacting...':'我先查看相关记录，再整理安排。'):'已整理好今天的安排。',avatar:{kind:'emoji',value:['🤖','🐱','🐻'][i],fallbackText:name[0]},...(!__BEFORE__&&i===0?{generation:{phase:compacting?'compacting':'replying',startedAt:1}}:{})}}}));
const messages:any[]=[{id:'u',role:'user',content:'整理安排'},{id:'t',role:'tool_use',content:{toolName:'unknown',input:{}}}];
function Status(){ const label=useCompanionWorkingLabel({sessionId:'demo',deviceId:'host-0',botId:'Cindy',active:true,messages,reconnectAttempt:null});return <CompanionWorkingStatus label={label}/>;}
createRoot(document.getElementById('root')!).render(<ThemeOverrideProvider mode={dark?'dark':'light'}><div style={{background:colors.surface,color:colors.textPrimary,minHeight:720,fontFamily:'-apple-system,sans-serif'}}><div style={{fontSize:11,padding:16,color:colors.textSecondary,borderBottom:`1px solid ${colors.border}`}}>{__BEFORE__?'修改前':'修改后'} · Mobile · {dark?'Dark':'Light'} · React Native Web 组件夹具</div><h2 style={{fontSize:26,padding:'4px 22px'}}>伙伴</h2><TeammateList items={rows as any} embedded loading={false} refreshing={false} error={null} isOnline={host=>host.deviceId!=='host-2'} onRefresh={()=>{}} onSelect={()=>{}}/><div style={{margin:'90px 18px 0',paddingTop:16,borderTop:`1px solid ${colors.border}`}}><Status/><div style={{borderRadius:24,border:`1px solid ${colors.border}`,padding:'16px 18px',color:colors.textTertiary}}>发消息给 Cindy</div></div></div></ThemeOverrideProvider>);
