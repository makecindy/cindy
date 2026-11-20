// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

import { SkillStateBadge } from '../SkillStateBadge';

afterEach(cleanup);

describe('SkillStateBadge', () => {
  it('启用时给出启用文案和说明', () => {
    render(<SkillStateBadge enabled />);
    expect(screen.getByText('skillhub.home.stateEnabled')).toBeTruthy();
    expect(screen.getByTitle('skillhub.home.stateEnabledHint')).toBeTruthy();
  });

  it('停用时给出停用文案和说明', () => {
    render(<SkillStateBadge enabled={false} />);
    expect(screen.getByText('skillhub.home.stateDisabled')).toBeTruthy();
    expect(screen.getByTitle('skillhub.home.stateDisabledHint')).toBeTruthy();
  });

  it('停用比启用更醒目：停用带填充底，启用只有弱化文字', () => {
    const { container } = render(
      <>
        <SkillStateBadge enabled />
        <SkillStateBadge enabled={false} />
      </>,
    );
    const [on, off] = [...container.querySelectorAll('span')];
    expect(on.className).not.toContain('surface-chip');
    expect(off.className).toContain('surface-chip');
    expect(on.className).toContain('text-tertiary');
    expect(off.className).toContain('text-secondary');
  });
});
