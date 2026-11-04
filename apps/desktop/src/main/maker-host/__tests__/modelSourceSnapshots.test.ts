import { describe, expect, it } from 'vitest';
import { acceptsModelSourceSnapshot, bindModelSourceSnapshot, issueModelSourceSnapshot, modelSourceRequestSignature } from '../model-source-snapshots';

const issue = () => issueModelSourceSnapshot([{ id: 'a/foo', name: 'Foo', discoveredSource: { kind: 'magpie', providerId: 'A' } }], 'pi', 'signature');

describe('model source receipts', () => {
  it('binds new connection sources to the exact outbound request, engine, model ID and returned data', () => {
    const source = issue()[0].discoveredSource!;
    expect(acceptsModelSourceSnapshot('a/foo', source, 'new', 'pi', 'signature')).toBe(true);
    expect(acceptsModelSourceSnapshot('foo', source, 'new', 'pi', 'signature')).toBe(false);
    expect(acceptsModelSourceSnapshot('a/foo', source, 'new', 'codex', 'signature')).toBe(false);
    expect(acceptsModelSourceSnapshot('a/foo', source, 'new', 'pi', 'new-context')).toBe(false);
    expect(acceptsModelSourceSnapshot('a/foo', { ...source, providerId: 'B' }, 'new', 'pi', 'signature')).toBe(false);
  });
  it('rejects receipts after configuration, owner or request generations change, including ABA', () => {
    const rows = issue(); let current = true;
    bindModelSourceSnapshot(rows, 'saved', () => current);
    const source = rows[0].discoveredSource!;
    expect(acceptsModelSourceSnapshot('a/foo', source, 'saved', 'pi')).toBe(true);
    expect(acceptsModelSourceSnapshot('a/foo', source, 'saved', 'pi', 'different-credential')).toBe(false);
    expect(acceptsModelSourceSnapshot('a/foo', { snapshotId: source.snapshotId, providerId: source.providerId, kind: 'magpie' }, 'saved', 'pi', 'signature')).toBe(true);
    expect(acceptsModelSourceSnapshot('a/foo', source, 'other', 'pi')).toBe(false);
    current = false;
    expect(acceptsModelSourceSnapshot('a/foo', source, 'saved', 'pi')).toBe(false);
  });
  it('canonicalizes header casing/order, while binding every endpoint and credential change', () => {
    const sig = (url: string, headers: Record<string, string>) => modelSourceRequestSignature(url, { headers });
    const url = 'https://gateway.test/v1/models';
    expect(sig(url, { Authorization: 'fake-A', 'X-Agent': 'cindy' })).toBe(sig(url, { 'x-agent': 'cindy', authorization: 'fake-A' }));
    expect(sig(url, { Authorization: 'fake-A' })).not.toBe(sig(url, { Authorization: 'fake-B' }));
    expect(sig(url, {})).not.toBe(sig(url + '?account=B', {}));
  });
});
