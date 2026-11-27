/**
 * Interface preferences live in renderer localStorage, which Main cannot read. When another
 * computer asks for a setup snapshot, Main asks one ready app window for the whitelisted keys
 * (same pattern as model favorites). No window, an owner change or a late reply yields null,
 * and the snapshot reports the section as unavailable instead of guessing.
 */
import { randomUUID } from 'node:crypto';
import { ipcMain, type WebContents } from 'electron';

import {
  SETUP_MIGRATION_IPC,
  isPortableRendererPrefKey,
  type SetupMigrationHostReply,
} from '../../shared/setupMigration.js';
import { SETUP_SNAPSHOT_LIMITS } from '@cindy/device-link';
import {
  activeOwnerScopeKey,
  getActiveDataOwnerPushStamp,
  isAppSessionBoundaryPending,
} from '../appSessionState.js';
import { assertTrustedAppRendererEvent } from '../security/trustedAppRenderer.js';

const REPLY_TIMEOUT_MS = 8000;

/** Keeps only whitelisted, bounded string preferences from a renderer reply. */
export function sanitizeRendererPrefs(raw: unknown): Record<string, string> | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out: Record<string, string> = {};
  let count = 0;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (count >= SETUP_SNAPSHOT_LIMITS.rendererPrefs) break;
    if (typeof value !== 'string' || !isPortableRendererPrefKey(key)) continue;
    if (Buffer.byteLength(value, 'utf8') > SETUP_SNAPSHOT_LIMITS.rendererPrefBytes) continue;
    out[key] = value;
    count += 1;
  }
  return out;
}

export interface SetupMigrationRendererHost {
  read(): Promise<Record<string, string> | null>;
}

export function registerSetupMigrationRendererHost(): SetupMigrationRendererHost {
  const hosts = new Map<number, WebContents>();
  const pending = new Map<string, { sender: number; settle(reply?: SetupMigrationHostReply): void }>();
  ipcMain.on(SETUP_MIGRATION_IPC.HOST_READY, (event) => {
    assertTrustedAppRendererEvent(event);
    const id = event.sender.id;
    if (hosts.has(id)) return;
    hosts.set(id, event.sender);
    event.sender.once('destroyed', () => {
      hosts.delete(id);
      for (const request of pending.values()) if (request.sender === id) request.settle();
    });
  });
  ipcMain.on(SETUP_MIGRATION_IPC.HOST_REPLY, (event, reply: SetupMigrationHostReply) => {
    assertTrustedAppRendererEvent(event);
    if (!reply || typeof reply.requestId !== 'string') return;
    const request = pending.get(reply.requestId);
    if (request?.sender === event.sender.id) request.settle(reply);
  });
  return {
    read: () => {
      if (isAppSessionBoundaryPending() || pending.size >= 8) return Promise.resolve(null);
      const host = [...hosts.values()].find((value) => !value.isDestroyed());
      if (!host) return Promise.resolve(null);
      const owner = activeOwnerScopeKey();
      const requestId = randomUUID();
      return new Promise((resolve) => {
        const settle = (reply?: SetupMigrationHostReply) => {
          if (!pending.delete(requestId)) return;
          clearTimeout(timer);
          if (!reply || reply.failed || isAppSessionBoundaryPending() || activeOwnerScopeKey() !== owner) {
            resolve(null);
            return;
          }
          resolve(sanitizeRendererPrefs(reply.prefs));
        };
        const timer = setTimeout(() => settle(), REPLY_TIMEOUT_MS);
        pending.set(requestId, { sender: host.id, settle });
        try {
          host.send(SETUP_MIGRATION_IPC.HOST_REQUEST, {
            requestId,
            ownerStamp: getActiveDataOwnerPushStamp(),
            expiresAt: Date.now() + REPLY_TIMEOUT_MS - 500,
          });
        } catch {
          settle();
        }
      });
    },
  };
}
