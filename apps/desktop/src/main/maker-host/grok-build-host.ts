/**
 * Grok Build desktop host — PATH detect, ACP auth probe, optional Maker registration.
 *
 * Unlike Pi, there is no CDN binary pin and no Cindy gateway endpoint. Missing
 * `grok` returns null so Claude Code / Codex / Pi keep working.
 *
 * Auth is grok CLI login or XAI_API_KEY. This module never reads ~/.grok/auth.json
 * and never reuses SuperGrok OAuth (`grok-oauth-login.ts`).
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import {
  GrokBuildAgent,
  probeGrokBuildAcp,
  resolveGrokBinaryFromPath,
  type AuthAdapter,
  type AuthState,
  type Logger,
} from '@cindy/maker-core';

import hostSystemPrompt from './host-system-prompt.md?raw';

const execFileAsync = promisify(execFile);

function createLogger(base: Logger): Logger {
  return base.child('grok-build-host');
}

export function resolveGrokBuildBinaryPath(): string | null {
  return resolveGrokBinaryFromPath();
}

class DesktopGrokBuildAuthAdapter implements AuthAdapter {
  constructor(
    private readonly binaryPath: string,
    private readonly logger: Logger,
  ) {}

  async getState(): Promise<AuthState> {
    if (process.env.XAI_API_KEY && process.env.XAI_API_KEY.trim().length > 0) {
      return { authenticated: true, identity: 'XAI_API_KEY', authSource: 'api-key' };
    }
    const probe = await probeGrokBuildAcp({
      binaryPath: this.binaryPath,
      logger: this.logger,
      env: process.env,
    });
    if (probe.status === 'ready') {
      return {
        authenticated: true,
        identity: probe.identity ?? 'grok',
        authSource: 'oauth',
      };
    }
    return {
      authenticated: false,
      errorReason: probe.errorReason ?? probe.status,
      authSource: 'oauth',
    };
  }

  async triggerLogin(): Promise<AuthState> {
    this.logger.info('spawning grok login');
    try {
      await execFileAsync(this.binaryPath, ['login'], {
        timeout: 15 * 60_000,
        env: process.env,
      });
    } catch (err) {
      this.logger.warn('grok login failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return this.getState();
  }

  async logout(): Promise<void> {
    this.logger.info('spawning grok logout');
    try {
      await execFileAsync(this.binaryPath, ['logout'], {
        timeout: 30_000,
        env: process.env,
      });
    } catch (err) {
      this.logger.warn('grok logout failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async getAuthEnv(): Promise<Record<string, string>> {
    const key = process.env.XAI_API_KEY?.trim();
    return key ? { XAI_API_KEY: key } : {};
  }
}

export function buildGrokBuildAgent(opts: {
  logger: Logger;
  reviewAutoPermissionAction?: ConstructorParameters<typeof GrokBuildAgent>[0]['reviewAutoPermissionAction'];
  registerLocalAgentProcess?: ConstructorParameters<typeof GrokBuildAgent>[0]['registerLocalAgentProcess'];
}): GrokBuildAgent | null {
  const log = createLogger(opts.logger);
  const binaryPath = resolveGrokBuildBinaryPath();
  if (!binaryPath) {
    log.info('grok binary not on PATH; grok-build agent disabled for this launch');
    return null;
  }
  log.info('grok-build agent enabled', { binaryPath });
  return new GrokBuildAgent({
    auth: new DesktopGrokBuildAuthAdapter(binaryPath, log),
    runtimeConfig: { systemPrompt: hostSystemPrompt.trim() },
    binaryPath,
    logger: log,
    reviewAutoPermissionAction: opts.reviewAutoPermissionAction,
    registerLocalAgentProcess: opts.registerLocalAgentProcess,
    capabilityAdditions: {
      availableModels: [
        { id: 'grok-build', displayName: 'Grok Build', contextWindow: 0, efforts: [], defaultEffort: null },
      ],
    },
  });
}
