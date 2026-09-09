/**
 * SkillHub 市场卡片图标回归：只展示 Skill 图标，并保证远程资源不可用时仍有本地兜底。
 * @vitest-environment jsdom
 */

import { fireEvent, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { MarketSkill } from '../../hooks/useMarketList';
import { MarketCard } from '../MarketCard';

const MARKET_SKILL: MarketSkill = {
  name: 'demo-skill',
  icon: 'https://assets.example.test/demo-skill.png',
  displayName: 'Demo Skill',
  description: 'A demo skill',
  authorName: 'Publisher',
  authorId: 'publisher-1',
  authorAvatarUrl: 'https://assets.example.test/publisher.png',
  avatarInitial: 'P',
      isMine: false,
      canManage: false,
  latestVersion: '1.0.0',
  visibility: 'PUBLIC',
  publishedVisibility: 'public',
  visibleDeptIds: [],
  categories: [],
  tags: [],
  githubUrl: null,
  publishedAt: '2026-09-01T00:00:00.000Z',
  relativeTime: 'today',
  downloads: 0,
  installedLocally: false,
  installedVersion: null,
  installedAbsolutePath: null,
  hasAnyInstall: false,
  latestPublishedFromDeviceId: null,
  cardState: 'not-installed',
};

describe('MarketCard Skill icon', () => {
  it('renders only a custom Skill icon and falls back to the local Package icon on load failure', () => {
    const { container } = render(
      <MarketCard
        skill={MARKET_SKILL}
        primaryAction="none"
        onClone={vi.fn()}
      />,
    );

    const images = container.querySelectorAll('img');
    expect(images).toHaveLength(1);
    expect(images[0]?.getAttribute('src')).toBe(MARKET_SKILL.icon);

    fireEvent.error(images[0]!);

    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('.lucide-package')).not.toBeNull();
    expect(container.textContent).toContain('Publisher · v1.0.0');
  });

  it.each([
    undefined,
    'http://localhost:3345/assets/default-skill-icon-v4.svg',
  ])('uses the same Package glyph as local Skills for default URL %s', (icon) => {
    const { container } = render(
      <MarketCard
        skill={{ ...MARKET_SKILL, icon }}
        primaryAction="none"
        onClone={vi.fn()}
      />,
    );

    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('.lucide-package')).not.toBeNull();
  });

  it('shows the first tag beside the title and collapses remaining tags', () => {
    const { container } = render(
      <MarketCard
        skill={{
          ...MARKET_SKILL,
          tags: [
            { slug: 'automation', name: 'Automation' },
            { slug: 'productivity', name: 'Productivity' },
          ],
        }}
        primaryAction="none"
        onClone={vi.fn()}
      />,
    );

    const title = container.querySelector('h3');
    expect(title?.parentElement?.textContent).toContain('Demo SkillAutomation+1');
    expect(container.textContent).not.toContain('Productivity');
  });
});
