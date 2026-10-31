import { chromium } from 'playwright-core';
const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const main = browser.contexts()[0].pages().find((p) => !/sidebarWindow|remoteDesktopViewer|resourceUsageWindow/.test(p.url()));
const probe = await main.evaluate(() => {
  const h = document.documentElement;
  return {
    cls: h.className, attr: h.getAttribute('data-theme'),
    lsTheme: localStorage.getItem('theme'),
    rootVar: getComputedStyle(h).getPropertyValue('--bg-canvas').trim() || getComputedStyle(h).getPropertyValue('--background').trim(),
    chipVar: getComputedStyle(h).getPropertyValue('--surface-chip').trim(),
  };
});
console.log(JSON.stringify(probe));
await main.screenshot({ path: '.tmp-shots/full-window.png' });
await browser.close();
