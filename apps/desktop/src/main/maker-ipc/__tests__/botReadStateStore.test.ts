/**
 * The host read ledger merges reports from this computer's windows, the phone and other Macs.
 * Pure kernels only (the persisted layer is electron-store): reports arrive out of order and a
 * device that never saw a companion seeds it, so neither may rewind a position another advanced.
 */

import { expect, it, vi } from 'vitest';
const config = vi.hoisted(() => ({ data: {} as Record<string, unknown>, fail: false }));
vi.mock('../../appSessionState.js', () => ({ ownerScopedUserDataPath: () => '/unused/read-ledger-test' }));
vi.mock('electron-store', () => ({ default: class {
  get(key: string, fallback?: unknown) { return config.data[key] ?? fallback; }
  set(value: Record<string, unknown>) {
    if (config.fail) throw new Error('write failed');
    config.data = { ...config.data, ...structuredClone(value) };
  }
} }));

import { applyBotReadPositions, normalizeBotReadState, pruneBotReadPositions, seedBotReadPositions, markBotReadPositions, loadBotReadState, loadAcknowledgedBotReadState, onBotReadStateChanged } from '../botReadStateStore';

it('only moves positions forward and lets a seed fill only a missing position', () => {
  const current = { 'bot-1': 200, 'group:g': 100 };
  expect(applyBotReadPositions(current, { 'bot-1': 150, 'group:g': 300, 'bot-2': 50 }, 'mark')).toEqual({
    next: { 'bot-1': 200, 'group:g': 300, 'bot-2': 50 }, changed: ['group:g', 'bot-2'],
  });
  // A phone that just met bot-1 seeds "now"; the computer's older read position stays.
  expect(applyBotReadPositions(current, { 'bot-1': 900, 'thread:s': 400 }, 'seed')).toEqual({
    next: { 'bot-1': 200, 'group:g': 100, 'thread:s': 400 }, changed: ['thread:s'],
  });
  expect(applyBotReadPositions(current, { 'bot-1': 100 }, 'mark').next).toBe(current);
});

it('drops malformed reports without touching the rest', () => {
  expect(normalizeBotReadState({ 'bot-1': 10.7, 'bad id': 5, 'bot-2': -1, 'bot-3': Number.NaN, 'group:': 3, 'thread:t': '9' }))
    .toEqual({ 'bot-1': 10 });
});

it('prunes deleted companions and local groups only when that kind is listed, never topics', () => {
  const current = { 'bot-1': 1, 'bot-gone': 2, 'group:g': 3, 'group:gone': 4, 'thread:t': 5 };
  expect(pruneBotReadPositions(current, { botIds: ['bot-1'] })).toEqual({
    next: { 'bot-1': 1, 'group:g': 3, 'group:gone': 4, 'thread:t': 5 }, changed: ['bot-gone'],
  });
  expect(pruneBotReadPositions(current, { groupIds: ['g'] }).changed).toEqual(['group:gone']);
});

// Actual persisted API with a minimal atomic config get/set fake, not a merge copy.
// Protects the merge with local read positions: seed != ack, and old ledgers remain readable.
it('preserves legacy acknowledgements but never promotes new seeds, including after failed writes', () => {
  config.data = { positions: { legacy: 90 } }; config.fail = false;
  const changed = vi.fn(); const off = onBotReadStateChanged(changed);
  try {
    seedBotReadPositions({ fresh: 200 });
    expect(loadBotReadState()).toEqual({ legacy: 90, fresh: 200 });
    expect(loadAcknowledgedBotReadState()).toEqual({ legacy: 90 });
    // A real read below an automatic seed remains a distinct user intention.
    markBotReadPositions({ fresh: 150 });
    expect(loadAcknowledgedBotReadState()).toEqual({ legacy: 90, fresh: 150 });
    expect(loadBotReadState().fresh).toBe(200); // upstream scalar contract retained
    changed.mockClear(); config.fail = true;
    expect(() => markBotReadPositions({ fresh: 300 })).toThrow('write failed');
    expect(loadAcknowledgedBotReadState().fresh).toBe(150);
    expect(changed).not.toHaveBeenCalled();
  } finally { config.fail = false; off(); }
});
