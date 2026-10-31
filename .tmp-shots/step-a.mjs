/* Step A: 新会话 + /goal 强制 waiting + 等 chip 等待中 + dark 截图(只裁 chip)。 */
import { chromium } from 'playwright-core';

const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const main = browser.contexts()[0].pages().find((p) => !/sidebarWindow|remoteDesktopViewer|resourceUsageWindow/.test(p.url()));
main.on('console', (m) => { if (m.type() === 'error') console.log('[page-err]', m.text().slice(0, 120)); });

await main.evaluate(() => { location.hash = '#/cc-agent/new'; });
await main.waitForSelector('.tiptap.ProseMirror', { timeout: 15000 });
console.log('composer ready');

const OBJECTIVE =
  '这是界面验收用的空目标:不要使用任何工具,不要做任何事,直接结束本轮,并在回复末尾按约定输出 goal_status 为 waiting 的裁决块,等待我的下一条消息。';

await main.click('.tiptap.ProseMirror');
await main.keyboard.type('/goal ' + OBJECTIVE, { delay: 8 });
await main.keyboard.press('Enter');
console.log('sent, waiting for session route...');

for (let i = 0; i < 40; i++) {
  await main.waitForTimeout(500);
  const url = main.url();
  if (/cc-agent\/[0-9a-f-]{36}/.test(url)) { console.log('session:', url.match(/cc-agent\/([0-9a-f-]{36})/)[1]); break; }
}

// 等模型跑完首轮并吐 waiting → chip 出现「等待中」
let waiting = null;
for (let i = 0; i < 120; i++) {
  await main.waitForTimeout(1000);
  waiting = await main.evaluate(() => {
    const spans = [...document.querySelectorAll('span')];
    const el = spans.find((s) => s.textContent.trim() === '等待中');
    if (!el) return null;
    let node = el;
    for (let k = 0; k < 4; k++) {
      if (node.parentElement && (node.parentElement.className || '').includes('rounded-lg')) { node = node.parentElement; break; }
      node = node.parentElement;
      if (!node) return null;
    }
    const r = node.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  });
  if (waiting) break;
  if (i % 10 === 9) console.log('...waiting for chip', i + 1 + 's');
}
if (!waiting) { console.log('CHIP NOT FOUND'); process.exit(1); }
console.log('chip rect:', JSON.stringify(waiting));

const pad = 6;
const clip = {
  x: Math.max(0, waiting.x - pad),
  y: Math.max(0, waiting.y - pad),
  width: waiting.width + pad * 2,
  height: waiting.height + pad * 2,
};
await main.screenshot({ path: '.tmp-shots/goal-waiting-dark.png', clip });
console.log('saved goal-waiting-dark.png');
await browser.close();
