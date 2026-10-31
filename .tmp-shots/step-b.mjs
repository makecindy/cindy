/* Step B: DOM 切 light(不刷新,避免 resumeOnOpen 自动唤醒)→ 再截等待中。 */
import { chromium } from 'playwright-core';

const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const main = browser.contexts()[0].pages().find((p) => !/sidebarWindow|remoteDesktopViewer|resourceUsageWindow/.test(p.url()));

await main.evaluate(() => {
  localStorage.setItem('theme', 'light');
  document.documentElement.setAttribute('data-theme', 'cindy-light');
  document.body.classList.remove('dark');
  document.body.classList.add('light');
});
await main.waitForTimeout(300);

const shot = await main.evaluate(() => {
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
  return { x: r.x, y: r.y, width: r.width, height: r.height, theme: document.documentElement.getAttribute('data-theme') };
});
if (!shot) { console.log('CHIP NOT FOUND'); process.exit(1); }
console.log('chip rect:', JSON.stringify(shot));

const pad = 6;
await main.screenshot({
  path: '.tmp-shots/goal-waiting-light.png',
  clip: { x: Math.max(0, shot.x - pad), y: Math.max(0, shot.y - pad), width: shot.width + pad * 2, height: shot.height + pad * 2 },
});
console.log('saved goal-waiting-light.png');
await browser.close();
