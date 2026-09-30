import React from 'react';
import { createRoot } from 'react-dom/client';
import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';
import { View } from 'react-native';
import { ThemeOverrideProvider } from '../../../../apps/mobile/src/theme/ThemeProvider';
import { lightColors, darkColors } from '../../../../apps/mobile/src/theme/tokens';
import { CompanionMessageCard } from '../../../../apps/mobile/src/session/CompanionMessageCard';
import { CompanionWorkingStatus } from '../../../../apps/mobile/src/session/CompanionWorkingStatus';
import { companionConversationItems } from '../../../../apps/mobile/src/session/companionConversationPresentation';
import { buildMobileMessageRenderItems } from '../../../../apps/mobile/src/session/messageRenderModel';
import zh from '../../../../apps/mobile/src/i18n/locales/zh-CN/index';
const dark = new URLSearchParams(location.search).get('theme') === 'dark';
await i18next.use(initReactI18next).init({ lng: 'zh-CN', resources: { 'zh-CN': { translation: zh } }, interpolation: { escapeValue: false } });
const colors = dark ? darkColors : lightColors;
const row = (id: string, role: string, content: unknown, agentMeta = {}) => ({ id, clientId: id, sessionId: 'fixture', role, content, agentMeta, toolUseId: null, createdAt: new Date(1000 + Number(id)).toISOString() });
const messages = [row('1','user','请整理会议安排。'),row('2','assistant','我先查看相关资料。'),row('3','tool_use',{toolName:'Read',toolUseId:'read',input:{path:'example'}}),row('4','tool_result',{toolUseId:'read',result:'Fixture tool result'}),row('5','assistant','安排已整理好，会议将在周五下午举行。',{turnCompleted:true})];
const grouped = buildMobileMessageRenderItems(messages as any, { isSessionStreaming: false });
// The source=bot task is known, but the optional resource detail is unavailable.
// Before: the screen skipped its projection in that state. After: ownership wins.
const items = __BEFORE__ ? grouped : companionConversationItems(grouped);
const direct = (direction: string) => ({ key: direction, source: {sessionId:'fixture'}, companion: {kind:'direct',meta:{direction,peerBotName:'Aster',peerBotId:'peer',viewerBotId:'viewer',threadId:'thread',preview:direction==='sent'?'请读取示例安排并回传相关摘要。这是合成的伙伴消息正文。':'示例安排已经核实，完整记录可从入口打开。'}} });
createRoot(document.getElementById('root')!).render(<ThemeOverrideProvider mode={dark?'dark':'light'}><div style={{background:colors.surface,color:colors.textPrimary,minHeight:900,fontFamily:'-apple-system,sans-serif',padding:'0 18px',boxSizing:'border-box'}}><p style={{fontSize:11,color:colors.textSecondary,paddingTop:16}}>{__BEFORE__?'修改前':'修改后'} · Mobile · {dark?'Dark':'Light'} · 组件 fixture</p><h2 style={{fontSize:24,margin:'28px 0'}}>Aster</h2><p style={{textAlign:'right',fontSize:17}}>请整理会议安排。</p>{items.filter(item=>item.type!=='message'||item.message.kind!=='user').map(item=><div key={item.key} style={{padding:'18px 0',fontSize:17,lineHeight:1.6}}>{item.type==='work_group'?<span style={{color:colors.textSecondary,fontSize:14}}>◇ 工作了 6 秒　›</span>:item.type==='message'?item.message.body:null}</div>)}<View><CompanionMessageCard message={direct('sent') as any}/><CompanionMessageCard message={direct('received') as any}/></View><p style={{fontSize:17,lineHeight:1.7}}>已收到回复，完整安排已确认。</p><div style={{marginTop:100}}><CompanionWorkingStatus label="正在整理对话…"/><div style={{border:`1px solid ${colors.border}`,borderRadius:28,padding:'16px 20px',color:colors.textSecondary}}>继续对话…</div></div></div></ThemeOverrideProvider>);
