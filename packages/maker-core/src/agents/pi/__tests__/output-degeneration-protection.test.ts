import { describe, expect, it, vi } from 'vitest';

import type { Logger } from '../../../interfaces/logger.js';
import type { PiRpcEvent } from '../rpc-client.js';
import {
  consumePiOutputDegenerationDirective,
  PiOutputDegenerationProtection,
  shouldProtectPiOutput,
} from '../output-degeneration-protection.js';

const ev = (event: Record<string, unknown>): PiRpcEvent => event as unknown as PiRpcEvent;

function loggerWithSpies(): Logger {
  const logger: Logger = {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    child: () => logger,
  };
  return logger;
}

function textDelta(text: string): PiRpcEvent {
  return ev({
    type: 'message_update',
    assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: text },
  });
}

describe('PiOutputDegenerationProtection', () => {
  it('consumes only the explicit leading per-turn bypass directive', () => {
    expect(consumePiOutputDegenerationDirective(
      '  /allow-repetitive-output\nRepeat this fixture 10,000 times.',
    )).toEqual({
      prompt: 'Repeat this fixture 10,000 times.',
      allowRepetitiveOutput: true,
    });
    expect(consumePiOutputDegenerationDirective(
      '/allow-repetitive-output-now keep the normal guard',
    )).toEqual({
      prompt: '/allow-repetitive-output-now keep the normal guard',
      allowRepetitiveOutput: false,
    });
  });

  it('requests exactly one native abort and reports only non-content diagnostics', async () => {
    const abort = vi.fn().mockResolvedValue({ success: true });
    const onDetected = vi.fn();
    const logger = loggerWithSpies();
    const protection = new PiOutputDegenerationProtection({
      logger,
      isEnabled: () => true,
      abort,
      onDetected,
      guardOptions: {
        minimumCharacters: 4_096,
        analysisWindowCharacters: 4_096,
        checkIntervalCharacters: 1_024,
        requiredConfirmations: 2,
      },
    });

    protection.onEvent(ev({ type: 'message_start' }));
    const repeated = 'let me write the file now; 现在执行；落地。'.repeat(300);
    for (let offset = 0; offset < repeated.length; offset += 257) {
      protection.onEvent(textDelta(repeated.slice(offset, offset + 257)));
    }

    await vi.waitFor(() => expect(abort).toHaveBeenCalledOnce());
    expect(onDetected).toHaveBeenCalledOnce();
    expect(logger.warn).toHaveBeenCalledWith(
      'pi output degeneration guard triggered',
      expect.objectContaining({
        reason: 'low-entropy-repetition',
        observedCharacters: expect.any(Number),
        structuredToolCall: false,
      }),
    );
    expect(JSON.stringify((logger.warn as ReturnType<typeof vi.fn>).mock.calls)).not.toContain(
      'let me write the file now',
    );
  });

  it('does not inspect a message after Pi reports a structured tool call', () => {
    const abort = vi.fn().mockResolvedValue({ success: true });
    const protection = new PiOutputDegenerationProtection({
      logger: loggerWithSpies(),
      isEnabled: () => true,
      abort,
      onDetected: vi.fn(),
      guardOptions: {
        minimumCharacters: 1_024,
        analysisWindowCharacters: 1_024,
        checkIntervalCharacters: 256,
        requiredConfirmations: 1,
      },
    });

    protection.onEvent(ev({ type: 'message_start' }));
    protection.onEvent(ev({
      type: 'message_update',
      assistantMessageEvent: { type: 'toolcall_start', contentIndex: 0 },
    }));
    protection.onEvent(textDelta('repeat this forever; '.repeat(500)));

    expect(abort).not.toHaveBeenCalled();
  });

  it('keeps one abort per turn and re-arms at the next agent boundary', async () => {
    const abort = vi.fn().mockResolvedValue({ success: true });
    const protection = new PiOutputDegenerationProtection({
      logger: loggerWithSpies(),
      isEnabled: () => true,
      abort,
      onDetected: vi.fn(),
      guardOptions: {
        minimumCharacters: 1_024,
        analysisWindowCharacters: 1_024,
        checkIntervalCharacters: 256,
        requiredConfirmations: 1,
      },
    });

    protection.onEvent(ev({ type: 'agent_start' }));
    protection.onEvent(ev({ type: 'message_start' }));
    protection.onEvent(textDelta('repeat this forever; '.repeat(500)));
    await vi.waitFor(() => expect(abort).toHaveBeenCalledOnce());

    // 同一 turn 即使 Pi 又开了一条 assistant message，也不能重复请求 abort。
    protection.onEvent(ev({ type: 'message_start' }));
    protection.onEvent(textDelta('repeat this forever; '.repeat(500)));
    expect(abort).toHaveBeenCalledOnce();

    protection.onEvent(ev({ type: 'agent_settled' }));
    protection.onEvent(ev({ type: 'agent_start' }));
    protection.onEvent(ev({ type: 'message_start' }));
    protection.onEvent(textDelta('repeat this forever; '.repeat(500)));
    await vi.waitFor(() => expect(abort).toHaveBeenCalledTimes(2));
  });

  it('keeps the terminal diagnosis latched when the abort RPC fails', async () => {
    const abort = vi.fn().mockRejectedValue(new Error('transport unavailable'));
    const onDetected = vi.fn();
    const logger = loggerWithSpies();
    const protection = new PiOutputDegenerationProtection({
      logger,
      isEnabled: () => true,
      abort,
      onDetected,
      guardOptions: {
        minimumCharacters: 1_024,
        analysisWindowCharacters: 1_024,
        checkIntervalCharacters: 256,
        requiredConfirmations: 1,
      },
    });

    protection.onEvent(ev({ type: 'agent_start' }));
    protection.onEvent(ev({ type: 'message_start' }));
    protection.onEvent(textDelta('repeat this forever; '.repeat(500)));
    await vi.waitFor(() => expect(logger.warn).toHaveBeenCalledWith(
      'pi output degeneration abort failed',
      expect.objectContaining({ message: 'transport unavailable' }),
    ));

    protection.onEvent(ev({ type: 'message_start' }));
    protection.onEvent(textDelta('repeat this forever; '.repeat(500)));
    expect(abort).toHaveBeenCalledOnce();
    expect(onDetected).toHaveBeenCalledOnce();
  });

  it('keeps the first-stage rollout scoped to the DeepSeek model family', () => {
    expect(shouldProtectPiOutput('DeepSeek-V4-Flash-0731')).toBe(true);
    expect(shouldProtectPiOutput('deepseek/deepseek-v4-pro')).toBe(true);
    expect(shouldProtectPiOutput('xai/grok-4.5')).toBe(false);
    expect(shouldProtectPiOutput('claude-sonnet-4-6')).toBe(false);
  });
});
