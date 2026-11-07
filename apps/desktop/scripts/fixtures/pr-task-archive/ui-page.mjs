import assert from 'node:assert/strict';
export default {
  name: 'pr-task-archive',
  entry: './pr-task-archive-fixture.tsx',
  viewport: { width: 900, height: 420 },
  real: 'GhostToolCard, PrRefsProvider, task-wide PR eligibility, archive buttons and automatic archive hint',
  notCovered: 'GitHub network and actual task archive/worktree recycling; leave-time eligibility is covered by hook unit tests. Plugin HTML is a saved fixture.',
  stubs: {
    'src/renderer/components/chat/GhostCardModelSelect': 'export const GhostCardModelSelect = () => null;',
    'src/renderer/components/chat/GhostCardSessionLink': 'export const GhostCardSessionLink = () => null;',

    'src/renderer/contexts/AuthContext': 'export const useAuth = () => ({ dataOwnerId: "fixture" }); export const useOptionalAuthDeviceId = () => null; export const useOptionalAuthUser = () => null;',
  },
  cases: {
    default: { about: '宿主已合并，插件尚未合并：不提示归档', data: { allMerged: false } },
    'all-merged': { about: '全部关联 PR 已合并：允许归档并显示自动归档提示', data: { allMerged: true } },
  },
  async ready(page) {
    await page.waitForFunction(() => {
      const frames = [...document.querySelectorAll('iframe')];
      return frames.length === 2 && frames.every(f => f.contentDocument?.querySelector('[data-ghost-task-archive]'));
    });
  },
  async check(page, ui) {
    await page.waitForFunction(() => [...document.querySelectorAll('iframe')].some(f =>
      f.contentDocument?.querySelector('[data-ghost-pr-status]')?.textContent?.length));
    const allMerged = ui.data.allMerged;
    await page.waitForFunction((expected) => {
      const buttons = [...document.querySelectorAll('iframe')].flatMap(f => [...f.contentDocument.querySelectorAll('[data-ghost-task-archive]')]);
      return buttons.length === 2 && buttons.every(b => (b.style.display !== 'none') === expected);
    }, allMerged);
    const hints = await page.evaluate(() => [...document.querySelectorAll('iframe')].reduce((n, f) => n + f.contentDocument.querySelectorAll('[data-x-auto-archive-hint]').length, 0));
    assert.equal(hints, allMerged ? 2 : 0);
  },
};
