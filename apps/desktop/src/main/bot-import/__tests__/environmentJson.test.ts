import { expect, it } from 'vitest';
import { encodeEnvironment, decodeEnvironment } from '../environmentJson.js';
import { serializeImportSnapshotAsync, deserializeImportSnapshotAsync, serializeImportSnapshot } from '../files.js';
it('round-trips large private JSON off the main thread while allowing the event loop to run', async () => {
  const original = { data: 'fixture 文🦊'.repeat(200000), nested: { literal: true, number: 3000 } };
  let ticked = false;
  setImmediate(() => { ticked = true; });
  const encoded = await encodeEnvironment(original, () => {});
  expect(ticked).toBe(true);
  expect(encoded.revision).toMatch(/^[a-f0-9]{64}$/);
  expect(await decodeEnvironment(encoded.text, () => {})).toEqual(original);
});
it('cancels a large conversion on owner loss and never exposes parser data in an error', async () => {
  let current = true;
  const result = encodeEnvironment({ text: 'fixture'.repeat(200000) }, () => { if (!current) throw new Error('owner changed'); });
  current = false;
  await expect(result).rejects.toThrow('owner changed');
  await expect(decodeEnvironment('fixture-secret'.repeat(50000), () => {})).rejects.toThrow('CREDENTIAL_STORAGE_INVALID');
});

it('keeps large resource bytes and old numeric-array checkpoints compatible', async () => {
  const snapshot = { source: { kind: 'hermes' as const, agentId: 'fixture', name: 'Fixture', root: '/fixture', workspace: '/fixture', configFile: '/fixture/config.yaml' }, fingerprint: 'fixture', items: [
    { view: { id: 'skill', name: 'Skill', category: 'skills' as const, selected: true }, files: [{ name: 'resource.bin', bytes: Buffer.alloc(2 * 1024 * 1024, 123), executable: true }] },
  ] };
  for (const text of [await serializeImportSnapshotAsync(snapshot, () => {}), JSON.stringify(snapshot), serializeImportSnapshot(snapshot)]) {
    const restored = await deserializeImportSnapshotAsync(text, () => {});
    expect(restored.source).toEqual(snapshot.source);
    const file = restored.items[0]!.files![0]!;
    expect(file.name).toBe('resource.bin'); expect(file.executable).toBe(true);
    expect(file.bytes.equals(snapshot.items[0]!.files[0]!.bytes)).toBe(true);
  }
});
