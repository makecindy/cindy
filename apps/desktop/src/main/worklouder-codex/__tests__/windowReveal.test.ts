import { describe, expect, it } from 'vitest';

import {
  createWorkLouderCodexWindowRevealGate,
  noteWorkLouderCodexWindowVisibility,
} from '../windowReveal.js';

describe('noteWorkLouderCodexWindowVisibility', () => {
  it('plays the first time the window appears', () => {
    const gate = createWorkLouderCodexWindowRevealGate();

    expect(noteWorkLouderCodexWindowVisibility(gate, true)).toBe(true);
  });

  it('plays only when the window comes back after being hidden', () => {
    const gate = createWorkLouderCodexWindowRevealGate();

    expect(noteWorkLouderCodexWindowVisibility(gate, true)).toBe(true);
    expect(noteWorkLouderCodexWindowVisibility(gate, true)).toBe(false);
    expect(noteWorkLouderCodexWindowVisibility(gate, false)).toBe(false);
    expect(noteWorkLouderCodexWindowVisibility(gate, true)).toBe(true);
  });

  it('does not play again while the window stays visible', () => {
    const gate = createWorkLouderCodexWindowRevealGate();

    noteWorkLouderCodexWindowVisibility(gate, true);
    noteWorkLouderCodexWindowVisibility(gate, false);
    expect(noteWorkLouderCodexWindowVisibility(gate, true)).toBe(true);
    expect(noteWorkLouderCodexWindowVisibility(gate, true)).toBe(false);
  });
});
