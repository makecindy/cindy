import { randomUUID } from 'node:crypto';

import type { GhostManifest } from '../../shared/ghost.js';
import { GHOST_CONFIRM_TIMEOUT_MS } from '../../shared/ghost.js';
import { declaredOidcTokenHosts } from './connectionAudienceResolver.js';

export interface ForgeOidcInstallConfirmPush {
  requestId: string;
  ghostId: string;
  ghostName: string;
  hosts: string[];
}

export interface ForgeOidcInstallConfirmFacts {
  ghostId: string;
  ghostName: string;
  hosts: string[];
}

/** 所有明确由 ghost_forge_install 发起的安装都记录作者自测来源。 */
export function forgeInstallOriginForMembership(membershipKind: 'personal' | 'org'): 'agent-forge' {
  void membershipKind;
  return 'agent-forge';
}

/** 只有企业身份安装声明了 oidc-token 的 Forge 包才需要这扇窄确认窗。 */
export function forgeOidcInstallConfirmFacts(
  manifest: GhostManifest,
  membershipKind: 'personal' | 'org',
): ForgeOidcInstallConfirmFacts | null {
  if (membershipKind !== 'org') return null;
  const hosts = declaredOidcTokenHosts(manifest);
  return hosts.length > 0 ? { ghostId: manifest.id, ghostName: manifest.name, hosts } : null;
}

export interface ForgeOidcInstallConfirmBridgeDeps {
  sendToWindow(payload: ForgeOidcInstallConfirmPush): boolean;
  timeoutMs?: number;
  log?: { warn: (message: string, meta?: Record<string, unknown>) => void };
}

export interface ForgeOidcInstallMainWindowSenderDeps<TWindow> {
  getMainWindow(): TWindow | null;
  isTrustedMainWindow(window: TWindow): boolean;
  send(window: TWindow, payload: ForgeOidcInstallConfirmPush): void;
}

/**
 * 只投挂载 ForgeOidcInstallConfirmHost 的主 App 窗口。辅助窗口即使受信、
 * 当前聚焦或排在窗口列表最前，也不能替代主窗口接这条确认请求。
 */
export function createForgeOidcInstallMainWindowSender<TWindow>(
  deps: ForgeOidcInstallMainWindowSenderDeps<TWindow>,
): (payload: ForgeOidcInstallConfirmPush) => boolean {
  return (payload) => {
    const mainWindow = deps.getMainWindow();
    if (!mainWindow || !deps.isTrustedMainWindow(mainWindow)) return false;
    deps.send(mainWindow, payload);
    return true;
  };
}

interface PendingConfirm {
  resolve: (confirmed: boolean) => void;
  timeoutId: ReturnType<typeof setTimeout>;
}

/**
 * Forge 企业身份自测确认的 main ↔ renderer 往返桥。只投一个 Cindy 窗口；
 * 无窗口、超时、畸形回包与边界切换都 fail closed。
 */
export class ForgeOidcInstallConfirmBridge {
  private readonly pending = new Map<string, PendingConfirm>();

  constructor(private readonly deps: ForgeOidcInstallConfirmBridgeDeps) {}

  request(facts: ForgeOidcInstallConfirmFacts): Promise<boolean> {
    const requestId = randomUUID();
    return new Promise<boolean>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.deps.log?.warn('forge OIDC install confirm timed out', {
          ghostId: facts.ghostId,
          requestId,
        });
        this.settle(requestId, false);
      }, this.deps.timeoutMs ?? GHOST_CONFIRM_TIMEOUT_MS);
      this.pending.set(requestId, { resolve, timeoutId });
      if (!this.deps.sendToWindow({ requestId, ...facts })) {
        this.pending.delete(requestId);
        clearTimeout(timeoutId);
        reject(new Error('没有可挂靠的宿主窗口'));
      }
    });
  }

  resolve(requestId: string, confirmed: unknown): boolean {
    if (!this.pending.has(requestId)) return false;
    this.settle(requestId, confirmed === true);
    return true;
  }

  cancelAll(): void {
    for (const requestId of Array.from(this.pending.keys())) this.settle(requestId, false);
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  private settle(requestId: string, confirmed: boolean): void {
    const entry = this.pending.get(requestId);
    if (!entry) return;
    this.pending.delete(requestId);
    clearTimeout(entry.timeoutId);
    entry.resolve(confirmed);
  }
}

let bridgeSingleton: ForgeOidcInstallConfirmBridge | null = null;

export function initForgeOidcInstallConfirmBridge(
  deps: ForgeOidcInstallConfirmBridgeDeps,
): ForgeOidcInstallConfirmBridge {
  bridgeSingleton = new ForgeOidcInstallConfirmBridge(deps);
  return bridgeSingleton;
}

export function getForgeOidcInstallConfirmBridge(): ForgeOidcInstallConfirmBridge | null {
  return bridgeSingleton;
}
