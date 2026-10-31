import { redactMessageRowForSharedGuest } from '../../../desktop/src/main/device-link/sharedTaskMessageOrigin';
import { HISTORY_GAP_SPLIT_MS } from '@cindy/maker-shared/history-gap';
import { expect, it } from 'vitest';
import { buildMobileMessageRenderItems } from '../session/messageRenderModel';
import { companionConversationItems } from '../session/companionConversationPresentation';
import type { RemoteMessage } from '../session/types';
const row = (id: string, role: RemoteMessage['role'], content: unknown, agentMeta: RemoteMessage['agentMeta'] = null): RemoteMessage => ({
  id, clientId: id, sessionId: 'chat', role, content, agentMeta, toolUseId: null, createdAt: new Date(1000 + Number(id.replace(/\D/g, '') || 0)).toISOString(),
});
const bodies = (messages: RemoteMessage[], running: boolean) => companionConversationItems(buildMobileMessageRenderItems(messages, { isSessionStreaming: running }));
const base = [row('u0', 'user', 'Help'), row('a1', 'assistant', 'Public progress'),
  row('t2', 'tool_use', { toolName: 'Read', toolUseId: 't', input: { path: 'private' } }),
  row('r3', 'tool_result', { toolUseId: 't', result: 'technical details' })];
// Unit regression: the real normalize → group → companion projection used to
// hide prose as soon as commentary metadata or a later tool arrived.
it('keeps working prose through streaming metadata and tools, folding only after the answer', () => {
  const progress = row('a1', 'assistant', 'Checking the refresh');
  const marked = { ...progress, agentMeta: { assistantPhase: 'commentary' } };
  for (const source of [[base[0], progress], [base[0], marked], [base[0], marked, ...base.slice(2)]]) {
    expect(bodies(source, true).filter(item => item.type === 'message').map(item => item.message.body))
      .toContain('Checking the refresh');
  }
  const completed = bodies([base[0], marked, ...base.slice(2), row('a4', 'assistant', 'Done', { turnCompleted: true })], false);
  expect(completed.filter(item => item.type === 'message').map(item => item.message.body)).toEqual(['Help', 'Done']);
  expect(JSON.stringify(completed.find(item => item.type === 'work_group'))).toContain('Checking the refresh');
});
// #6351: this consumer expands work groups and infers contiguous sealed runs,
// so grouping alone cannot prevent a failed sample becoming another reply.
it.each(['retrying', 'completed', 'exhausted'] as const)(
  'does not promote failed sampling prose in a %s companion turn', (ending) => {
    const failed = row('a1', 'assistant', '# Failed opening\n' + 'Details '.repeat(100), {
      turnCompleted: true, turnCostUsd: 0.1, failedSamplingAttempt: {
        threadId: 'thread', turnId: 'turn', attempt: 1, itemId: 'failed',
      },
    });
    const source = [row('u0', 'user', 'Help'), failed,
      ...(ending === 'completed' ? [row('a2', 'assistant', 'Accepted intro'),
        row('a3', 'assistant', 'Accepted answer', { turnCompleted: true })]
        : ending === 'exhausted' ? [row('e2', 'error', 'Model failed')] : []),
    ];
    const visible = bodies(source, ending === 'retrying')
      .filter(item => item.type === 'message').map(item => item.message);
    expect(visible.filter(item => item.kind === 'assistant').map(item => item.body))
      .toEqual(ending === 'completed' ? ['Accepted intro', 'Accepted answer'] : []);
    expect(visible.some(item => item.source.id === 'u0')).toBe(true);
    expect(visible.some(item => item.source.role === 'error')).toBe(ending === 'exhausted');
    expect(source[1]).toBe(failed);
    expect(source[1].content).toContain('# Failed opening');
    expect(source[1].agentMeta?.failedSamplingAttempt).toBeDefined();
  });
