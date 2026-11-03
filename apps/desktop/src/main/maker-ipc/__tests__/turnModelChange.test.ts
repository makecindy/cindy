import { describe, expect, it, vi } from 'vitest';
import { recordTurnModelChange, type TurnModelIdentity } from '../turnModelChange';

// Unit: the user's requested change-only separator. No earlier test covered
// actual dispatch attribution, repeated models, or an input removed by /clear.
describe('dispatched model boundaries', () => {
  const previous: TurnModelIdentity = { agentKind: 'codex', model: 'owner-model', providerId: 'account' };
  it.each([
    ['first input', null, previous, false],
    ['same model', previous, previous, false],
    ['different source only', previous, { ...previous, providerId: 'other' }, false],
    ['different model', previous, { ...previous, model: 'automation-model' }, true],
    ['cross engine already has a handoff', previous, { ...previous, agentKind: 'pi' as const }, false],
  ] as const)('%s', async (_label, old, current, visible) => {
    let recorded: TurnModelIdentity | undefined;
    const publish = vi.fn(async () => {});
    await recordTurnModelChange(current, {
      readPrevious: async () => old,
      record: async (value) => { recorded = value; return true; },
      publish,
    });
    expect(recorded).toEqual(current);
    expect(publish.mock.calls).toHaveLength(visible ? 1 : 0);
    if (visible) expect(publish).toHaveBeenCalledWith({
      fromModel: 'owner-model', toModel: 'automation-model', modelOnly: true,
    });
  });
  it('does not publish a separator when its input disappeared before persistence', async () => {
    const publish = vi.fn(async () => {});
    await recordTurnModelChange({ ...previous, model: 'other' }, {
      readPrevious: async () => previous, record: async () => false, publish,
    });
    expect(publish).not.toHaveBeenCalled();
  });
});
