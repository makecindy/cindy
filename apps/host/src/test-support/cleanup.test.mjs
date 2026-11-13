// Unit: lifoCleanup runs every registered step, last registered first, and reports the first
// failure only after the rest have run. No files or processes; the test context is a stand-in.
import test from 'node:test';
import assert from 'node:assert/strict';
import { lifoCleanup } from './cleanup.mjs';

test('cleanup steps run last-in first-out, each one even after a failure, and the first failure to occur is reported after all of them', async () => {
  const hooks = [];
  const context = { name: 'fixture', after: hook => hooks.push(hook), diagnostic() { return this.name; } };
  const t = lifoCleanup(context);
  const ran = [];
  t.after(() => { ran.push('remove directory'); });
  t.after(() => { ran.push('close server'); throw new Error('close server failed'); });
  t.after(async () => { ran.push('close database'); throw new Error('close database failed'); });
  t.after(() => { ran.push('stop runtime'); });
  // One hook on the real context; other properties and methods are the context's own.
  assert.equal(hooks.length, 1);
  assert.equal(t.name, 'fixture');
  assert.equal(t.diagnostic(), 'fixture');
  // close database runs before close server, so its failure is the one reported.
  await assert.rejects(hooks[0](), /close database failed/);
  assert.deepEqual(ran, ['stop runtime', 'close database', 'close server', 'remove directory']);
});
