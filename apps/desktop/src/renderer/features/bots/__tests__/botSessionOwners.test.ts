/**
 * 伙伴任务在侧栏里怎么归组。
 *
 * 两条硬要求:
 *   1. **一个伙伴的任务聚在一起**,不按工作目录散进项目组 —— 同一个伙伴可以在
 *      多个项目里干活,按目录分会把它的对话切碎。
 *   2. **归属表还没到的时候,任务不能消失**。会话行本身不带 botId,归属只有伙伴
 *      档案知道;档案迟到的那一瞬间宁可落到未分类,也不能整个不见。
 */

import { describe, expect, it } from 'vitest';

import { groupSessions } from '@/features/cc-agent/lib/projectGrouping';
import type { Session } from '@/lib/ccAgent.types';
import { buildBotSessionOwners, findBotProfileForSession } from '../botSessionOwners';
import type { BotProfile } from '../botStore';

function session(id: string, over: Partial<Session> = {}): Session {
  return {
    id,
    title: id,
    source: 'bot',
    workingDir: '/w/project-a',
    status: 'active',
    createdAt: '2026-08-22T00:00:00.000Z',
    updatedAt: '2026-08-22T00:00:00.000Z',
    userSendAt: '2026-08-22T00:00:00.000Z',
    pinnedAt: null,
    workspaceKind: 'project',
    _count: { messages: 3 },
    ...over,
  } as unknown as Session;
}

function profile(over: Partial<BotProfile> = {}): BotProfile {
  return {
    id: 'bot-a',
    name: '小柴',
    avatar: 'shiba',
    avatarColor: 'violet',
    canonicalSessionId: 's-main',
    sessions: [
      { id: 's-main', role: 'canonical' },
      { id: 's-telegram', role: 'route' },
      { id: 's-old', role: 'history' },
    ],
    ...over,
  } as unknown as BotProfile;
}

describe('伙伴归属表', () => {
  it('主对话、渠道任务、归档历史三种都收', () => {
    const owners = buildBotSessionOwners([profile()]);
    expect([...owners.keys()].sort()).toEqual(['s-main', 's-old', 's-telegram']);
    expect(owners.get('s-telegram')).toEqual({
      botId: 'bot-a',
      displayName: '小柴',
      avatar: 'shiba',
      avatarColor: 'violet',
    });
  });

  it('没有注册表投影时不使用兼容镜像认领任务', () => {
    const owners = buildBotSessionOwners([profile({ sessions: [] })]);
    expect(owners.has('s-main')).toBe(false);
    expect(findBotProfileForSession([profile({ sessions: [] })], 's-main')).toBeUndefined();
  });

  it('右侧栏等单任务入口也只认注册表投影', () => {
    const bot = profile({ canonicalSessionId: 'stale-mirror' });
    expect(findBotProfileForSession([bot], 's-main')).toBe(bot);
    expect(findBotProfileForSession([bot], 'stale-mirror')).toBeUndefined();
  });
});

describe('侧栏按伙伴分组', () => {
  it('同一个伙伴在不同项目里的任务聚在一组,不按目录切碎', () => {
    const owners = buildBotSessionOwners([profile()]);
    const result = groupSessions(
      [
        session('s-main', { workingDir: '/w/project-a' }),
        session('s-telegram', { workingDir: '/w/project-b' }),
        session('s-other', { workingDir: '/w/project-a', source: 'desktop' }),
      ],
      { botOwnerBySessionId: owners },
    );
    expect(result.bots).toHaveLength(1);
    expect(result.bots[0]!.displayName).toBe('小柴');
    expect(result.bots[0]!.sessions.map((s) => s.id).sort()).toEqual(['s-main', 's-telegram']);
    // 普通会话照旧按目录进项目组,一点没受影响。
    expect(result.projects.flatMap((p) => p.sessions.map((s) => s.id))).toEqual(['s-other']);
  });

  it('归属表还没到时任务不消失 —— 走原来的分组,宁可落到别处也不能不见', () => {
    const result = groupSessions([session('s-main')], {});
    const seen = [
      ...result.bots.flatMap((b) => b.sessions.map((s) => s.id)),
      ...result.projects.flatMap((p) => p.sessions.map((s) => s.id)),
      ...result.unclassified.map((s) => s.id),
      ...result.dialogues.map((s) => s.id),
    ];
    expect(seen).toContain('s-main');
  });

  it('用户 pin 过的伙伴任务仍然只出现在置顶区', () => {
    const owners = buildBotSessionOwners([profile()]);
    const result = groupSessions(
      [session('s-main', { pinnedAt: '2026-08-22T01:00:00.000Z' }), session('s-telegram')],
      { botOwnerBySessionId: owners },
    );
    expect(result.pinned.map((s) => s.id)).toEqual(['s-main']);
    expect(result.bots[0]!.sessions.map((s) => s.id)).toEqual(['s-telegram']);
  });

  it('多个伙伴按最近活动倒序', () => {
    const owners = buildBotSessionOwners([
      profile(),
      profile({ id: 'bot-b', name: '林律', canonicalSessionId: 's-b', sessions: [{ id: 's-b' }] as never }),
    ]);
    const result = groupSessions(
      [
        session('s-main', { updatedAt: '2026-08-22T00:00:00.000Z', userSendAt: '2026-08-22T00:00:00.000Z' }),
        session('s-b', { updatedAt: '2026-08-22T09:00:00.000Z', userSendAt: '2026-08-22T09:00:00.000Z' }),
      ],
      { botOwnerBySessionId: owners },
    );
    expect(result.bots.map((b) => b.displayName)).toEqual(['林律', '小柴']);
  });
});
