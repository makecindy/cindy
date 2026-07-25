import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentEvent, SendOrigin } from '@cindy/maker-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HeadlessGoalService } from './goal-service.js';
import { HeadlessSessionStorage } from './session-storage.js';
import type { HeadlessSessionRuntime } from './session-runtime.js';
import type { HeadlessSessionMeta } from './session-types.js';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

class FakeGoalRuntime implements HeadlessSessionRuntime {
  readonly sent: Array<{ sessionId: string; content: string; origin: SendOrigin }> = [];
  private readonly events = new Set<(sessionId: string, event: AgentEvent) => void>();
  private readonly starts = new Set<(sessionId: string, origin: SendOrigin) => void>();

  async send(session: HeadlessSessionMeta, content: string | { content: unknown }, origin: SendOrigin = { kind: 'user' }): Promise<void> {
    for (const listener of this.starts) listener(session.id, origin);
    this.sent.push({ sessionId: session.id, content: typeof content === 'string' ? content : JSON.stringify(content), origin });
  }
  async steer(): Promise<void> { return undefined; }
  async abort(): Promise<void> { return undefined; }
  async closeSession(): Promise<void> { return undefined; }
  async resolveInteraction(): Promise<boolean> { return false; }
  async reconfigure(): Promise<void> { return undefined; }
  async setOrcaRole(): Promise<void> { return undefined; }
  isSessionBusy(): boolean { return false; }
  isAnySessionBusy(): boolean { return false; }
  async close(): Promise<void> { return undefined; }
  subscribeAgentEvents(listener: (sessionId: string, event: AgentEvent) => void): () => void { this.events.add(listener); return () => this.events.delete(listener); }
  subscribeTurnStarts(listener: (sessionId: string, origin: SendOrigin) => void): () => void { this.starts.add(listener); return () => this.starts.delete(listener); }
  emit(sessionId: string, event: AgentEvent): void { for (const listener of this.events) listener(sessionId, event); }
}

async function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-headless-goal-'));
  dirs.push(dir);
  const sessions = new HeadlessSessionStorage(path.join(dir, 'sessions.db'));
  const runtime = new FakeGoalRuntime();
  await sessions.create({ id: 's1', agentKind: 'codex', workDir: '/tmp', title: 'Goal', model: 'gpt-5.6' });
  const goal = new HeadlessGoalService(path.join(dir, 'sessions.db'), sessions, runtime);
  await goal.start();
  return { dir, sessions, runtime, goal };
}

describe('HeadlessGoalService', () => {
  it('continues only after terminal events and persists complete status', async () => {
    const { goal, runtime } = await fixture();
    await goal.set({ sessionId: 's1', objective: 'finish the task', limits: { maxTurns: 4, budgetTokens: null, noProgressLimit: null } });
    await vi.waitFor(() => expect(runtime.sent).toHaveLength(1));
    expect(runtime.sent[0]).toMatchObject({ origin: { kind: 'goal' }, content: expect.stringContaining('finish the task') });

    runtime.emit('s1', { type: 'text', data: { text: 'working\n```json\n{"goal_status":"continue","reason":"one more step"}\n```', isFinal: true } } as AgentEvent);
    runtime.emit('s1', { type: 'done', data: { usage: { promptTokens: 10, completionTokens: 5 } } } as AgentEvent);
    await vi.waitFor(() => expect(runtime.sent).toHaveLength(2));
    await expect(goal.getStatus('s1')).resolves.toMatchObject({ status: 'active', turnsUsed: 1, tokensUsed: 15 });

    runtime.emit('s1', { type: 'text', data: { text: 'done\n```json\n{"goal_status":"complete","reason":"verified"}\n```', isFinal: true } } as AgentEvent);
    runtime.emit('s1', { type: 'done', data: { usage: { promptTokens: 2, completionTokens: 3 } } } as AgentEvent);
    await vi.waitFor(async () => expect((await goal.getStatus('s1'))?.status).toBe('complete'));
    await expect(goal.getStatus('s1')).resolves.toMatchObject({ turnsUsed: 2, tokensUsed: 20, lastReason: 'verified' });
    await goal.stop();
  });

  it('pauses on a normal user turn and restores an active goal after daemon restart', async () => {
    const { dir, sessions, runtime, goal } = await fixture();
    await goal.set({ sessionId: 's1', objective: 'survive restart', limits: { maxTurns: null, budgetTokens: null, noProgressLimit: null } });
    await vi.waitFor(() => expect(runtime.sent).toHaveLength(1));
    await runtime.send((await sessions.get('s1'))!, 'user interruption');
    await vi.waitFor(async () => expect((await goal.getStatus('s1'))?.status).toBe('paused'));
    await goal.resume('s1');
    await vi.waitFor(() => expect(runtime.sent).toHaveLength(2));
    await goal.stop();

    const restartedRuntime = new FakeGoalRuntime();
    const restarted = new HeadlessGoalService(path.join(dir, 'sessions.db'), sessions, restartedRuntime);
    await restarted.start();
    await vi.waitFor(() => expect(restartedRuntime.sent).toHaveLength(1));
    expect(restartedRuntime.sent[0].content).toContain('survive restart');
    await restarted.stop();
  });
});
