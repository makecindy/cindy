import type { InstalledGhost } from '../../../shared/ghost.js';
import { deliveryNamespaceFields, installedGhostStoragePart } from '../../../shared/pluginIdentity.js';
import {
  classifyGhostVisibility,
  classifyInstalledGhostVisibility,
  type GhostVisibilityDeps,
} from '../../cindy-brain/ghostVisibility.js';
import type { AuthRecoveryRequest } from './host.js';

interface SessionContext {
  workingDir: string | null;
  remoteHostId: string | null;
}

export interface GithubAuthRecoveryDeps extends GhostVisibilityDeps {
  /** Null while signed out or crossing an owner boundary. */
  ownerKey(): string | null;
  sessionContext(sessionId: string): Promise<SessionContext | null>;
  isTrusted(ghost: InstalledGhost): boolean;
  setupReady(instanceId: string): boolean;
  connected(ghost: InstalledGhost, isCurrent: () => boolean): Promise<boolean>;
}

/** No operations are replayed and no credentials are returned to the requesting process. */
export function createGithubAuthRecovery(deps: GithubAuthRecoveryDeps) {
  return async (request: AuthRecoveryRequest): Promise<string | null> => {
    if (request.asker.program !== 'git' || request.asker.gitOrigin !== 'https://github.com') return null;
    const url = request.prompt.match(/\bhttps?:\/\/[^\s'"]+/i)?.[0];
    try {
      // Also check the prompt: a redirected authentication challenge must not
      // inherit the initial GitHub transport's identity.
      if (!url || new URL(url).origin !== 'https://github.com') return null;
      const owner = deps.ownerKey();
      if (!owner) return null;
      const context = await deps.sessionContext(request.sessionId);
      if (!context?.workingDir || context.remoteHostId || deps.ownerKey() !== owner) return null;
      const visible = classifyGhostVisibility('cindy-github', context.workingDir, deps);
      if (!visible.ok) return null;
      // Snapshot the installation identity before any asynchronous connection probe.
      const ghost = structuredClone(visible.ghost);
      const instanceId = installedGhostStoragePart(ghost);
      const isCurrent = () => {
        if (deps.ownerKey() !== owner) return false;
        const current = classifyInstalledGhostVisibility(ghost, context.workingDir, deps);
        return current.ok && current.ghost.approval.state === 'approved' &&
          deps.isTrusted(current.ghost) && deps.setupReady(instanceId);
      };
      if (ghost.manifest.kind !== 'chip' ||
          !['list_tools', 'call_tool'].every((name) => ghost.manifest.tools?.some((tool) => tool.name === name)) ||
          !isCurrent()) return null;
      if (!await deps.connected(ghost, isCurrent) || !isCurrent()) return null;
      const latest = await deps.sessionContext(request.sessionId);
      if (!latest || latest.remoteHostId || latest.workingDir !== context.workingDir || !isCurrent()) return null;
      const target = JSON.stringify({ ghost_id: ghost.manifest.id, ...deliveryNamespaceFields(ghost) });
      return 'CINDY_AUTH_ALTERNATIVE_AVAILABLE: GitHub is already connected through an available plugin in this task. ' +
        `Call ghost_info(${target}), inspect its operations, and use the plugin when it supports the requested work. ` +
        'Do not ask the user for a GitHub username, password or token to fix this shell-only authentication failure. ' +
        'If the exact operation requires native Git or the user explicitly requested the terminal, retry the command with ' +
        'CINDY_INPUT_HANDOFF_PREFER_TERMINAL=1 to use the existing terminal authentication flow. ' +
        'This guidance does not authorize an operation or supply credentials.';
    } catch {
      // Discovery/probe trouble must not make native Git or the original input
      // flow unusable, and must not leak a remote error body into the helper.
      return null;
    }
  };
}
