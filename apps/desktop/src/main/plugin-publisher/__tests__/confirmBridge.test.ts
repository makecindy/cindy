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
    await expect(decision).resolves.toBe(true);

    const broadcast = bridge.request(0, facts, ownerStamp, (request) => {
      requestId = request.requestId;
      return true;
    });
    expect(bridge.resolve(3, requestId, true)).toBe(true);
    await expect(broadcast).resolves.toBe(true);
  });

  it('cancels when the request cannot be delivered', async () => {
    const bridge = new PluginPublisherConfirmBridge();
    await expect(bridge.request(7, facts, ownerStamp, () => false)).resolves.toBe(false);
  });

  it('cancelAll drops broadcast pending confirms', async () => {
    const bridge = new PluginPublisherConfirmBridge();
    const pending = bridge.request(0, facts, ownerStamp, () => true);
    bridge.cancelAll();
    await expect(pending).resolves.toBe(false);
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

    await expect(pending).resolves.toBe(false);
    // Excludes leaving an unreachable entry behind after the quota is released.
    expect(bridge.resolve(1, requestId, true)).toBe(false);
  });
});
