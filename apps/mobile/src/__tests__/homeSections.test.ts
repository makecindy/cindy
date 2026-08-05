import { beforeAll, describe, expect, it } from 'vitest';
import { i18n } from '@/i18n';
import { buildGroupedHomeRows, buildHomeSections, buildMixedHomeRows, homeRowBefore } from '@/session/homeSections';
import type { MobileHomePresentation, MobileHomeProjectGroup } from '@/session/mobileHome';
import type { RemoteSessionListItem } from '@/session/sessionList';

// 文案已 i18n 化;固定 zh-CN 让字面量断言与语言环境解耦(全局 mock 默认 en-US)。
beforeAll(async () => {
  await i18n.changeLanguage('zh-CN');
});

// 最小 fixture:buildHomeSections / rows 只读取下面这几个字段,其余字段对本测试无关,
// 用 cast 避免构造完整 RemoteSessionListItem / MobileHomeProjectGroup。
function listItem(id: string, lastActivityAt: string): RemoteSessionListItem {
  return { session: { id }, lastActivityAt } as unknown as RemoteSessionListItem;
}

function projectGroup(
  key: string,
  latestActivityAt: string,
  sessions: RemoteSessionListItem[],
): MobileHomeProjectGroup {
  return { key, latestActivityAt, sessions, sessionCount: sessions.length } as unknown as MobileHomeProjectGroup;
}

function presentation(over: Partial<MobileHomePresentation>): MobileHomePresentation {
  return { pinned: [], chats: [], projects: [], ...over } as unknown as MobileHomePresentation;
}

describe('buildHomeSections', () => {
  it('置顶收起时保留分区但清空 data(表头照常渲染,只折叠下属会话)', () => {
    const home = presentation({
      pinned: [listItem('p1', '2026-06-02T00:00:00Z'), listItem('p2', '2026-06-01T00:00:00Z')],
      chats: [listItem('c1', '2026-06-03T00:00:00Z')],
    });

    const expanded = buildHomeSections(home, false, false);
    const pinnedExpanded = expanded.find((s) => s.key === 'pinned');
    expect(pinnedExpanded?.title).toBe('置顶');
    expect(pinnedExpanded?.data).toHaveLength(2);

    const collapsed = buildHomeSections(home, false, true);
    const pinnedCollapsed = collapsed.find((s) => s.key === 'pinned');
    expect(pinnedCollapsed).toBeDefined();
    expect(pinnedCollapsed?.title).toBe('置顶'); // 表头仍在
    expect(pinnedCollapsed?.data).toHaveLength(0); // 只清空下属会话
  });

  it('仅置顶且收起时,只有一个空 data 的置顶分区(对应 Home 的空态守卫)', () => {
    const home = presentation({ pinned: [listItem('p1', '2026-06-01T00:00:00Z')] });
    const sections = buildHomeSections(home, false, true);
    expect(sections).toHaveLength(1);
    expect(sections[0].key).toBe('pinned');
    expect(sections[0].data).toHaveLength(0);
  });

  it('无置顶时不产生置顶分区', () => {
    const home = presentation({ chats: [listItem('c1', '2026-06-01T00:00:00Z')] });
    const sections = buildHomeSections(home, false, false);
    expect(sections.find((s) => s.key === 'pinned')).toBeUndefined();
  });

  it('分组模式把项目与普通对话放在同一分区,不渲染项目 / 对话汇总表头', () => {
    const home = presentation({
      chats: [listItem('c1', '2026-06-01T00:00:00Z')],
      projects: [projectGroup('proj-a', '2026-06-02T00:00:00Z', [listItem('s1', '2026-06-02T00:00:00Z')])],
    });
    expect(buildHomeSections(home, false, false).find((s) => s.title === null)?.key).toBe('mixed');
    expect(buildHomeSections(home, true, false).map((s) => [s.key, s.title])).toEqual([
      ['grouped', null],
    ]);
  });
});

