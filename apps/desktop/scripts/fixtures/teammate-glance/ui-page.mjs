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
    'src/renderer/features/bots/botStore': {
      partial: `export const useBotProfiles=()=>${data}.case==='new'?[]:[{id:'cindy-default',name:'Cindy',templateId:'cindy',status:'active',sessionId:'chat-1'}];export const useBotUnreadCounts=()=>({});`,
    },
    'src/renderer/features/bots/useRemoteBots': `export const useRemoteBots=()=>${data}.case==='new'?[]:[
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
    new: { about: 'A new teammate: Computers, and the todo block with only 帮我查查 and the daily switch; no outputs' },
  },
  async ready(page) {
    await page.getByTestId('bot-glance-button').waitFor();
  },
  async check(page, ui) {
    const button = page.getByTestId('bot-glance-button');
    if (ui.case !== 'new') {
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
      assert.equal(await page.getByTestId('bot-glance-check').count(), 1, '帮我查查 even without todos');
      assert.equal(await page.getByTestId('bot-glance-daily-check').count(), 1, 'daily switch');
      assert.equal(await page.getByTestId('bot-glance-output').count(), 0, 'no outputs block');
      assert.equal(await page.getByTestId('bot-glance-computer').count(), 1, 'only this computer');
      await ui.capture('open');
      return;
    }
    assert.equal(await page.getByTestId('bot-glance-todo').count(), 5, 'five todos before Show more');
    assert.equal(await page.getByTestId('bot-glance-check').count(), 1, '帮我查查 first in the todo block');
    assert.equal(await page.getByTestId('bot-glance-output').count(), 3, 'three outputs before Show more');
    assert.equal(await page.getByTestId('bot-glance-computer').count(), 2, 'offline computers folded');
    const box = await popover.boundingBox();
    assert.ok(box.width <= 360 && box.x + box.width <= ui.viewport.width, 'popover stays inside the window');
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