// Regression: the mobile companion filter discarded the work groups restored on
// Desktop. Unit entry is the real normalize → group → companion projection;
// a user row, progress and one tool suffice to lose the only process entry.
it('keeps live work and completed process details reachable like Desktop', () => {
  const active = bodies(base, true);
  expect(active.map(item => item.type)).toEqual(['message', 'message', 'work_group']);
  expect(JSON.stringify(active)).toContain('technical details');
  const complete = bodies([...base, row('a4', 'assistant', 'Answer', { turnCompleted: true })], false);
  expect(complete.filter(item => item.type === 'message').map(item => item.message.body)).toEqual(['Help', 'Answer']);
  expect(JSON.stringify(complete)).toContain('Public progress');
  expect(base[1].content).toBe('Public progress');
});
it('keeps a provider final reply visible while streaming and after tool/history updates', () => {
  const answer = row('a1', 'assistant', 'Visible first reply', { assistantPhase: 'final_answer', isStreaming: true });
  for (const source of [[base[0], answer], [base[0], answer, ...base.slice(2)],
    [base[0], { ...answer, agentMeta: { assistantPhase: 'final_answer' } }, ...base.slice(2),
      row('a4', 'assistant', 'Done', { turnCompleted: true })]]) {
    expect(bodies(source, true).filter(item => item.type === 'message').map(item => item.message.body))
      .toContain('Visible first reply');
  }
});
it('retains an interrupted/no-final reply and the actual error', () => {
  const items = bodies([...base, row('a4', 'assistant', 'Useful partial answer'), row('e5', 'error', 'Model failed')], false);
  expect(JSON.stringify(items)).toContain('Useful partial answer');
  expect(JSON.stringify(items)).toContain('Model failed');
  expect(items.some(item => item.type === 'work_group')).toBe(true);
});
it('keeps all contiguous blocks of a sealed final answer', () => {
  const items = bodies([...base, row('a4', 'assistant', 'Part one'), row('a5', 'assistant', 'Part two', { turnCompleted: true })], false);
  const text = items.filter(item => item.type === 'message').map(item => item.message.body);
  expect(text).toEqual(['Help', 'Part one', 'Part two']);
});
// #7081 review: no tool/thinking boundary exists between progress and the final.
// Unit: real normalize → shared grouping → companion projection, including a late running status.
it.each([false, true])('folds commentary before a directly adjacent sealed answer (running=%s)', (running) => {
  const progress = row('a1', 'assistant', 'Checking', { assistantPhase: 'commentary' });
  const final = row('a2', 'assistant', 'Done', { assistantPhase: 'final_answer', turnCompleted: true });
  expect(bodies([base[0], progress, { ...final, agentMeta: { assistantPhase: 'final_answer', isStreaming: true } }], true)
    .filter(item => item.type === 'message').map(item => item.message.body)).toEqual(['Help', 'Checking', 'Done']);
  const complete = bodies([base[0], progress, final], running);
  expect(complete.filter(item => item.type === 'message').map(item => item.message.body)).toEqual(['Help', 'Done']);
  const work = complete.find(item => item.type === 'work_group');
  expect(work).toMatchObject({ isStreaming: false });
  expect(JSON.stringify(work)).toContain('Checking');
});
it('keeps every sealed reply block after a continuation even when the main timeline folds earlier seals', () => {
  const items = bodies([...base,
    row('a4', 'assistant', 'First block'), row('a5', 'assistant', 'First reply', { turnCompleted: true }),
    row('t6', 'tool_use', { toolName: 'Read', toolUseId: 't6', input: { path: 'private' } }),
    row('r7', 'tool_result', { toolUseId: 't6', result: 'more technical details' }),
    row('a8', 'assistant', 'Second reply', { turnCompleted: true }),
  ], false);
  const text = items.filter(item => item.type === 'message').map(item => item.message.body);
  expect(text).toEqual(['Help', 'First block', 'First reply', 'Second reply']);
});
it('keeps delivered attachments without their preamble', () => {
  const items = bodies([...base, row('a4', 'assistant', '![Picture](https://example.com/picture.png)')], false);
  expect(JSON.stringify(items)).toContain('picture.png');
  expect(items.filter(item => item.type === 'message').map(item => item.message.body)).not.toContain('Public progress');
  expect(JSON.stringify(items)).toContain('Public progress');
});
it('retains required questions and plan decisions in the actual message projection', () => {
  const items = bodies([...base,
    row('q4', 'ask_user', { status: 'answered', question: 'Which document?', reply: 'The brief' }),
    row('p5', 'plan_review', { plan: 'Review the brief', status: 'approved' }),
  ], false);
  expect(items.filter(item => item.type === 'message').map(item => item.message.kind))
    .toEqual(['user', 'assistant', 'ask_user', 'plan_review']);
  expect(JSON.stringify(items)).toContain('Which document?');
  expect(JSON.stringify(items)).toContain('Review the brief');
});

