/** 由另一个任务新建的任务：侧栏小标记与标题区「来自」入口（#11610）。 */
export default {
  name: 'session-origin',
  entry: './fixture.tsx',
  viewport: { width: 900, height: 360 },
  real: 'SessionEntryList, SessionItem, SessionContentHeader, SessionOriginMark, theme and translations',
  notCovered: 'Writing origin_session on send_to_session, navigation to the source task, remote/cross-computer sources, pinned cards',
  stubs: {
    'src/renderer/contexts/AuthContext': {
      partial: 'export const useAuth = () => ({dataOwnerId: "fixture", isAuthenticated: false});',
    },
    'src/renderer/hooks/useCCSessions': {
      partial: `export const useCCSessions=()=>({sessions:[],patchLocal:()=>{}});`,
    },
  },
  cases: {
    default: { about: 'Two tasks opened by another task, the source task and an ordinary task; header of an opened task' },
  },
  async ready(page) {
    await page.locator('[data-session-id="child-1"]').waitFor();
  },
  async check(page, ui) {
    await ui.capture('rows-and-header');
    const mark = page.locator('[data-session-id="child-1"] [data-session-origin-mark]');
    if (await mark.count()) {
      await mark.hover();
      await page.getByRole('tooltip').first().waitFor();
      await ui.capture('row-tooltip');
    }
  },
};
