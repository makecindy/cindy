import { describe, expect, it } from 'vitest';

import { PluginPublisherConfirmBridge } from '../confirmBridge.js';

const facts = {
  orgSlug: 'acme',
  orgName: 'Acme',
  ghostId: 'demo',
  name: 'Demo',
  version: '1.0.0',
  sizeBytes: 12,
};
const ownerStamp = { dataOwnerId: 'owner-a', ownerGeneration: 1 };

describe('PluginPublisherConfirmBridge', () => {
  it('only accepts the requesting window, except broadcast confirms', async () => {
    const bridge = new PluginPublisherConfirmBridge();
    let requestId = '';
    const decision = bridge.request(7, facts, ownerStamp, (request) => {
      requestId = request.requestId;
      expect(request.facts).toEqual(facts);
      return true;
    });
    expect(bridge.resolve(8, requestId, true)).toBe(false);
    expect(bridge.resolve(7, requestId, true)).toBe(true);
    await expect(decision).resolves.toEqual({ confirmed: true });

    const broadcast = bridge.request(0, facts, ownerStamp, (request) => {
      requestId = request.requestId;
      return true;
    });
    expect(bridge.resolve(3, requestId, true)).toBe(true);
    await expect(broadcast).resolves.toEqual({ confirmed: true });
  });

  it('cancels when the request cannot be delivered', async () => {
    const bridge = new PluginPublisherConfirmBridge();
    await expect(bridge.request(7, facts, ownerStamp, () => false)).resolves.toEqual({ confirmed: false });
  });

  it('cancelAll drops broadcast pending confirms', async () => {
    const bridge = new PluginPublisherConfirmBridge();
    const pending = bridge.request(0, facts, ownerStamp, () => true);
    bridge.cancelAll();
    await expect(pending).resolves.toEqual({ confirmed: false });
  });

  it('drops a pending confirm when its transfer is aborted', async () => {
    const bridge = new PluginPublisherConfirmBridge();
    const controller = new AbortController();
    let requestId = '';
    const pending = bridge.request(
      0,
      facts,
      ownerStamp,
      (request) => {
        requestId = request.requestId;
        return true;
      },
      controller.signal,
    );

    controller.abort();

    await expect(pending).resolves.toEqual({ confirmed: false });
    // Excludes leaving an unreachable entry behind after the quota is released.
    expect(bridge.resolve(1, requestId, true)).toBe(false);
  });

  // #1541: a window may only attach an audience when Main let the screen edit it, so a publish
  // whose current audience must be kept ("沿用当前范围") can never be changed from the renderer.
  it('keeps the chosen audience only for an editable, confirmed screen', async () => {
    const bridge = new PluginPublisherConfirmBridge();
    const chosen = { type: 'matchAny' as const, departmentIds: ['d1'] };
    const editable = {
      kind: 'editable' as const, isNew: true, current: { type: 'all' as const },
      initial: { type: 'all' as const }, members: [], unresolved: [],
    };
    const cases = [
      { audience: editable, confirmed: true, expected: { confirmed: true, visibilityAudience: chosen } },
      { audience: editable, confirmed: false, expected: { confirmed: false } },
      { audience: { kind: 'locked' as const }, confirmed: true, expected: { confirmed: true } },
      { audience: { kind: 'denied' as const, reason: 'forbidden' as const }, confirmed: true, expected: { confirmed: true } },
    ];
    for (const { audience, confirmed, expected } of cases) {
      let requestId = '';
      const pending = bridge.request(7, facts, ownerStamp, (request) => {
        requestId = request.requestId;
        expect(request.audience).toEqual(audience);
        return true;
      }, undefined, audience);
      expect(bridge.resolve(7, requestId, confirmed, chosen)).toBe(true);
      await expect(pending).resolves.toEqual(expected);
    }
  });
});
