/**
 * GrokBuildAgent — xAI Grok Build (`grok` CLI) as a Cindy harness.
 *
 * Protocol: ACP over `grok agent [ --always-approve ] stdio` (JSON-RPC 2.0 NDJSON).
 * Optional like Pi: host `buildGrokBuildAgent()` returns null when `grok` is not
 * on PATH. Missing grok must not affect Claude Code / Codex / Pi.
 *
 * Permission modes (strict → wide, [0] is strictest):
 *   ask  — ACP session/request_permission → InteractionResolver
 *   auto — ACP permission requests → shared Auto-review core (NOT grok autoMode)
 *   bypassPermissions — `grok agent --always-approve stdio` and `_meta.yoloMode`
 */

import { randomUUID } from 'node:crypto';

import type { AgentKind, PermissionMode, UserMessage } from '../../types/common.js';
import type { Capabilities } from '../../types/capabilities.js';
import type {
  AgentEvent,
  InteractionResolver,
  UsageSnapshot,
} from '../../types/events.js';
import {
  annotatePermissionRequestForUnavailableReview,
  createAutoReviewUnavailableNotice,
  resolveAutoReviewDecision,
} from '../shared/auto-review-decision.js';
import { createAsyncQueue } from '../shared/async-queue.js';
import { pickTurnStartStatus } from '../shared/turn-start-phrases.js';
import {
  AgentNotAuthenticatedError,
  BaseAgent,
  type AgentDeps,
  type AgentSessionHandle,
  type SendOptions,
  type StartSessionOptions,
} from '../base-agent.js';
import { ACP_PROTOCOL_VERSION, isRecord, type AcpContentBlock, type AcpPermissionOption, type AcpToolCall } from './types.js';
import { AcpClient } from './acp-client.js';
import { createGrokStdioTransport } from './stdio-transport.js';
import {
  GROK_BUILD_SOURCE,
  translateError,
  translatePromptResult,
  translateSessionUpdate,
  usageFromUpdate,
} from './translator.js';
import { grokBuildToolToReviewableAction, pickPermissionOptionId } from './auto-review-policy.js';

const NOT_IMPLEMENTED = { supported: false, reason: 'not-implemented' as const };

function emptyUsage(): UsageSnapshot {
  return { tokenUsage: 0, contextTokens: 0, contextWindow: 0, costUsd: 0 };
}

function userMessageToPrompt(message: UserMessage): AcpContentBlock[] {
  if (typeof message.content === 'string') {
    return [{ type: 'text', text: message.content }];
  }
  const blocks: AcpContentBlock[] = [];
  for (const block of message.content) {
    if (block.type === 'text') {
      blocks.push({ type: 'text', text: block.text });
    } else if (block.type === 'image') {
      blocks.push({ type: 'text', text: `[image: ${block.path}]` });
    } else if (block.type === 'file') {
      blocks.push({ type: 'text', text: `[file: ${block.path}]` });
    } else if (block.type === 'mention') {
      blocks.push({ type: 'text', text: `@${block.name} (${block.path})` });
    }
  }
  return blocks.length > 0 ? blocks : [{ type: 'text', text: '' }];
}

function lastUserText(message: UserMessage): string {
  if (typeof message.content === 'string') return message.content;
  for (let i = message.content.length - 1; i >= 0; i -= 1) {
    const block = message.content[i];
    if (block.type === 'text' && block.text.trim()) return block.text;
  }
  return '';
}

export class GrokBuildAgent extends BaseAgent {
  readonly kind: AgentKind = 'grok-build';
  readonly capabilities: Capabilities;

  constructor(deps: AgentDeps) {
    super(deps);
    this.capabilities = this.buildCapabilities(GrokBuildAgent.baseCapabilities());
  }

  private static baseCapabilities(): Capabilities {
    return {
      switchModel: { supported: true },
      availableModels: [
        { id: 'grok-build', displayName: 'Grok Build', contextWindow: 0, efforts: [], defaultEffort: null },
      ],
      hasFastMode: false,
      effort: { supported: false, reason: 'not-implemented' },
      effortLevels: [],
      reasoningDisplay: ['off', 'full'],
      permissionModes: [
        {
          id: 'ask',
          displayName: 'Default permissions',
          description: 'Grok Build tools that write files, run commands, or leave the workspace ask each time via ACP prompts.',
        },
        {
          id: 'auto',
          displayName: 'Auto-review',
          description: 'In-workspace writes and safe commands run automatically; out-of-workspace writes and risky commands still ask. Cindy Auto-review intercepts ACP permission requests.',
        },
        {
          id: 'bypassPermissions',
          displayName: 'Full access',
          description: 'Grok Build runs with always-approve (ACP yoloMode). Highest risk; use only for trusted tasks.',
        },
      ],
      setPermissionModeMidSession: { supported: false, reason: 'not-implemented', message: 'Grok Build permission mode is set when the session starts.' },
      turnPermissionPolicy: {
        supported: { supported: true },
        unsupportedPermissionModes: ['bypassPermissions'],
      },
      planMode: NOT_IMPLEMENTED,
      multimodal: {
        text: { supported: true },
        image: { supported: false, reason: 'not-implemented' },
        file: { supported: false, reason: 'not-implemented' },
      },
      fork: NOT_IMPLEMENTED,
      rewind: NOT_IMPLEMENTED,
      sessionTree: NOT_IMPLEMENTED,
      abort: { supported: true },
      sameTurnSteer: NOT_IMPLEMENTED,
      memory: {
        supported: NOT_IMPLEMENTED,
      },
      extraDirs: NOT_IMPLEMENTED,
      sessionHtmlExport: NOT_IMPLEMENTED,
      manualCompact: NOT_IMPLEMENTED,
    };
  }

