import type { Logger } from '../../interfaces/logger.js';
import {
  OutputDegenerationGuard,
  type OutputDegenerationGuardOptions,
  type OutputDegenerationVerdict,
} from '../shared/output-degeneration-guard.js';
import type { PiRpcEvent } from './rpc-client.js';

export const PI_ALLOW_REPETITIVE_OUTPUT_DIRECTIVE = '/allow-repetitive-output';

interface PiAbortResponse {
  success: boolean;
  error?: unknown;
}

export interface PiOutputDegenerationProtectionOptions {
  logger: Logger;
  /** 动态读取当前模型，模型切换后不能沿用启动时快照。 */
  isEnabled: () => boolean;
  abort: () => Promise<PiAbortResponse>;
  /** 同步登记终态原因，避免 abort ACK 与 agent_settled 竞态丢失诊断。 */
  onDetected: (verdict: Extract<OutputDegenerationVerdict, { kind: 'hard' }>) => void;
  guardOptions?: OutputDegenerationGuardOptions;
}

export interface PiOutputDegenerationDirective {
  prompt: string;
  allowRepetitiveOutput: boolean;
}

/**
 * 显式、按 turn 放行的用户入口。只认开头的完整指令 token，不猜测自然语言意图；
 * 指令本身不会发送给模型，避免它污染正文或被 Pi 当作扩展命令执行。
 */
export function consumePiOutputDegenerationDirective(
  prompt: string,
): PiOutputDegenerationDirective {
  const trimmed = prompt.trimStart();
  if (
    !trimmed.startsWith(PI_ALLOW_REPETITIVE_OUTPUT_DIRECTIVE)
    || !isDirectiveBoundary(trimmed[PI_ALLOW_REPETITIVE_OUTPUT_DIRECTIVE.length])
  ) {
    return { prompt, allowRepetitiveOutput: false };
  }

  return {
    prompt: trimmed.slice(PI_ALLOW_REPETITIVE_OUTPUT_DIRECTIVE.length).trimStart(),
    allowRepetitiveOutput: true,
  };
}

/**
 * Pi 事件层的低熵输出保险丝。
 *
 * 只消费当前 assistant message 的可见 text_delta。发现结构化 tool call 后禁用本消息的
 * 文本判定；命中时只发一次 Pi 原生 abort，不自动重放用户请求。正文与指标判定由纯 guard
 * 负责，这里只拥有 Pi RPC 生命周期和幂等中断。
 */
export class PiOutputDegenerationProtection {
  private readonly guard: OutputDegenerationGuard;
  private readonly logger: Logger;
  private readonly isEnabled: () => boolean;
  private readonly abort: () => Promise<PiAbortResponse>;
  private readonly onDetected: PiOutputDegenerationProtectionOptions['onDetected'];
  private messageHasStructuredToolCall = false;
  private turnAbortRequested = false;

  constructor(options: PiOutputDegenerationProtectionOptions) {
    this.guard = new OutputDegenerationGuard(options.guardOptions);
    this.logger = options.logger;
    this.isEnabled = options.isEnabled;
    this.abort = options.abort;
    this.onDetected = options.onDetected;
  }

  onEvent(event: PiRpcEvent): void {
    if (event.type === 'agent_start' || event.type === 'agent_settled') {
      this.turnAbortRequested = false;
      this.resetMessage();
      return;
    }
    if (event.type === 'message_start') {
      this.resetMessage();
      return;
    }
    if (event.type === 'tool_execution_start') {
      this.messageHasStructuredToolCall = true;
      return;
    }
    if (event.type !== 'message_update') return;

    const delta = event.assistantMessageEvent as Record<string, unknown> | undefined;
    if (!delta || typeof delta.type !== 'string') return;
    if (delta.type.startsWith('toolcall_')) {
      this.messageHasStructuredToolCall = true;
      return;
    }
    if (
      delta.type !== 'text_delta'
      || typeof delta.delta !== 'string'
      || this.messageHasStructuredToolCall
      || this.turnAbortRequested
      || !this.isEnabled()
    ) {
      return;
    }

    const verdict = this.guard.onTextDelta(delta.delta);
    if (verdict.kind !== 'hard') return;
    this.turnAbortRequested = true;
    this.onDetected(verdict);
    this.logger.warn('pi output degeneration guard triggered', {
      reason: verdict.reason,
      observedCharacters: verdict.observedCharacters,
      analysisWindowCharacters: verdict.analysisWindowCharacters,
      uniqueNgramRatio: verdict.uniqueNgramRatio,
      halfSimilarity: verdict.halfSimilarity,
      confirmations: verdict.confirmations,
      structuredToolCall: false,
    });
    void this.abort().then(
      (response) => {
        if (response.success) {
          this.logger.info('pi output degeneration abort accepted', {
            reason: verdict.reason,
            observedCharacters: verdict.observedCharacters,
          });
          return;
        }
        this.logger.warn('pi output degeneration abort rejected', {
          reason: verdict.reason,
          message: typeof response.error === 'string' ? response.error : 'unknown',
        });
      },
      (error: unknown) => {
        this.logger.warn('pi output degeneration abort failed', {
          reason: verdict.reason,
          message: error instanceof Error ? error.message : String(error),
        });
      },
    );
  }

  private resetMessage(): void {
    this.guard.resetMessage();
    this.messageHasStructuredToolCall = false;
  }
}

/** 首阶段只覆盖 Issue 证实的 Pi + DeepSeek 模型族，不按自定义 provider 名称写死。 */
export function shouldProtectPiOutput(model: string): boolean {
  return model.toLowerCase().includes('deepseek');
}

function isDirectiveBoundary(character: string | undefined): boolean {
  return character === undefined || /\s/u.test(character);
}
