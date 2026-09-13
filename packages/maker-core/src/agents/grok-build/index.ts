/**
 * GrokBuildAgent — Grok Build as a first-class Cindy harness (same bar as Claude Code).
 *
 * Runtime is the Cindy-hosted Pi loop: MCP / Orca / Ghost, rewind / fork / plan /
 * steer, and Cindy xAI · SuperGrok model routing. It is not `grok agent stdio` ACP
 * and does not use a separate grok CLI login.
 *
 * `kind` stays `grok-build` so picker, persistence, and IPC keep a fourth harness.
 */

import type { AgentKind } from '../../types/common.js';
import type { AgentDeps } from '../base-agent.js';
import { PiAgent } from '../pi/index.js';

export class GrokBuildAgent extends PiAgent {
  override readonly kind: AgentKind = 'grok-build';

  constructor(deps: AgentDeps) {
    super(deps);
    // Exclusive Grok chips do not advertise Fast; keep the harness toggle off.
    this.capabilities.hasFastMode = false;
  }
}

export { detectGrokBuildOnPath, probeGrokBuildAcp, resolveGrokBinaryFromPath } from './detect.js';
export type { GrokBuildDetectStatus, GrokBuildProbeResult } from './detect.js';
