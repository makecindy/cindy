import { chromium } from 'playwright-core';
const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const main = browser.contexts()[0].pages().find((p) => !/sidebarWindow|remoteDesktopViewer|resourceUsageWindow/.test(p.url()));
const keys = await main.evaluate(() => {
  const out = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (/theme|appearance|dark/i.test(k)) out.push(k + ' = ' + String(localStorage.getItem(k)).slice(0, 120));
  }
  return out;
});
console.log(keys.join('\n') || '(no theme keys)');
await browser.close();
