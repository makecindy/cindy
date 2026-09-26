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
it('has no process entry or commentary during generation, and retains the completed answer', () => {
  const active = bodies(base, true);
  expect(active.map(item => item.type)).toEqual(['message']);
  expect(JSON.stringify(active)).not.toMatch(/Public progress|technical details/);
  const complete = bodies([...base, row('a4', 'assistant', 'Answer', { turnCompleted: true })], false);
  expect(complete.filter(item => item.type === 'message').map(item => item.message.body)).toEqual(['Help', 'Answer']);
  expect(base[1].content).toBe('Public progress');
});
it('retains an interrupted/no-final reply and the actual error', () => {
  const items = bodies([...base, row('a4', 'assistant', 'Useful partial answer'), row('e5', 'error', 'Model failed')], false);
  expect(JSON.stringify(items)).toContain('Useful partial answer');
  expect(JSON.stringify(items)).toContain('Model failed');
  expect(items.some(item => item.type === 'work_group')).toBe(false);
});
it('keeps all contiguous blocks of a sealed final answer', () => {
  const items = bodies([...base, row('a4', 'assistant', 'Part one'), row('a5', 'assistant', 'Part two', { turnCompleted: true })], false);
  const text = items.filter(item => item.type === 'message').map(item => item.message.body);
  expect(text).toEqual(['Help', 'Part one', 'Part two']);
});
it('keeps delivered attachments without their preamble', () => {
  const items = bodies([...base, row('a4', 'assistant', '![Picture](https://example.com/picture.png)')], false);
  expect(JSON.stringify(items)).toContain('picture.png');
  expect(JSON.stringify(items)).not.toContain('Public progress');
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
  expect(texts(messages)).toEqual(['Current answer, first part', 'Current answer, last part']);
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
it.each([false, true])('keeps the result receipt without resurrecting its preamble (streaming=%s)', (running) => {
  const items = bodies([...base, receipt], running);
  expect(JSON.stringify(items)).toContain('The completed brief');
  expect(JSON.stringify(items)).not.toContain('Public progress');
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
    expect(items.some(item => item.type === 'work_group' || item.type === 'tool_group')).toBe(false);
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
  // The hidden separator still ends the interrupted turn, whose useful partial prose stays readable.
  expect(items.filter(item => item.type === 'message').map(item => item.message.body)).toEqual(['Help', 'Public progress', 'Answer']);
  const live = companionConversationItems(buildMobileMessageRenderItems(base, {
    isSessionStreaming: true, autoResumePending: { attempt: 2, maxAttempts: 3 },
  }));
  expect(live.filter(isResumeCard)).toHaveLength(1);
});
