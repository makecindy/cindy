import assert from 'node:assert/strict';

export default {
  name: 'pr-link-menu',
  entry: './fixture.tsx',
  viewport: { width: 640, height: 480 },
  real: 'UserMessageUrlLink, useOpenWithMenu, Radix DropdownMenu, production theme and 12-locale copy',
  notCovered:
    'Actual association IPC/toast, Electron native context menus, remote device-link routing and real PR/MR verification',
  stubs: {
    'src/renderer/contexts/PrRefsContext': {
      partial: `export const usePrRefsForSession=()=>window.__uiPage.ctx.case==='already'?[{id:'fixture-pr',sessionId:'fixture-session',provider:'github',host:'github.com',owner:'example',repo:'repo',prNumber:7,url:'https://github.com/example/repo/pull/7',firstSeenAt:1,lastSeenAt:1,associationSource:'explicit',removedAt:null}]:[]; export const usePrActions=()=>({invalidateRemotePrRefs:()=>{}});`,
    },
  },
  cases: {
    default: { about: 'GitHub PR subpage shows the add-to-header action in the real link menu' },
    already: { about: 'An associated PR shows a disabled already-in-header item' },
    gitlab: { about: 'GitLab MR subpage is recognized and offers the same action' },
  },
  async check(page, ui) {
    const link = page.getByRole('link').first();
    await link.click({ button: 'right' });
    const key =
      ui.case === 'already'
        ? 'chat.markdownRenderer.prAlreadyInHeader'
        : 'chat.markdownRenderer.addPrToHeader';
    const item = page.getByRole('menuitem', { name: await ui.t(key), exact: true });
    await item.waitFor();
    if (ui.case === 'already') assert.equal(await item.getAttribute('aria-disabled'), 'true');
    await ui.capture('link-menu');
    await page.keyboard.press('Escape');
  },
};
