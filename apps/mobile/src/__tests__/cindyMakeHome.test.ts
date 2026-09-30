import { afterEach, describe, expect, it } from 'vitest';
import { i18n } from '@/i18n';
import { buildMobileHomePresentation, type MobileHomeSessionLike } from '@/session/mobileHome';
import { buildHomeSections, homeRowsShareRenderData, isFolderHomeRow } from '@/session/homeSections';
import { buildHomeProjectMachineIdentities } from '@/session/homeProjectMachineIdentity';

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
    workingDir: `/data/make/${id}`,
    source: 'cindy-make',
    ...patch,
  };
}

describe('Cindy Make home folder', () => {
  it.each(['zh-CN', 'zh-TW', 'en', 'ja', 'ko'])('keeps one named folder in grouped and flat home views (%s)', async (locale) => {
    await i18n.changeLanguage(locale);
    const home = buildMobileHomePresentation({
      sessions: [
        session('feature'),
        session('merge', { source: 'cindy-make-merge' }),
        session('project', { source: undefined, workingDir: '/repo/ordinary' }),
      ],
    });
    for (const groupByProject of [true, false]) {
      const rows = buildHomeSections(home, groupByProject, false).flatMap((section) => section.data);
      const folders = rows.filter((row) => row.kind === 'cindy-make');
      expect(folders).toHaveLength(1);
      expect(isFolderHomeRow(folders[0])).toBe(true);
      expect(folders[0].project).toMatchObject({ title: 'Cindy Make', workingDir: '', subtitle: 'My PC' });
      expect(folders[0].project.sessions.map((item) => item.session.id).sort()).toEqual(['feature', 'merge']);
      expect(rows).toHaveLength(2);
      const identities = buildHomeProjectMachineIdentities(home);
      expect(identities.get(folders[0].key)?.displayLabel).toBe('My PC');
    }
    const groupedFolder = buildHomeSections(home, true, false)[0].data.find((row) => row.kind === 'cindy-make')!;
    const flatFolder = buildHomeSections(home, false, false)[0].data.find((row) => row.kind === 'cindy-make')!;
    expect(homeRowsShareRenderData(groupedFolder, flatFolder)).toBe(true);
  });

  it('keeps every task available in the flat task-switching drawer', () => {
    const sessions = Array.from({ length: 12 }, (_, index) => session(`make-${index}`));
    const home = buildMobileHomePresentation({ sessions });
    const rows = buildHomeSections(home, false, false, { groupCindyMake: false }).flatMap((section) => section.data);
    expect(rows).toHaveLength(sessions.length);
    expect(rows.every((row) => row.kind === 'session' && row.sourceLabel === 'Cindy Make')).toBe(true);
    expect(rows.flatMap((row) => row.kind === 'session' ? [row.item.session.id] : []).sort())
      .toEqual(sessions.map((item) => item.id).sort());
  });

  it('sorts the folder and its tasks by priority while keeping pins separate', () => {
    const home = buildMobileHomePresentation({
      sessions: [
        session('waiting', { source: 'cindy-make-merge' }),
        session('running'),
        session('pinned', { pinnedAt: '2026-01-02T00:00:00.000Z' }),
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
    const first = sections[1].data[0];
    expect(first.kind).toBe('cindy-make');
    if (!isFolderHomeRow(first)) throw new Error('Expected the Cindy Make folder');
    expect(first.project.sessions.map((item) => item.session.id)).toEqual(['waiting', 'running']);
    expect(first.project.pendingInteractionCount).toBe(1);
  });
});
