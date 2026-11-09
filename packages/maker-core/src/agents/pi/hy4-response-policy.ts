/** Keep HY4's tool-planning narration in its reasoning channel, not the answer. */
export const HY4_RESPONSE_POLICY = [
  '# HY4 response channels',
  'Keep private deliberation, tool-selection drafts, and repeated searches for tools in the reasoning channel. Do not restate them in the user-facing answer.',
  'Call tools directly when no useful update is needed. Give a brief progress update only for a meaningful result, a blocker, or a change of approach; do not narrate every tool lookup or retry.',
  'Use the language of the user\'s request for all user-facing text, including progress updates, unless the user explicitly requests another language. Preserve code, tool names, identifiers, and quotations as needed.',
  'After using tools, answer the user\'s actual question with the result. Do not replace the answer with a description of what you intend to do.',
].join('\n');

/** Self-contained child-process source, independent of host bundler transforms. */
export const HY4_RESPONSE_POLICY_INSTALL_SOURCE = String.raw`
  pi.on('before_agent_start', (event, ctx) => {
    // Read the live model each turn: a task may switch to or away from HY4.
    if (typeof ctx.model?.id !== 'string' || !/^(?:tencent\/)?hy4(?:-preview)?$/i.test(ctx.model.id)) return;
    return { systemPrompt: event.systemPrompt + '\n\n' + ${JSON.stringify(HY4_RESPONSE_POLICY)} };
  });
`;
