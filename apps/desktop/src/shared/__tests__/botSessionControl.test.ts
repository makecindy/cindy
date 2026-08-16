import { describe, expect, it } from 'vitest';

import {
  buildBotSessionControlContext,
  normalizeBotSessionControlMode,
} from '../botSessionControl';

describe('Bot task-control policy', () => {
  it('defaults unknown and legacy Profiles to no cross-task control', () => {
    expect(normalizeBotSessionControlMode(undefined)).toBe('none');
    expect(normalizeBotSessionControlMode('all')).toBe('none');
  });

  it('keeps observation separate from mutation permissions', () => {
    const observe = buildBotSessionControlContext('observe');
    expect(observe).toContain('permits observation only');
    expect(observe).toContain('Do not send, steer, stop, edit, or cancel');

    const coordinate = buildBotSessionControlContext('coordinate');
    expect(coordinate).toContain('permits coordination');
    expect(coordinate).toContain('edit or cancel only queue messages created by this task');
    expect(coordinate).toContain('structured acknowledgement');
  });
});
