/* Step C: theme=light + reload(真实切主题;resumeOnOpen 会自动唤醒)→
   1) chip 目标推进中 → awake-light
   2) 唤醒轮结束后回到等待中 → waiting-light */
import { chromium } from 'playwright-core';

const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const main = browser.contexts()[0].pages().find((p) => !/sidebarWindow|remoteDesktopViewer|resourceUsageWindow/.test(p.url()));

await main.evaluate(() => localStorage.setItem('theme', 'light'));
await main.reload();
await main.waitForSelector('.tiptap.ProseMirror', { timeout: 30000 });
console.log('reloaded, light theme');

const chipRect = () => main.evaluate(() => {
  const spans = [...document.querySelectorAll('span')];
  const el = spans.find((s) => ['等待中', '目标推进中'].includes(s.textContent.trim()));
  if (!el) return null;
  let node = el;
  for (let k = 0; k < 4; k++) {
    if (node.parentElement && (node.parentElement.className || '').includes('rounded-lg')) { node = node.parentElement; break; }
    node = node.parentElement; if (!node) return null;
  }
  const r = node.getBoundingClientRect();
  const label = [...document.querySelectorAll('span')].some((s) => s.textContent.trim() === '目标推进中') ? 'active' : 'waiting';
  return { x: r.x, y: r.y, width: r.width, height: r.height, label };
});

// 等唤醒轮把 chip 推到「目标推进中」
let shot = null;
for (let i = 0; i < 60; i++) {
  await main.waitForTimeout(1000);
  shot = await chipRect();
  if (shot?.label === 'active') break;
}
console.log('post-reload chip:', JSON.stringify(shot));

const pad = 6;
const clipOf = (r) => ({ x: Math.max(0, r.x - pad), y: Math.max(0, r.y - pad), width: r.width + pad * 2, height: r.height + pad * 2 });

if (shot?.label === 'active') {
  await main.screenshot({ path: '.tmp-shots/goal-awake-light.png', clip: clipOf(shot) });
  console.log('saved goal-awake-light.png');
} else {
  console.log('WARN: never saw active chip after reload');
}

// 等唤醒轮结束、模型再吐 waiting → 回到等待中
let w = null;
for (let i = 0; i < 90; i++) {
  await main.waitForTimeout(1000);
  w = await chipRect();
  if (w?.label === 'waiting') break;
  if (i % 10 === 9) console.log('...settle', i + 1 + 's');
}
if (w?.label === 'waiting') {
  await main.screenshot({ path: '.tmp-shots/goal-waiting-light.png', clip: clipOf(w) });
  console.log('saved goal-waiting-light.png');
} else {
  console.log('WARN: waiting chip not seen after wake turn, last=', JSON.stringify(w));
}
await browser.close();
