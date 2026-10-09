import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { assertBotTaskCoordination, classifySessionMessagePurpose, coordinationInput, readBotTaskCoordination } from '../botTaskCoordination';
import { buildMakerUserMessage, sanitizeQueuedMessageForPersistence, type AgentInputQueuedMessage } from '../../../shared/agentInputQueue';
import { redactMessageOriginForSharedGuest, redactQueueItemForSharedGuest } from '../../device-link/sharedTaskMessageOrigin';
import { rebuildSessionQueueItem } from '../sessionControlService';
import { projectCoordinationOutput } from '../coordinationOutput';
import type { AgentEvent } from '@cindy/maker-core';
import { stripMainOnlySendOpts } from '../mobileClientPromptNote';

const h = vi.hoisted(() => ({ db: null as ReturnType<typeof drizzle> | null }));
vi.mock('../../localDb/client/current.js', () => ({ getDbClient: () => ({ drizzle: h.db }) }));
let db: Database.Database;
const receipt = { delegationId: 'delegation', senderSessionId: 'child', runSequence: 2 };
beforeEach(() => {
  db = new Database(':memory:');
  h.db = drizzle(db);
  db.exec(`
    CREATE TABLE bot_delegations (id TEXT, child_session_id TEXT, requesting_bot_id TEXT, parent_session_id TEXT, run_sequence INTEGER);
    CREATE TABLE bot_profiles (id TEXT, canonical_session_id TEXT, status TEXT);
    CREATE TABLE bot_session_links (bot_id TEXT, session_id TEXT, role TEXT, archived_at INTEGER);
    CREATE TABLE sessions (id TEXT, status TEXT);
    INSERT INTO bot_delegations VALUES ('delegation', 'child', 'bot', 'parent', 2);
    INSERT INTO bot_profiles VALUES ('bot', 'parent', 'active');
    INSERT INTO bot_session_links VALUES ('bot', 'parent', 'canonical', NULL);
    INSERT INTO sessions VALUES ('child', 'active');
  `);
});
afterEach(() => db.close());

it('defaults only the verified delegated child to coordination, with an explicit visible escape', async () => {
  expect(await classifySessionMessagePurpose({ senderSessionId: 'child', targetSessionId: 'parent' })).toEqual({ coordination: receipt, delegatedContinuation: true });
  expect(await classifySessionMessagePurpose({ senderSessionId: 'child', targetSessionId: 'parent', purpose: 'user-visible' })).toEqual({ coordination: null, delegatedContinuation: true });
  expect(await classifySessionMessagePurpose({ senderSessionId: 'ordinary', targetSessionId: 'parent' })).toEqual({ coordination: null, delegatedContinuation: false });
  expect(await classifySessionMessagePurpose({ senderSessionId: 'child', targetSessionId: 'ordinary' })).toEqual({ coordination: null, delegatedContinuation: false });
  expect(await classifySessionMessagePurpose({ senderSessionId: 'child' })).toEqual({ coordination: null, delegatedContinuation: false });
  await expect(classifySessionMessagePurpose({ senderSessionId: 'ordinary', targetSessionId: 'parent', purpose: 'coordination' })).rejects.toThrow('delegated task');
});
it.each([
  "UPDATE bot_delegations SET parent_session_id = 'group-lane'",
  "UPDATE bot_profiles SET canonical_session_id = 'replacement'",
  "UPDATE bot_profiles SET status = 'disabled'",
  "UPDATE bot_session_links SET role = 'history'",
  'UPDATE bot_session_links SET archived_at = 1',
  "UPDATE sessions SET status = 'archived'",
])('rejects a mismatched or retired relationship: %s', async sql => {
  db.exec(sql);
  expect(await readBotTaskCoordination('child', 'parent')).toBeNull();
  await expect(assertBotTaskCoordination('parent', receipt)).rejects.toThrow('changed');
});
it('revalidates the execution on restored queue dispatch', async () => {
  await expect(assertBotTaskCoordination('parent', JSON.parse(JSON.stringify(receipt)))).resolves.toBeUndefined();
  db.exec('UPDATE bot_delegations SET run_sequence = 3');
  await expect(assertBotTaskCoordination('parent', receipt)).rejects.toThrow('changed');
});
it('keeps the source and body durable, but puts the coordination instruction only in model input', () => {
  const input = coordinationInput('File ownership agreement', receipt);
  const item = { ...input, text: input.persistedContent, agentOmitsTriggerPrefix: true,
    clientId: 'coordination', origin: { kind: 'session', senderSessionId: 'child', displayText: input.message },
    chatMessage: { clientId: 'coordination', role: 'user', content: input.persistedContent }, createOpts: {},
  } as unknown as AgentInputQueuedMessage;
  const restored = JSON.parse(JSON.stringify(sanitizeQueuedMessageForPersistence(item)));
  expect(restored.botTaskCoordination).toEqual(receipt);
  expect(restored.text).toBe('[UI_ACTION_TRIGGER]File ownership agreement');
  expect(restored.persistedContent).not.toContain('Internal task coordination');
  const wire = buildMakerUserMessage(restored);
  expect(wire).toMatchObject({ content: expect.stringContaining('Internal task coordination') });
  expect(wire).toMatchObject({ content: expect.stringContaining('File ownership agreement') });
  expect(JSON.stringify(wire)).not.toContain('[UI_ACTION_TRIGGER]');
  expect(redactQueueItemForSharedGuest(restored)).not.toHaveProperty('botTaskCoordination');
  expect(redactMessageOriginForSharedGuest({ botTaskCoordinationInput: receipt })).toEqual({});
});
it('strips forged receipts from direct renderer/device-link sends', () => {
  expect(stripMainOnlySendOpts({ persistUserMessage: { clientId: 'x', content: 'Hello', botTaskCoordination: receipt } }))
    .toEqual({ persistUserMessage: { clientId: 'x', content: 'Hello' } });
});

