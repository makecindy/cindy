import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-order-store-test-'));

vi.mock('electron', () => ({ app: { getPath: () => '/tmp/never-used-here' } }));
vi.mock('../logger-adapter.js', () => ({
  desktopMakerLogger: { child: () => ({ info: () => {}, warn: () => {}, error: () => {} }) },
}));
vi.mock('../../appSessionState.js', () => ({
  ownerScopedUserDataPath: (name: string) => path.join(tmpDir, name),
}));

const { __testing, readProviderOrder, setProviderOrder } =
  await import('../provider-order-store.js');

afterEach(() => __testing.reset());
afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

describe('provider-order-store', () => {
  it('seeds an empty order with Cindy AI without creating a preference file', () => {
    expect(readProviderOrder()).toEqual(['xd']);
    expect(fs.existsSync(path.join(tmpDir, 'provider-order-prefs.json'))).toBe(false);
  });

  it('appends providers as they first appear and avoids unchanged writes', () => {
    expect(setProviderOrder(['xd', 'openai'])).toBe(true);
    expect(setProviderOrder(['xd', 'openai'])).toBe(false);
    expect(setProviderOrder(['xd', 'openai', 'anthropic'])).toBe(true);
    expect(readProviderOrder()).toEqual(['xd', 'openai', 'anthropic']);
    expect(
      JSON.parse(fs.readFileSync(path.join(tmpDir, 'provider-order-prefs.json'), 'utf8')),
    ).toEqual({ providerOrder: ['xd', 'openai', 'anthropic'] });
  });

  it('reorders visible providers while retaining a currently hidden provider slot', () => {
    setProviderOrder(['xd', 'anthropic', 'openai']);
    setProviderOrder(['openai', 'xd']);
    expect(readProviderOrder()).toEqual(['openai', 'anthropic', 'xd']);
  });

  it('does not reorder an already recorded provider when observing it alone', () => {
    setProviderOrder(['xd', 'custom', 'openai']);
    setProviderOrder(['openai', 'custom', 'xd']);

    expect(setProviderOrder(['custom'])).toBe(false);
    expect(readProviderOrder()).toEqual(['openai', 'custom', 'xd']);
  });
});
