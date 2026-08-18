// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { BotArtifactCard } from '../BotArtifactCard';
import { makeBotArtifact } from '../../../../shared/botArtifact';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts ? `${key}:${JSON.stringify(opts)}` : key,
    i18n: { language: 'en' },
  }),
}));

afterEach(() => cleanup());

function artifact(target: string, isRef = false) {
  return makeBotArtifact({
    source: isRef ? 'delegation' : 'generated',
    target,
    isRef,
    createdAt: Date.now() - 30_000,
  });
}

describe('BotArtifactCard', () => {
  it.each([
    ['/w/plan.md', 'doc'],
    ['/w/data.csv', 'sheet'],
    ['/w/hero.png', 'image'],
    ['/w/q3.pptx', 'deck'],
    ['/w/bundle.zip', 'other'],
  ])('renders %s as the %s card', (target, category) => {
    render(<BotArtifactCard item={artifact(target)} onOpen={() => {}} />);
    const card = screen.getByTestId('bot-artifact-card');
    expect(card.getAttribute('data-artifact-category')).toBe(category);
  });

  it('shows title and a 类型 · 时间 meta line, and omits size when unknown', () => {
    render(<BotArtifactCard item={artifact('/w/plan.md')} onOpen={() => {}} />);
    expect(screen.getByText('plan.md')).toBeTruthy();
    // 「类型 · 时间」两段;体积未知不占位。
    expect(
      screen.getByText('bots.artifacts.category.doc · bots.artifacts.time.justNow'),
    ).toBeTruthy();
  });

  it('renders a real thumbnail for image artifacts instead of an icon block', () => {
    render(<BotArtifactCard item={artifact('cindy-media://blobs/h.png', true)} onOpen={() => {}} />);
    const img = screen.getByRole('img') as HTMLImageElement;
    expect(img.getAttribute('src')).toBe('cindy-media://blobs/h.png');
  });

  it('does not build a table preview for spreadsheets', () => {
    render(<BotArtifactCard item={artifact('/w/data.csv')} onOpen={() => {}} />);
    expect(screen.queryByRole('img')).toBeNull();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('opens through the action and stays free of a repo jump when none is wired', () => {
    const onOpen = vi.fn();
    const item = artifact('/w/plan.md');
    render(<BotArtifactCard item={item} onOpen={onOpen} />);
    fireEvent.click(screen.getByText('bots.artifacts.open'));
    expect(onOpen).toHaveBeenCalledWith(item);
    expect(screen.queryByText('bots.artifacts.reveal')).toBeNull();
  });

  it('offers 在仓库中查看 only when a reveal handler is supplied', () => {
    const onReveal = vi.fn();
    const item = artifact('/w/plan.md');
    render(<BotArtifactCard item={item} onOpen={() => {}} onReveal={onReveal} />);
    fireEvent.click(screen.getByText('bots.artifacts.reveal'));
    expect(onReveal).toHaveBeenCalledWith(item);
  });

  it('falls back to the icon block when the thumbnail fails to load', () => {
    render(<BotArtifactCard item={artifact('/w/hero.png')} onOpen={() => {}} />);
    const img = screen.getByRole('img');
    fireEvent.error(img);
    expect(screen.queryByRole('img')).toBeNull();
    expect(screen.getByText('hero.png')).toBeTruthy();
  });
});
