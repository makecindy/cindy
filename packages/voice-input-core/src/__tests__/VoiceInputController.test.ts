import { describe, expect, it, vi } from 'vitest';

import { VoiceInputController } from '../VoiceInputController.js';
import { VoiceTimelineLogger } from '../VoiceTimelineLogger.js';
import type {
  AsrEvent,
  AsrProvider,
  EditableRange,
  SpeechSegment,
  VoiceInputDraftSource,
  VoiceInputState,
  VoiceTimelineEvent,
  RefinementResult,
} from '../types.js';

class FakeAsrProvider implements AsrProvider {
  private callback: (event: AsrEvent) => void = () => {};
  public appended = 0;
  public flush: () => Promise<void> = async () => {};
  public recover?: () => Promise<void>;

  async start(): Promise<void> {
    this.callback({ type: 'connected', at: Date.now() });
  }

  // Real providers await an in-flight recover() inside stop() (swallowing its
  // rejection), so stop() is another window where a failure can land.
  public stopHook: () => Promise<void> = async () => {};

  async stop(): Promise<void> {
    await this.stopHook();
    this.callback({ type: 'disconnected', at: Date.now() });
  }

  appendAudio(chunk: ArrayBuffer): void {
    void chunk;
    this.appended += 1;
  }

  flushAudio(): Promise<void> {
    return this.flush();
  }

  onEvent(callback: (event: AsrEvent) => void): void {
    this.callback = callback;
  }

  emit(event: AsrEvent): void {
    this.callback(event);
  }
}

// A host that takes the text: salvage treats the returned range as the
// acceptance signal, so stubs that mean "accepted" must return one.
function acceptSubmission(text: string, segment: SpeechSegment): EditableRange {
  return {
    id: `range-${segment.id}`,
    segmentIds: [segment.id],
    startOffset: 0,
    endOffset: text.length,
    userTouched: false,
  };
}

function pcmChunk(amplitude: number): ArrayBuffer {
  const samples = new Int16Array(160);
  samples.fill(amplitude);
  return samples.buffer;
}

