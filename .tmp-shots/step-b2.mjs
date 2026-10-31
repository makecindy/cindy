import { chromium } from 'playwright-core';
const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const main = browser.contexts()[0].pages().find((p) => !/sidebarWindow|remoteDesktopViewer|resourceUsageWindow/.test(p.url()));
await main.evaluate(() => {
  localStorage.setItem('theme', 'light');
  const h = document.documentElement;
  h.classList.remove('dark'); h.classList.add('light');
  h.setAttribute('data-theme', 'cindy-light');
});
await main.waitForTimeout(300);
const shot = await main.evaluate(() => {
  const el = [...document.querySelectorAll('span')].find((s) => s.textContent.trim() === '等待中');
  if (!el) return null;
  let node = el;
  for (let k = 0; k < 4; k++) {
    if (node.parentElement && (node.parentElement.className || '').includes('rounded-lg')) { node = node.parentElement; break; }
    node = node.parentElement; if (!node) return null;
  }
  const r = node.getBoundingClientRect();
  return { x: r.x, y: r.y, width: r.width, height: r.height, cls: document.documentElement.className, bg: getComputedStyle(node.closest('[style*="surface"]') || node).backgroundColor };
});
if (!shot) { console.log('CHIP NOT FOUND'); process.exit(1); }
console.log(JSON.stringify(shot));
const pad = 6;
await main.screenshot({ path: '.tmp-shots/goal-waiting-light.png', clip: { x: Math.max(0, shot.x - pad), y: Math.max(0, shot.y - pad), width: shot.width + pad * 2, height: shot.height + pad * 2 } });
console.log('saved');
await browser.close();
