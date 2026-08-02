import { i18n } from '@/i18n';
import type { MobileHomePresentation, MobileHomeProjectGroup } from './mobileHome';
import type { RemoteSessionListItem } from './sessionList';

/** 首页列表的一行:项目分组头,或一条会话(置顶 / 普通 / 项目内)。 */
export type HomeRow =
  | { key: string; kind: 'project'; project: MobileHomeProjectGroup }
  | { key: string; kind: 'session'; item: RemoteSessionListItem; source: 'chat' | 'pinned' | 'project' };

/** SectionList 的一个分区。title 为 null 的分区不渲染表头。 */
export type HomeSection = { data: HomeRow[]; key: string; title: string | null };

/**
 * 把 home 展示模型拆成 SectionList 的分区(纯函数,便于单测)。
 * - 置顶单独成区;`pinnedCollapsed` 时清空 data 但**保留分区**(SectionList 对空 data 仍渲染
 *   表头,所以折叠时表头照常显示,只折叠下属会话)。
 * - 分组模式保留项目 folder 行,与普通对话按活动时间倒序混排。
 * - 非分组模式把普通对话 + 项目下属会话展平,按活动时间倒序。
 */
export function buildHomeSections(
  home: MobileHomePresentation,
  groupByProject: boolean,
  pinnedCollapsed: boolean,
): HomeSection[] {
  const sections: HomeSection[] = [];
  if (home.pinned.length > 0) {
    sections.push({
      data: pinnedCollapsed
        ? []
        : home.pinned.map((item) => ({ item, key: `pinned:${item.session.id}`, kind: 'session', source: 'pinned' })),
      key: 'pinned',
      title: i18n.t('session.row.pinnedSection'),
    });
  }

  const rows = groupByProject ? buildGroupedHomeRows(home) : buildMixedHomeRows(home);
  if (rows.length > 0) {
    sections.push({
      data: rows,
      key: groupByProject ? 'grouped' : 'mixed',
      title: null,
    });
  }
  return sections;
}

/**
 * 取某行在整个列表里的前一行:同 section 内取 index-1;section 首行跨区取前一个
 * **非空** section 的末行(置顶收起时 pinned 区 data 为空,要跳过)。
 * SectionList 的 renderItem 只给区内 index,置顶区 → 主列表边界的分割线唯一化
 * (prevIsBlock)必须跨区看邻接,否则相邻块的边线可能叠成双线。
 */
export function homeRowBefore(
  sections: HomeSection[],
  sectionKey: string,
  index: number,
): HomeRow | undefined {
  const sectionIndex = sections.findIndex((section) => section.key === sectionKey);
  if (sectionIndex < 0) return undefined;
  if (index > 0) return sections[sectionIndex].data[index - 1];
  for (let i = sectionIndex - 1; i >= 0; i -= 1) {
    const data = sections[i].data;
    if (data.length > 0) return data[data.length - 1];
  }
  return undefined;
}

export function buildProjectHomeRows(home: MobileHomePresentation): HomeRow[] {
  return home.projects.map((project) => ({ key: project.key, kind: 'project' as const, project }));
}

export function buildDialogueHomeRows(home: MobileHomePresentation): HomeRow[] {
  return home.chats.map((item) => ({
    item,
    key: `chat:${item.automationGroup?.key ?? item.session.id}`,
    kind: 'session' as const,
    source: 'chat' as const,
  }));
}

/** 混排模式:chats + 各项目下属会话全部展平为会话行,按活动时间倒序。 */
export function buildMixedHomeRows(home: MobileHomePresentation): HomeRow[] {
  return [
    // 自动化组行用组 key(组内 primary 会变,session.id 不稳定;组 key 稳定才能保住展开态与 diff)。
    ...buildDialogueHomeRows(home),
    ...home.projects.flatMap((project) =>
      project.sessions.map((item) => ({
        item,
        key: `project:${project.key}:${item.automationGroup?.key ?? item.session.id}`,
        kind: 'session' as const,
        source: 'project' as const,
      })),
    ),
  ].sort(compareHomeRowsByActivityDesc);
}

/** 分组模式:项目保留 folder 行,与普通对话统一按活动时间倒序混排。 */
export function buildGroupedHomeRows(home: MobileHomePresentation): HomeRow[] {
  return [
    ...buildProjectHomeRows(home),
    ...buildDialogueHomeRows(home),
  ].sort(compareHomeRowsByActivityDesc);
}

function compareHomeRowsByActivityDesc(a: HomeRow, b: HomeRow): number {
  return homeRowActivity(b).localeCompare(homeRowActivity(a)) || a.key.localeCompare(b.key);
}

function homeRowActivity(row: HomeRow): string {
  return row.kind === 'project' ? row.project.latestActivityAt : row.item.lastActivityAt;
}
