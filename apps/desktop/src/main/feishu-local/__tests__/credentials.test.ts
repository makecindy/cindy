import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  root: '',
  session: { mode: 'local', dataOwnerId: 'owner-a', generation: 1 } as {
    mode: 'signed-out' | 'local' | 'cloud';
    dataOwnerId: string | null;
    generation: number;
  },
  boundaryPending: false,
  portOptions: null as null | {
    credentials: {
      read(): Promise<string | null>;
      write(value: string): Promise<void>;
      bind?(): {
        read(): Promise<string | null>;
        write(value: string): Promise<void>;
        assertCurrent(): void;
      } | null;
    };
  },
}));

mocks.root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-feishu-local-credentials-'));

vi.mock('electron', () => ({
  app: { getPath: (kind: string) => kind === 'home' ? path.join(mocks.root, 'home') : mocks.root },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(`encrypted:${value}`, 'utf8'),
    decryptString: (value: Buffer) => {
      const raw = value.toString('utf8');
      if (raw === 'corrupt') throw new Error('cannot decrypt');
      return raw.replace(/^encrypted:/, '');
    },
  },
}));

vi.mock('../../appSessionState.js', () => ({
  getActiveAppSession: () => ({ ...mocks.session }),
  activeOwnerScopeKey: () => `${mocks.session.dataOwnerId ?? 'none'}:${mocks.session.generation}`,
  isAppSessionBoundaryPending: () => mocks.boundaryPending,
  ownerScopedUserDataPath: (...parts: string[]) => {
    const owner = mocks.session.dataOwnerId;
    return owner
      ? path.join(mocks.root, 'owners', `key-${owner}`, ...parts)
      : path.join(mocks.root, 'no-owner', ...parts);
  },
}));

vi.mock('@cindy/mcps/feishu-local', () => ({
  createNodeFeishuLocalPort: (options: typeof mocks.portOptions) => {
    mocks.portOptions = options;
    return {} as never;
  },
}));

vi.mock('../../device-link/index.js', () => ({ getSelfDeviceId: () => 'device-fixture' }));
vi.mock('../../mcp-integrations/ghostAttachmentResolve.js', () => ({ resolveGhostAttachmentUrl: () => null }));
vi.mock('../../maker-ipc/botAuthorizationService.js', () => ({ getBotAuthorizationService: () => null }));

import { getFeishuLocalDesktopPort } from '../desktopPort.js';

function credentialFile(owner: string): string {
  return path.join(mocks.root, 'owners', `key-${owner}`, 'feishu-local-cli', 'credentials.enc');
}

afterAll(() => {
  fs.rmSync(mocks.root, { recursive: true, force: true });
});

describe('Feishu local CLI Desktop credentials', () => {
  it('binds ciphertext to the committed owner and drops stale queued writes', async () => {
    getFeishuLocalDesktopPort();
    const credentials = mocks.portOptions!.credentials;
    const boundA = credentials.bind!();
    expect(boundA).not.toBeNull();
    await boundA!.write('fixture-archive-A');

    const fileA = credentialFile('owner-a');
    expect(fs.existsSync(fileA)).toBe(true);
    expect(fs.existsSync(path.join(mocks.root, 'feishu-local-cli', 'credentials.enc'))).toBe(false);
    expect(fs.readFileSync(fileA, 'utf8')).not.toContain('fixture-archive-A');
    expect(await credentials.read()).toBe('fixture-archive-A');

    mocks.session = { mode: 'local', dataOwnerId: 'owner-b', generation: 2 };
    const fileB = credentialFile('owner-b');
    expect(await credentials.read()).toBeNull();
    expect(fs.existsSync(fileB)).toBe(false);
    await expect(boundA!.write('fixture-stale-A')).rejects.toThrow();
    expect(fs.existsSync(fileB)).toBe(false);

    mocks.session = { mode: 'local', dataOwnerId: 'owner-a', generation: 3 };
    expect(await credentials.read()).toBe('fixture-archive-A');
    await expect(boundA!.write('fixture-stale-A')).rejects.toThrow();
    expect(await credentials.read()).toBe('fixture-archive-A');

    mocks.boundaryPending = true;
    expect(credentials.bind!()).toBeNull();
    expect(await credentials.read()).toBeNull();
    await expect(credentials.write('fixture-boundary')).rejects.toThrow();
    mocks.session = { mode: 'signed-out', dataOwnerId: null, generation: 4 };
    mocks.boundaryPending = false;
    expect(credentials.bind!()).toBeNull();
    expect(fs.existsSync(path.join(mocks.root, 'no-owner', 'feishu-local-cli', 'credentials.enc'))).toBe(false);
  });
});
