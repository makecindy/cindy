import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { expect, it, vi } from 'vitest';

// Execute the production adapter: a second copy of these ordering checks would
// not catch a stale REST response being wired to the live presence handler.
const source = ts.createSourceFile('context.tsx', readFileSync(resolve(process.cwd(), 'src/device-link/DeviceLinkContext.tsx'), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function fixture() {
  let expression: ts.Expression | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isBinaryExpression(node) && node.left.getText(source) === 'rosterConsumerRef.current'
      && ts.isArrowFunction(node.right)) expression = node.right;
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (!expression) throw new Error('Missing roster consumer');
  const client = { getStatus: () => 'online' };
  const bindings = { client, clientRef: { current: client }, connectionEpochRef: { current: 1 },
    presenceAvailabilityEpochsRef: { current: { next: 0, byDevice: new Map<string, number>() } },
    remoteResponseEvidenceEpochs: { next: 0, byDevice: new Map<string, number>() },
    presenceAvailableByDeviceRef: { current: new Map<string, boolean>() },
    presenceUnavailableVerdictsRef: { current: new Map<string, { kind: string }>() },
    applyPresence: vi.fn(),
  };
  const compiled = ts.transpileModule(`const create = ${expression.getText(source)};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const create = new Function(...Object.keys(bindings), `${compiled}\nreturn create;`)(...Object.values(bindings));
  return { ...bindings, apply: create() as (devices: unknown[]) => void };
}
const device = { deviceId: 'host', name: 'Computer', online: false, remoteControlEnabled: true, isSelf: false };

it('seeds an already offline host and does not reset unchanged online links', () => {
  const f = fixture();
  f.apply([device]);
  expect(f.applyPresence).toHaveBeenCalledWith(expect.objectContaining({ deviceId: 'host', online: false }));
  f.applyPresence.mockClear();
  f.presenceAvailableByDeviceRef.current.set('host', true);
  f.apply([{ ...device, online: true }]);
  expect(f.applyPresence).not.toHaveBeenCalled();
});

it('keeps remote-disabled distinct from offline even after a recent response', () => {
  const f = fixture();
  f.presenceAvailableByDeviceRef.current.set('host', false);
  f.presenceUnavailableVerdictsRef.current.set('host', { kind: 'presence' });
  f.remoteResponseEvidenceEpochs.byDevice.set('host', 1);
  f.apply([{ ...device, online: true, remoteControlEnabled: false }]);
  expect(f.applyPresence).toHaveBeenCalledWith(expect.objectContaining({ online: true, remoteControlEnabled: false }));
});

it('rejects stale offline REST evidence after a response, presence update or connection change', () => {
  for (const source of ['response', 'presence', 'connection']) {
    const f = fixture();
    if (source === 'response') f.remoteResponseEvidenceEpochs.byDevice.set('host', 1);
    if (source === 'presence') f.presenceAvailabilityEpochsRef.current.byDevice.set('host', 1);
    if (source === 'connection') f.connectionEpochRef.current++;
    f.apply([device]);
    expect(f.applyPresence).not.toHaveBeenCalled();
  }
});
