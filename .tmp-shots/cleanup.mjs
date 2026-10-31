import { chromium } from 'playwright-core';
const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const main = browser.contexts()[0].pages().find((p) => !/sidebarWindow|remoteDesktopViewer|resourceUsageWindow/.test(p.url()));
// 清除目标(chip 右端最后一个按钮 aria-label=清除目标)
const clearBtn = main.locator('[aria-label="清除目标"]');
if (await clearBtn.count()) { await clearBtn.click(); console.log('goal cleared'); }
await main.waitForTimeout(800);
// 主题还原 dark + 刷新生效
await main.evaluate(() => localStorage.setItem('theme', 'dark'));
await main.reload();
await main.waitForTimeout(1500);
const st = await main.evaluate(() => ({
  theme: localStorage.getItem('theme'), cls: document.documentElement.className,
  chip: !!([...document.querySelectorAll('span')].find((s) => ['等待中','目标推进中'].includes(s.textContent.trim()))),
}));
console.log(JSON.stringify(st));
await browser.close();
