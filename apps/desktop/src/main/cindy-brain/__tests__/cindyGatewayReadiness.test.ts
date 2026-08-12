/**
 * cindyGatewayReadiness.test.ts — 锁住 XD 网关 endpoint 的运行期就绪判据。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const runtime = vi.hoisted(() => ({
  canUseCindyGateway: true,
  gatewayBaseUrl: 'https://gateway.example',
  appCapabilityReads: 0,
  endpointReads: 0,
}));

vi.mock('../../appCapabilities.js', () => ({
  getAppCapabilities: () => {
    runtime.appCapabilityReads += 1;
    return { canUseCindyGateway: runtime.canUseCindyGateway };
  },
}));

vi.mock('../../model-access/effectiveEndpoint.js', () => ({
  effectiveXdGatewayBaseUrl: () => {
    runtime.endpointReads += 1;
    return runtime.gatewayBaseUrl;
  },
}));

import { isXdGatewayProviderReady } from '../cindyGatewayReadiness';

const XD_CASES: Array<{
  name: string;
  canUseCindyGateway: boolean;
  gatewayBaseUrl: string;
  expected: boolean;
}> = [
  {
    name: '已登录且 endpoint 已下发 → 就绪',
    canUseCindyGateway: true,
    gatewayBaseUrl: 'https://gateway.example',
    expected: true,
  },
  {
    name: '已登录但 endpoint 尚未下发 → 未就绪',
    canUseCindyGateway: true,
    gatewayBaseUrl: '',
    expected: false,
  },
  {
    name: '已登录但 endpoint 仅含空白 → 未就绪',
    canUseCindyGateway: true,
    gatewayBaseUrl: '  \n\t  ',
    expected: false,
  },
  {
    name: '未登录但 endpoint 残留 → 未就绪',
    canUseCindyGateway: false,
    gatewayBaseUrl: 'https://gateway.example',
    expected: false,
  },
];

describe('isXdGatewayProviderReady', () => {
  beforeEach(() => {
    runtime.canUseCindyGateway = true;
    runtime.gatewayBaseUrl = 'https://gateway.example';
    runtime.appCapabilityReads = 0;
    runtime.endpointReads = 0;
  });

  it.each(XD_CASES)('$name', ({ canUseCindyGateway, gatewayBaseUrl, expected }) => {
    runtime.canUseCindyGateway = canUseCindyGateway;
    runtime.gatewayBaseUrl = gatewayBaseUrl;

    expect(isXdGatewayProviderReady('xd')).toBe(expected);
  });

  it('非 XD 供应商不依赖 XD 网关状态', () => {
    runtime.canUseCindyGateway = false;
    runtime.gatewayBaseUrl = '';

    expect(isXdGatewayProviderReady('other')).toBe(true);
    expect(runtime.appCapabilityReads).toBe(0);
    expect(runtime.endpointReads).toBe(0);
  });
});
