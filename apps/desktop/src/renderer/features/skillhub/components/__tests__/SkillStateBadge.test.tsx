// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

import { SkillStateBadge } from '../SkillStateBadge';

afterEach(cleanup);

describe('SkillStateBadge', () => {
  it('启用时输出启用文案、说明与分隔符', () => {
    render(<SkillStateBadge enabled />);
    expect(screen.getByText('skillhub.home.stateEnabled')).toBeTruthy();
    expect(screen.getByTitle('skillhub.home.stateEnabledHint')).toBeTruthy();
    expect(screen.getByText('·').getAttribute('aria-hidden')).toBe('true');
  });

  it('停用时输出停用文案与说明', () => {
    render(<SkillStateBadge enabled={false} />);
    expect(screen.getByText('skillhub.home.stateDisabled')).toBeTruthy();
    expect(screen.getByTitle('skillhub.home.stateDisabledHint')).toBeTruthy();
  });
});
