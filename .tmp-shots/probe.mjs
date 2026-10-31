/* 探查 dev 实例:主窗口、composer、主题机制。只读,不改状态。 */
import { chromium } from 'playwright-core';

const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const ctx = browser.contexts()[0];
const pages = ctx.pages();
const main = pages.find((p) => !/sidebarWindow|remoteDesktopViewer|resourceUsageWindow/.test(p.url()));
console.log('main url:', main.url());

const info = await main.evaluate(() => {
  const html = document.documentElement;
  const composer = document.querySelector('.tiptap.ProseMirror');
  return {
    theme: html.getAttribute('data-theme') || html.className.slice(0, 80),
    colorScheme: getComputedStyle(html).colorScheme,
    hasComposer: !!composer,
    bodyClasses: html.className,
    goalChip: !!document.querySelector('[class*="GoalIndicator"]'),
  };
});
console.log(JSON.stringify(info, null, 2));
await browser.close();
