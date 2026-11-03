import assert from 'node:assert/strict';

const chips = (page) => page.locator('[data-plugin-sidebar-widget] button[aria-expanded]');

export default {
  name: 'plugin-sidebar-widget', entry: './fixture.tsx', viewport: { width: 280, height: 560 },
  real: 'PluginSidebarWidgets and ghostSidebarWidgetStore with real theme tokens: chips, counts, unresolved ids and the expanded container',
  notCovered: 'Real task rows (stand-ins here; checked in the full --mock Desktop), plugin runtime, main-process validation and task status changes',
  stubs: {
    'src/renderer/features/cc-agent/sidebar/SessionEntryList': `import { createElement as h } from 'react';export const SessionEntryRows=({entries})=>entries.map(({session:s})=>h('div',{key:s.id,'data-session-id':s.id,className:'flex h-8 items-center truncate px-3 text-sm text-foreground'},s.title));`,
    'src/renderer/cindy-brain/useInstalledGhosts': `const ghosts=[{instanceKey:'_root__project-board',manifest:{id:'project-board',name:'Project Board'},enabled:true}];export const useInstalledGhosts=()=>ghosts;`,
  },
  cases: {
    default: { about: 'Three groups collapsed, then expand and collapse one', data: { variant: 'default' } },
    'four-groups': { about: 'Four groups wrap inside the default sidebar width without horizontal overflow', data: { variant: 'four' } },
    'unknown-tasks': { about: 'Ids the host cannot resolve are not counted; a group with none is hidden', data: { variant: 'unknown' } },
    'same-name-runs': { about: 'Two runs of one routine stay two rows, matching the count on the chip', data: { variant: 'runs' } },
    'no-tasks': { about: 'Nothing resolvable: the widget takes no space', data: { variant: 'empty' } },
  },
  async check(page, ui) {
    if (ui.case === 'no-tasks') {
      assert.equal(await page.locator('[data-plugin-sidebar-widget]').count(), 0);
      return;
    }
    await chips(page).first().waitFor();
    if (ui.case === 'unknown-tasks') {
      assert.equal(await chips(page).count(), 1);
      assert.match(await chips(page).first().innerText(), /1/);
      return;
    }
    if (ui.case === 'same-name-runs') {
      await chips(page).first().click();
      assert.equal(await page.locator('[data-plugin-sidebar-widget] [data-session-id]').count(), 2);
      return;
    }
    assert.equal(await chips(page).count(), ui.case === 'four-groups' ? 4 : 3);
    if (ui.case !== 'default') return;
    const done = chips(page).nth(1);
    await done.click();
    assert.equal(await done.getAttribute('aria-expanded'), 'true');
    await page.locator('[data-plugin-sidebar-widget] [data-session-id="done-a"]').waitFor();
    assert.equal(await page.locator('[data-plugin-sidebar-widget] [data-session-id]').count(), 2);
    await ui.capture('expanded');
    await done.click();
    assert.equal(await page.locator('[data-plugin-sidebar-widget] [data-session-id]').count(), 0);
  },
};
