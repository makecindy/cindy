import { describe, expect, it } from 'vitest';
import { buildMarketSkillRoute, skillDetailCatalog, skillDetailLocalParams, skillDetailReturnRoute, withSkillDetailReturn } from '../detailRoutes';
import { buildLocalSkillRoute, findLocalSkillRouteEntry } from '../localRoutes';

describe('shared detail URL state', () => {
  it('round-trips literal percent signs and escaped names without losing source identity', () => {
    const skill = { id: 'source', kind: 'skill' as const, engine: 'pi' as const, scope: 'global' as const,
      name: '100% a&b', absolutePath: '/skills/special', sourceKey: 'other / source' };
    const query = new URL(buildLocalSkillRoute(skill), 'https://test.local').searchParams;
    expect(findLocalSkillRouteEntry([skill], skillDetailLocalParams(query), query)).toBe(skill);
  });
  it.each(['market', 'team', undefined] as const)('preserves the %s remote catalog and original list filters', (catalogScope) => {
    const returnTo = '/skillhub/local?tab=public&q=a%26b&category=tools';
    const query = new URL(buildMarketSkillRoute({ name: 'demo', catalogScope }, returnTo), 'https://test.local').searchParams;
    expect(skillDetailCatalog(query)).toBe(catalogScope);
    expect(skillDetailReturnRoute(query)).toBe(returnTo);
  });
  it.each(['https://example.com', '//example.com', '/skillhub/market/other', '/settings'])('rejects an unrelated return URL %s', (returnTo) => {
    const route = withSkillDetailReturn('/skillhub/detail?view=local', returnTo);
    expect(skillDetailReturnRoute(new URL(route, 'https://test.local').searchParams)).toBe('/skillhub/local');
  });
});
