import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '@cindy/maker-core';
import type { PersistSessionStreamEventDeps } from '../sessionEventStream.js';
import type { PreparedSessionEvent } from '../sessionEventPreparation.js';

// #12110: the desktop session entry builds its event dependencies with
// Object.create(...) and defines a few hooks as own properties. Everything else
// (log, orcaTeamServiceForEvents) stays on the prototype, so the persistence
// boundary must pass those two through explicitly instead of spreading deps.
const mocks = vi.hoisted(() => ({
  persistSubagentTaskUpdate: vi.fn(),
  broadcastSubagentRunsChanged: vi.fn(),
  captureSubagentObservationGeneration: vi.fn(),
  enqueueSubagentObservationWrite: vi.fn(),
  onAssistantTextEvent: vi.fn(),
  onAgentTaskUpdateEvent: vi.fn(),
  enqueueDurableWrite: vi.fn(),
}));

vi.mock('../../localDb/subagentRuns.js', () => ({ persistSubagentTaskUpdate: mocks.persistSubagentTaskUpdate }));
vi.mock('../../localDb/ipc/subagentRuns.js', () => ({ broadcastSubagentRunsChanged: mocks.broadcastSubagentRunsChanged }));
vi.mock('../../subagentObservationRewindFence.js', () => ({
  captureSubagentObservationGeneration: mocks.captureSubagentObservationGeneration,
  enqueueSubagentObservationWrite: mocks.enqueueSubagentObservationWrite,
}));
vi.mock('../../messagePersistBroadcaster.desktop.js', () => ({
  enqueueDurableWrite: mocks.enqueueDurableWrite,
  getSessionTextSnapshot: vi.fn(() => null),
  flushAssistantBlock: vi.fn(),
  onAssistantTextEvent: mocks.onAssistantTextEvent,
  onAssistantAttemptFailure: vi.fn(),
  onAssistantSamplingAccepted: vi.fn(),
  onAgentTaskUpdateEvent: mocks.onAgentTaskUpdateEvent,
  onThinkingEvent: vi.fn(),
  onToolResultEvent: vi.fn(),
  onToolResultFullEvent: vi.fn(),
  persistToolProcessMedia: vi.fn(),
  onToolUseEvent: vi.fn(),
}));

const { persistSessionStreamEvent } = await import('../sessionEventStream.js');

const session = { id: 'session-1', remoteHostId: null, agentKind: 'codex' } as unknown as Session;
const tick = () => new Promise(resolve => setImmediate(resolve));

describe('session event persistence dependencies', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.onAgentTaskUpdateEvent.mockReturnValue(true);
    mocks.onAssistantTextEvent.mockReturnValue(undefined);
    mocks.enqueueDurableWrite.mockImplementation(async (_key: string, write: () => Promise<unknown>) => write());
    mocks.enqueueSubagentObservationWrite.mockImplementation(
      ({ enqueue }: { enqueue: () => Promise<unknown> }) => enqueue());
  });

  it('logs the original database failure when the subagent write is refused', async () => {
    mocks.captureSubagentObservationGeneration.mockReturnValue({ generation: 1, taskKey: 'codex:task-1' });
    mocks.persistSubagentTaskUpdate.mockRejectedValue(
      Object.assign(new Error('DB_TRANSPORT_OUTCOME_UNKNOWN'), { code: 'DB_TRANSPORT_OUTCOME_UNKNOWN' }));
    const log = { warn: vi.fn() };
    const deps = Object.create({ log, orcaTeamServiceForEvents: null }) as PersistSessionStreamEventDeps;

    persistSessionStreamEvent(deps, session, {
      event: { type: 'agent_task_update', source: 'codex', data: { taskId: 'task-1', status: 'running' } },
      eventAgentMeta: null,
    } as unknown as PreparedSessionEvent);
    await tick();

    expect(log.warn).toHaveBeenCalledWith('Subagent workspace persistence failed',
      { sessionId: 'session-1', error: 'DB_TRANSPORT_OUTCOME_UNKNOWN' });
  });

  // Unit: plugin forwarding must distinguish finished foreground progress from a draft,
  // a subagent's text and a final answer even when all have identical content.
  it('marks only finished progress belonging to the current plugin input', () => {
    const deps = { log: { warn: vi.fn() }, orcaTeamServiceForEvents: null };
    const event = { type: 'text', source: 'codex',
      data: { text: 'same text', phase: 'commentary', isFinal: true, isFullText: true } };
    const input = 'plugin-task:run';
    for (const [sourceEvent, meta, identity, eligible] of [
      [event, {}, input, true],
      [{ ...event, source: 'claude-code' }, { stopReason: 'tool_use' }, input, true],
      [{ ...event, source: 'pi' }, { stopReason: 'toolUse' }, input, true],
      [{ ...event, data: { ...event.data, phase: 'final_answer' } }, {}, input, false],
      [{ ...event, data: { ...event.data, isFinal: false } }, {}, input, false],
      [{ ...event, runtimeRecovery: true }, {}, input, false],
      [{ ...event, turnScope: 'background' }, {}, input, false],
      [event, { parentUuid: 'subagent-parent' }, input, false],
      [event, {}, 'human-steer', false],
    ] as const) {
      persistSessionStreamEvent(deps, session, { event: sourceEvent, eventAgentMeta: meta,
        groupLaneInputClientId: identity } as unknown as PreparedSessionEvent);
      const persisted = mocks.onAssistantTextEvent.mock.lastCall?.[2];
      expect(persisted?.pluginProgressInputId).toBe(eligible ? input : undefined);
    }
  });

  it('captures worker text through the dependency inherited from the session entry', () => {
    const captureWorkerText = vi.fn();
    const deps = Object.create({ log: { warn: vi.fn() }, orcaTeamServiceForEvents: { captureWorkerText } }) as PersistSessionStreamEventDeps;

    persistSessionStreamEvent(deps, session, {
      event: { type: 'text', source: 'codex', data: { text: 'worker report', isFinal: true } },
      eventAgentMeta: null,
    } as unknown as PreparedSessionEvent);

    expect(captureWorkerText).toHaveBeenCalledWith('session-1', 'worker report', { isFinal: true });
  });
});
