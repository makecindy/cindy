import { describe, expect, it } from 'vitest';
import { migrationNativeContext } from '../migrationNativeContext';
const original = '12345678-1234-4234-a234-123456789012';
describe('independent migration context identities', () => {
  it.each(['switched to another agent', '{broken', 'null', '[1]', '"legacy"', ''])('preserves legacy metadata verbatim: %s', raw => {
    expect(migrationNativeContext('migration', [original]).metadata(raw)).toBe(raw);
  });
  it('preserves native fork turn anchors while mapping them to the copied context', () => {
    const copy = migrationNativeContext('migration', [original]);
    const anchor = { agentKind: 'codex', sdkSessionId: original, kind: 'turn', id: 'turn-1' };
    expect(JSON.parse(copy.metadata(JSON.stringify({ nativeForkAnchor: anchor }))!)).toEqual({
      nativeForkAnchor: { ...anchor, sdkSessionId: copy.id(original) },
    });
  });
  it('is stable on retry and different on the next move', () => {
    const first = migrationNativeContext('migration-A', [original]).id(original);
    expect(migrationNativeContext('migration-A', [original]).id(original)).toBe(first);
    expect(migrationNativeContext('migration-B', [original]).id(original)).not.toBe(first);
    expect(first).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-a[a-f0-9]{3}-[a-f0-9]{12}$/);
  });
  it('changes only the Claude envelope identity, preserving message IDs and user content', () => {
    const copy = migrationNativeContext('migration', [original]);
    const row = {
      message: { sessionId: original, content: original },
      sessionId: original,
      uuid: 'message-id',
      parentUuid: 'parent-id',
    };
    const result = JSON.parse(
      copy.transcript(Buffer.from(JSON.stringify(row) + '\n'), 'cc').toString(),
    );
    expect(result).toEqual({ ...row, sessionId: copy.id(original) });
  });
  it('preserves Codex event bytes and offsets outside its session metadata ID', () => {
    const copy = migrationNativeContext('migration', [original]);
    const header = JSON.stringify({
      timestamp: '2026-09-26',
      type: 'session_meta',
      payload: { id: original, cwd: '/source' },
    });
    const event = JSON.stringify({
      type: 'response_item',
      payload: { id: original, content: original },
    });
    const bytes = Buffer.from(header + '\n' + event + '\n');
    const result = copy.transcript(bytes, 'codex');
    expect(result.length).toBe(bytes.length);
    expect(result.toString().split('\n')[1]).toBe(event);
    expect(JSON.parse(result.toString().split('\n')[0]).payload.id).toBe(copy.id(original));
    expect(
      copy.stateRows({
        threads: [{ id: original }],
        threadDynamicTools: [{ thread_id: original, schema: original }],
        threadSpawnEdges: [{ parent_thread_id: original, child_thread_id: 'other' }],
      }),
    ).toEqual({
      threads: [{ id: copy.id(original) }],
      threadDynamicTools: [{ thread_id: copy.id(original), schema: original }],
      threadSpawnEdges: [{ parent_thread_id: copy.id(original), child_thread_id: 'other' }],
    });
  });
});
