import path from 'node:path';
import { createNodeFeishuLocalPort } from '@cindy/mcps/feishu-local';
import type { FeishuLocalHostPort, FeishuLocalSetupInput } from '@cindy/mcps/feishu-local';
import { createCredentialStore } from '../credentials/store.mjs';
import { hostBlobStore } from '../media-store.js';
import { createGhostAttachmentResolver } from '../../../desktop/src/main/mcp-integrations/ghostAttachmentResolveCore.js';
import { createImageCacheStore } from '../../../desktop/src/main/imageCacheStore.js';
import { ownerScopedPath } from '../../../desktop/src/main/dataOwnerPath.js';
import {
  createFeishuLocalHostSetupAdapter,
  type HostConfirmations,
  type SetupResult,
} from './setupAdapter.js';

interface HostPortOptions {
  profileDir: string;
  ownerId?: string;
  deviceId?(): string;
  confirmations?: HostConfirmations;
  current?(): boolean;
  ownerScope?(): string;
  t?(key: string): string;
}

interface BoundCredentialAdapter {
  read(): Promise<string | null>;
  write(value: string): Promise<void>;
  assertCurrent(): void;
}

const CREDENTIAL_KEY = 'feishu_local_cli_profile_v1';

function setupUnavailable(): SetupResult {
  return { ok: false, reasonCode: 'SETUP_UNAVAILABLE', message: 'A native setup card is unavailable in this host.' };
}

export function createFeishuLocalHostPort(options: HostPortOptions): FeishuLocalHostPort {
  const credentialDir = ownerScopedPath(options.profileDir, options.ownerId ?? 'local', 'feishu-local-cli');
  let storePromise: ReturnType<typeof createCredentialStore> | null = null;
  const getStore = () => {
    if (!storePromise) {
      const pending = createCredentialStore({ userDataDir: credentialDir });
      // The Host may assemble providers before its credential identity exists.
      // Mark the lazy rejection handled; individual reads/writes still fail closed.
      pending.catch(() => {});
      storePromise = pending;
    }
    return storePromise;
  };
  const resolveImageUrl = createGhostAttachmentResolver(hostBlobStore, createImageCacheStore(() => options.profileDir));
  const homeDir = process.env.HOME ?? process.env.USERPROFILE ?? options.profileDir;

  function bindCredential(): BoundCredentialAdapter | null {
    if (!options.current?.() || !options.ownerScope) return null;
    let scope: string;
    try {
      scope = options.ownerScope();
    } catch {
      return null;
    }
    const assertCurrent = () => {
      if (!options.current?.()) throw new Error('OWNER_SCOPE_CHANGED');
      try {
        if (options.ownerScope?.() !== scope) throw new Error('OWNER_SCOPE_CHANGED');
      } catch {
        throw new Error('OWNER_SCOPE_CHANGED');
      }
    };
    return {
      assertCurrent,
      async read(): Promise<string | null> {
        assertCurrent();
        const store = await getStore();
        assertCurrent();
        return store.read(CREDENTIAL_KEY);
      },
      async write(value: string): Promise<void> {
        assertCurrent();
        const store = await getStore();
        assertCurrent();
        store.write(CREDENTIAL_KEY, value);
        assertCurrent();
      },
    };
  }

  const credentials = {
    async read(): Promise<string | null> {
      return (await bindCredential()?.read()) ?? null;
    },
    async write(value: string): Promise<void> {
      const bound = bindCredential();
      if (!bound) throw new Error('OWNER_SCOPE_CHANGED');
      await bound.write(value);
    },
    bind: bindCredential,
  };

  let setupAdapter: ((input: FeishuLocalSetupInput) => Promise<SetupResult>) | undefined;
  const port = createNodeFeishuLocalPort({
    homeDir,
    profileDir: options.profileDir,
    deviceId: () => options.deviceId?.() ?? 'node-host',
    credentials,
    managedBinaryPath: path.join(options.profileDir, 'managed-tools', 'lark-cli', 'current', process.platform === 'win32' ? 'lark-cli.exe' : 'lark-cli'),
    resolveManagedImage: async (imageRef) => {
      try {
        const resolved = resolveImageUrl(imageRef);
        if (!resolved?.absPath || !resolved.mimeType.startsWith('image/')) return null;
        return { absPath: resolved.absPath, mimeType: resolved.mimeType };
      } catch {
        return null;
      }
    },
    requestSetup: async (input) => {
      if (!setupAdapter) return setupUnavailable();
      return setupAdapter(input);
    },
  });
  if (options.confirmations && options.current && options.ownerScope) {
    setupAdapter = createFeishuLocalHostSetupAdapter({
      port,
      confirmations: options.confirmations,
      current: options.current,
      ownerScope: options.ownerScope,
      t: options.t ?? (key => key),
    });
  }
  return port;
}