  async startSession(opts: StartSessionOptions): Promise<AgentSessionHandle> {
    const auth = await this.deps.auth.getState();
    if (!auth.authenticated) {
      throw new AgentNotAuthenticatedError(this.kind, auth.errorReason);
    }

    const permissionMode: PermissionMode = opts.permissionMode ?? 'ask';
    const model = opts.model || 'grok-build';
    const bypass = permissionMode === 'bypassPermissions';
    const args = ['agent'];
    if (bypass) args.push('--always-approve');
    if (model && model !== 'grok-build') {
      args.push('-m', model);
    }
    args.push('stdio');

    const authEnv = await this.deps.auth.getAuthEnv();
    const env: NodeJS.ProcessEnv = { ...process.env, ...authEnv };
    const events = createAsyncQueue<AgentEvent>();
    let usage = emptyUsage();
    let resolver: InteractionResolver | undefined;
    let acpSessionId = '';
    let closed = false;
    let promptInFlight = false;
    const lastUserIntent = { text: '' };
    const thought = { blockId: randomUUID() };
    let onTurnAccepted: (() => void) | undefined;
    const autoReviewNotice = createAutoReviewUnavailableNotice((message) => {
      events.push({ type: 'error', data: { message, isTerminal: false }, source: GROK_BUILD_SOURCE });
    });

    const transport = createGrokStdioTransport({
      binaryPath: this.deps.binaryPath,
      args,
      cwd: opts.workingDir,
      env,
      onProcessSpawned: (pid) => this.deps.registerLocalAgentProcess?.({
        pid,
        kind: 'grok-build',
        role: 'task-host',
      }),
    });
    const client = new AcpClient({
      transport,
      logger: this.deps.logger.child('grok-build'),
    });

    client.onNotification((method, params) => {
      if (method !== 'session/update' || !isRecord(params) || !isRecord(params.update)) return;
      onTurnAccepted?.();
      const sessionUpdate = params.update as { sessionUpdate: string; [key: string]: unknown };
      if (sessionUpdate.sessionUpdate === 'usage_update') {
        usage = {
          ...usage,
          ...usageFromUpdate(sessionUpdate),
        };
      }
      for (const event of translateSessionUpdate(sessionUpdate as never, thought)) {
        events.push(event);
      }
    });

    client.setRequestHandler(async (method, params) => {
      if (method !== 'session/request_permission') {
        throw new Error(`unsupported ACP client method: ${method}`);
      }
      if (!isRecord(params) || !isRecord(params.toolCall)) {
        return { outcome: { outcome: 'cancelled' } };
      }
      const toolCall = params.toolCall as AcpToolCall;
      const options = Array.isArray(params.options) ? params.options as AcpPermissionOption[] : [];
      return this.resolvePermission({
        permissionMode,
        toolCall,
        options,
        resolver,
        workingDir: opts.workingDir,
        extraDirs: opts.extraDirs ?? [],
        model,
        providerId: opts.providerId,
        sessionId: opts.sessionId,
        lastUserIntent: lastUserIntent.text,
        autoReviewNotice,
      });
    });

    client.start();
    try {
      const init = await client.initialize({
        protocolVersion: ACP_PROTOCOL_VERSION,
        clientInfo: { name: 'cindy', version: '0.0.0' },
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
        },
      });
      if (init.agentCapabilities?.promptCapabilities?.image) {
        // capabilities is already published; image support is negotiated per session.
        this.deps.logger.debug('grok-build ACP reports image prompt capability');
      }

      const hostPrompt = this.deps.runtimeConfig.systemPrompt?.trim() ?? '';
      const userPrompt = opts.userPrompt?.trim() ?? '';
      const systemPromptOverride = [hostPrompt, userPrompt].filter(Boolean).join('\n\n') || undefined;
      const created = await client.sessionNew({
        cwd: opts.workingDir,
        mcpServers: [],
        _meta: {
          ...(bypass ? { yoloMode: true } : {}),
          ...(systemPromptOverride ? { systemPromptOverride } : {}),
        },
      });
      acpSessionId = created.sessionId;
    } catch (err) {
      closed = true;
      await client.close('startSession failed');
      events.end();
      throw err;
    }
    events.push({
      type: 'session_id',
      data: { sessionId: acpSessionId },
      source: GROK_BUILD_SOURCE,
    });

