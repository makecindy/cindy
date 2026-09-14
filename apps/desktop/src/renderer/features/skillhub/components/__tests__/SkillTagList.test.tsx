/**
 * SkillHub catalog tag-row regressions.
 * @vitest-environment jsdom
 */

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { SkillTagList } from '../SkillTagList';

describe('SkillTagList', () => {
  it('does not reserve a row when a Skill has no displayable tags', () => {
    const { container } = render(
      <SkillTagList tags={[{ slug: 'blank', name: '   ' }]} />,
    );

    expect(container.childElementCount).toBe(0);
  });

  it('shows tag names and collapses deduplicated overflow into a count pill', () => {
    render(
      <SkillTagList
        maxVisible={2}
        tags={[
          { slug: 'automation', name: 'Automation', source: 'platform' },
          { slug: 'office', name: 'Office', source: 'platform' },
          { slug: 'automation-copy', name: ' automation ', source: 'platform' },
          { slug: 'productivity', name: 'Productivity', source: 'platform' },
        ]}
      />,
    );

    expect(screen.getByText('Automation')).toBeTruthy();
    expect(screen.getByText('Office')).toBeTruthy();
    expect(screen.queryByText('Productivity')).toBeNull();
    expect(screen.getAllByRole('listitem')).toHaveLength(3);
    expect(screen.getByText('+1').getAttribute('aria-label')).toBe('Productivity');
  });
});
