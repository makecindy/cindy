// Run with: pnpm exec tsx scripts/codex-stream-benchmark.ts [--extended]
// Synchronous translator cost only: no model/network/UI work or queue retention.
import { performance } from 'node:perf_hooks';
import {
  newCodexRuntimeState,
  translateAgentMessageDelta,
  translateItemNotification,
} from '../packages/maker-core/src/agents/codex/translator.js';
import type { AsyncQueue } from '../packages/maker-core/src/agents/shared/async-queue.js';
import type { AgentEvent } from '../packages/maker-core/src/types/events.js';

const queue = { push: () => {} } as unknown as AsyncQueue<AgentEvent>;
const log = { info() {}, warn() {}, error() {}, debug() {} };
const citation = ':codex-file-citation{path="src/index.ts" line=10}';
const cases = [{ name: 'file citations', chunk: '文'.repeat(20) + citation, snapshotEvery: 0 }];
if (process.argv.includes('--extended')) {
  cases.push(
    { name: 'plain text', chunk: '文'.repeat(69), snapshotEvery: 0 },
    { name: 'file + web citations', chunk: `正文${citation}\uE200cite\uE202turn1search0\uE201`, snapshotEvery: 0 },
    { name: 'file citations + snapshots', chunk: '文'.repeat(20) + citation, snapshotEvery: 32 },
  );
}
console.log(`Node ${process.version}, ${process.platform}/${process.arch}`);
for (const { name, chunk, snapshotEvery } of cases) {
  console.log(`${name}: chunk=${chunk.length} UTF-16 code units`);
  for (const count of [500, 1000, 2000, 4000]) {
    const ctx = { rt: newCodexRuntimeState(), log };
    let snapshot = '';
    const start = performance.now();
    for (let i = 0; i < count; i++) {
      translateAgentMessageDelta({ threadId: 'bench', turnId: 'turn', itemId: 'message', delta: chunk }, queue, ctx);
      if (snapshotEvery) {
        snapshot += chunk;
        if ((i + 1) % snapshotEvery === 0) {
          translateItemNotification('updated', {
            threadId: 'bench', turnId: 'turn', item: { type: 'agentMessage', id: 'message', text: snapshot },
          }, queue, ctx);
        }
      }
    }
    console.log(`${count} deltas, ${count * chunk.length} code units: ${(performance.now() - start).toFixed(2)} ms`);
  }
}