it.each([false, true])('does not seal old commentary across an unloaded history gap (streaming=%s)', (running) => {
  const at = (message: RemoteMessage, time: number) => ({ ...message, createdAt: new Date(time).toISOString() });
  const currentStart = 1000 + HISTORY_GAP_SPLIT_MS + 1;
  const messages = [
    at(row('a1', 'assistant', 'Old commentary'), 1000),
    // The intervening user message has not been loaded yet.
    at(row('a2', 'assistant', 'Current answer, first part'), currentStart),
    at(row('a3', 'assistant', 'Current answer, last part', { turnCompleted: true }), currentStart + 1),
  ];
  const texts = (source: RemoteMessage[]) => bodies(source, running)
    .filter(item => item.type === 'message').map(item => item.message.body);
  expect(texts(messages)).toEqual(['Old commentary', 'Current answer, first part', 'Current answer, last part']);
  // Once the actual user boundary is loaded, retain the older no-final reply
  // through the existing per-turn fallback, independently of the newer seal.
  expect(texts([messages[0], at(row('u2', 'user', 'New question'), currentStart - 1), ...messages.slice(1)]))
    .toEqual(['Old commentary', 'New question', 'Current answer, first part', 'Current answer, last part']);
});

const receipt = row('r6', 'assistant', '', { botCollaboration: {
  v: 1, role: 'delegation-result', delegationId: 'job', fromBotId: 'bot', fromBotName: 'Aster',
  toBotId: null, toBotName: '', parentSessionId: 'chat', childSessionId: 'child', objective: 'Brief',
  result: { runSequence: 1, status: 'completed', text: 'The completed brief', artifacts: [] },
} });
it.each([false, true])('keeps progress until a final reply even when a result receipt arrives (streaming=%s)', (running) => {
  const items = bodies([...base, receipt], running);
  expect(JSON.stringify(items)).toContain('The completed brief');
  expect(JSON.stringify(items)).toContain('Public progress');
});
it.each([false, true])('does not suppress an older reply across a history gap before a receipt (streaming=%s)', (running) => {
  const oldReply = row('a1', 'assistant', 'Earlier useful reply');
  const laterReceipt = { ...receipt, createdAt: new Date(1001 + HISTORY_GAP_SPLIT_MS + 1).toISOString() };
  const messages = [oldReply, laterReceipt];
  for (const source of [messages, [oldReply, { ...row('u2', 'user', 'New request'), createdAt: laterReceipt.createdAt }, laterReceipt]]) {
    const items = bodies(source, running);
    expect(JSON.stringify(items)).toContain('Earlier useful reply');
    expect(JSON.stringify(items)).toContain('The completed brief');
  }
});
it.each([{ turnCompleted: true }, { turnUsageDetails: { totalTokens: 12 } }])('keeps persisted and live answers with completion seal %j', (seal) => {
  const complete = [...base, row('a7', 'assistant', 'Delivered answer', seal)];
  for (const running of [true, false]) {
    const items = bodies(complete, running);
    expect(items.filter(item => item.type === 'message').map(item => item.message.body)).toEqual(['Help', 'Delivered answer']);
    expect(items.some(item => item.type === 'work_group')).toBe(true);
  }
});

