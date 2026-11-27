// @vitest-environment jsdom
import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { BotGroupSidebarAvatar } from '../BotGroupAvatars';
import { BotGroupPlanCard, BotGroupPlanFollowUpRow } from '../BotGroupPlan';
import type { BotGroupMemberView, BotGroupPlanView } from '../../../../shared/botGroupChat';

afterEach(cleanup);

// #5759 acceptance: the real plan card and next-step row must retain cloud artwork.
// Existing stack tests use initials only. Minimal failing input: avatar='' with avatarUrl set.
// Unit tier; render the actual BotAvatar so dropping the URL becomes a visible missing image.
it('shows the member artwork in plan steps and next-step prompts, with a removed-member fallback', async () => {
  const member: BotGroupMemberView = {
    botId: 'filo', name: 'Filo', avatar: '', avatarColor: 'violet', status: 'active',
    avatarUrl: 'https://cdn.example.com/filo.png',
  };
  const step = { position: 0, botId: 'filo', botName: 'Filo', task: 'Check the result', status: 'pending' as const };
  const plan: BotGroupPlanView = {
    id: 'p1', status: 'waiting', organizerBotId: 'filo', organizerName: 'Filo', steps: [step],
    currentStep: null, workDir: null, branch: null, createdAt: 1, updatedAt: 1,
  };
  const noop = () => {};
  const content = (members: BotGroupMemberView[]) => <>
    <BotGroupPlanCard plan={plan} members={members} actionable={false} pending={null}
      onStart={noop} onDismiss={noop} onEditStep={noop} />
    <BotGroupPlanFollowUpRow plan={plan} followUp={{ kind: 'continue', next: step }}
      members={members} pending={null} onContinue={noop} onRetry={noop} onEnd={noop} />
  </>;
  const { container, rerender } = render(content([member]));
  await waitFor(() => expect(Array.from(container.querySelectorAll('img'), img => img.getAttribute('src')))
    .toEqual([member.avatarUrl, member.avatarUrl]));
  rerender(content([]));
  expect(container.querySelector('img')).toBeNull();
  expect(container.querySelector('[data-testid="bot-group-plan-step"]')?.textContent).toContain('Filo');
  expect(container.querySelector('[data-testid="bot-group-plan-follow-up"]')?.textContent).toContain('Filo');
});

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
