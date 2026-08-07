import { beforeEach, describe, expect, it, vi } from 'vitest';

const handle = vi.fn();
vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/tmp/cindy-media-protocol-test') },
  protocol: { handle },
}));
vi.mock('../logger', () => ({ createLogger: () => ({ error: vi.fn() }) }));

const { registerImageProtocolHandler } = await import('../imageProtocol');
const { registerVideoProtocolHandler } = await import('../videoProtocol');
const { registerModelProtocolHandler } = await import('../modelProtocol');

describe('media protocol malformed URLs', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns 403 instead of 500 for malformed percent encoding', async () => {
    registerImageProtocolHandler();
    registerVideoProtocolHandler();
    registerModelProtocolHandler();
    const handlers = new Map(handle.mock.calls);
    for (const scheme of ['xdt-image', 'xdt-video', 'xdt-model']) {
      const handler = handlers.get(scheme);
      await expect(handler(new Request(`${scheme}://session/%E0%A4%A`))).resolves.toMatchObject({ status: 403 });
    }
  });
});