it('drops persisted auto-resume separators like Desktop, keeping only the live reconnect card', () => {
  const resumed = [...base, row('u4', 'user', 'continue', { autoResume: true, autoResumeInfo: { attempt: 1, maxAttempts: 3 } }),
    row('a5', 'assistant', 'Answer', { turnCompleted: true })];
  const isResumeCard = (item: ReturnType<typeof bodies>[number]) => item.type === 'message' && item.message.systemCardType === 'auto-resume';
  // Ordinary tasks keep the separator; the teammate projection hides the persisted one.
  expect(buildMobileMessageRenderItems(resumed, { isSessionStreaming: false }).some(isResumeCard)).toBe(true);
  const items = bodies(resumed, false);
  expect(items.some(isResumeCard)).toBe(false);
  // The interrupted process remains readable inside its original work group.
  expect(items.filter(item => item.type === 'message').map(item => item.message.body)).toEqual(['Help', 'Answer']);
  expect(JSON.stringify(items)).toContain('Public progress');
  const live = companionConversationItems(buildMobileMessageRenderItems(base, {
    isSessionStreaming: true, autoResumePending: { attempt: 2, maxAttempts: 3 },
  }));
  expect(live.filter(isResumeCard)).toHaveLength(1);
});

it('attaches exact frozen results to their final reply across reload and keeps unbound receipts', () => {
  const card = { v: 1, role: 'delegation-result', delegationId: 'job', fromBotId: 'bot', fromBotName: 'Cindy',
    toBotId: null, toBotName: '', parentSessionId: 'chat', childSessionId: 'child', objective: 'Report',
    result: { runSequence: 1, status: 'completed', text: 'Frozen result', artifacts: [] } };
  const input = [row('r1', 'assistant', 'Frozen result', { botCollaboration: card }),
    row('u2', 'user', 'Include priorities'), row('a3', 'assistant', 'Checking'),
    row('t4', 'tool_use', { toolName: 'Read', toolUseId: 't4', input: {} }),
    row('a5', 'assistant', 'Summary', { turnCompleted: true, botTaskResults: [card] })];
  const projected = bodies(input, false).filter(item => item.type === 'message');
  expect(projected.map(item => item.message.body)).toEqual(['Include priorities', 'Summary']);
  expect(projected.at(-1)?.message.source.agentMeta?.botTaskResults).toEqual([card]);
  expect(bodies(input.slice(0, -1), false).some(item => item.type === 'message' && item.message.companion)).toBe(true);
  expect(bodies([input[0], row('a6', 'assistant', 'Other reply', { turnCompleted: true })], false)
    .some(item => item.type === 'message' && item.message.companion)).toBe(true);
});

it('keeps explicit group private deliveries while the private model works and after later replies', () => {
  const messages = [row('g1', 'assistant', 'Group delivery', { sourceGroup: { groupId: 'g-1' } }), ...base];
  const text = (rows: RemoteMessage[], running: boolean) => bodies(rows, running)
    .filter(item => item.type === 'message').map(item => item.message.body);
  expect(text(messages, true)).toContain('Group delivery');
  expect(text([...messages, row('a4', 'assistant', 'Answer', { turnCompleted: true })], false)).toContain('Group delivery');
});

