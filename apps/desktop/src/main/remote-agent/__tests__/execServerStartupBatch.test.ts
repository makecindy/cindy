/**
 * Production startup batch: serial manifest probes must become pipelined native RPCs,
 * without treating existing/denied/unknown paths as absent (remote adaptation contract).
 * Existing mirror tests cover static absence, not speculative replies or invalidation.
 * Minimal input: one manifest metadata query plus out-of-order native replies. Unit tier,
 * no filesystem/socket/process; real process timing is in startupProbe.e2e.test.ts.
 * Standalone measured wall time: 265ms.
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

import { createExecServerStartupBatch } from '../host/execServerStartupBatch';

const base = path.resolve('batch-fixture');
const uri = (dir: string, marker = '.codex-plugin') => pathToFileURL(path.join(dir, marker, 'plugin.json')).href;
const query = (id: string | number, target = uri(base), extra = {}) => JSON.stringify({ id, method: 'fs/getMetadata', params: { path: target, ...extra } });
function fixture(shortcut: (data: string) => string | null = () => null) {
  const forwarded: string[] = [];
  const answered: string[] = [];
  const batch = createExecServerStartupBatch({ shortcut, forward: data => forwarded.push(data), answer: data => answered.push(data) });
  const reply = (target: string, value: object) => {
    const request = forwarded.map(data => JSON.parse(data)).find(rpc => rpc.params.path === target);
    expect(request).toBeDefined();
    return batch.response(JSON.stringify({ id: request.id, ...value }));
  };
  return { batch, forwarded, answered, reply };
}

describe('native startup manifest batching', () => {
  it('leaves malformed and unrelated messages to the original transport', () => {
    for (const data of ['null', '{', JSON.stringify({ id: 1, method: 5 }), query(1, 'file://bad-host/path')]) {
      const f = fixture();
      expect(f.batch.request(data)).toBe(false);
      expect(f.forwarded).toEqual([]);
      expect(f.answered).toEqual([]);
    }
  });
  it('pipelines all candidates before receiving a reply and matches out-of-order absence to original ids', () => {
    const f = fixture();
    expect(f.batch.request(query(1))).toBe(true);
    expect(f.forwarded.length).toBeGreaterThan(3);
    expect(f.forwarded.length).toBeLessThanOrEqual(192);
    expect(f.answered).toEqual([]);
    const second = uri(base, '.claude-plugin');
    f.reply(second, { error: { code: -32004, message: 'missing' } });
    expect(f.batch.request(query('second', second))).toBe(true);
    expect(JSON.parse(f.answered[0])).toMatchObject({ id: 'second', error: { code: -32004 } });
    f.reply(uri(base), { error: { code: -32004, message: 'missing' } });
    expect(JSON.parse(f.answered[1])).toMatchObject({ id: 1, error: { code: -32004 } });
    expect(f.batch.response(JSON.stringify({ id: 'unrelated', result: {} }))).toBe(false);
  });

  it.each([
    { result: { isFile: true } },
    { error: { code: -32001, message: 'denied' } },
    { error: { code: -32601, message: 'unsupported' } },
  ])('forwards the original request for existing files and non-NotFound errors: %j', value => {
    const f = fixture();
    const original = query('original');
    f.batch.request(original);
    f.reply(uri(base), value);
    expect(f.forwarded.at(-1)).toBe(original);
    expect(f.answered).toEqual([]);
    expect(f.batch.request(query('again'))).toBe(false);
  });

  it('consumes a large internal error reply and releases the original query', () => {
    const f = fixture();
    const original = query('original');
    expect(f.batch.request(original)).toBe(true);
    // The tunnel permits replies larger than the 16 KiB request optimization budget.
    expect(f.reply(uri(base), { error: { code: -32001, message: 'x'.repeat(20 * 1024) } })).toBe(true);
    expect(f.forwarded.at(-1)).toBe(original);
    expect(f.answered).toEqual([]);
  });

  it('uses the original sandbox and never reuses a result under different permissions or for file content', () => {
    const f = fixture();
    const sandbox = { permissions: 'read-only' };
    f.batch.request(query(1, uri(base), { sandbox }));
    expect(f.forwarded.map(data => JSON.parse(data).params.sandbox)).toEqual(f.forwarded.map(() => sandbox));
    f.reply(uri(base), { error: { code: -32004 } });
    expect(f.batch.request(query(2, uri(base), { sandbox: { permissions: 'other' } }))).toBe(false);
    expect(f.batch.request(JSON.stringify({ id: 3, method: 'fs/readFile', params: { path: uri(base), sandbox } }))).toBe(false);
    expect(f.batch.request(query(4, uri(base), { sandbox }))).toBe(true);
  });

  it.each(['finish', 'fs/writeFile', 'process/start'])('discards negatives and releases held queries on %s, consuming late internal replies', reason => {
    const f = fixture();
    const held = query(1);
    f.batch.request(held);
    const second = uri(base, '.claude-plugin');
    f.reply(second, { error: { code: -32004 } });
    if (reason === 'finish') f.batch.finish();
    else expect(f.batch.request(JSON.stringify({ id: 2, method: reason, params: {} }))).toBe(false);
    expect(f.forwarded.at(-1)).toBe(held);
    expect(f.batch.request(query(3, second))).toBe(false);
    expect(f.reply(uri(base), { error: { code: -32004 } })).toBe(true);
    expect(f.answered).toEqual([]);
  });

  it('does not forward known-absent candidates, and bounds deep ancestry without guessing beyond it', () => {
    const deep = path.join(base, ...Array.from({ length: 80 }, () => 'level'));
    const f = fixture(data => JSON.parse(data).params.path.includes('.cursor-plugin') ? '{}' : null);
    f.batch.request(query(1, uri(deep)));
    expect(f.forwarded).toHaveLength(128);
    expect(f.batch.request(query(2, uri(path.parse(base).root)))).toBe(false);
    expect(f.batch.request(query(3, uri(path.join(base, 'unrelated'))))).toBe(false);
  });
});
