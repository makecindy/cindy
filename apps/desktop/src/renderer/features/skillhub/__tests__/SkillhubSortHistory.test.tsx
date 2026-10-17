// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, useLocation, useNavigate, type Location } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import { useSkillhubHomeNavigation } from '../hooks/useSkillhubHomeNavigation';
afterEach(cleanup);
function Harness({ navigationLocation }: { navigationLocation?: Location }) {
  const h = useSkillhubHomeNavigation(navigationLocation);
  const location = useLocation(), navigate = useNavigate();
  return <>
    <output data-testid="state">{JSON.stringify({ sort: h.sort, category: h.category, tab: h.catalogTab })}</output>
    <output data-testid="url">{location.pathname}{location.search}</output>
    <button onClick={() => h.setSort('updated_at')}>Updated</button>
    <button onClick={() => h.setCategory('code')}>Code</button>
    <button onClick={() => h.setCatalogTab('organization')}>Team</button>
    <button onClick={() => h.setCatalogTab('local')}>Local</button>
    <button onClick={() => navigate('/away')}>Away</button>
    <button onClick={() => navigate(-1)}>Back</button>
    <button onClick={() => navigate(1)}>Forward</button>
    <button onClick={() => h.openLocalSkill({ kind: 'skill', scope: 'global', name: 'demo' } as SkillhubSkill)}>Detail</button>
    <button onClick={h.backToCatalog}>Detail Back</button>
  </>;
}
function state() { return JSON.parse(screen.getByTestId('state').textContent!); }
const click = (name: string) => fireEvent.click(screen.getByRole('button', { name }));
describe('catalog sort and category history', () => {
  it.each(['/skillhub/local', '/settings?tab=plugins'])('restores history without modifying URL %s', path => {
    render(<MemoryRouter initialEntries={[path]}><Harness /></MemoryRouter>);
    click('Updated'); click('Code'); click('Team'); click('Local');
    expect(screen.getByTestId('url').textContent).toBe(path);
    expect(state()).toEqual({ sort: 'updated_at', category: 'code', tab: 'local' });
    click('Away'); click('Back');
    expect(state()).toEqual({ sort: 'updated_at', category: 'code', tab: 'local' });
    click('Back'); // no extra entry from changing filters
    expect(screen.getByTestId('url').textContent).toBe(path);
    click('Forward'); expect(screen.getByTestId('url').textContent).toBe('/away');
    click('Back'); expect(state().sort).toBe('updated_at');
    click('Detail'); click('Detail Back');
    expect(state()).toEqual({ sort: 'updated_at', category: 'code', tab: 'local' });
  });
  it('reads the retained catalog location rather than the currently open detail URL', () => {
    const retained = { pathname: '/skillhub/local', search: '?sort=updated_at&category=code', hash: '', key: 'catalog', state: null };
    render(<MemoryRouter initialEntries={['/skillhub/local/skill/global/demo?sort=downloads']}><Harness navigationLocation={retained} /></MemoryRouter>);
    expect(state()).toEqual({ sort: 'updated_at', category: 'code', tab: 'public' });
  });
});
