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

  it('以文字形式紧跟来源，不额外增加徽标或底色', () => {
    const { container } = render(<SkillStateBadge enabled={false} />);
    const [label, separator] = [...container.querySelectorAll('span')];
    expect(label.textContent).toBe('skillhub.home.stateDisabled');
    expect(separator.textContent).toBe('·');
    expect(separator.getAttribute('aria-hidden')).toBe('true');
    // 尺寸与颜色由同一行的来源文字提供，组件自身不画底、不加圆角。
    expect(container.querySelector('[class*="surface-chip"]')).toBeNull();
    expect(container.querySelector('[class*="rounded"]')).toBeNull();
  });
});