describe('homeRowBefore(跨 section 邻接:分割线唯一化的 prevIsBlock 依据)', () => {
  // 分组模式:置顶区 + 按活动时间混排的主列表(首行是自动化组会话 —— 首页里以块呈现,自画顶线)。
  const automationChat = {
    session: { id: 'auto-1' },
    lastActivityAt: '2026-06-06T00:00:00Z',
    automationGroup: { key: 'grp-a' },
  } as unknown as RemoteSessionListItem;
  const home = presentation({
    pinned: [listItem('pin-1', '2026-06-03T00:00:00Z')],
    chats: [automationChat, listItem('c1', '2026-06-01T00:00:00Z')],
    projects: [
      projectGroup('proj-a', '2026-06-05T00:00:00Z', [listItem('s1', '2026-06-05T00:00:00Z')]),
      projectGroup('proj-b', '2026-06-04T00:00:00Z', [listItem('s2', '2026-06-04T00:00:00Z')]),
    ],
  });

  it('置顶区 → 主列表首行:跨区取到末位置顶会话', () => {
    const sections = buildHomeSections(home, true, false);
    const prev = homeRowBefore(sections, 'grouped', 0);
    expect(prev?.kind).toBe('session');
    expect(prev && prev.kind === 'session' ? prev.item.session.id : null).toBe('pin-1');
  });

  it('同区内仍取 index-1,不受跨区逻辑影响', () => {
    const sections = buildHomeSections(home, true, false);
    const prev = homeRowBefore(sections, 'grouped', 1);
    expect(prev?.kind).toBe('session');
    expect(prev && prev.kind === 'session' ? prev.item.session.id : null).toBe('auto-1');
  });

  it('置顶收起时 pinned 区 data 为空:跨区回溯要跳过空区', () => {
    const sections = buildHomeSections(home, true, true);
    const prev = homeRowBefore(sections, 'grouped', 0);
    expect(prev).toBeUndefined();
  });

  it('全列表首行与未知 section key 都返回 undefined', () => {
    const sections = buildHomeSections(home, true, false);
    expect(homeRowBefore(sections, 'pinned', 0)).toBeUndefined();
    expect(homeRowBefore(sections, 'nope', 0)).toBeUndefined();
  });
});

describe('buildMixedHomeRows / buildGroupedHomeRows', () => {
  const home = presentation({
    chats: [
      listItem('chat-new', '2026-06-06T00:00:00Z'),
      listItem('chat-old', '2026-06-01T00:00:00Z'),
    ],
    projects: [
      projectGroup('proj-new', '2026-06-05T00:00:00Z', [
        listItem('s1', '2026-06-05T00:00:00Z'),
        listItem('s2', '2026-06-04T00:00:00Z'),
      ]),
    ],
  });

  it('混排:项目下属会话展平为 session 行,按活动时间倒序', () => {
    const rows = buildMixedHomeRows(home);
    expect(rows.every((r) => r.kind === 'session')).toBe(true);
    expect(rows.map((r) => (r.kind === 'session' ? r.item.session.id : 'project'))).toEqual([
      'chat-new',
      's1',
      's2',
      'chat-old',
    ]);
  });

  it('分组:项目保留 folder 行,与普通对话按活动时间倒序混排', () => {
    const rows = buildGroupedHomeRows(home);
    expect(rows.map((row) => row.kind === 'project' ? row.project.key : row.item.session.id)).toEqual([
      'chat-new',
      'proj-new',
      'chat-old',
    ]);
  });

  it('活动时间相同时按 row key 稳定排序,不受上游输入顺序影响', () => {
    const activityAt = '2026-06-07T00:00:00Z';
    const forward = presentation({
      chats: [listItem('chat-z', activityAt), listItem('chat-a', activityAt)],
      projects: [
        projectGroup('project-z', activityAt, [listItem('session-z', activityAt)]),
        projectGroup('project-a', activityAt, [listItem('session-a', activityAt)]),
      ],
    });
    const reversed = presentation({
      chats: [...forward.chats].reverse(),
      projects: [...forward.projects].reverse(),
    });

    for (const buildRows of [buildMixedHomeRows, buildGroupedHomeRows]) {
      const forwardKeys = buildRows(forward).map((row) => row.key);
      const reversedKeys = buildRows(reversed).map((row) => row.key);
      expect(forwardKeys).toEqual([...forwardKeys].sort((a, b) => a.localeCompare(b)));
      expect(reversedKeys).toEqual(forwardKeys);
    }
  });
});
