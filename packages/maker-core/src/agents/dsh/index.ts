/** DeepSeek Harness adapter. The host owns binaries, credentials, and remote process boundaries. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

import type { AgentEvent, UsageSnapshot } from '../../types/events.js';
import type { AgentKind, UserContentBlock, UserMessage } from '../../types/common.js';
import type { Capabilities } from '../../types/capabilities.js';
import { BaseAgent, type AgentDeps, type AgentSessionHandle, type SendOptions, type StartSessionOptions } from '../base-agent.js';
import { buildDshCordisConfig, renderDshCordisYaml } from './composition.js';
import { DSH_BRIDGE_SOURCE } from './bridge-source.js';
import type {
  DshInitializeResult,
  DshReasoningEffort,
  DshSessionEventNotificationParams,
  DshSessionStatusNotificationParams,
  DshThinkingPolicy,
  DshVendorModel,
} from './protocol.js';
import { DshRpcProcess } from './rpc-client.js';
import { createDshEventQueue, createDshTranslateContext, settleDshTurnOnIdle, translateDshEvent } from './translator.js';
import { createDshStdioTransport, type DshTransport } from './transport.js';

export interface DshVendorOptions {
  dshBinPath?: string;
  dshNodePath?: string;
  /** Host-controlled user-data root; dsh session persistence never falls back to cwd. */
  dshSessionRoot?: string;
  /** Secret is accepted only to populate the spawned process environment. */
  dshApiKey?: string;
  dshBashLocal?: boolean;
  /** Endpoint and model metadata are prepared by the trusted desktop host. */
  dshBaseUrl?: string;
  dshModels?: readonly DshVendorModel[];
  dshReasoningEffort?: DshReasoningEffort;
  dshThinkingPolicy?: DshThinkingPolicy;
}

