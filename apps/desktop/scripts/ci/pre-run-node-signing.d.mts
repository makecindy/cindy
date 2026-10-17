import type { execFileSync } from 'node:child_process';

/** Signs only the target Node; executed is false for cross-architecture builds. */
export function signPreRunNode(tools: string, arch: string, options?: {
  identity?: string;
  timestamp?: boolean;
  run?: typeof execFileSync;
}): { node: string; executed: boolean };
