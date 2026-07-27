import { describe, expect, it } from 'vitest';
import { applyCodexPlanSnapshotOnDone } from '../messageRender.js';

function planMessage(id: string, plan: unknown) {
  return {
    id,
    clientId: id,
    role: 'tool_use',
    toolName: 'update_plan',
    toolUseId: id,
    toolInput: { explanation: 'keep', plan },
    content: {
      toolUseId: id,
      toolName: 'update_plan',
      input: { explanation: 'keep', plan },
    },
  };
}

describe('applyCodexPlanSnapshotOnDone', () => {
  it('applies the terminal snapshot only to the matching turn plan row', () => {
    const older = planMessage('plan:old', [{ step: 'Old', status: 'in_progress' }]);
    const latest = planMessage('plan:new', [
      { step: 'Inspect', status: 'completed' },
      { step: 'Patch', status: 'in_progress' },
    ]);
    const snapshot = [
      { step: 'Inspect', status: 'completed' },
      { step: 'Patch', status: 'completed' },
    ];

    const result = applyCodexPlanSnapshotOnDone([older, latest], snapshot, 'new');

    expect(result).toMatchObject({ changed: true, toolUseId: 'plan:new' });
    expect(result.messages[0]).toBe(older);
    expect(result.messages[1]).toMatchObject({
      toolInput: { explanation: 'keep', plan: snapshot },
      content: { input: { explanation: 'keep', plan: snapshot } },
    });
  });

  it('does not update an earlier turn when the matching plan row is missing', () => {
    const old = planMessage('plan:old', [{ step: 'Old', status: 'in_progress' }]);
    const messages = [old];

    expect(applyCodexPlanSnapshotOnDone(
      messages,
      [{ step: 'New', status: 'completed' }],
      'new',
    )).toEqual({ messages, changed: false, toolUseId: null });
  });

  it('is idempotent across all snapshot fields', () => {
    const snapshot = [{ step: 'Done', status: 'completed', description: 'final details' }];
    const message = planMessage('plan:done', snapshot);
    const messages = [message];

    expect(applyCodexPlanSnapshotOnDone(messages, snapshot, 'done')).toEqual({
      messages,
      changed: false,
      toolUseId: 'plan:done',
    });
    expect(applyCodexPlanSnapshotOnDone(
      messages,
      [{ step: 'Done', status: 'completed', description: 'updated details' }],
      'done',
    ).changed).toBe(true);
  });

  it('applies an authoritative empty terminal snapshot', () => {
    const message = planMessage('plan:old', [{ step: 'Old', status: 'in_progress' }]);
    const result = applyCodexPlanSnapshotOnDone([message], [], 'old');

    expect(result.changed).toBe(true);
    expect(result.messages[0]).toMatchObject({
      toolInput: { plan: [] },
      content: { input: { plan: [] } },
    });
  });

  it('does nothing when task_complete has no plan snapshot', () => {
    const message = planMessage('plan:old', [{ step: 'Old', status: 'in_progress' }]);
    const messages = [message];

    expect(applyCodexPlanSnapshotOnDone(messages, null, 'old')).toEqual({
      messages,
      changed: false,
      toolUseId: null,
    });
  });

  it('marks the matching plan complete when a successful turn has no final snapshot', () => {
    const message = planMessage('plan:done', [
      { step: 'Inspect', status: 'in_progress' },
      { step: 'Patch', status: 'pending' },
    ]);
    const result = applyCodexPlanSnapshotOnDone(
      [message],
      null,
      'done',
      'completed',
    );

    expect(result.changed).toBe(true);
    expect(result.toolUseId).toBe('plan:done');
    expect(result.messages[0]).toMatchObject({
      toolInput: {
        plan: [
          { step: 'Inspect', status: 'completed' },
          { step: 'Patch', status: 'completed' },
        ],
      },
      content: {
        input: {
          plan: [
            { step: 'Inspect', status: 'completed' },
            { step: 'Patch', status: 'completed' },
          ],
        },
      },
    });
  });

  it('treats an unfinished done snapshot as cached progress for a successful turn', () => {
    const message = planMessage('plan:done', [
      { step: 'Inspect', status: 'in_progress' },
      { step: 'Patch', status: 'pending' },
    ]);
    const cachedProgress = [
      { step: 'Inspect', status: 'completed', description: 'kept from latest update' },
      { step: 'Patch', status: 'in_progress' },
    ];

    const result = applyCodexPlanSnapshotOnDone(
      [message],
      cachedProgress,
      'done',
      'completed',
    );

    expect(result.changed).toBe(true);
    expect(result.messages[0]).toMatchObject({
      toolInput: {
        plan: [
          { step: 'Inspect', status: 'completed', description: 'kept from latest update' },
          { step: 'Patch', status: 'completed' },
        ],
      },
    });
  });

  it('does not infer completion without a matching turn id', () => {
    const message = planMessage('plan:unrelated', [
      { step: 'Inspect', status: 'in_progress' },
    ]);
    const messages = [message];

    expect(applyCodexPlanSnapshotOnDone(
      messages,
      null,
      null,
      'completed',
    )).toEqual({ messages, changed: false, toolUseId: null });
  });

  it('does not infer completion for a failed or interrupted turn', () => {
    const message = planMessage('plan:stopped', [{ step: 'Inspect', status: 'in_progress' }]);
    const messages = [message];

    expect(applyCodexPlanSnapshotOnDone(messages, null, 'stopped', 'interrupted')).toEqual({
      messages,
      changed: false,
      toolUseId: null,
    });
  });
});