    const handle: AgentSessionHandle = {
      id: acpSessionId,
      agentKind: this.kind,
      model,
      async send(message: UserMessage, sendOpts?: SendOptions) {
        if (closed) throw new Error('grok-build session is closed');
        lastUserIntent.text = lastUserText(message);
        const greeting = pickTurnStartStatus(undefined);
        events.push({
          type: 'status',
          data: { status: 'running', text: greeting.text, ...usage },
          source: GROK_BUILD_SOURCE,
        });
        promptInFlight = true;
        let sendReturned = false;
        let acceptState: 'pending' | 'accepted' | 'rejected' = 'pending';
        let acceptResolve = () => {};
        const accepted = new Promise<void>((resolve) => {
          acceptResolve = resolve;
        });
        const markAccepted = () => {
          if (acceptState !== 'pending') return;
          acceptState = 'accepted';
          acceptResolve();
        };
        const publishAfterSend = (event: AgentEvent) => {
          const fire = () => { events.push(event); };
          if (sendReturned) fire();
          else setImmediate(fire);
        };
        onTurnAccepted = markAccepted;
        const promptPromise = (async () => {
          try {
            const result = await client.sessionPrompt({
              sessionId: acpSessionId,
              prompt: userMessageToPrompt(message),
            });
            markAccepted();
            publishAfterSend(translatePromptResult(result));
          } catch (err) {
            if (acceptState === 'accepted' || sendReturned) {
              const messageText = err instanceof Error ? err.message : String(err);
              publishAfterSend(translateError(messageText, true));
              return;
            }
            acceptState = 'rejected';
            throw err;
          } finally {
            promptInFlight = false;
            if (onTurnAccepted === markAccepted) onTurnAccepted = undefined;
          }
        })();
        try {
          await Promise.race([accepted, promptPromise]);
          sendReturned = true;
        } finally {
          void sendOpts;
        }
      },
      async steer() {
        throw new Error('grok-build does not support same-turn steer');
      },
      async abort() {
        if (!promptInFlight) return;
        await client.sessionCancel(acpSessionId);
      },
      async close() {
        if (closed) return;
        closed = true;
        await client.close('session close');
        events.end();
      },
      events() {
        return events;
      },
      getUsageSnapshot() {
        return usage;
      },
      setInteractionResolver(next: InteractionResolver) {
        resolver = next;
      },
    };
    return handle;
  }

  private async resolvePermission(args: {
    permissionMode: PermissionMode;
    toolCall: AcpToolCall;
    options: AcpPermissionOption[];
    resolver: InteractionResolver | undefined;
    workingDir: string;
    extraDirs: string[];
    model: string;
    providerId?: string | null;
    sessionId?: string;
    lastUserIntent: string;
    autoReviewNotice: { notify(): void; reset(): void };
  }): Promise<{ outcome: { outcome: 'selected'; optionId: string } | { outcome: 'cancelled' } }> {
    const { permissionMode, toolCall, options, resolver } = args;
    const select = (behavior: 'allow' | 'deny', always = false) => {
      const optionId = pickPermissionOptionId(options, behavior, always);
      if (!optionId) return { outcome: { outcome: 'cancelled' as const } };
      return { outcome: { outcome: 'selected' as const, optionId } };
    };

    if (permissionMode === 'bypassPermissions') {
      return select('allow', true);
    }

    const request = {
      requestId: toolCall.toolCallId || randomUUID(),
      toolUseId: toolCall.toolCallId,
      kind: 'permission' as const,
      toolName: toolCall.title || toolCall.kind || 'tool',
      input: isRecord(toolCall.rawInput) ? toolCall.rawInput : {},
      title: toolCall.title,
    };

    if (permissionMode === 'auto') {
      const decision = await resolveAutoReviewDecision(
        {
          sessionId: args.sessionId,
          agentKind: this.kind,
          providerId: args.providerId,
          model: args.model,
          userIntent: args.lastUserIntent,
          action: grokBuildToolToReviewableAction(toolCall),
          workspaceRoots: [args.workingDir, ...args.extraDirs],
          platform: process.platform,
        },
        this.deps.reviewAutoPermissionAction,
      );
      if (decision.verdict === 'allow') return select('allow');
      if (decision.verdict === 'block') return select('deny');
      if (decision.unavailable) args.autoReviewNotice.notify();
      if (!resolver) return select('deny');
      const prompt = decision.unavailable
        ? annotatePermissionRequestForUnavailableReview(request)
        : request;
      const user = await resolver(prompt);
      if (user.kind !== 'permission') return { outcome: { outcome: 'cancelled' } };
      return select(user.behavior, Boolean(user.permissionUpdates?.length));
    }

    if (!resolver) return { outcome: { outcome: 'cancelled' } };
    const user = await resolver(request);
    if (user.kind !== 'permission') return { outcome: { outcome: 'cancelled' } };
    return select(user.behavior, Boolean(user.permissionUpdates?.length));
  }
}

export { resolveGrokBinaryFromPath, probeGrokBuildAcp, detectGrokBuildOnPath } from './detect.js';
export type { GrokBuildDetectStatus, GrokBuildProbeResult } from './detect.js';
