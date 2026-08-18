/** Desktop-only construction for the optional DeepSeek Harness adapter. */
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import { DshAgent, type AgentDeps } from '@cindy/maker-core';
import type { RemoteHost } from '@cindy/maker-remote-ssh';
import { app } from 'electron';

import { getProviderSecretStore } from '../secrets/providerSecretStore.js';
import { desktopClaudeAuthAdapter } from './auth-adapters.js';
import { buildDesktopClaudeRuntimeConfig } from './runtime-configs.js';
import { createSshDshTransport } from './dsh-remote-transport.js';

const require = createRequire(import.meta.url);

function resolveDshLauncher(): string | null {
  const override = process.env.CINDY_DSH_BIN?.trim();
  if (override) return path.isAbsolute(override) && fs.existsSync(override) ? override : null;
  try {
    // packaged-bin resolves the plugin graph from the installed DSH runtime,
    // rather than from the per-session temporary config directory.
    return require.resolve('@deepseek-ai/dsh-sdk-jsonrpc-demo/packaged-bin');
  } catch {
    return null;
  }
}

/**
 * DSH ships with the desktop package. A developer-only path override remains
 * available for isolated protocol debugging.
 */
export function buildDshAgent(
  logger: AgentDeps['logger'],
  createRemoteDshTransport?: AgentDeps['createRemoteDshTransport'],
): DshAgent | null {
  const binPath = resolveDshLauncher();
  if (!binPath) return null;
  return new DshAgent({
    auth: desktopClaudeAuthAdapter,
    runtimeConfig: buildDesktopClaudeRuntimeConfig(() => 'https://api.deepseek.com'),
    binaryPath: binPath,
    logger,
    createRemoteDshTransport,
  });
}

/** Main-process-only values supplied immediately before the child is started. */
export function prepareDshVendorOptions(remoteHostId?: string): Record<string, string> {
  const apiKey = getProviderSecretStore().get('deepseek');
  if (!apiKey) throw new Error('DeepSeek API key is not configured');
  return {
    dshApiKey: apiKey,
    // $HOME is expanded by the fixed remote launcher, never by this Windows/macOS host.
    dshSessionRoot: remoteHostId ? '$HOME/.xdt-server/v1/dsh-sessions' : path.join(app.getPath('userData'), 'dsh-sessions'),
  };
}

export function createDesktopRemoteDshTransport(
  remoteHost: RemoteHost,
  input: Parameters<NonNullable<AgentDeps['createRemoteDshTransport']>>[0],
  logger: AgentDeps['logger'],
) {
  return createSshDshTransport({
    remoteHost,
    workingDir: input.workingDir,
    configYaml: input.configYaml,
    bridgeSource: input.bridgeSource,
    apiKey: input.apiKey,
    sessionRoot: input.sessionRoot,
    logger,
  });
}
