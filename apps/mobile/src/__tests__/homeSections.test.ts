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

  it('分组模式按桌面层级拆分数据,但不渲染项目 / 对话汇总表头', () => {
    const home = presentation({
      chats: [listItem('c1', '2026-06-01T00:00:00Z')],
      projects: [projectGroup('proj-a', '2026-06-02T00:00:00Z', [listItem('s1', '2026-06-02T00:00:00Z')])],
    });
    expect(buildHomeSections(home, false, false).find((s) => s.title === null)?.key).toBe('mixed');
    expect(buildHomeSections(home, true, false).map((s) => [s.key, s.title])).toEqual([
      ['projects', null],
      ['dialogue', null],
    ]);
  });
});

describe('homeRowBefore(跨 section 邻接:分割线唯一化的 prevIsBlock 依据)', () => {
  // 分组模式:置顶 + 项目区 + 对话区(首行是自动化组会话 —— 首页里以块呈现,自画顶线)。
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

  it('项目区末块 → 对话区首行(自动化组):跨区取到末位项目行,块顶线得以让位', () => {
    const sections = buildHomeSections(home, true, false);
    const prev = homeRowBefore(sections, 'dialogue', 0);
    expect(prev?.kind).toBe('project');
    expect(prev && prev.kind === 'project' ? prev.project.key : null).toBe('proj-b');
  });

  it('同区内仍取 index-1,不受跨区逻辑影响', () => {
    const sections = buildHomeSections(home, true, false);
    const prev = homeRowBefore(sections, 'projects', 1);
    expect(prev && prev.kind === 'project' ? prev.project.key : null).toBe('proj-a');
  });

  it('置顶收起时 pinned 区 data 为空:跨区回溯要跳过空区', () => {
    const sections = buildHomeSections(home, true, true);
    const prev = homeRowBefore(sections, 'projects', 0);
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
    chats: [listItem('chat-old', '2026-06-01T00:00:00Z')],
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
    // proj 的两条(06-05/06-04)比 chat(06-01)新 → 排在前
    expect(rows.map((r) => (r.kind === 'session' ? r.source : 'project'))).toEqual(['project', 'project', 'chat']);
  });

  it('分组:固定桌面层级,项目文件夹始终在普通对话之前', () => {
    const rows = buildGroupedHomeRows(home);
    const kinds = rows.map((r) => r.kind);
    expect(kinds).toContain('project');
    expect(kinds).toContain('session');
    // 用户口头定稿:移动端跟 Mac 侧栏一致,分组模式不再按时间把普通对话插到项目上方。
    expect(rows[0].kind).toBe('project');
  });
});
