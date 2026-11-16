import assert from 'node:assert/strict';

export default {
  name: 'plugin-global-route', entry: './fixture.tsx', viewport: { width: 960, height: 640 },
  real: 'useTabGroupPanes, global tab store and availability, retained sidebar mount, RightSidebar width/collapse rendering',
  notCovered: 'Full MainLayout, actual plugin installation, MCP App bridge and native window lifecycle. The iframe below is labeled fixture content; no product UI is added.',
  stubs: {
    'src/renderer/features/right-sidebar/RightSidebarShell': `
      import React from 'react';
      import { useGlobalTabs } from '@/features/right-sidebar/globalTabs';
      export function RightSidebarShell() {
        const tabs = useGlobalTabs();
        return tabs.length ? React.createElement('iframe', { title: '全局插件页面',
          style: { width: '100%', height: '100%', border: 0 },
          srcDoc: '<!doctype html><html style="color-scheme:' + window.__uiPage.ctx.theme +
            ';font-family:system-ui"><body style="background:Canvas;color:CanvasText"><h1>全局具名页</h1><p>隔离验收内容</p></body></html>' }) : null;
      }`,
    'src/renderer/features/right-sidebar/TabGroupPanel': 'export const tabGroupPanelComponent = () => () => null;',
  },
  cases: {
    default: { about: 'Named global page stays visible after switching from a task to /plugins' },
    task: { about: 'The existing task-route sidebar stays visible' },
  },
  async ready(page) { await page.getByRole('button', { name: '打开全局页' }).waitFor(); },
  async check(page, ui) {
    await page.getByRole('button', { name: '打开全局页' }).click();
    const frame = page.getByTitle('全局插件页面');
    await frame.waitFor({ state: 'attached' });
    const rect = await frame.boundingBox();
    assert.ok(rect && rect.width > 300 && rect.height > 200, `global iframe must be visible: ${JSON.stringify(rect)}`);
    await ui.capture('visible-global-page');
  },
};
