// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { BotGroupSidebarAvatar } from '../BotGroupAvatars';

afterEach(cleanup);

// Deliberately not alphabetical: the group's order must survive rendering.
const members = ['Zulu', 'Alpha', 'Mike', 'Quebec', 'Bravo', 'Echo', 'Charlie', 'Delta'].map(
  (name) => ({ botId: name, name, avatar: '', avatarColor: 'violet' }),
);

// Positioned siblings paint back to front in DOM order. Read the visible stack
// from the complete foreground avatar backwards, not left to right in the DOM.
function frontToBackInitials(container: HTMLElement) {
  return Array.from(container.firstElementChild!.children)
    .reverse()
    .map((avatar) => avatar.textContent)
    .join('');
}

describe.each([false, true])('sidebar avatars (compact=%s)', (compact) => {
  it.each([
    [2, 'ZA'],
    [3, 'ZAM'],
    [4, 'ZAMQ'],
    [5, 'ZAMQB'],
    [8, 'ZAMQB'],
  ] as const)('stacks the first members front to back for %i members', (count, initials) => {
    const { container } = render(
      <BotGroupSidebarAvatar members={members.slice(0, count)} compact={compact} />,
    );
    expect(frontToBackInitials(container)).toBe(initials);
  });

  it('follows a changed group order without retaining the old visible members', () => {
    const { container, rerender } = render(
      <BotGroupSidebarAvatar members={members} compact={compact} />,
    );
    rerender(<BotGroupSidebarAvatar members={[...members].reverse()} compact={compact} />);
    expect(frontToBackInitials(container)).toBe('DCEBQ');
  });
});
