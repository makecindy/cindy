/**
 * Unit contract: production parsers/edit/merge protect offline edits and reset tombstones.
 * Existing project-order/voice-dictionary tests do not cover account preferences. Minimum failure:
 * concurrent edits to two keys or an old value arriving after reset; unvalidated settings must be refused.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  editAccountPreferenceState,
  materializeAccountPreferences,
  mergeAccountPreferencesStates,
  normalizeAccountPreferenceValue,
  parseAccountPreferencesState,
  parseAccountPreferencesSyncFrame,
  type AccountPreferencesState,
} from '../accountPreferencesSync.js';

const empty = (): AccountPreferencesState => ({ version: 1, fields: {} });

describe('account preferences sync contract', () => {
  it('converges concurrent independent edits and deterministic same-key conflicts in either direction', () => {
    const a = editAccountPreferenceState(empty(), { key: 'theme', value: 'dark', nodeId: 'a', counter: 0 })!;
    const b = editAccountPreferenceState(empty(), { key: 'language', value: 'ja', nodeId: 'b', counter: 0 })!;
    const ab = mergeAccountPreferencesStates(a.state, b.state);
    expect(ab.state).toEqual(mergeAccountPreferencesStates(b.state, a.state).state);
    expect(materializeAccountPreferences(ab.state)).toEqual({ theme: 'dark', language: 'ja' });
    const concurrent = editAccountPreferenceState(empty(), { key: 'theme', value: 'light', nodeId: 'b', counter: 0 })!;
    const winner = mergeAccountPreferencesStates(a.state, concurrent.state).state;
    expect(winner).toEqual(mergeAccountPreferencesStates(concurrent.state, a.state).state);
    expect(materializeAccountPreferences(winner)).toEqual({ theme: 'light' });
    expect(mergeAccountPreferencesStates(winner, winner).changed).toBe(false);
  });

  it('advances past all observed revisions and keeps resets durable against stale offline replicas', () => {
    const before = editAccountPreferenceState(empty(), { key: 'theme', value: 'dark', nodeId: 'a', counter: 50 })!;
    const reset = editAccountPreferenceState(before.state, { key: 'theme', value: null, nodeId: 'b', counter: 0 })!;
    expect(reset.counter).toBe(52);
    const merged = mergeAccountPreferencesStates(reset.state, before.state);
    expect(merged.changed).toBe(false);
    expect(materializeAccountPreferences(merged.state)).toEqual({ theme: null });
    expect(editAccountPreferenceState(reset.state, { key: 'theme', value: null, nodeId: 'b', counter: 52 })?.changed).toBe(false);
  });

  it('accepts only versioned, bounded whitelist data and canonicalizes task info without reordering it', () => {
    const state = editAccountPreferenceState(empty(), { key: 'language', value: 'ja', nodeId: 'a', counter: 0 })!.state;
    const frame = { version: 1, dataOwnerId: 'owner', state };
    expect(parseAccountPreferencesSyncFrame(frame)?.state).toEqual(state);
    vi.stubGlobal('TextEncoder', undefined);
    try { expect(parseAccountPreferencesSyncFrame(frame)?.state).toEqual(state); }
    finally { vi.unstubAllGlobals(); }
    expect(parseAccountPreferencesSyncFrame({ ...frame, version: 2 })).toBeNull();
    expect(parseAccountPreferencesSyncFrame({ ...frame, credentials: 'never' })).toBeNull();
    expect(parseAccountPreferencesSyncFrame({ ...frame, dataOwnerId: 'x'.repeat(17000) })).toBeNull();
    expect(parseAccountPreferencesState({ version: 1, fields: { apiKey: { value: 'never', counter: 1, nodeId: 'a' } } })).toBeNull();
    expect(parseAccountPreferencesState({ version: 1, fields: { theme: { value: 'dark', counter: -1, nodeId: 'a' } } })).toBeNull();
    expect(normalizeAccountPreferenceValue('cc-agent.sidebar.filter.taskInfo', '[ "cost", "time" ]')).toBe('["cost","time"]');
    expect(normalizeAccountPreferenceValue('cc-agent.sidebar.filter.taskInfo', '["cost","cost"]')).toBeUndefined();
    expect(normalizeAccountPreferenceValue('cc-agent.sidebar.filter.taskInfo', '["credentials"]')).toBeUndefined();
    expect(editAccountPreferenceState(empty(), { key: 'theme', value: 'dark', nodeId: 'a', counter: Number.MAX_SAFE_INTEGER })).toBeNull();
  });
});
