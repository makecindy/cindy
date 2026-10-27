import { afterEach, describe, expect, it } from 'vitest';
import { i18n } from '@/i18n';
import { buildMobileHomePresentation, type MobileHomeSessionLike } from '@/session/mobileHome';
import { buildHomeSections } from '@/session/homeSections';

const initialLanguage = i18n.language;
afterEach(async () => { await i18n.changeLanguage(initialLanguage); });

function session(id: string, patch: Partial<MobileHomeSessionLike> = {}): MobileHomeSessionLike {
  return {
    id,
    agentKind: 'codex',
    model: 'model',
    title: id,
    status: 'active',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    deviceLinkDeviceId: 'pc',
    deviceLinkDeviceName: 'My PC',
    workingDir: '/data/make/' + id,
    source: 'cindy-make',
    ...patch,
  };
}

describe('Cindy Make home visibility', () => {
  it.each(['zh-CN', 'zh-TW', 'en', 'ja', 'ko'])('hides Cindy Make rows in grouped and flat home views (%s)', async (locale) => {
    await i18n.changeLanguage(locale);
    const home = buildMobileHomePresentation({
      sessions: [
        session('feature'),
        session('merge', { source: 'cindy-make-merge' }),
        session('ordinary', { source: undefined, workingDir: '/repo/ordinary' }),
      ],
    });
    expect(home.projects.flatMap((project) => project.sessions.map((item) => item.session.id))).toEqual(['ordinary']);
    expect(home.pinned).toEqual([]);
    expect(home.chats).toEqual([]);
    for (const groupByProject of [true, false]) {
      const rows = buildHomeSections(home, groupByProject, false).flatMap((section) => section.data);
      const visibleIds = rows.flatMap((row) => {
        if (row.kind === 'session') return [row.item.session.id];
        if (row.kind === 'project' || row.kind === 'dialogue') {
          return row.project.sessions.map((item) => item.session.id);
        }
        return [];
      });
      expect(visibleIds).toEqual(['ordinary']);
      expect(rows.some((row) => row.kind === 'cindy-make')).toBe(false);
    }
  });

  it('does not put disabled Cindy Make tasks in the flat task-switching drawer', () => {
    const sessions = [
      ...Array.from({ length: 12 }, (_, index) => session('make-' + index)),
      session('ordinary', { source: undefined, workingDir: '/repo/ordinary' }),
    ];
    const home = buildMobileHomePresentation({ sessions });
    const rows = buildHomeSections(home, false, false, { groupCindyMake: false })
      .flatMap((section) => section.data);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind).toBe('session');
    if (rows[0]?.kind === 'session') expect(rows[0].item.session.id).toBe('ordinary');
  });

  it('keeps ordinary priority ordering while Cindy Make tasks are hidden', () => {
    const home = buildMobileHomePresentation({
      sessions: [
        session('waiting', { source: 'cindy-make-merge' }),
        session('running', { source: undefined }),
        session('pinned', { source: undefined, pinnedAt: '2026-01-02T00:00:00.000Z' }),
        session('ordinary', { source: undefined, updatedAt: '2026-01-03T00:00:00.000Z' }),
      ],
      pendingInteractionIndex: new Map([['waiting', 1]]),
    });
    const sections = buildHomeSections(home, false, false, {
      sortBy: 'priority',
      priorityContext: {
        runningSessionIds: new Set(['running']),
        unreadSessionIds: new Set(),
        waitingSessionIds: new Set(['waiting']),
      },
    });
    expect(sections[0].data.map((row) => row.kind === 'session' ? row.item.session.id : row.kind)).toEqual(['pinned']);
    expect(sections[1].data.map((row) => row.kind === 'session' ? row.item.session.id : row.kind)).toEqual(['running', 'ordinary']);
    expect(sections.some((section) => section.data.some((row) => row.kind === 'cindy-make'))).toBe(false);
  });
});
