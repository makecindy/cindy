import { afterEach, describe, expect, it, vi } from 'vitest';
const fixture = vi.hoisted(() => ({ packaged: true, exists: vi.fn() }));
vi.mock('../../authManager.js', () => ({ getAccessToken: vi.fn() }));
vi.mock('electron', () => ({ app: { get isPackaged() { return fixture.packaged; }, getPath: () => '/isolated' } }));
vi.mock('node:fs', () => ({ existsSync: fixture.exists, readFileSync: vi.fn(() => '{"baseUrl":"https://example.com","token":"test"}') }));
vi.mock('../botGroupChatService.js', () => ({ readPersistedReplyText: vi.fn() }));
vi.mock('../../localDb/client/current.js', () => ({ getDbClient: vi.fn() }));
import { withChatServerDev } from '../chatServerDev.js';
import type { BotGroupChatService, BotGroupChatServiceDeps } from '../botGroupChatService.js';

describe('Chat Server local integration isolation', () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });
  const local = {} as BotGroupChatService;
  const deps = {} as BotGroupChatServiceDeps;
  it('does not read fixture files in a packaged application', () => {
    fixture.packaged = true; vi.stubEnv('XDT_ISOLATED', '1');
    expect(withChatServerDev(local, deps)).toBe(local);
    expect(fixture.exists).not.toHaveBeenCalled();
  });
  it('does not read fixture files for a shared DEV profile', () => {
    fixture.packaged = false; vi.stubEnv('XDT_ISOLATED', '0');
    expect(withChatServerDev(local, deps)).toBe(local);
    expect(fixture.exists).not.toHaveBeenCalled();
  });
  it('keeps normal group behavior when the isolated profile has no fixture', () => {
    fixture.packaged = false; vi.stubEnv('XDT_ISOLATED', '1'); fixture.exists.mockReturnValue(false);
    expect(withChatServerDev(local, deps)).toBe(local);
  });
  it('refuses a fixture that targets an external server before network or runtime work', () => {
    fixture.packaged = false; vi.stubEnv('XDT_ISOLATED', '1'); fixture.exists.mockReturnValue(true);
    expect(() => withChatServerDev(local, deps)).toThrow();
  });
});
