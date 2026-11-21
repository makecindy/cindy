import { app, safeStorage } from 'electron';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createNodeFeishuLocalPort } from '@cindy/mcps/feishu-local';
import type { FeishuLocalHostPort } from '@cindy/mcps/feishu-local';
import {
  activeOwnerScopeKey,
  getActiveAppSession,
  isAppSessionBoundaryPending,
  ownerScopedUserDataPath,
} from '../appSessionState.js';
import { getSelfDeviceId } from '../device-link/index.js';
import { resolveGhostAttachmentUrl } from '../mcp-integrations/ghostAttachmentResolve.js';
import { getBotAuthorizationService } from '../maker-ipc/botAuthorizationService.js';

let singleton: FeishuLocalHostPort | null = null;

interface CredentialBinding {
  file: string;
  assertCurrent(): void;
}

interface BoundCredentialAdapter {
  read(): Promise<string | null>;
  write(value: string): Promise<void>;
  assertCurrent(): void;
}

function credentialBinding(): CredentialBinding | null {
  try {
    if (!getActiveAppSession().dataOwnerId || isAppSessionBoundaryPending()) return null;
    const scope = activeOwnerScopeKey();
    return {
      file: ownerScopedUserDataPath('feishu-local-cli', 'credentials.enc'),
      assertCurrent: () => {
        if (isAppSessionBoundaryPending() || activeOwnerScopeKey() !== scope) {
          throw new Error('Credential owner scope changed');
        }
      },
    };
  } catch {
    return null;
  }
}

function bindCredential(): BoundCredentialAdapter | null {
  const binding = credentialBinding();
  if (!binding) return null;
  const { file, assertCurrent } = binding;
  return {
    assertCurrent,
    async read(): Promise<string | null> {
      try {
        assertCurrent();
        const encoded = await fs.readFile(file, 'utf8');
        assertCurrent();
        return safeStorage.decryptString(Buffer.from(encoded, 'base64'));
      } catch {
        return null;
      }
    },
    async write(value: string): Promise<void> {
      if (!safeStorage.isEncryptionAvailable()) throw new Error('safeStorage unavailable');
      assertCurrent();
      await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      assertCurrent();
      const temporary = `${file}.tmp-${randomUUID()}`;
      try {
        await fs.writeFile(temporary, safeStorage.encryptString(value).toString('base64'), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
        assertCurrent();
        await fs.rename(temporary, file);
      } finally {
        await fs.rm(temporary, { force: true }).catch(() => {});
      }
    },
  };
}

async function readCredential(): Promise<string | null> {
  return (await bindCredential()?.read()) ?? null;
}

async function writeCredential(value: string): Promise<void> {
  const bound = bindCredential();
  if (!bound) throw new Error('safeStorage unavailable');
  await bound.write(value);
}

export function getFeishuLocalDesktopPort(): FeishuLocalHostPort {
  if (singleton) return singleton;
  const profileDir = app.getPath('userData');
  singleton = createNodeFeishuLocalPort({
    homeDir: app.getPath('home'),
    profileDir,
    deviceId: () => getSelfDeviceId() ?? 'desktop-local',
    credentials: { read: readCredential, write: writeCredential, bind: bindCredential },
    managedBinaryPath: path.join(profileDir, 'managed-tools', 'lark-cli', 'current', process.platform === 'win32' ? 'lark-cli.exe' : 'lark-cli'),
    resolveManagedImage: async (imageRef) => {
      try {
        const resolved = resolveGhostAttachmentUrl(imageRef);
        if (!resolved?.absPath || !resolved.mimeType.startsWith('image/')) return null;
        return { absPath: resolved.absPath, mimeType: resolved.mimeType };
      } catch {
        return null;
      }
    },
    requestSetup: async ({ sessionId, reauthorize }) => {
      const service = getBotAuthorizationService();
      if (!service || !sessionId) {
        return { ok: false, reasonCode: 'SETUP_UNAVAILABLE', message: 'A native setup card is unavailable for this task.' };
      }
      try {
        const result = await service.request(sessionId, {
          kind: 'host-capability',
          id: 'feishu-local-cli',
          reauthorize: reauthorize === true,
        });
        if (result.ok && result.status === 'already-connected') return { ok: true };
        return {
          ok: false,
          reasonCode: 'SETUP_REQUIRED',
          message: 'Authorization card sent. Complete it in Cindy; no device code or token is exposed in chat.',
        };
      } catch {
        return { ok: false, reasonCode: 'SETUP_UNAVAILABLE', message: 'A native setup card is unavailable for this task.' };
      }
    },
  });
  return singleton;
}
