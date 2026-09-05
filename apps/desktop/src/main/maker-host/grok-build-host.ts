/**
 * Grok Build desktop host — Cindy-hosted harness (same loop as Pi / bar as Claude Code).
 *
 * Registration follows the Cindy Pi runtime, not PATH `grok`. Auth is SuperGrok /
 * Cindy gateway via `desktopPiAuthAdapter`. Sessions live in a sibling agent-home
 * so Pi JSONL is not mixed.
 */

import path from 'node:path';
import { app } from 'electron';

import { GrokBuildAgent } from '@cindy/maker-core/grok-build';
import type { Logger } from '@cindy/maker-core';

import { buildDesktopPiLoopDeps, type BuildPiAgentOpts } from './pi-host.js';

function createLogger(base: Logger): Logger {
  return base.child('grok-build-host');
}

export function resolveGrokBuildAgentHome(remoteHostId?: string): string {
  if (remoteHostId) return '$HOME/.xdt-server/v1/grok-build-agent-home';
  return path.join(app.getPath('userData'), 'grok-build-agent-home');
}

export function buildGrokBuildAgent(opts: BuildPiAgentOpts): GrokBuildAgent | null {
  const log = createLogger(opts.logger);
  const deps = buildDesktopPiLoopDeps({
    ...opts,
    logger: log,
    resolvePiAgentHome: opts.resolvePiAgentHome ?? resolveGrokBuildAgentHome,
  });
  if (!deps) {
    log.info('Cindy hosted loop unavailable; grok-build harness disabled for this launch');
    return null;
  }
  log.info('grok-build harness enabled (Cindy hosted loop)', {
    binaryPath: deps.binaryPath,
  });
  return new GrokBuildAgent(deps);
}
