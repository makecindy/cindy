import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const constructedDomains: unknown[] = [];

vi.doMock('@larksuiteoapi/node-sdk', () => ({
  Client: class {
    readonly im = {};

    constructor(options: { domain?: unknown }) {
      constructedDomains.push(options.domain);
    }
  },
  Domain: {
    Feishu: 'feishu-domain',
    Lark: 'lark-domain',
  },
}));

let outbound: typeof import('../outbound.js');

beforeAll(async () => {
  outbound = await import('../outbound.js');
});

afterAll(() => {
  outbound.unbindClient();
  vi.doUnmock('@larksuiteoapi/node-sdk');
});

describe('outbound IM service routing', () => {
  it.each([
    ['feishu', 'feishu-domain'],
    ['lark', 'lark-domain'],
  ] as const)('uses the %s API domain', (service, expectedDomain) => {
    outbound.bindClient({
      appId: 'cli_service_test',
      appSecret: 'secret',
      service,
    });

    expect(constructedDomains.at(-1)).toBe(expectedDomain);
  });
});
