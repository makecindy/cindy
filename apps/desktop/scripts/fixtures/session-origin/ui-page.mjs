/** 由另一个任务新建的任务：侧栏小标记与标题区「来自」入口（#11610）。 */
export default {
  name: 'session-origin',
  entry: './fixture.tsx',
  viewport: { width: 900, height: 360 },
  real: 'SessionEntryList, SessionItem, SessionCard (list and pinned card), SessionContentHeader, SessionOriginMark, theme and translations',
  notCovered: 'Writing origin_session on send_to_session, navigation to the source task, remote/cross-computer sources, the collapsed rail',
  stubs: {
    'src/renderer/contexts/AuthContext': {
      partial: 'export const useAuth = () => ({dataOwnerId: "fixture", isAuthenticated: false});',
    },
    'src/renderer/hooks/useCCSessions': {
      partial: `export const useCCSessions=()=>({sessions:[],patchLocal:()=>{}});`,
    },
  },
  cases: {
    default: { about: 'Single-line text rows: only the mark after the title; header of an opened task' },
    list: { about: 'Two-line list rows: the second line leads with the short source; long title and source', viewport: { width: 900, height: 400 } },
    card: { about: 'Pinned cards: the source sits in the bottom row between icons and time; summary unchanged', viewport: { width: 900, height: 640 } },
  },
  async ready(page) {
    await page.locator('[data-session-id="child-1"]').waitFor();
  },
  async check(page, ui) {
    await ui.capture('rows-and-header');
    const mark = page.locator('[data-session-id="child-1"] :is([data-session-origin-mark], [data-session-origin-lead], [data-session-origin-meta])');
    if (await mark.count()) {
      await mark.first().hover();
      await page.getByRole('tooltip').first().waitFor();
      await ui.capture('row-tooltip');
    }
  },
};