it.each([true, false])('keeps guest-safe explicit delivery without sealing adjacent progress (running=%s)', (running) => {
  const messages = [row('u0', 'user', 'Help'), row('a1', 'assistant', 'Before'),
    row('g2', 'assistant', 'Private delivery', { sourceGroup: { groupId: 'private-group', name: 'Secret group' } }),
    row('a3', 'assistant', 'After'),
    row('t4', 'tool_use', { toolName: 'Read', toolUseId: 't4', input: {} }),
    ...(!running ? [row('a5', 'assistant', 'Final reply', { turnCompleted: true })] : []),
  ].map(redactMessageRowForSharedGuest);
  expect(messages[2].agentMeta).toEqual({ explicitDelivery: true });
  expect(JSON.stringify(messages)).not.toMatch(/private-group|Secret group/);
  const text = bodies(messages, running).filter(item => item.type === 'message').map(item => item.message.body);
  expect(text).toContain('Private delivery');
  expect(text.includes('Before')).toBe(running);
  expect(text.includes('After')).toBe(running);
});
it('keeps a component progress answer visible before finalization and later tool calls', () => {
  const content = '```cindy-ui\n' + JSON.stringify({ seq: 1, op: 'create', id: 'heading', kind: 'heading', props: { text: 'Result' } }) + '\n';
  const source = [row('u0', 'user', 'Help'), row('a1', 'assistant', content, { assistantPhase: 'commentary' }), ...base.slice(2)];
  const result = bodies(source, true);
  expect(result.some(item => item.type === 'message' && item.message.body === content)).toBe(true);
});

// Unit: actual normalize → ordinary grouping → teammate journal. A streaming
// commentary followed by one tool used to become separate top-level messages.
it('keeps mobile progress in one stable process across tools, switch and completion', async () => {
  const { companionProcessItems } = await import('../session/companionConversationPresentation');
  const stages = [base.slice(0, 1).concat(row('a1', 'assistant', 'Checking', { assistantPhase: 'commentary' })),
    base, [...base, row('s4', 'agent_switch', { fromAgentKind: 'codex', toAgentKind: 'pi' }), row('a5', 'assistant', 'Continuing', { assistantPhase: 'commentary' })]];
  const keys = stages.map(source => {
    const items = companionProcessItems(buildMobileMessageRenderItems(source, { isSessionStreaming: true }), true);
    expect(items.filter(item => item.type === 'work_group')).toHaveLength(1);
    return items.find(item => item.type === 'work_group')!.key;
  });
  expect(new Set(keys).size).toBe(1);
  const done = companionProcessItems(buildMobileMessageRenderItems([...stages[2], row('a6', 'assistant', 'Result', { turnCompleted: true })], { isSessionStreaming: false }), false);
  expect(done.find(item => item.type === 'work_group')?.key).toBe(keys[0]);
  expect(done.filter(item => item.type === 'message').map(item => item.message.body)).toEqual(['Help', 'Result']);
  expect(JSON.stringify(done)).toContain('technical details');
  expect(JSON.stringify(done)).toContain('Continuing');
});

it('retains the first thinking-only work before any progress text', async () => {
  const { companionProcessItems } = await import('../session/companionConversationPresentation');
  const source = [row('u0', 'user', 'Help'), row('w1', 'thinking', { text: 'Initial work', durationMs: 1 }),
    row('a2', 'assistant', 'Checking', { assistantPhase: 'commentary' }),
    row('w3', 'thinking', { text: 'More work', durationMs: 1 }), row('a4', 'assistant', 'Result', { turnCompleted: true })];
  const initial = companionProcessItems(buildMobileMessageRenderItems(source.slice(0, 2), { isSessionStreaming: true }), true);
  expect(initial.filter(item => item.type === 'work_group')).toHaveLength(1);
  expect(JSON.stringify(initial)).toContain('Initial work');
  for (const running of [false, true]) {
    const raw = buildMobileMessageRenderItems(source, { isSessionStreaming: running });
    const items = companionProcessItems(raw, running);
    expect(items.filter(item => item.type === 'work_group')).toHaveLength(1);
    expect(JSON.stringify(items.find(item => item.type === 'work_group'))).toContain('Initial work');
    expect(items.filter(item => item.type === 'message').map(item => item.message.body)).toEqual(['Help', 'Result']);
  }
});
