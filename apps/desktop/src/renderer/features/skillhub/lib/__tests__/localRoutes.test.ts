import { describe, expect, it } from 'vitest';

import {
  buildLocalSkillRoute,
  findLocalSkillByPath,
  findLocalSkillRouteEntry,
} from '../localRoutes';

type Entry = Parameters<typeof buildLocalSkillRoute>[0];

function entry(overrides: Partial<Entry> = {}): Entry {
  return {
    id: 'pi:skill:project:abcd1234:demo',
    engine: 'pi',
    kind: 'skill',
    scope: 'project',
    name: 'demo',
    absolutePath: '/repo/.pi/skills/demo',
    projectHash: 'abcd1234',
    ...overrides,
  };
}

describe('local SkillHub routes', () => {
  it('finds a renamed skill by its lexical discovered path when absolutePath is realpathed', () => {
    const renamed = entry({
      absolutePath: '/shared/skills/renamed',
      discoveredPath: '/home/user/.claude/skills/renamed',
    });

    expect(findLocalSkillByPath(
      [renamed],
      '/home/user/.claude/skills/renamed',
    )).toBe(renamed);
  });

  it('keeps the existing URL shape for an unambiguous skill', () => {
    expect(buildLocalSkillRoute(entry())).toBe(
      '/skillhub/local/skill/project/abcd1234/demo?engine=pi',
    );
  });

  it('keeps a unique source stable when a same-name source appears later', () => {
    const original = entry({ sourceKey: 'pi-source' });
    const route = buildLocalSkillRoute(original);
    const addedLater = entry({
      id: 'pi:demo:agents-source',
      absolutePath: '/repo/.agents/skills/demo',
      sourceKey: 'agents-source',
      requiresSourceKey: true,
    });
    const search = new URL(route, 'https://cindy.local').searchParams;

    expect(route).toBe(
      '/skillhub/local/skill/project/abcd1234/demo?engine=pi&source=pi-source',
    );
    expect(findLocalSkillRouteEntry(
      [addedLater, original],
      { kind: 'skill', projectHash: 'abcd1234', name: 'demo' },
      search,
    )).toBe(original);
  });

  it('adds a source key and resolves each same-name physical source exactly', () => {
    const pi = entry({ id: 'pi:demo:pi-source', sourceKey: 'pi-source', requiresSourceKey: true });
    const agents = entry({
      id: 'pi:demo:agents-source',
      absolutePath: '/repo/.agents/skills/demo',
      sourceKey: 'agents-source',
      requiresSourceKey: true,
    });
    const params = { kind: 'skill', projectHash: 'abcd1234', name: 'demo' };

    expect(buildLocalSkillRoute(pi)).toBe(
      '/skillhub/local/skill/project/abcd1234/demo?engine=pi&source=pi-source',
    );
    expect(
      findLocalSkillRouteEntry(
        [agents, pi],
        params,
        new URLSearchParams('engine=pi&source=pi-source'),
      ),
    ).toBe(pi);
    expect(
      findLocalSkillRouteEntry(
        [pi, agents],
        params,
        new URLSearchParams('engine=pi&source=agents-source'),
      ),
    ).toBe(agents);
    expect(
      findLocalSkillRouteEntry(
        [pi, agents],
        params,
        new URLSearchParams('engine=pi&source=missing'),
      ),
    ).toBeNull();
  });

  it('makes a legacy ambiguous URL fall back independently of discovery order', () => {
    const first = entry({ absolutePath: '/repo/z/.pi/skills/demo', sourceKey: 'bbbb' });
    const second = entry({ absolutePath: '/repo/a/.agents/skills/demo', sourceKey: 'aaaa' });
    const params = { kind: 'skill', projectHash: 'abcd1234', name: 'demo' };
    const search = new URLSearchParams('engine=pi');

    expect(findLocalSkillRouteEntry([first, second], params, search)).toBe(second);
    expect(findLocalSkillRouteEntry([second, first], params, search)).toBe(second);
  });

  it('keeps a source-aware URL valid after its collision shrinks to one survivor', () => {
    const survivor = entry({
      engine: 'codex',
      absolutePath: '/home/.agents/skills/demo',
      sourceKey: undefined,
      requiresSourceKey: undefined,
    });

    expect(findLocalSkillRouteEntry(
      [survivor],
      { kind: 'skill', projectHash: 'abcd1234', name: 'demo' },
      new URLSearchParams('engine=codex&source=removed-source'),
    )).toBe(survivor);
  });
});
