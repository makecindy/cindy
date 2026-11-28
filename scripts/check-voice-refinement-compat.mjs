// Run with vite-node so this uses the same TS request builder as the clients.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { DictationRefiner } from '../packages/voice-input-core/src/DictationRefiner.ts';

let request;
const refiner = new DictationRefiner({
  model: 'compatibility-check',
  client: {
    async requestJson(input) {
      request = input;
      return { text: '测试。' };
    },
  },
});
await refiner.refine({ text: '测试', runId: 'compatibility-check', segmentIds: [] });
assert.equal(request.schemaName, 'dictation_refinement');
assert.equal(request.system, refiner.buildWarmupRequest().system);
const hash = createHash('sha256').update(request.system).digest('hex');

for (const file of ['config/endpoint.global.json', 'config/endpoint.json']) {
  const { voiceApiBaseUrl } = JSON.parse(readFileSync(file, 'utf8'));
  const url = new URL('/api/voice/compatibility/dictation-refinement/' + hash, voiceApiBaseUrl);
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
    assert.equal(response.status, 200, 'HTTP ' + response.status);
    assert.equal((await response.json()).supported, true, 'Digest missing from the effective allowlist');
    console.log(file, request.user.promptVersion, hash, 'accepted');
  } catch (error) {
    console.error(file, request.user.promptVersion, hash, error.message);
    process.exitCode = 1;
  }
}
