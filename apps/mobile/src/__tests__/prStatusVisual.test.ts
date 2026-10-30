import { GitMerge, GitPullRequest, GitPullRequestClosed, GitPullRequestDraft } from 'lucide-react-native';
import { describe, expect, it, vi } from 'vitest';

import { prStatusVisual } from '@/session/prStatusVisual';
import { darkColors, lightColors } from '@/theme/tokens';

vi.mock('lucide-react-native', () => ({
  GitMerge: () => null,
  GitPullRequest: () => null,
  GitPullRequestClosed: () => null,
  GitPullRequestDraft: () => null,
}));

describe('prStatusVisual', () => {
  it('颜色语义对齐桌面 PR_STATUS_COLOR:已合并为焦点蓝,不再与未知态同灰', () => {
    for (const colors of [lightColors, darkColors]) {
      expect(prStatusVisual('merged', colors).color).toBe('#417CDD');
      expect(prStatusVisual('open', colors).color).toBe(colors.statusDone);
      expect(prStatusVisual('closed', colors).color).toBe(colors.statusError);
    }
    expect(prStatusVisual('draft', lightColors).color).toBe(lightColors.textTertiary);
    expect(prStatusVisual(null, darkColors).color).toBe(darkColors.textTertiary);
  });

  it('形状随状态变化,未知态退回中性图标', () => {
    expect(prStatusVisual('open', lightColors).Icon).toBe(GitPullRequest);
    expect(prStatusVisual('merged', lightColors).Icon).toBe(GitMerge);
    expect(prStatusVisual('closed', lightColors).Icon).toBe(GitPullRequestClosed);
    expect(prStatusVisual('draft', lightColors).Icon).toBe(GitPullRequestDraft);
    expect(prStatusVisual(null, lightColors).Icon).toBe(GitPullRequest);
  });
});