export class DshAgent extends BaseAgent {
  readonly kind: AgentKind = 'dsh';
  readonly capabilities: Capabilities;
  constructor(deps: AgentDeps) { super(deps); this.capabilities = this.buildCapabilities(DshAgent.baseCapabilities()); }
  private static baseCapabilities(): Capabilities {
    const unavailable = { supported: false as const, reason: 'not-implemented' as const };
    return {
      switchModel: unavailable, availableModels: [], hasFastMode: false, effort: unavailable, effortLevels: [], reasoningDisplay: ['full'], permissionModes: [], setPermissionModeMidSession: unavailable,
      multimodal: { text: { supported: true }, image: unavailable, file: unavailable }, fork: unavailable, rewind: unavailable, sessionTree: unavailable,
      abort: { supported: true }, sameTurnSteer: unavailable, memory: { supported: unavailable }, extraDirs: unavailable,
    };
  }
  override async startSession(opts: StartSessionOptions): Promise<AgentSessionHandle> {
    const vendor = (opts.vendorOptions ?? {}) as DshVendorOptions;
    const sessionRoot = vendor.dshSessionRoot;
    if (!sessionRoot || (!opts.remoteHostId && !path.isAbsolute(sessionRoot))) throw new Error('dshSessionRoot must be a host-managed absolute path');
    const apiKey = vendor.dshApiKey;
    if (!apiKey) throw new Error('dsh requires an API key supplied by the host');
    let tempDir: string | undefined;
    let transport: DshTransport | undefined;
    const cleanTemp = async (): Promise<void> => {
      if (!tempDir) return;
      await rm(tempDir, { recursive: true, force: true }).catch((error) => this.deps.logger.warn('dsh temp config cleanup failed', { message: error instanceof Error ? error.message : String(error) }));
    };
    try {
      const model = opts.model || 'deepseek-v4-flash';
      const config = buildDshCordisConfig({
        provider: 'deepseek-official',
        model,
        apiKeyEnv: 'DEEPSEEK_API_KEY',
        cwd: opts.workingDir,
        sessionRoot,
        bashLocal: vendor.dshBashLocal,
        baseUrl: vendor.dshBaseUrl,
        models: vendor.dshModels,
        ...(vendor.dshThinkingPolicy
          ? { thinkingPolicy: vendor.dshThinkingPolicy }
          : { reasoningEffort: vendor.dshReasoningEffort ?? 'max' }),
      });
      const configYaml = renderDshCordisYaml(config);
      if (opts.remoteHostId) {
        if (!this.deps.createRemoteDshTransport) throw new Error('dsh SSH transport is not configured by the host');
        transport = await this.deps.createRemoteDshTransport({ remoteHostId: opts.remoteHostId, workingDir: opts.workingDir, configYaml, bridgeSource: DSH_BRIDGE_SOURCE, apiKey, sessionRoot });
      } else {
        tempDir = await mkdtemp(path.join(os.tmpdir(), 'cindy-dsh-'));
        const configPath = path.join(tempDir, 'cordis.yml');
        await writeFile(configPath, configYaml, 'utf8');
        await writeFile(path.join(tempDir, 'cindy-dsh-bridge.mjs'), DSH_BRIDGE_SOURCE, 'utf8');
        const localInput = {
          binPath: vendor.dshBinPath ?? this.deps.binaryPath,
          configPath,
          workingDir: opts.workingDir,
          env: {
            ...process.env,
            DEEPSEEK_API_KEY: apiKey,
            DSH_CWD: opts.workingDir,
            DSH_SESSION_ROOT: sessionRoot,
          },
        };
        transport = this.deps.createLocalDshTransport
          ? await this.deps.createLocalDshTransport(localInput)
          : createDshStdioTransport({
              nodePath: vendor.dshNodePath ?? process.execPath,
              binPath: localInput.binPath,
              configPath: localInput.configPath,
              cwd: localInput.workingDir,
              env: localInput.env,
              logger: this.deps.logger,
            });
      }
      const queue = createDshEventQueue();
      const context = createDshTranslateContext(this.deps.logger);
      const logger = this.deps.logger;
      let closed = false;
      const proc = new DshRpcProcess({ transport, logger: this.deps.logger, onExit: ({ code, signal }) => { if (!closed) queue.push({ type: 'error', data: { message: `dsh exited (code=${code}, signal=${signal})`, isTerminal: true }, source: 'dsh' }); void cleanTemp(); queue.end(); }, onNotification: (notification) => {
        if (notification.method === 'session.event') { const params = notification.params as DshSessionEventNotificationParams; if (params?.event) translateDshEvent(params.event, queue, context); }
        else if (notification.method === 'session.status') { const params = notification.params as DshSessionStatusNotificationParams; if (params?.status === 'running') queue.push({ type: 'status', data: { status: 'Working…', ...context.usage, isRunning: true }, source: 'dsh' }); else if (params?.status === 'idle') settleDshTurnOnIdle(queue, context); }
      } });
      await proc.request<DshInitializeResult>('initialize', { cwd: opts.workingDir, provider: 'deepseek-official', model });
      const sessionId = opts.resumeSessionId ?? randomUUID();
      if (opts.resumeSessionId) await proc.request('session/resume', { sessionId });
      const send = async (message: UserMessage, sendOpts?: SendOptions): Promise<void> => {
        if (sendOpts?.signal?.aborted) throw new Error('dsh send cancelled before dispatch');
        const text = textFromMessage(message);
        if (!text) throw new Error('dsh requires non-empty text input');
        await proc.request('session/prompt', { sessionId, contentBlocks: [{ type: 'text', text }] });
      };
      return {
        get id() { return sessionId; }, agentKind: 'dsh', model, send,
        async steer() { throw new Error('dsh does not support same-turn steering'); },
        async abort() {
          if (proc.isClosed) return;
          try { await proc.request('session/cancel', { sessionId }); } catch (error) {
            logger.warn('dsh cancel RPC failed; terminating process', { message: error instanceof Error ? error.message : String(error) });
            closed = true; await proc.close().catch(() => undefined); await cleanTemp(); queue.end();
          }
        },
        async close() {
          if (closed) return;
          closed = true;
          try {
            // The current dsh wire lacks a reliable cancel; shutdown is best-effort.
            await proc.request('shutdown', {}, { timeoutMs: 5_000 });
          } catch (error) {
            // Closing the process below is the required fallback after a lost RPC response.
          } finally {
            await proc.close().catch(() => undefined);
            await cleanTemp();
            queue.end();
          }
        },
        events(): AsyncIterable<AgentEvent> { return queue; }, getUsageSnapshot(): UsageSnapshot { return context.usage; }, setInteractionResolver() { /* dsh wire has no interaction requests */ }, isTurnRunning() { return context.isStreaming; },
      };
    } catch (error) {
      if (transport && !transport.isClosed()) {
        await transport.close('dsh session startup failed').catch((closeError) => {
          this.deps.logger.warn('dsh startup transport cleanup failed', {
            message: closeError instanceof Error ? closeError.message : String(closeError),
          });
        });
      }
      await cleanTemp();
      throw error;
    }
  }
}
function textFromMessage(message: UserMessage): string {
  if (typeof message.content === 'string') return message.content;
  const text: string[] = [];
  for (const block of message.content as UserContentBlock[]) {
    if (block.type === 'text') text.push(block.text);
    else if (block.type === 'mention') text.push(`\`${block.path}\``);
    else throw new Error(`dsh does not support ${block.type} attachments`);
  }
  return text.join(' ').trim();
}
