import { describe, expect, it, vi } from 'vitest';
import type { AgentIslandSessionActivity } from '../../../shared/agentIsland.js';
import { encodeSnapshot, parseHelperLine, passportTasks, PassportTaskHistory, passportTextPage } from '../protocol.js';
import { PassportController } from '../controller.js';

const task = { id: 'session-1', title: 'Task title', status: 'waiting', message: 'Needs your input' };
const activity = (id: string, phase: AgentIslandSessionActivity['phase']): AgentIslandSessionActivity => ({
  sessionId: id, phase, startedAtMs: null, lastActivityAtMs: 0, currentActionSummary: 'Hello',
  compactDetail: 'Hello', attention: false, workflow: null, turnGeneration: null,
  gracefulStopState: 'none', source: 'live',
});
describe('Passport BLE protocol', () => {
  it('keeps the task being read visible without erasing terminal history', () => {
    const catalog = Array.from({ length: 9 }, (_, i) => ({ id: `task-${i}`, title: `Task ${i}` }));
    const history = new PassportTaskHistory();
    history.observe([activity('task-0', 'error')]);
    const running = catalog.slice(1, 8).map((task) => activity(task.id, 'running'));
    const tasks = history.tasks(catalog, running, 'task-8');
    expect(tasks).toHaveLength(8);
    expect(tasks.some((task) => task.id === 'task-8')).toBe(true);
    expect(history.tasks(catalog, []).find((task) => task.id === 'task-0')?.status).toBe('failed');
  });
  it('pages complete Chinese replies inside the existing message field', () => {
    const text = '这是完整的回复，需要逐页阅读。'.repeat(50);
    let joined = '';
    for (let i = 0; ; i++) {
      const page = passportTextPage(text, i);
      if (page.page !== i) break;
      expect(Buffer.byteLength(page.message)).toBeLessThan(192);
      expect(page.message.split('\n').length).toBeLessThanOrEqual(4);
      joined += page.message.split('\n').slice(1).join('');
    }
    expect(joined).toBe(text);
  });
  it('validates the task and recording token on control events', () => {
    const event = { kind: 'action', action: 5, id: task.id, token: 0x12345678 };
    expect(parseHelperLine(JSON.stringify(event))).toEqual(event);
    for (const patch of [{ token: -1 }, { token: 2 ** 32 }, { action: 7 }, { id: '中'.repeat(20) }]) {
      expect(parseHelperLine(JSON.stringify({ ...event, ...patch }))).toBeNull();
    }
    const action = vi.fn();
    const controller = new PassportController(() => {}, () => {}, action);
    controller.update([task]);
    controller.handle(JSON.stringify(event));
    expect(action).not.toHaveBeenCalled();
    controller.handle('{"kind":"ready"}'); controller.handle(JSON.stringify(event));
    expect(action).toHaveBeenCalledOnce();
  });
  it('matches the firmware fixed-width v1 frame', () => {
    const bytes = encodeSnapshot([task]);
    expect(bytes.length).toBe(332);
    expect([...bytes.subarray(0, 4)]).toEqual([74, 1, 1, 1]);
    expect(bytes.subarray(4, 13).toString()).toBe('session-1');
    expect(bytes.subarray(124, 131).toString()).toBe('waiting');
    expect(bytes.subarray(140, 156).toString()).toBe('Needs your input');
    expect([...encodeSnapshot([])]).toEqual([2, 0, 1, 0]);
  });
  it('bounds UTF-8 fields without splitting characters or truncating IDs', () => {
    const bytes = encodeSnapshot([{ ...task, title: '你'.repeat(40) }]);
    expect(bytes.subarray(44, 122).toString()).toBe('你'.repeat(26));
    expect(bytes[122]).toBe(0);
    expect(() => encodeSnapshot([{ ...task, id: 'a'.repeat(40) }])).toThrow();
    expect(() => encodeSnapshot([task, task])).toThrow();
    expect(() => encodeSnapshot(Array(9).fill(task))).toThrow();
  });
  it('lists every catalog task, live ones first, and marks idle ones done', () => {
    expect(passportTasks(
      [{ id: 'done', title: 'Done' }, { id: 'wait', title: 'Waiting' }, { id: 'idle', title: null }],
      [activity('done', 'completed'), activity('wait', 'needs-interaction'), activity('hidden', 'running')],
    ).map((t) => [t.id, t.status, t.title])).toEqual([
      ['wait', 'waiting', 'Waiting'], ['done', 'done', 'Done'], ['idle', 'done', ''],
    ]);
  });
  it('rejects malformed or unauthorized helper actions', () => {
    expect(parseHelperLine('{')).toBeNull();
    expect(parseHelperLine('{"kind":"open","id":42}')).toBeNull();
    expect(parseHelperLine('{"kind":"approve","id":"session-1"}')).toBeNull();
    const opened: string[] = [];
    const c = new PassportController(() => {}, (id) => opened.push(id));
    c.update([task]); c.handle('{"kind":"open","id":"session-1"}');
    expect(opened).toEqual([]);
    c.handle('{"kind":"ready"}'); c.handle('{"kind":"open","id":"unknown"}');
    c.handle('{"kind":"open","id":"session-1"}');
    expect(opened).toEqual(['session-1']);
    c.update([]); c.handle('{"kind":"open","id":"session-1"}');
    expect(opened).toEqual(['session-1']);
  });
  it('invalidates pending task opens across disconnect and reconnect', () => {
    const c = new PassportController(() => {}, () => {});
    c.update([task]); c.handle('{"kind":"ready"}');
    const version = c.connectionVersion;
    expect(c.canOpen(task.id)).toBe(true);
    c.handle('{"kind":"disconnected"}');
    expect(c.canOpen(task.id)).toBe(false);
    c.handle('{"kind":"ready"}');
    expect(c.connectionVersion).not.toBe(version);
  });
  it('coalesces snapshots under backpressure and resends after reconnect', () => {
    const writes: string[] = [];
    const c = new PassportController((line) => writes.push(line), () => {});
    c.update([task]); expect(writes).toHaveLength(0);
    c.handle('{"kind":"ready"}'); expect(writes).toHaveLength(1);
    c.update([{ ...task, title: 'Intermediate' }]); c.update([{ ...task, title: 'Latest' }]);
    expect(writes).toHaveLength(1);
    c.handle('{"kind":"idle"}'); expect(writes).toHaveLength(2);
    expect(Buffer.from(writes[1].trim(), 'base64').subarray(44, 50).toString()).toBe('Latest');
    c.handle('{"kind":"idle"}'); expect(writes).toHaveLength(2);
    c.handle('{"kind":"disconnected"}'); c.handle('{"kind":"ready"}');
    expect(writes).toHaveLength(3);
    c.handle('{"kind":"idle"}'); c.heartbeat();
    expect(writes).toHaveLength(4);
  });
});

describe('Passport completed tasks', () => {
  const catalog = [{ id: 's1', title: '中文任务' }];
  it('retains completed tasks after overlay expiry, then replaces them when work resumes', () => {
    const history = new PassportTaskHistory();
    history.observe([activity('s1', 'completed')]);
    expect(history.tasks(catalog, [])[0]).toMatchObject({ id: 's1', status: 'done', title: '中文任务' });
    history.observe([activity('s1', 'running')]);
    expect(history.tasks(catalog, [activity('s1', 'running')])[0].status).toBe('running');
    expect(history.tasks([], [])).toEqual([]);
  });
  it('forgets remembered detail for archived tasks and across owner changes', () => {
    const history = new PassportTaskHistory();
    history.observe([activity('s1', 'completed')]);
    expect(history.tasks([], [])).toEqual([]);
    expect(history.tasks(catalog, [])[0].message).toBe('');
    history.observe([activity('s1', 'completed')]); history.clear();
    expect(history.tasks(catalog, [])[0].message).toBe('');
  });
});
