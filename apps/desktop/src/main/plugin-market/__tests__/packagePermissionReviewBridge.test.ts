import { describe, expect, it } from 'vitest';

import type { PluginMarketPackageReviewFacts } from '../../../shared/pluginMarket';
import { PluginMarketPackagePermissionReviewBridge } from '../packagePermissionReviewBridge';

const facts: PluginMarketPackageReviewFacts = {
  manifest: {
    schemaVersion: 2,
    id: 'cindy-test',
    name: 'Test Plugin',
    version: '1.0.0',
    kind: 'chip',
    entry: 'main.js',
    slots: ['notify'],
  },
  permissionDiff: null,
  isUpdate: true,
  packageSha256: 'a'.repeat(64),
  installedBaseline: null,
  sourceType: 'server',
};
const ownerStamp = { dataOwnerId: 'owner-a', ownerGeneration: 7 };

describe('PluginMarketPackagePermissionReviewBridge', () => {
  it('only accepts the answer from the requesting window and hides approval bindings', async () => {
    const bridge = new PluginMarketPackagePermissionReviewBridge();
    let request: Parameters<Parameters<typeof bridge.request>[3]>[0] | undefined;
    const decision = bridge.request(7, facts, ownerStamp, (next) => {
      request = next;
      return true;
    });

    expect(request).not.toHaveProperty('packageSha256');
    expect(request).not.toHaveProperty('installedBaseline');
    // 更新语义独立于权限基线：旧安装基线不可读时 diff 可以为 null。
    expect(request).toMatchObject({ isUpdate: true, permissionDiff: null, ownerStamp });
    expect(bridge.resolve(8, request!.requestId, true)).toBe(false);
    expect(bridge.resolve(7, request!.requestId, true)).toBe(true);
    await expect(decision).resolves.toBe(true);
  });

  it('cancels every pending decision when its requester window is destroyed', async () => {
    const bridge = new PluginMarketPackagePermissionReviewBridge();
    const decision = bridge.request(7, facts, ownerStamp, () => true);

    bridge.cancelRequester(7);

    await expect(decision).resolves.toBe(false);
  });

  it('cancels immediately when the request cannot be delivered', async () => {
    const bridge = new PluginMarketPackagePermissionReviewBridge();

    await expect(bridge.request(7, facts, ownerStamp, () => false)).resolves.toBe(false);
  });
});
