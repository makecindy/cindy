import test from 'node:test';
import assert from 'node:assert/strict';
import { applyLiveSessionSettings } from './session-settings.mjs';

// Unit regression: provider-only edits must change the live route too; unsupported
// controls must fail before the HTTP handler writes a success to the database.
test('provider-only changes retain the model and clear the previous credential route', async () => {
  const calls = [];
  await applyLiveSessionSettings({ setModel: async (...args) => calls.push(args) }, { providerId: null }, { model: 'model-a' });
  assert.deepEqual(calls, [['model-a', { providerId: null }]]);
});

test('unsupported effort, fast and plan changes propagate instead of claiming success', async () => {
  for (const [field, setter, value] of [['effort', 'setEffort', 'high'], ['fastMode', 'setFastMode', true], ['planModeEnabled', 'setPlanMode', true]]) {
    const error = Object.assign(new Error('unsupported'), { name: 'NotSupportedError' });
    await assert.rejects(applyLiveSessionSettings({ [setter]: async () => { throw error; } }, { [field]: value }, {}), error);
  }
});
