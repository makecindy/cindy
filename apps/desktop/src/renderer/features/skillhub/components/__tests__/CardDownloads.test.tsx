// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mapHubSkillInfoToDesktopInfo } from '../../../../../main/skillhub/infoMapping';
import { mapServerToView } from '../../hooks/useMarketList';
import { HomeMarketCard } from '../HomeMarketCard';
import { MarketCard } from '../MarketCard';

vi.mock('react-i18next', async (importOriginal) => ({ ...await importOriginal<typeof import('react-i18next')>(), useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }) }));
afterEach(cleanup);
const hub = { slug: 'skill', displayName: 'Title', summary: 'Description', version: '1', owner: { slug: 'author', name: 'Author' }, visibility: 'public', updatedAt: '2026-10-13T00:00:00Z', tags: [{ slug: 'code', name: 'Code' }] };
function view(downloads?: number, flag?: boolean) {
  const item = mapHubSkillInfoToDesktopInfo({ ...hub, stats: { downloads } });
  if (flag !== undefined) item.downloadsAvailable = flag;
  return mapServerToView(item, { byCatalogKey: new Map(), untrackedByName: new Map() }, new Set(), ((key: string) => key) as never);
}
for (const kind of ['home', 'market'] as const) describe(kind + ' card contract', () => {
  function card(skill = view(0), onClick = vi.fn(), onUpdate = vi.fn(), onClone = vi.fn()) {
    return render(kind === 'home' ? <HomeMarketCard skill={skill} onClick={onClick} onUpdate={onUpdate} /> : <MarketCard skill={skill} onClick={onClick} onUpdate={onUpdate} onClone={onClone} />);
  }
  it.each([undefined, NaN, Infinity, -1])('hides unknown or invalid count %s through main and hook mapping', downloads => {
    const skill = view(downloads);
    expect(skill.downloadsAvailable).toBe(false);
    expect(card(skill).queryByLabelText('skillhub.marketCard.downloadsLabel')).toBeNull();
  });
  it.each([0, 12000])('preserves a real count %s', downloads => {
    expect(card(view(downloads)).getByLabelText('skillhub.marketCard.downloadsLabel').textContent).toBe(new Intl.NumberFormat('en').format(downloads));
  });
  it('honors explicit missing flag even for compatibility zero', () => {
    expect(card(view(0, false)).queryByLabelText('skillhub.marketCard.downloadsLabel')).toBeNull();
  });
  it('supports numeric counts from old hosts without availability', () => {
    const item = mapHubSkillInfoToDesktopInfo({ ...hub, stats: { downloads: 0 } });
    const { downloadsAvailable: _, ...old } = item;
    const skill = mapServerToView(old, { byCatalogKey: new Map(), untrackedByName: new Map() }, new Set(), ((key: string) => key) as never);
    expect(card(skill).getByLabelText('skillhub.marketCard.downloadsLabel').textContent).toBe('0');
  });
  it('places description before tags and downloads in the tag footer', () => {
    const { getByText, getByRole, getByLabelText } = card();
    const description = getByText('Description');
    const tags = getByRole('list');
    expect(description.compareDocumentPosition(tags) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(tags.parentElement).toBe(getByLabelText('skillhub.marketCard.downloadsLabel').parentElement);
  });
  it('retains download when tags and publisher are absent and falls back to Package', () => {
    const { container, getByLabelText } = card({ ...view(0), tags: [], authorName: '', publisherName: '', icon: undefined });
    expect(getByLabelText('skillhub.marketCard.downloadsLabel').textContent).toBe('0');
    expect(container.querySelector('.lucide-package')).not.toBeNull();
  });
  it('does not open detail when updating', () => {
    const onClick = vi.fn(), onUpdate = vi.fn();
    const skill = { ...view(0), updateAvailable: true, installedLocally: true };
    const { getByRole } = card(skill, onClick, onUpdate);
    fireEvent.click(getByRole('button', { name: 'skillhub.marketCard.updateAvailable' }));
    expect(onUpdate).toHaveBeenCalledWith(skill);
    expect(onClick).not.toHaveBeenCalled();
  });
});

it('Clone does not trigger detail navigation', () => {
  const onClick = vi.fn(), onClone = vi.fn();
  const skill = view(0);
  const { getByRole } = render(<MarketCard skill={skill} onClick={onClick} onClone={onClone} />);
  fireEvent.click(getByRole('button', { name: /clone/i }));
  expect(onClone).toHaveBeenCalledWith(skill);
  expect(onClick).not.toHaveBeenCalled();
});
