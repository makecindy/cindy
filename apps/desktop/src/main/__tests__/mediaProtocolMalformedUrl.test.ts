import { beforeEach, describe, expect, it, vi } from 'vitest';

type ProtocolHandler = (request: Request) => Promise<Response>;

const handle = vi.fn<(scheme: string, handler: ProtocolHandler) => void>();
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
    const handlers = new Map<string, ProtocolHandler>(handle.mock.calls);
    for (const scheme of ['xdt-image', 'xdt-video', 'xdt-model']) {
      const handler = handlers.get(scheme);
      expect(handler).toBeTypeOf('function');
      if (!handler) throw new Error(`missing protocol handler for ${scheme}`);
      await expect(handler(new Request(`${scheme}://session/%E0%A4%A`))).resolves.toMatchObject({ status: 403 });
    }
  });
});
