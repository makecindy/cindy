/**
 * 「群协作」(bot-group-chat.md §9): the one Skill that guides the task of a group's Cindy, shipped
 * with the app like the teammate core and mounted only on those tasks (the task runs in the user's
 * own repository, where Cindy writes no template). Kept short and neutral; how the reply reaches
 * the group is the host's job, so the Skill never asks the model to post there.
 */
export const GROUP_COLLABORATION_SKILL_NAME = 'group-collaboration';
export const GROUP_COLLABORATION_SKILL_DESCRIPTION = '群协作: handling a request from a Cindy group chat (a message labeled 来自群「…」): how to coordinate the group’s teammates with @mentions, answer directly, or open a task.';

// Also supplied with the member list, so a harness that loads Skills on demand knows how @ delivery works.
export const GROUP_TEAMMATE_HANDOFF_GUIDANCE =
  'Answer whoever asked. For a user, reply in the group. For a teammate, @ that teammate with your result or blocker. '
  + 'When you need help, use the group introductions to choose whom to @ and say what you need from each. Their replies are results: use them to answer your requester.';

export const GROUP_REQUEST_GUIDANCE = 'Answer whoever asked. If this request lists reachable teammates, use @ to ask them for help or return your result to the teammate who asked.';

export const GROUP_TEAMMATE_PROJECT_GUIDANCE =
  'Your introduction describes your role. For project context, check your own linked projects with `list_teammate_projects` when available. A link alone does not assign work. '
  + 'If the user asks to create a teammate, use the existing creation flow with the name and role they give.';

export const GROUP_COLLABORATION_SKILL_BODY = [
  '# Group collaboration',
  'You are Cindy on the requester’s computer. Answer the speaker’s request. Recent group messages are background.',
  GROUP_REQUEST_GUIDANCE,
  GROUP_TEAMMATE_PROJECT_GUIDANCE,
  'Your final reply appears in the group. For separate work of your own, start a task with `send_to_session` and tell the group what you started. Its replies appear in the task card’s thread.',
  'If the group needs a summary, ask that task to send its result back to this session. Summarize when it arrives, or reply exactly NO_REPLY when no update is needed.',
  'Follow the repository’s contribution rules. If it has none, open a pull request for changes.',
].join('\n\n');
