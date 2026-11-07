import type { Routine } from '@cindy/maker-scheduler';
import { describe, expect, it } from 'vitest';

import { buildCarryover, convertRoutine } from '../botV2Carryover.js';

// V1 → V2 upgrade (2026-11-07), measured on a real V1 copy: 8 routines (7 paused), 112 todos
// (51 open, 8 of them deleted by the owner), workbench and ledger entries. Nothing open may be
// lost, paused stays paused, and finished or deleted items are not carried.
const routine = (patch: Partial<Routine>): Routine => ({
  id: '5FBFC2EB-9761-429b', botId: 'b', name: 'PR watch', prompt: 'check PRs', enabled: false,
  triggers: [{ id: 't', kind: 'cron', expression: '5 * * * *', timezone: 'Asia/Shanghai' }],
  revision: 1, createdAt: 0, updatedAt: 0, ...patch,
});

describe('convertRoutine', () => {
  const route = { harness: 'codex' as const, model: 'm', providerId: 'p', effort: 'high', fastMode: false };

  it('keeps schedule, check script, model and paused state', () => {
    const { automations, note } = convertRoutine(routine({
      silentWhenIdle: true, preRunHook: { command: 'node check.mjs', timeoutMs: 180000 },
      modelOverride: { agentKind: 'pi', model: 'flash', providerId: 'xd', effort: 'high', fastMode: false },
    }), route, { now: 0, timezone: 'UTC' });
    expect(note).toBeNull();
    expect(automations).toEqual([{ enabled: false, config: expect.objectContaining({
      id: 'routine-5fbfc2eb9761', cronExpr: '5 * * * *', timezone: 'Asia/Shanghai', recurring: true,
      persistentSession: true, silentWhenIdle: true,
      preRunHook: { command: 'node check.mjs', timeoutMs: 180000 }, agentKind: 'pi', model: 'flash', providerId: 'xd',
    }) }]);
    // Without its own model it keeps running on the teammate's.
    expect(convertRoutine(routine({ enabled: true }), route, { now: 0, timezone: 'UTC' }).automations[0])
      .toMatchObject({ enabled: true, config: { agentKind: 'codex', model: 'm', providerId: 'p' } });
  });

  it('turns what cannot run on its own into a paused manual automation with a note', () => {
    const result = convertRoutine(routine({
      enabled: true,
      triggers: [{ id: 'e', kind: 'event', sourceId: 'gmail', eventType: 'mail', filters: [] }],
    }), route, { now: 0, timezone: 'UTC' });
    expect(result.automations).toEqual([{ enabled: false, config: expect.objectContaining({ manual: true }) }]);
    expect(result.note).toContain('event gmail/mail');
    // A plugin check decided when it ran: created, but paused for the owner.
    const plugin = convertRoutine(routine({ enabled: true, preRunPlugin: { pluginId: 'x' } as never }), route,
      { now: 0, timezone: 'UTC' });
    expect(plugin.automations[0]?.enabled).toBe(false);
    expect(plugin.note).toContain('plugin check');
    // A routine that posted to a chat says so: its results now stay in the automation's task.
    expect(convertRoutine(routine({ delivery: { kind: 'im', targetId: 'feishu:group' } }), route, { now: 0, timezone: 'UTC' }).note)
      .toContain('feishu:group');
  });
});

describe('buildCarryover', () => {
  it('carries only open work and skips what was finished or deleted', () => {
    const doc = buildCarryover({
      todos: { items: [
        { title: 'Open one', status: 'open', next: { label: 'verify on iPhone' }, createdAt: '2026-11-01T00:00:00Z' },
        { title: 'Deleted one', status: 'open', decision: { kind: 'deleted' } },
        { title: 'Done one', status: 'done' },
      ] },
      workbench: { tasks: { a: { title: 'PR #1', verdict: 'unfinished', next: 'wait CI' }, b: { title: 'PR #2', verdict: 'done' } } },
      workingMemory: { waiting: [{ text: 'owner unlocks Mac' }], corrections: [{ text: 'no rich text by default' }] },
    }, (key) => key.toUpperCase());
    expect(doc).toContain('- 2026-11-01 · Open one — verify on iPhone');
    expect(doc).toContain('- PR #1 — wait CI');
    expect(doc).toContain('## WAITING');
    expect(doc).not.toMatch(/Deleted one|Done one|PR #2|## ROUTINES|## THREADS/);
    expect(buildCarryover({ todos: { items: [{ title: 'x', status: 'done' }] } }, (key) => key)).toBeNull();
  });
});
