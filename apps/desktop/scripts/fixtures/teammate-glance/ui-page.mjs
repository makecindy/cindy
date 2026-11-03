import assert from 'node:assert/strict';

const data = 'window.__uiPage.ctx';
const now = Date.now();

/** 伙伴近况浮层（docs/product-rules/cindy-bots-runtime.md 6.3.4）。 */
export default {
  name: 'teammate-glance',
  entry: './glance-fixture.tsx',
  viewport: { width: 1040, height: 760 },
  real: 'BotSessionContentHeader, BotGlancePopover (computers, todos, outputs, due dots, context menu), Radix popover/menu, theme and translations',
  notCovered:
    'Live todo/delegation data, cloud companion home switching, remote teammates over device-link, sending the quoted todo or 帮我查查, toggling the daily check, opening files',
  stubs: {
    'src/renderer/features/device-link/refreshRemoteSessions': `export const refreshRemoteDeviceSessions=async()=> 'done';`,
    'src/renderer/hooks/useCCSessions': `const tasks=[{id:'task-1',title:'整理项目反馈',status:'active',updatedAt:'2026-10-28T10:00:00Z'}, {id:'task-2',title:'完善手机任务入口',status:'active',updatedAt:'2026-10-28T09:00:00Z'}];export const useCCSessions=()=>({sessions:${data}.case==='new'?[]:tasks});`,
    'src/renderer/features/bots/botFollowScopes': { partial: `export const useTaskCreatorIndex=()=>new Map(['task-1','task-2'].map(id=>[JSON.stringify([null,id]),new Set([JSON.stringify(['teammate','cindy'])])]));` },
    'src/renderer/contexts/PrRefsContext': { partial: `export const usePrRefsForSessions=ids=>ids.length?[{sessionId:'task-1',owner:'example',repo:'app',prNumber:42,lastSeenAt:${now + 1}}]:[]; export const usePrStatuses=()=>({statuses:new Map([['example/app#42',{ok:true,status:'merged',title:'修复伙伴任务的跨设备入口'}]]),successfulStatuses:new Map()});` },
    'src/renderer/lib/sessionAttentionStore': { partial: `export const useSessionAttentionKind=id=>id==='task-1'?'done':undefined;` },
    'src/renderer/features/bots/botStore': {
      partial: `export const useBotProfiles=()=>${data}.case==='new'?[]:[{id:'cindy-default',name:'Cindy',templateId:'cindy',status:'active',sessionId:'chat-1'}];export const useBotUnreadCounts=()=>({});`,
    },
    'src/renderer/features/bots/useRemoteBots': `export const useRemoteCindyIds=()=>new Set(); export const useRemoteBots=()=>${data}.case==='new'?[]:[
      {id:'cindy-default',name:'Cindy',deviceId:'mini',deviceName:'Mac-mini',online:true,sessionId:'r1',avatar:'',status:'active'},
      {id:'cindy-default',name:'Cindy',deviceId:'mbp',deviceName:'Chris-MBP-M5',online:false,sessionId:'r2',avatar:'',status:'active'},
      {id:'cindy-default',name:'Cindy',deviceId:'imac',deviceName:'Office iMac',online:false,sessionId:'r3',avatar:'',status:'active'}];`,
    'src/renderer/features/device-link/useDeviceLinkDeviceList':
      "export const useDeviceLinkDeviceList=()=>[{deviceId:'self',name:'Mac-Studio',isSelf:true}];",
    'src/renderer/features/bots/botDelegationLive': `export const useBotDelegations=()=>${data}.case==='new'?[]:[
      {id:'d1',requestingBotId:'cindy-default',status:'completed',title:'October growth report',childSessionId:'c1',completedAt:${now},updatedAt:${now},
       artifacts:[{path:'reports/October growth report.docx',absolutePath:'/w/reports/October growth report.docx',status:'added'},{path:'src/app.ts',status:'modified'}]},
      {id:'d2',requestingBotId:'cindy-default',status:'completed',title:'Studio local capabilities',childSessionId:'c2',completedAt:${now - 86_400_000},updatedAt:${now - 86_400_000},
       artifacts:[{path:'Studio capabilities.pdf',absolutePath:'/w/Studio capabilities.pdf',status:'added'},{path:'feedback.xlsx',absolutePath:'/w/feedback.xlsx',status:'added'},{path:'tray.png',absolutePath:'/w/tray.png',status:'added'}]}];`,
  },
  cases: {
    default: { about: 'Cindy on several computers, todos with one due today, finished deliverables' },
    menu: { about: 'Right-clicking a todo offers only Delete' },
    new: { about: 'Empty teammate: only Computers; no todo suggestions or outputs' },
    activity: { about: 'No todos, attributed recent tasks, unread result and true PR title' },
  },
  async ready(page) {
    await page.getByTestId('bot-glance-button').waitFor();
  },
  async check(page, ui) {
    const button = page.getByTestId('bot-glance-button');
    if (ui.case !== 'new' && ui.case !== 'activity') {
      await page.waitForFunction(() =>
        document.querySelector('[data-testid="bot-glance-button"] span[aria-hidden]') !== null,
      );
      await ui.capture('entry-due-dot');
    }
    await button.click();
    const popover = page.getByTestId('bot-glance-popover');
    await popover.waitFor();
    if (ui.case === 'new') {
      assert.equal(await page.getByTestId('bot-glance-todo').count(), 0, 'no todo rows');
      assert.equal(await page.getByTestId('bot-glance-check').count(), 0, 'no check prompt when empty');
      assert.equal(await page.getByTestId('bot-glance-daily-check').count(), 0, 'no daily prompt');
      assert.equal(await page.getByTestId('bot-glance-output').count(), 0, 'no outputs block');
      assert.equal(await page.getByTestId('bot-glance-computer').count(), 1, 'only this computer');
      await ui.capture('open');
      return;
    }
    if (ui.case === 'activity') {
      assert.equal(await page.getByTestId('bot-glance-task').count(), 2);
      assert.equal(await page.getByTestId('bot-glance-pr').count(), 1);
      assert.equal(await page.getByTestId('bot-glance-check').count(), 0);
      await ui.capture('open');
      return;
    }
    assert.equal(await page.getByTestId('bot-glance-todo').count(), 2, 'two todos leave room for recent tasks');
    assert.equal(await page.getByTestId('bot-glance-check').count(), 1, '帮我查查 first in the todo block');
    assert.equal(await popover.locator('[data-testid="bot-glance-output"], [data-testid="bot-glance-pr"]').count(), 3, 'three mixed outputs before Show more');
    assert.equal(await page.getByTestId('bot-glance-computer').count(), 2, 'offline computers folded');
    const box = await popover.boundingBox();
    assert.ok(box.width <= 360 && box.x + box.width <= ui.viewport.width, 'popover stays inside the window');
    assert.ok(box.y >= 0 && box.y + box.height <= ui.viewport.height + 1, 'popover uses available height without leaving the window');
    if (ui.case === 'menu') {
      await page.getByTestId('bot-glance-todo').nth(1).click({ button: 'right' });
      await page.getByRole('menuitem').first().waitFor();
      assert.equal(await page.getByRole('menuitem').count(), 1, 'only Delete');
      await ui.capture('menu');
      return;
    }
    await ui.capture('open');
  },
};
