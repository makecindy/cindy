import { describe, expect, it } from 'vitest';
import { collectPluginUiTurnAnchors } from './messageRender.js';

// Public turn targets use the existing user boundary, never an index or a
// guessed identity when history starts inside a turn.
describe('plugin UI turn anchors', () => {
  it('keeps steer/continuations with the loaded user and leaves unanchored history alone', () => {
    const anchors = collectPluginUiTurnAnchors([
      { role: 'assistant', clientId: 'orphan' },
      { role: 'user', clientId: 'user-1' }, { role: 'assistant', clientId: 'a' },
      { role: 'user', clientId: 'steer', delivery: 'steer' }, { role: 'assistant', clientId: 'b' },
      { role: 'user', clientId: 'recovery', isSyntheticTrigger: true }, { role: 'assistant', clientId: 'c' },
      { role: 'user', clientId: 'user-2' }, { role: 'assistant', clientId: 'd' },
    ]);
    expect([...anchors]).toEqual([['a', 'user-1'], ['b', 'user-1'], ['c', 'user-1'], ['d', 'user-2']]);
  });
});
