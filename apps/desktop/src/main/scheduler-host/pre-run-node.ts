import { app } from 'electron';
import { randomUUID } from 'node:crypto';
import { accessSync, constants, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** Private dependency injection for real-runtime tests, never persisted as config. */
export interface PreRunNodeRuntime { node: string; supervisor: string; client: string; }
/** Only the native supervisor writes this channel; shell/Node never inherit it. */
export interface PreRunNodeReport {
  version: 1; entered: boolean; completed: number; nodeExit: number; shellExit: number; valid: boolean;
}
export function preRunNodeRuntime(): PreRunNodeRuntime {
  const resources = app.isPackaged ? process.resourcesPath : path.join(app.getAppPath(), 'resources');
  const root = path.join(resources, 'tools', 'pre-run-node', process.platform + '-' + process.arch);
  return {
    node: path.join(root, process.platform === 'win32' ? 'node.exe' : 'node'),
    supervisor: path.join(root, process.platform === 'win32' ? 'supervisor.exe' : 'supervisor'),
    client: path.join(root, 'gate-client.cjs'),
  };
}
/** Missing assets fail closed; schedule firing never installs a runtime. */
export function preparePreRunNode(runtime: PreRunNodeRuntime = preRunNodeRuntime()): {
  runtime: PreRunNodeRuntime; env: Record<string, string>; close(): void;
} {
  for (const file of [runtime.node, runtime.supervisor]) accessSync(file, constants.X_OK);
  accessSync(runtime.client, constants.R_OK);
  const nonce = randomUUID();
  let directory: string | undefined;
  let endpoint: string;
  if (process.platform === 'win32') endpoint = '\\\\.\\pipe\\cindy-pre-run-node-' + nonce;
  else {
    directory = mkdtempSync(path.join(os.tmpdir(), 'cindy-pre-run-node-'));
    endpoint = path.join(directory, 'gate.sock');
    if (Buffer.byteLength(endpoint) > 103) {
      rmSync(directory, { recursive: true, force: true });
      // AF_UNIX limits the supplied bytes, not the canonical /tmp target.
      directory = mkdtempSync(path.join('/tmp', 'cindy-pre-run-socket-'));
      endpoint = path.join(directory, 'gate.sock');
    }
  }
  return {
    runtime,
    env: {
      CINDY_PRE_RUN_NODE: runtime.node,
      CINDY_PRE_RUN_GATE_ENDPOINT: endpoint,
      CINDY_PRE_RUN_GATE_NONCE: nonce,
      CINDY_PRE_RUN_GATE_CLIENT: pathToFileURL(runtime.client).href,
    },
    close() {
      try { if (directory) rmSync(directory, { recursive: true, force: true }); } catch { /* best effort, never bypass the result */ }
    },
  };
}
/** Validate the report and actual supervisor exit together; no receipt-only pass. */
export function readPreRunNodeReport(text: string, supervisorExit: number | null): PreRunNodeReport | undefined {
  if (text.length > 1024) return undefined;
  try {
    const value = JSON.parse(text) as PreRunNodeReport;
    if (value.version !== 1 || typeof value.entered !== 'boolean' || typeof value.valid !== 'boolean'
      || ![value.completed, value.nodeExit, value.shellExit].every(Number.isInteger)) return undefined;
    if (value.valid && (!value.entered || ![0, 2].includes(value.completed)
      || value.completed !== value.nodeExit || value.nodeExit !== value.shellExit
      || value.shellExit !== supervisorExit)) return undefined;
    return value;
  } catch { return undefined; }
}
