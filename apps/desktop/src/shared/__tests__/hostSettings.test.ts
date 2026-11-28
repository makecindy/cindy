import { describe, expect, it } from 'vitest';
import { normalizeHostSettingsChange } from '../hostSettings.js';

describe('host settings closed mutation grammar', () => {
  it.each([{ harness: ['codex'] }, { harness: { toString: () => 'codex' } }, { harness: null }, { harness: 0 }, { harness: true }])('rejects non-string harness %j', ({ harness }) => {
    expect(() => normalizeHostSettingsChange({ domain: 'newTaskDefaults', set: { harness } })).toThrow('INVALID_SETTINGS_CHANGE');
  });
  it('sorts clear/set, preserves explicit defaults and normalizes only validated primitives', () => {
    expect(normalizeHostSettingsChange({ domain: 'appearance', set: { windowZoom: 1.24, uiFamily: ' Mono ' }, clear: ['codeSize', 'codeSize'] })).toEqual({ domain: 'appearance', set: { uiFamily: 'Mono', windowZoom: 1.2 }, clear: ['codeSize'] });
    expect(normalizeHostSettingsChange({ domain: 'newTaskDefaults', set: { fast: false, harness: 'codex' } }).set).toEqual({ fast: false, harness: 'codex' });
  });
  it.each([
    { domain: 'appearance', set: { uiSize: 11 } },
    { domain: 'appearance', set: { uiSize: 12.5 } },
    { domain: 'appearance', set: { uiFamily: ['Mono'] } },
    { domain: 'databaseWarning', set: { thresholdGiB: 0.1 } },
    { domain: 'databaseWarning', set: { disabled: 'false' } },
    { domain: 'newTaskDefaults', set: { permissionMode: 'bypassPermissions' } },
    { domain: 'newTaskDefaults', set: { providerId: {} } },
    { domain: 'newTaskDefaults', set: { fast: 1 } },
    { domain: 'personalization', set: { userPrompt: 'a'.repeat(8001) } },
    { domain: 'personalization', set: { userPrompt: 'a' }, clear: ['userPrompt'] },
    { domain: 'appearance', clear: ['path'] },
    { domain: 'appearance', set: { uiSize: 16 }, owner: 'other' },
    { domain: 'appearance', set: [] },
    { domain: 'appearance' },
  ])('rejects unsupported or malformed mutations', (input) => {
    expect(() => normalizeHostSettingsChange(input)).toThrow('INVALID_SETTINGS_CHANGE');
  });
});