it('retains hidden persistence and routing when the sending task edits its queued coordination', () => {
  const item = { clientId: 'edit', text: '[UI_ACTION_TRIGGER]Old agreement', persistedContent: '[UI_ACTION_TRIGGER]Old agreement',
    botTaskCoordination: receipt, agentOmitsTriggerPrefix: true, chatMessage: { role: 'user' },
    origin: { kind: 'session', senderSessionId: 'child', displayText: 'Old agreement' },
  } as unknown as AgentInputQueuedMessage;
  const edited = rebuildSessionQueueItem(item, 'Updated agreement');
  expect(edited.persistedContent).toBe('[UI_ACTION_TRIGGER]Updated agreement');
  expect(edited.botTaskCoordination).toEqual(receipt);
  expect(buildMakerUserMessage(edited)).toMatchObject({ content: expect.stringContaining('Updated agreement') });
});
it.each<AgentEvent['type']>(['interaction_request', 'interaction_dismissed', 'error', 'tool_use', 'tool_result', 'account_usage'])('does not suppress an attention/action event: %s', type => {
  const event: AgentEvent = { type, source: 'codex', data: { requestId: 'interaction', kind: 'ask_user_question', questions: [] } };
  expect(projectCoordinationOutput(event, true)).toBe(event);
});

it('uses the registered host entry for both quiet and explicitly visible delegated sends', async () => {
  const source = readFileSync(resolve(__dirname, '..', 'register.ts'), 'utf8').replace(/\r\n/g, '\n');
  const start = source.indexOf('    sendToSession: async (params) => {');
  const end = source.indexOf('    enableOrca:', start);
  expect(start).toBeGreaterThan(0);
  const code = ts.transpileModule('return ({' + source.slice(start, end) + '}).sendToSession;', {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  const send = vi.fn(async (params: unknown) => params);
  let currentOwner = true;
  const dispatch = new Function('captureDataOwnerBroadcastScope', 'isDataOwnerBroadcastScopeCurrent',
    'classifySessionMessagePurpose', 'coordinationInput', 'sendToSessionInternal', code)(
    () => 'owner', () => currentOwner, classifySessionMessagePurpose, coordinationInput, send);
  await dispatch({ dispatcherSessionId: 'child', targetSessionId: 'parent', message: 'Agreement' });
  expect(send).toHaveBeenLastCalledWith(expect.objectContaining({ forceQueue: true, botTaskCoordination: receipt,
    persistedContent: '[UI_ACTION_TRIGGER]Agreement', autoReviewUserText: { kind: 'delegated-continuation' } }));
  await dispatch({ dispatcherSessionId: 'child', targetSessionId: 'parent', message: 'Requested result', messagePurpose: 'user-visible' });
  expect(send).toHaveBeenLastCalledWith(expect.objectContaining({ message: 'Requested result', autoReviewUserText: { kind: 'delegated-continuation' } }));
  expect(send.mock.calls.at(-1)?.[0]).not.toHaveProperty('botTaskCoordination');
  await dispatch({ dispatcherSessionId: 'ordinary', targetSessionId: 'parent', message: 'Ordinary task message' });
  expect(send).toHaveBeenLastCalledWith({ dispatcherSessionId: 'ordinary', targetSessionId: 'parent', message: 'Ordinary task message' });
  currentOwner = false;
  const count = send.mock.calls.length;
  expect(await dispatch({ dispatcherSessionId: 'child', targetSessionId: 'parent', message: 'Agreement' })).toMatchObject({ ok: false });
  expect(send).toHaveBeenCalledTimes(count);
});
