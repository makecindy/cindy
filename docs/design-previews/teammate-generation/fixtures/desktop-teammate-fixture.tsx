import React from 'react';
import { createRoot } from 'react-dom/client';
import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';
import { MemoryRouter } from 'react-router-dom';
import zh from '../../../../apps/desktop/src/renderer/i18n/locales/zh-CN/common.json';
import { defaultLight as cindyLight } from '../../../../apps/desktop/src/renderer/themes/builtin/default-light';
import '../../../../apps/desktop/src/renderer/themes/colors';
import { ThemeService } from '../../../../apps/desktop/src/renderer/themes/theme-service';
import { defaultDark as cindyDark } from '../../../../apps/desktop/src/renderer/themes/builtin/default-dark';
import { CindyDeviceRow } from '../../../../apps/desktop/src/renderer/features/bots/CindyDeviceRow';
import { BotWorkingStatus } from '../../../../apps/desktop/src/renderer/features/bots/BotWorkingStatus';
import { BotGenerationLabel } from '../../../../apps/desktop/src/renderer/features/bots/BotGenerationLabel';
import { BotAvatar } from '../../../../apps/desktop/src/renderer/features/bots/BotAvatar';
import { WorkGroupBlock } from '../../../../apps/desktop/src/renderer/components/chat/WorkGroupBlock';
import { simplifyBotRenderItems } from '../../../../apps/desktop/src/renderer/features/bots/botConversationPresentation';
import { groupWorkRuns } from '../../../../apps/desktop/src/renderer/components/chat/messageWorkGroups';
const q = new URLSearchParams(location.search);
const dark = q.get('theme') === 'dark';
const scenario = q.get('scenario') || 'working';
const compacting = scenario === 'compacting';
const running = scenario === 'working' || compacting;
const online = scenario !== 'offline';
const theme = dark ? cindyDark : cindyLight;
new ThemeService().applyTheme(theme);
document.documentElement.classList.toggle('dark',dark);
await i18next.use(initReactI18next).init({ lng:'zh-CN', resources:{ 'zh-CN':{ translation:zh }}, interpolation:{ escapeValue:false }});
const bot = { id:'demo',name:'Cindy',avatar:'cindy://avatar/preset/cindy',avatarColor:'teal' };
const current = {key:'local', bot, label:'这台电脑', deviceName:'这台电脑', online, unread:false,route:'/bots/demo'};
const inputs:any[] = [
 {type:'message',key:'user',message:{clientId:'user',role:'user',content:'帮我整理今天的安排。'}},
 {type:'message',key:'progress',message:{clientId:'progress',role:'assistant',content:'我先查看相关记录，再整理安排。',isStreaming:running}},
 ...(running ? [] : [{type:'message',key:'answer',message:{clientId:'answer',role:'assistant',content:'已整理好今天的安排，重点事项有三项。',turnCompleted:true}}]),
];
const items=simplifyBotRenderItems(groupWorkRuns(inputs,running),running);
function App(){return <MemoryRouter><div className="fixture-caption">{__BEFORE__?'修改前':'修改后'} · Desktop · {dark?'Dark':'Light'} · 真实组件 / 离线夹具</div><div className="layout"><aside><h2>伙伴</h2><CindyDeviceRow current={current as any} options={[current] as any} selected typing={running} timestamp="现在" onOpen={()=>{}} onSelect={()=>{}} subtitle={running?(__BEFORE__?(compacting?'Compacting...':'我先查看相关记录，再整理安排。'):<BotGenerationLabel sessionId="demo" phase={compacting?'compacting':'replying'} startedAt={1}/>):'已整理好今天的安排。'}/></aside><main><header><BotAvatar bot={bot} size="sm"/> Cindy</header><section className="messages">{items.map(item=>item.type==='work_group'?<WorkGroupBlock key={item.key} blockId={item.key} compact isStreaming={running} childItems={[{kind:'rendered',key:'public',renderNode:()=> <div>我先查看相关记录，再整理安排。</div>}]} />:item.type==='message'?<div key={item.key} className={item.message.role==='user'?'user-bubble':'answer'}>{item.message.content}</div>:null)}</section><footer><BotWorkingStatus visible={running} status={compacting?'Compacting...':'Generating…'} messages={[{clientId:'progress',role:'assistant',content:'公开进度',isStreaming:running && !compacting}]} startedAt={1} foregroundRunning={running} backgroundWorkActive={false} avatar={<BotAvatar bot={bot} size="sm"/>}/><div className="composer">发消息给 Cindy <span>↑</span></div></footer></main></div></MemoryRouter>}
createRoot(document.getElementById('root')!).render(<App/>);
