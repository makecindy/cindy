import { describe, expect, it } from 'vitest';

import { syncMarketPreviewSelection } from '../marketPreviewSync';
import type { MarketSkill } from '../../hooks/useMarketList';

function skill(name: string, description: string): MarketSkill {
  return {
    name,
    displayName: name,
    description,
    authorName: 'Lizi',
    authorId: 'user_lizi',
    authorAvatarUrl: null,
    avatarInitial: 'L',
  isMine: true,
  canManage: true,
    latestVersion: '1.0.0',
    visibility: 'PUBLIC',
    visibleDeptIds: [],
    categories: [],
    tags: [],
    githubUrl: null,
    publishedAt: '2026-06-11T00:00:00.000Z',
    relativeTime: '刚刚',
    downloads: 0,
    installedLocally: true,
    installedVersion: '1.0.0',
    installedAbsolutePath: '/tmp/skill',
    hasAnyInstall: true,
    latestPublishedFromDeviceId: null,
    cardState: 'installed-latest',
  };
}

describe('syncMarketPreviewSelection', () => {
  it('updates the preview panel to the refreshed list item', () => {
    const stale = skill('lark-task', 'old');
    const fresh = skill('lark-task', 'new');

    expect(syncMarketPreviewSelection({ previewSkill: stale, selectedName: stale.name }, [fresh])).toEqual({
      previewSkill: fresh,
      selectedName: fresh.name,
    });
  });

  it('closes the preview panel when the selected cloud skill disappears', () => {
    const stale = skill('lark-task', 'old');

    expect(syncMarketPreviewSelection({ previewSkill: stale, selectedName: stale.name }, [])).toEqual({
      previewSkill: null,
      selectedName: null,
    });
  });

  it('does not open a preview panel from a card-only selection highlight', () => {
    expect(syncMarketPreviewSelection({ previewSkill: null, selectedName: 'lark-task' }, [
      skill('lark-task', 'new'),
    ])).toEqual({
      previewSkill: null,
      selectedName: 'lark-task',
    });
  });
});