describe('VoiceInputController', () => {
  it('starts without a global crypto implementation', async () => {
    const originalCrypto = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
    Object.defineProperty(globalThis, 'crypto', {
      configurable: true,
      value: undefined,
    });
    try {
      const asr = new FakeAsrProvider();
      const controller = new VoiceInputController({
        asr,
        logger: new VoiceTimelineLogger(),
        callbacks: {
          onDraftChanged: () => {},
          onSubmitted: () => undefined,
        },
      });

      const runId = await controller.start();
      await controller.cancel();

      expect(runId).toMatch(/^voice-/);
    } finally {
      if (originalCrypto) {
        Object.defineProperty(globalThis, 'crypto', originalCrypto);
      } else {
        delete (globalThis as { crypto?: unknown }).crypto;
      }
    }
  });

  it('submits the latest partial when stop does not receive stable text', async () => {
    const asr = new FakeAsrProvider();
    const submitted: SpeechSegment[] = [];
    const controller = new VoiceInputController({
      asr,
      logger: new VoiceTimelineLogger(),
      stableWaitMs: 0,
      callbacks: {
        onDraftChanged: () => {},
        onSubmitted: (text, segment) => {
          void text;
          submitted.push(segment);
          return undefined;
        },
      },
    });

    await controller.start();
    asr.emit({ type: 'partial', text: 'hello world', at: Date.now() });
    await controller.stop();

    expect(submitted.map((segment) => segment.text)).toEqual(['hello world']);
  });

  it('marks partial and stable draft updates separately', async () => {
    const asr = new FakeAsrProvider();
    const drafts: Array<{ text: string; source: VoiceInputDraftSource }> = [];
    const timeline: VoiceTimelineEvent[] = [];
    const controller = new VoiceInputController({
      asr,
      logger: new VoiceTimelineLogger((event) => timeline.push(event)),
      stableWaitMs: 0,
      callbacks: {
        onDraftChanged: (text, _segment, source) => {
          drafts.push({ text, source });
        },
        onSubmitted: () => undefined,
      },
    });

    await controller.start();
    asr.emit({ type: 'partial', text: 'hello world', at: Date.now() });
    asr.emit({ type: 'stable', text: 'hello world', at: Date.now() });

    expect(drafts).toEqual([
      { text: 'hello world', source: 'partial' },
      { text: 'hello world', source: 'stable' },
    ]);
    expect(timeline).toContainEqual(expect.objectContaining({
      type: 'draft_changed',
      reason: 'asr_partial',
      source: 'partial',
    }));
    expect(timeline).toContainEqual(expect.objectContaining({
      type: 'draft_changed',
      reason: 'asr_stable',
      source: 'stable',
    }));
  });

  it('awaits flush before choosing stable text', async () => {
    const asr = new FakeAsrProvider();
    const submitted: SpeechSegment[] = [];
    const states: VoiceInputState[] = [];
    const controller = new VoiceInputController({
      asr,
      logger: new VoiceTimelineLogger(),
      stableWaitMs: 0,
      callbacks: {
        onStateChanged: (state) => states.push(state),
        onDraftChanged: () => {},
        onSubmitted: (text, segment) => {
          void text;
          submitted.push(segment);
          return undefined;
        },
      },
    });
    asr.flush = async () => {
      asr.emit({ type: 'stable', text: 'stable result', at: Date.now() });
    };

    await controller.start();
    asr.emit({ type: 'partial', text: 'partial result', at: Date.now() });
    await controller.stop();

    expect(submitted.map((segment) => segment.text)).toEqual(['stable result']);
    expect(states).toContain('submitting');
    expect(states.at(-1)).toBe('done');
  });

  it('uses partial text received while submitting as a stop fallback', async () => {
    const asr = new FakeAsrProvider();
    const submitted: SpeechSegment[] = [];
    const controller = new VoiceInputController({
      asr,
      logger: new VoiceTimelineLogger(),
      stableWaitMs: 0,
      callbacks: {
        onDraftChanged: () => {},
        onSubmitted: (text, segment) => {
          void text;
          submitted.push(segment);
          return undefined;
        },
      },
    });
    asr.flush = async () => {
      asr.emit({ type: 'partial', text: 'hello world tail', at: Date.now() });
    };

    await controller.start();
    asr.emit({ type: 'partial', text: 'hello world', at: Date.now() });
    await controller.stop();

    expect(submitted.map((segment) => segment.text)).toEqual(['hello world tail']);
  });

  it('silently completes when the user did not produce speech', async () => {
    const asr = new FakeAsrProvider();
    const states: VoiceInputState[] = [];
    const outcomes: string[] = [];
    const errors: string[] = [];
    const controller = new VoiceInputController({
      asr,
      logger: new VoiceTimelineLogger(),
      stableWaitMs: 0,
      callbacks: {
        onStateChanged: (state, outcome) => {
          states.push(state);
          if (outcome) outcomes.push(outcome);
        },
        onDraftChanged: () => {},
        onSubmitted: () => undefined,
        onError: (message) => errors.push(message),
      },
    });

    await controller.start();
    controller.appendAudio(pcmChunk(0), {
      capturedAt: 0,
      convertedAt: 0,
      chunkIndex: 0,
      sampleRate: 16_000,
      durationMs: 10,
    });
    await controller.stop();

    expect(controller.currentState).toBe('done');
    expect(states.at(-1)).toBe('done');
    expect(outcomes.at(-1)).toBe('no_speech');
    expect(errors).toEqual([]);
  });

  it('surfaces an error when speech was detected but the transcript is empty', async () => {
    const asr = new FakeAsrProvider();
    const states: VoiceInputState[] = [];
    const errors: Array<{ message: string; code?: string }> = [];
    const controller = new VoiceInputController({
      asr,
      logger: new VoiceTimelineLogger(),
      stableWaitMs: 0,
      callbacks: {
        onStateChanged: (state) => states.push(state),
        onDraftChanged: () => {},
        onSubmitted: () => undefined,
        onError: (message, code) => errors.push({ message, code }),
      },
    });

    await controller.start();
    controller.appendAudio(pcmChunk(1_000), {
      capturedAt: 0,
      convertedAt: 0,
      chunkIndex: 0,
      sampleRate: 16_000,
      durationMs: 10,
    });
    await controller.stop();

    expect(controller.currentState).toBe('error');
    expect(states.at(-1)).toBe('error');
    expect(errors).toEqual([{
      message: 'Voice input detected speech but returned no transcript. Please try again.',
      code: 'empty_transcript',
    }]);
  });

  it('keeps the transcript recognized before a fatal transport drop', async () => {
    const asr = new FakeAsrProvider();
    const submitted: string[] = [];
    const errors: Array<{ message: string; code?: string; kept?: boolean }> = [];
    const timeline: VoiceTimelineEvent[] = [];
    const controller = new VoiceInputController({
      asr,
      logger: new VoiceTimelineLogger((event) => timeline.push(event)),
      callbacks: {
        onDraftChanged: () => {},
        onSubmitted: (text, segment) => {
          submitted.push(text);
          return acceptSubmission(text, segment);
        },
        onError: (message, code, details) => errors.push({ message, code, kept: details?.transcriptKept }),
      },
    });

    await controller.start();
    asr.emit({ type: 'partial', text: 'half a sentence', at: Date.now() });
    asr.emit({ type: 'disconnected', at: Date.now() });

    expect(submitted).toEqual(['half a sentence']);
    expect(errors).toEqual([{
      message: 'Voice input connection was interrupted. Please try again.',
      code: 'connection_interrupted',
      kept: true,
    }]);
    expect(controller.currentState).toBe('error');
    expect(timeline).toContainEqual(expect.objectContaining({
      type: 'transcript_salvaged',
      text: 'half a sentence',
      source: 'partial',
    }));
  });

  it('hands the transcript to the host before the terminal error state', async () => {
    const asr = new FakeAsrProvider();
    const calls: string[] = [];
    const controller = new VoiceInputController({
      asr,
      logger: new VoiceTimelineLogger(),
      callbacks: {
        onStateChanged: (state) => calls.push(`state:${state}`),
        onDraftChanged: () => {},
        onSubmitted: (text, segment) => {
          calls.push('submitted');
          return acceptSubmission(text, segment);
        },
        onError: () => calls.push('error'),
      },
    });

    await controller.start();
    asr.emit({ type: 'stable', text: 'ordering matters', at: Date.now() });
    asr.emit({ type: 'disconnected', at: Date.now() });

    // Hosts drop their draft on 'error', so the text has to land first.
    expect(calls).toEqual(['state:listening', 'submitted', 'state:error', 'error']);
  });

  it('keeps the transcript when stop-time flush fails', async () => {
    const asr = new FakeAsrProvider();
    asr.flush = async () => {
      throw new Error('socket closed');
    };
    const submitted: string[] = [];
    const errors: Array<{ message: string; code?: string; kept?: boolean }> = [];
    const timeline: VoiceTimelineEvent[] = [];
    const controller = new VoiceInputController({
      asr,
      logger: new VoiceTimelineLogger((event) => timeline.push(event)),
      callbacks: {
        onDraftChanged: () => {},
        onSubmitted: (text, segment) => {
          submitted.push(text);
          return acceptSubmission(text, segment);
        },
        onError: (message, code, details) => errors.push({ message, code, kept: details?.transcriptKept }),
      },
    });

    await controller.start();
    asr.emit({ type: 'stable', text: 'kept text', at: Date.now() });
    await controller.stop();

    expect(submitted).toEqual(['kept text']);
    expect(errors).toEqual([{ message: 'socket closed', code: undefined, kept: true }]);
    expect(timeline).toContainEqual(expect.objectContaining({
      type: 'transcript_salvaged',
      text: 'kept text',
      source: 'stable',
    }));
  });

  it('does not submit twice when recovery rejects after stop already submitted', async () => {
    const asr = new FakeAsrProvider();
    let rejectRecover: ((error: Error) => void) | undefined;
    asr.recover = () => new Promise<void>((_resolve, reject) => {
      rejectRecover = reject;
    });
    const submitted: string[] = [];
    const errors: Array<{ message: string; code?: string; kept?: boolean }> = [];
    const controller = new VoiceInputController({
      asr,
      logger: new VoiceTimelineLogger(),
      stableWaitMs: 0,
      refiner: {
        refine: () => new Promise<RefinementResult>(() => {}),
      },
      callbacks: {
        onDraftChanged: () => {},
        onSubmitted: (text, segment) => {
          submitted.push(text);
          return {
            id: 'range-1',
            segmentIds: [segment.id],
            startOffset: 0,
            endOffset: text.length,
            userTouched: false,
          };
        },
        onError: (message, code, details) => errors.push({ message, code, kept: details?.transcriptKept }),
      },
    });

    await controller.start();
    asr.emit({ type: 'partial', text: 'one submission only', at: Date.now() });
    asr.emit({ type: 'disconnected', at: Date.now() });
    await controller.stop();

    expect(controller.currentState).toBe('refining');
    expect(submitted).toEqual(['one submission only']);

    rejectRecover?.(new Error('network down'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(submitted).toEqual(['one submission only']);
    expect(errors).toEqual([{
      message: 'Voice input stopped receiving recognition. Please try again.',
      code: 'recognition_stalled',
      kept: true,
    }]);
  });

  it('salvages the newest transcript when a partial follows a stable', async () => {
    const asr = new FakeAsrProvider();
    const submitted: string[] = [];
    const timeline: VoiceTimelineEvent[] = [];
    const controller = new VoiceInputController({
      asr,
      logger: new VoiceTimelineLogger((event) => timeline.push(event)),
      callbacks: {
        onDraftChanged: () => {},
        onSubmitted: (text, segment) => {
          submitted.push(text);
          return acceptSubmission(text, segment);
        },
      },
    });

    await controller.start();
    // Providers emit both lanes as the full aggregate transcript, so the partial
    // for the utterance in progress already contains the completed one.
    asr.emit({ type: 'stable', text: 'first sentence.', at: Date.now() });
    asr.emit({ type: 'partial', text: 'first sentence. second sen', at: Date.now() });
    asr.emit({ type: 'disconnected', at: Date.now() });

    expect(submitted).toEqual(['first sentence. second sen']);
    expect(timeline).toContainEqual(expect.objectContaining({
      type: 'transcript_salvaged',
      source: 'partial',
    }));
  });

  it('does not resubmit when a failure lands while stop is flushing', async () => {
    const asr = new FakeAsrProvider();
    let rejectRecover: ((error: Error) => void) | undefined;
    asr.recover = () => new Promise<void>((_resolve, reject) => {
      rejectRecover = reject;
    });
    let releaseFlush: (() => void) | undefined;
    asr.flush = () => new Promise<void>((resolve) => {
      releaseFlush = resolve;
    });
    const submitted: string[] = [];
    const errors: Array<{ message: string; code?: string; kept?: boolean }> = [];
    const controller = new VoiceInputController({
      asr,
      logger: new VoiceTimelineLogger(),
      stableWaitMs: 0,
      callbacks: {
        onDraftChanged: () => {},
        onSubmitted: (text, segment) => {
          submitted.push(text);
          return acceptSubmission(text, segment);
        },
        onError: (message, code, details) => errors.push({ message, code, kept: details?.transcriptKept }),
      },
    });

    await controller.start();
    asr.emit({ type: 'partial', text: 'only once', at: Date.now() });
    asr.emit({ type: 'disconnected', at: Date.now() });

    const stopPromise = controller.stop();
    await Promise.resolve();

    rejectRecover?.(new Error('network down'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(submitted).toEqual(['only once']);
    expect(controller.currentState).toBe('error');

    // Providers await an in-flight recover() during flushAudio() but swallow its
    // rejection, so stop() resumes on an already-failed run.
    releaseFlush?.();
    await stopPromise;

    expect(submitted).toEqual(['only once']);
    expect(controller.currentState).toBe('error');
    expect(errors).toEqual([{
      message: 'Voice input stopped receiving recognition. Please try again.',
      code: 'recognition_stalled',
      kept: true,
    }]);
  });

  it('does not resubmit when a failure lands while the provider is stopping', async () => {
    const asr = new FakeAsrProvider();
    let rejectRecover: ((error: Error) => void) | undefined;
    asr.recover = () => new Promise<void>((_resolve, reject) => {
      rejectRecover = reject;
    });
    let releaseStop: (() => void) | undefined;
    asr.stopHook = () => new Promise<void>((resolve) => {
      releaseStop = resolve;
    });
    const submitted: string[] = [];
    const errors: Array<{ message: string; code?: string; kept?: boolean }> = [];
    const controller = new VoiceInputController({
      asr,
      logger: new VoiceTimelineLogger(),
      stableWaitMs: 0,
      callbacks: {
        onDraftChanged: () => {},
        onSubmitted: (text, segment) => {
          submitted.push(text);
          return acceptSubmission(text, segment);
        },
        onError: (message, code, details) => errors.push({ message, code, kept: details?.transcriptKept }),
      },
    });

    await controller.start();
    asr.emit({ type: 'partial', text: 'only once', at: Date.now() });
    asr.emit({ type: 'disconnected', at: Date.now() });

    const stopPromise = controller.stop();
    await new Promise((resolve) => setTimeout(resolve, 0));

    // The run fails while stop() is parked on the provider's stop(), i.e. after
    // the flush window has already closed.
    rejectRecover?.(new Error('network down'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(submitted).toEqual(['only once']);
    expect(controller.currentState).toBe('error');

    releaseStop?.();
    await stopPromise;

    expect(submitted).toEqual(['only once']);
    expect(controller.currentState).toBe('error');
  });

  it('does not strand the run when the host throws on submit', async () => {
    const asr = new FakeAsrProvider();
    const errors: Array<{ message: string; code?: string; kept?: boolean }> = [];
    let submitAttempts = 0;
    const controller = new VoiceInputController({
      asr,
      logger: new VoiceTimelineLogger(),
      stableWaitMs: 0,
      callbacks: {
        onDraftChanged: () => {},
        onSubmitted: () => {
          // e.g. the composer's window was destroyed while stop() was in flight
          submitAttempts += 1;
          throw new Error('editor is gone');
        },
        onError: (message, code, details) => errors.push({ message, code, kept: details?.transcriptKept }),
      },
    });

    await controller.start();
    asr.emit({ type: 'partial', text: 'nowhere to go', at: Date.now() });
    await expect(controller.stop()).resolves.toBeUndefined();

    // A terminal state is what lets the next dictation start at all.
    expect(controller.currentState).toBe('error');
    expect(errors).toEqual([{ message: 'editor is gone', code: undefined, kept: false }]);
    // Exactly one attempt: a callback that threw part-way has already run an
    // unknown share of its side effects, so salvage must not run it again.
    expect(submitAttempts).toBe(1);
    await expect(controller.start()).resolves.toMatch(/./);
  });

  it('does not claim retention when the host refuses the salvaged text', async () => {
    const asr = new FakeAsrProvider();
    const timeline: VoiceTimelineEvent[] = [];
    const errors: Array<{ message: string; code?: string; kept?: boolean }> = [];
    const controller = new VoiceInputController({
      asr,
      logger: new VoiceTimelineLogger((event) => timeline.push(event)),
      callbacks: {
        onDraftChanged: () => {},
        // Mobile refuses writes once the user has edited the voice insertion,
        // so the salvaged text never lands in the composer.
        onSubmitted: () => undefined,
        onError: (message, code, details) => errors.push({ message, code, kept: details?.transcriptKept }),
      },
    });

    await controller.start();
    asr.emit({ type: 'partial', text: 'never lands', at: Date.now() });
    asr.emit({ type: 'disconnected', at: Date.now() });

    expect(errors).toEqual([{
      message: 'Voice input connection was interrupted. Please try again.',
      code: 'connection_interrupted',
      kept: false,
    }]);
    expect(timeline).toContainEqual(expect.objectContaining({
      type: 'transcript_salvaged',
      accepted: false,
    }));
  });

  it('logs an interrupted stop as cancelled when the user cancelled', async () => {
    const asr = new FakeAsrProvider();
    // stop() and cancel() each await the provider's stop(); hold both and
    // release them together, otherwise the first one never settles.
    const stopResolvers: Array<() => void> = [];
    asr.stopHook = () => new Promise<void>((resolve) => {
      stopResolvers.push(resolve);
    });
    const timeline: VoiceTimelineEvent[] = [];
    const controller = new VoiceInputController({
      asr,
      logger: new VoiceTimelineLogger((event) => timeline.push(event)),
      stableWaitMs: 0,
      refiner: {
        refine: () => new Promise<RefinementResult>(() => {}),
      },
      callbacks: {
        onDraftChanged: () => {},
        onSubmitted: (text, segment) => ({
          id: 'range-1',
          segmentIds: [segment.id],
          startOffset: 0,
          endOffset: text.length,
          userTouched: false,
        }),
      },
    });

    await controller.start();
    asr.emit({ type: 'partial', text: 'abandoned', at: Date.now() });
    const stopPromise = controller.stop();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const cancelPromise = controller.cancel();
    stopResolvers.splice(0).forEach((resolve) => resolve());
    await cancelPromise;
    stopResolvers.splice(0).forEach((resolve) => resolve());
    await stopPromise;

    expect(timeline).toContainEqual(expect.objectContaining({
      type: 'refine_discarded',
      reason: 'cancelled',
    }));
    expect(timeline).not.toContainEqual(expect.objectContaining({
      type: 'refine_discarded',
      reason: 'run_failed',
    }));
  });

  it('does not let a late refinement overwrite a failed run', async () => {
    const asr = new FakeAsrProvider();
    let rejectRecover: ((error: Error) => void) | undefined;
    asr.recover = () => new Promise<void>((_resolve, reject) => {
      rejectRecover = reject;
    });
    let resolveRefine: ((result: RefinementResult) => void) | undefined;
    const applied: string[] = [];
    const states: VoiceInputState[] = [];
    const controller = new VoiceInputController({
      asr,
      logger: new VoiceTimelineLogger(),
      stableWaitMs: 0,
      refiner: {
        refine: () => new Promise<RefinementResult>((resolve) => {
          resolveRefine = resolve;
        }),
      },
      callbacks: {
        onStateChanged: (state) => states.push(state),
        onDraftChanged: () => {},
        onSubmitted: (text, segment) => ({
          id: 'range-1',
          segmentIds: [segment.id],
          startOffset: 0,
          endOffset: text.length,
          userTouched: false,
        }),
        applyRefinement: (_range, refinedText) => {
          applied.push(refinedText);
          return true;
        },
        onError: () => {},
      },
    });

    await controller.start();
    asr.emit({ type: 'partial', text: 'text under refinement', at: Date.now() });
    asr.emit({ type: 'disconnected', at: Date.now() });
    await controller.stop();
    expect(controller.currentState).toBe('refining');

    // Recovery gives up while refinement is still running.
    rejectRecover?.(new Error('network down'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(controller.currentState).toBe('error');

    resolveRefine?.({
      accepted: true,
      sourceSegmentIds: ['segment-1'],
      basedOnText: 'text under refinement',
      refinedText: 'Text under refinement.',
      elapsedMs: 1,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    // The user was already told the run failed; refinement must not rewrite
    // their text nor flip the run back to a success state.
    expect(applied).toEqual([]);
    expect(controller.currentState).toBe('error');
    expect(states.at(-1)).toBe('error');
  });

  it('reports the original failure cause alongside the retention flag', async () => {
    const asr = new FakeAsrProvider();
    const errors: Array<{ message: string; code?: string; kept?: boolean }> = [];
    const controller = new VoiceInputController({
      asr,
      logger: new VoiceTimelineLogger(),
      callbacks: {
        onDraftChanged: () => {},
        onSubmitted: acceptSubmission,
        onError: (message, code, details) => errors.push({ message, code, kept: details?.transcriptKept }),
      },
    });

    await controller.start();
    asr.emit({ type: 'partial', text: 'said something', at: Date.now() });
    // An auth/quota failure must not be flattened into "the connection dropped":
    // retention rides along as a detail so hosts can show both.
    asr.emit({ type: 'error', message: 'Voice credential expired.', at: Date.now() });

    expect(errors).toEqual([{ message: 'Voice credential expired.', code: undefined, kept: true }]);
  });

  it('ignores stop-time ASR errors after transcript text is available', async () => {
    const asr = new FakeAsrProvider();
    const errors: string[] = [];
    const applied: string[] = [];
    const timeline: VoiceTimelineEvent[] = [];
    const controller = new VoiceInputController({
      asr,
      logger: new VoiceTimelineLogger((event) => timeline.push(event)),
      stableWaitMs: 0,
      refiner: {
        async refine(input) {
          return {
            accepted: true,
            sourceSegmentIds: input.segmentIds,
            basedOnText: input.text,
            refinedText: 'Hello world.',
            elapsedMs: 1,
          };
        },
      },
      callbacks: {
        onDraftChanged: () => {},
        onError: (message) => errors.push(message),
        onSubmitted: (_text, segment) => ({
          id: 'range-1',
          segmentIds: [segment.id],
          startOffset: 0,
          endOffset: segment.text.length,
          userTouched: false,
        }),
        applyRefinement: (_range, refinedText) => {
          applied.push(refinedText);
          return true;
        },
      },
    });
    asr.flush = async () => {
      asr.emit({ type: 'error', message: 'commit failed after stop', at: Date.now() });
    };

    await controller.start();
    asr.emit({ type: 'partial', text: 'hello world', at: Date.now() });
    await controller.stop();
    await Promise.resolve();

    expect(errors).toEqual([]);
    expect(applied).toEqual(['Hello world.']);
    expect(controller.currentState).toBe('done');
    expect(timeline).toContainEqual(expect.objectContaining({
      type: 'asr_stop_error_ignored',
      textChars: 'hello world'.length,
    }));
  });

  it('ignores late ASR errors after submission while refinement is in flight', async () => {
    const asr = new FakeAsrProvider();
    const errors: string[] = [];
    const applied: string[] = [];
    const timeline: VoiceTimelineEvent[] = [];
    let resolveRefinement!: (result: RefinementResult) => void;
    const controller = new VoiceInputController({
      asr,
      logger: new VoiceTimelineLogger((event) => timeline.push(event)),
      stableWaitMs: 0,
      refiner: {
        refine: () => new Promise<RefinementResult>((resolve) => {
          resolveRefinement = resolve;
        }),
      },
      callbacks: {
        onDraftChanged: () => {},
        onError: (message) => errors.push(message),
        onSubmitted: (_text, segment) => ({
          id: 'range-1',
          segmentIds: [segment.id],
          startOffset: 0,
          endOffset: segment.text.length,
          userTouched: false,
        }),
        applyRefinement: (_range, refinedText) => {
          applied.push(refinedText);
          return true;
        },
      },
    });

    await controller.start();
    asr.emit({ type: 'partial', text: 'hello world', at: Date.now() });
    await controller.stop();

    expect(controller.currentState).toBe('refining');
    asr.emit({ type: 'error', message: 'late commit failed after submitted', at: Date.now() });
    expect(errors).toEqual([]);
    expect(controller.currentState).toBe('refining');

    resolveRefinement({
      accepted: true,
      sourceSegmentIds: [],
      basedOnText: 'hello world',
      refinedText: 'Hello world.',
      elapsedMs: 1,
    });

    await vi.waitFor(() => expect(applied).toEqual(['Hello world.']));
    expect(controller.currentState).toBe('done');
    expect(timeline).toContainEqual(expect.objectContaining({
      type: 'asr_stop_error_ignored',
      textChars: 'hello world'.length,
    }));
  });

  it('surfaces unexpected ASR disconnects while listening', async () => {
    const asr = new FakeAsrProvider();
    const states: VoiceInputState[] = [];
    const errors: string[] = [];
    const timeline: VoiceTimelineEvent[] = [];
    const controller = new VoiceInputController({
      asr,
      logger: new VoiceTimelineLogger((event) => timeline.push(event)),
      callbacks: {
        onStateChanged: (state) => states.push(state),
        onDraftChanged: () => {},
        onSubmitted: () => undefined,
        onError: (message) => errors.push(message),
      },
    });

    await controller.start();
    asr.emit({ type: 'disconnected', at: Date.now() });

    expect(states.at(-1)).toBe('error');
    expect(errors).toEqual(['Voice input connection was interrupted. Please try again.']);
    expect(timeline).toContainEqual(expect.objectContaining({
      type: 'error',
      message: 'Voice input connection was interrupted. Please try again.',
    }));
  });

  it('does not surface provider disconnects caused by cancel', async () => {
    const asr = new FakeAsrProvider();
    const states: VoiceInputState[] = [];
    const errors: string[] = [];
    const timeline: VoiceTimelineEvent[] = [];
    const controller = new VoiceInputController({
      asr,
      logger: new VoiceTimelineLogger((event) => timeline.push(event)),
      callbacks: {
        onStateChanged: (state) => states.push(state),
        onDraftChanged: () => {},
        onSubmitted: () => undefined,
        onError: (message) => errors.push(message),
      },
    });

    await controller.start();
    await controller.cancel();

    expect(controller.currentState).toBe('done');
    expect(states.at(-1)).toBe('done');
    expect(errors).toEqual([]);
    expect(timeline).toContainEqual(expect.objectContaining({ type: 'cancelled' }));
    expect(timeline).not.toContainEqual(expect.objectContaining({ type: 'error' }));
  });

  it('runs optional refinement after submitted text', async () => {
    const asr = new FakeAsrProvider();
    const applied: string[] = [];
    const states: VoiceInputState[] = [];
    const range: EditableRange = {
      id: 'range-1',
      segmentIds: ['placeholder'],
      startOffset: 0,
      endOffset: 5,
      userTouched: false,
    };
    const controller = new VoiceInputController({
      asr,
      logger: new VoiceTimelineLogger(),
      stableWaitMs: 0,
      refiner: {
        async refine(input) {
          return {
            accepted: true,
            sourceSegmentIds: input.segmentIds,
            basedOnText: input.text,
            refinedText: 'Hello world.',
            elapsedMs: 1,
          };
        },
      },
      callbacks: {
        onStateChanged: (state) => states.push(state),
        onDraftChanged: () => {},
        onSubmitted: (_text, segment) => ({
          ...range,
          segmentIds: [segment.id],
        }),
        applyRefinement: (_range, refinedText) => {
          applied.push(refinedText);
          return true;
        },
      },
    });

    await controller.start();
    asr.emit({ type: 'partial', text: 'hello world', at: Date.now() });
    await controller.stop();

    expect(states).toContain('refining');
    expect(applied).toEqual(['Hello world.']);
    expect(states.at(-1)).toBe('done');
  });

  it('starts refinement while stop-time ASR finalization is still pending', async () => {
    const asr = new FakeAsrProvider();
    const applied: string[] = [];
    let resolveFlush: (() => void) | undefined;
    let refineCalls = 0;
    asr.flush = async () => {
      await new Promise<void>((resolve) => {
        resolveFlush = resolve;
      });
      asr.emit({ type: 'stable', text: 'hello world', at: Date.now() });
    };

    const controller = new VoiceInputController({
      asr,
      logger: new VoiceTimelineLogger(),
      stableWaitMs: 0,
      refiner: {
        async refine(input) {
          refineCalls += 1;
          return {
            accepted: true,
            sourceSegmentIds: input.segmentIds,
            basedOnText: input.text,
            refinedText: 'Hello world.',
            elapsedMs: 1,
          };
        },
      },
      callbacks: {
        onStateChanged: () => {},
        onDraftChanged: () => {},
        onSubmitted: (_text, segment) => ({
          id: 'range-1',
          segmentIds: [segment.id],
          startOffset: 0,
          endOffset: segment.text.length,
          userTouched: false,
        }),
        applyRefinement: (_range, refinedText) => {
          applied.push(refinedText);
          return true;
        },
      },
    });

    await controller.start();
    asr.emit({ type: 'partial', text: 'hello world', at: Date.now() });
    const stopPromise = controller.stop();
    await Promise.resolve();

    expect(refineCalls).toBe(1);
    expect(applied).toEqual([]);

    resolveFlush?.();
    await stopPromise;
    await Promise.resolve();

    expect(refineCalls).toBe(1);
    expect(applied).toEqual(['Hello world.']);
  });

  it('attempts recover instead of failing on disconnect when provider supports it', async () => {
    const asr = new FakeAsrProvider();
    let recoverCalls = 0;
    asr.recover = async () => {
      recoverCalls += 1;
    };
    const states: VoiceInputState[] = [];
    const errors: string[] = [];
    const timeline: VoiceTimelineEvent[] = [];
    const controller = new VoiceInputController({
      asr,
      logger: new VoiceTimelineLogger((event) => timeline.push(event)),
      callbacks: {
        onStateChanged: (state) => states.push(state),
        onDraftChanged: () => {},
        onSubmitted: () => undefined,
        onError: (message) => errors.push(message),
      },
    });

    await controller.start();
    asr.emit({ type: 'disconnected', at: Date.now() });
    // Let the recover().then chain settle.
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(recoverCalls).toBe(1);
    expect(errors).toEqual([]);
    expect(states).not.toContain('error');
    expect(timeline).toContainEqual(expect.objectContaining({
      type: 'asr_recovery_attempted',
      trigger: 'disconnected',
      attempt: 1,
    }));
    expect(timeline).toContainEqual(expect.objectContaining({ type: 'asr_recovery_succeeded' }));
  });

  it('does not recover from a partial stall while the transport stays connected', async () => {
    vi.useFakeTimers();
    try {
      const asr = new FakeAsrProvider();
      let recoverCalls = 0;
      asr.recover = async () => {
        recoverCalls += 1;
      };
      const timeline: VoiceTimelineEvent[] = [];
      const controller = new VoiceInputController({
        asr,
        logger: new VoiceTimelineLogger((event) => timeline.push(event)),
        stableWaitMs: 0,
        callbacks: {
          onDraftChanged: () => {},
          onSubmitted: () => undefined,
        },
      });

      await controller.start();
      const voicedChunk = new Int16Array(320).fill(1_000).buffer;
      for (let i = 0; i < 60; i += 1) {
        controller.appendAudio(voicedChunk, {
          capturedAt: Date.now(),
          convertedAt: Date.now(),
          chunkIndex: i,
          sampleRate: 16_000,
          durationMs: 40,
        });
      }

      await vi.advanceTimersByTimeAsync(5_000);

      expect(recoverCalls).toBe(0);
      expect(controller.currentState).toBe('listening');
      expect(timeline).toContainEqual(expect.objectContaining({ type: 'asr_stall_warning' }));
      expect(timeline).not.toContainEqual(expect.objectContaining({ type: 'asr_recovery_attempted' }));

      const stopPromise = controller.stop();
      await vi.advanceTimersByTimeAsync(0);
      await stopPromise;
    } finally {
      vi.useRealTimers();
    }
  });

  it('caps network recover attempts per run', async () => {
    const asr = new FakeAsrProvider();
    let recoverCalls = 0;
    asr.recover = async () => {
      recoverCalls += 1;
    };
    const errors: string[] = [];
    const controller = new VoiceInputController({
      asr,
      logger: new VoiceTimelineLogger(),
      callbacks: {
        onDraftChanged: () => {},
        onSubmitted: () => undefined,
        onError: (message) => errors.push(message),
      },
    });

    await controller.start();
    for (let i = 0; i < 3; i += 1) {
      asr.emit({ type: 'disconnected', at: Date.now() });
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    asr.emit({ type: 'disconnected', at: Date.now() });

    expect(recoverCalls).toBe(3);
    expect(controller.currentState).toBe('error');
    expect(errors).toEqual(['Voice input connection was interrupted. Please try again.']);
  });

  it('falls through to fail when recover throws after disconnect', async () => {
    const asr = new FakeAsrProvider();
    asr.recover = async () => {
      throw new Error('network down');
    };
    const states: VoiceInputState[] = [];
    const errors: string[] = [];
    const controller = new VoiceInputController({
      asr,
      logger: new VoiceTimelineLogger(),
      callbacks: {
        onStateChanged: (state) => states.push(state),
        onDraftChanged: () => {},
        onSubmitted: () => undefined,
        onError: (message) => errors.push(message),
      },
    });

    await controller.start();
    asr.emit({ type: 'disconnected', at: Date.now() });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(states.at(-1)).toBe('error');
    expect(errors.length).toBe(1);
  });

  it('ignores stale refinement results after a new run starts', async () => {
    const asr = new FakeAsrProvider();
    const applied: string[] = [];
    const states: VoiceInputState[] = [];
    let resolveRefine: ((result: RefinementResult) => void) | undefined;

    const controller = new VoiceInputController({
      asr,
      logger: new VoiceTimelineLogger(),
      stableWaitMs: 0,
      refiner: {
        async refine() {
          return await new Promise<RefinementResult>((resolve) => {
            resolveRefine = resolve;
          });
        },
      },
      callbacks: {
        onStateChanged: (state) => states.push(state),
        onDraftChanged: () => {},
        onSubmitted: (_text, segment) => ({
          id: 'range-1',
          segmentIds: [segment.id],
          startOffset: 0,
          endOffset: segment.text.length,
          userTouched: false,
        }),
        applyRefinement: (_range, refinedText) => {
          applied.push(refinedText);
          return true;
        },
      },
    });

    await controller.start();
    asr.emit({ type: 'partial', text: 'old run', at: Date.now() });
    await controller.stop();
    expect(controller.currentState).toBe('refining');

    await controller.cancel();
    await controller.start();
    expect(controller.currentState).toBe('listening');

    resolveRefine?.({
      accepted: true,
      sourceSegmentIds: ['old-segment'],
      basedOnText: 'old run',
      refinedText: 'Old run.',
      elapsedMs: 1,
    });
    await Promise.resolve();

    expect(applied).toEqual([]);
    expect(controller.currentState).toBe('listening');
    expect(states.at(-1)).toBe('listening');
  });
});
