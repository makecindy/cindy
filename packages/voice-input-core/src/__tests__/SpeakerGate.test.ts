import { describe, expect, it } from 'vitest';

import {
  SPEAKER_GATE_SAMPLE_RATE,
  SPEAKER_GATE_VAD_FRAME,
  SpeakerGate,
  type SpeakerGateDecision,
  type SpeakerGateEngine,
} from '../SpeakerGate.js';
import { buildSpeakerEnrollment, type SpeakerEnrollmentEngine } from '../speakerEnrollment.js';
import type { AudioTrace } from '../types.js';

// Synthetic voices: the owner is a positive DC level, a bystander a negative
// one. The fake engine "embeds" by the sign of the mean, which is enough to
// exercise the gate's holding, ordering and muting without real models.
const OWNER = 8_000;
const BYSTANDER = -8_000;
const OWNER_PRINT = new Float32Array([1, 0]);

class FakeEngine implements SpeakerGateEngine {
  embedCalls = 0;
  embedInputs: Float32Array[] = [];
  failEmbed = false;
  hangEmbed = false;

  async resetVad(): Promise<void> {}

  async detectSpeech(samples: Float32Array): Promise<boolean[]> {
    const flags: boolean[] = [];
    for (let i = 0; i + SPEAKER_GATE_VAD_FRAME <= samples.length; i += SPEAKER_GATE_VAD_FRAME) {
      let energy = 0;
      for (let j = i; j < i + SPEAKER_GATE_VAD_FRAME; j += 1) energy += Math.abs(samples[j]);
      flags.push(energy / SPEAKER_GATE_VAD_FRAME > 0.05);
    }
    return flags;
  }

  async embed(samples: Float32Array): Promise<Float32Array | null> {
    this.embedCalls += 1;
    this.embedInputs.push(samples.slice());
    if (this.failEmbed) throw new Error('model crashed');
    if (this.hangEmbed) return new Promise(() => {});
    let sum = 0;
    for (const sample of samples) sum += sample;
    return sum >= 0 ? new Float32Array([1, 0]) : new Float32Array([0, 1]);
  }
}

type Emitted = { samples: Int16Array; trace?: AudioTrace };

function makeAudio(parts: Array<[level: number, seconds: number]>): Int16Array {
  const total = parts.reduce((sum, [, sec]) => sum + Math.round(sec * SPEAKER_GATE_SAMPLE_RATE), 0);
  const out = new Int16Array(total);
  let offset = 0;
  for (const [level, sec] of parts) {
    const length = Math.round(sec * SPEAKER_GATE_SAMPLE_RATE);
    out.fill(level, offset, offset + length);
    offset += length;
  }
  return out;
}

/** Pushes audio in 40 ms chunks, the cadence the desktop capture uses. */
function pushAll(gate: SpeakerGate, audio: Int16Array): void {
  const chunk = 640;
  for (let i = 0, index = 0; i < audio.length; i += chunk, index += 1) {
    const slice = audio.slice(i, Math.min(audio.length, i + chunk));
    gate.push(slice.buffer, {
      capturedAt: index,
      convertedAt: index,
      chunkIndex: index,
      sampleRate: SPEAKER_GATE_SAMPLE_RATE,
      durationMs: 40,
    });
  }
}

function joined(emitted: Emitted[]): Int16Array {
  const out = new Int16Array(emitted.reduce((sum, item) => sum + item.samples.length, 0));
  let offset = 0;
  for (const item of emitted) {
    out.set(item.samples, offset);
    offset += item.samples.length;
  }
  return out;
}

function countLevel(samples: Int16Array, from: number, to: number, level: number): number {
  let count = 0;
  for (let i = Math.round(from * SPEAKER_GATE_SAMPLE_RATE); i < Math.round(to * SPEAKER_GATE_SAMPLE_RATE); i += 1) {
    if (samples[i] === level) count += 1;
  }
  return count;
}

function startGate(engine: FakeEngine, extra: Partial<ConstructorParameters<typeof SpeakerGate>[0]> = {}) {
  const emitted: Emitted[] = [];
  const decisions: SpeakerGateDecision[] = [];
  const passthrough: string[] = [];
  const gate = new SpeakerGate({
    engine,
    enrolledEmbedding: OWNER_PRINT,
    onDecision: (decision) => decisions.push(decision),
    onPassthrough: (reason) => passthrough.push(reason),
    ...extra,
  });
  gate.begin((chunk, trace) => emitted.push({ samples: new Int16Array(chunk), trace }));
  return { gate, emitted, decisions, passthrough };
}

describe('SpeakerGate', () => {
  it.each([0, 0.6])('verifies complete windows rounded to VAD frames after %s s of silence', async (silenceSec) => {
    const engine = new FakeEngine();
    const { gate, decisions, emitted, passthrough } = startGate(engine);
    const audio = makeAudio([[0, silenceSec], [OWNER, 3.2]]);

    pushAll(gate, audio);
    await gate.finish();

    const completeWindows = decisions.filter(({ startSample, endSample }) => endSample - startSample >= SPEAKER_GATE_SAMPLE_RATE);
    expect(completeWindows.length).toBeGreaterThanOrEqual(2);
    // 1.5 seconds does not align with 512-sample VAD frames. The model must
    // receive the entire window it judges, including the rounded-up samples.
    expect(completeWindows[0].endSample - completeWindows[0].startSample).toBeGreaterThan(1.5 * SPEAKER_GATE_SAMPLE_RATE);
    decisions.forEach(({ startSample, endSample }, index) => {
      if (endSample - startSample < SPEAKER_GATE_SAMPLE_RATE) return;
      const expected = Float32Array.from(audio.slice(startSample, endSample), (sample) => sample / 32768);
      expect(engine.embedInputs[index].length).toBe(expected.length);
      expect(engine.embedInputs[index]).toEqual(expected);
    });
    expect(passthrough).toEqual([]);
    expect(joined(emitted)).toEqual(audio);
  });

  it('still supplements a short final window with recent speech', async () => {
    const engine = new FakeEngine();
    const { gate, decisions } = startGate(engine);
    const audio = makeAudio([[OWNER, 0.8], [OWNER / 2, 0.9]]);

    pushAll(gate, audio);
    await gate.finish();

    const last = decisions[decisions.length - 1];
    expect(last.endSample - last.startSample).toBeLessThan(SPEAKER_GATE_SAMPLE_RATE);
    expect(engine.embedInputs[engine.embedInputs.length - 1]).toEqual(
      Float32Array.from(audio.slice(-SPEAKER_GATE_SAMPLE_RATE), (sample) => sample / 32768),
    );
  });

  it.each(['different speaker', 'unusable embedding'] as const)(
    'does not pad the owner\'s next short phrase with a rejected %s', async rejection => {
      const engine = new FakeEngine();
      if (rejection === 'unusable embedding') {
        const embed = engine.embed.bind(engine);
        engine.embed = async samples => {
          const result = await embed(samples);
          return result?.[1] === 1 ? null : result;
        };
      }
      const { gate, emitted, decisions, passthrough } = startGate(engine);
      // Exact VAD frames: a rejected full window and remainder, a brief pause,
      // then an owner's phrase too short to fill minVerifySec on its own.
      const audio = makeAudio([[BYSTANDER, 1.6], [0, 0.064], [OWNER, 0.256]]);
      pushAll(gate, audio);
      await gate.finish();

      expect(decisions[0].accepted).toBe(false);
      const last = decisions[decisions.length - 1];
      expect(last.accepted).toBe(true);
      const current = Float32Array.from(audio.slice(last.startSample, last.endSample), sample => sample / 32768);
      expect(engine.embedInputs[engine.embedInputs.length - 1]).toEqual(current);
      const out = joined(emitted);
      expect(out.length).toBe(audio.length);
      expect(countLevel(out, 0, 1.6, BYSTANDER)).toBe(0);
      expect(countLevel(out, 1.664, 1.92, OWNER)).toBe(Math.round(0.256 * SPEAKER_GATE_SAMPLE_RATE));
      expect(passthrough).toEqual([]);
    },
  );

  it('clears older accepted context when a different speaker interrupts', async () => {
    const engine = new FakeEngine();
    const { gate, emitted, decisions } = startGate(engine);
    const audio = makeAudio([[OWNER, 1.6], [0, 0.064], [BYSTANDER, 1.6], [0, 0.064], [BYSTANDER, 0.256]]);
    pushAll(gate, audio);
    await gate.finish();

    expect(decisions[0].accepted).toBe(true);
    expect(decisions[decisions.length - 1].accepted).toBe(false);
    expect(engine.embedInputs[engine.embedInputs.length - 1].some(sample => sample > 0)).toBe(false);
    const out = joined(emitted);
    expect(out.length).toBe(audio.length);
    expect(countLevel(out, 0, 1.6, OWNER)).toBe(Math.round(1.6 * SPEAKER_GATE_SAMPLE_RATE));
    expect(out.some(sample => sample === BYSTANDER)).toBe(false);
  });

  it('does not release new audio when an aborted finish resumes', async () => {
    let release!: (value: Float32Array) => void;
    const engine = new FakeEngine();
    engine.embed = () => new Promise((resolve) => { release = resolve; });
    const { gate } = startGate(engine);
    pushAll(gate, makeAudio([[OWNER, 0.5]]));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const finishing = gate.finish();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const oldRelease = release;
    gate.abort();
    const emitted: Emitted[] = [];
    gate.begin((chunk) => emitted.push({ samples: new Int16Array(chunk) }));
    pushAll(gate, makeAudio([[BYSTANDER, 0.5]]));
    oldRelease(OWNER_PRINT);
    await finishing;
    expect(emitted).toEqual([]);
    gate.abort();
  });

  it('passes the owner, mutes a bystander and keeps every chunk in order', async () => {
    const engine = new FakeEngine();
    const { gate, emitted, decisions } = startGate(engine);
    const audio = makeAudio([[0, 0.6], [OWNER, 2], [0, 1], [BYSTANDER, 2], [0, 0.6]]);

    pushAll(gate, audio);
    await gate.finish();

    const out = joined(emitted);
    expect(out.length).toBe(audio.length);
    expect(emitted.map((item) => item.trace?.chunkIndex)).toEqual(
      Array.from({ length: emitted.length }, (_, index) => index),
    );
    // Owner speech (0.6–2.6 s) survives, bystander speech (3.6–5.6 s) is gone.
    expect(countLevel(out, 0.6, 2.6, OWNER)).toBe(Math.round(2 * SPEAKER_GATE_SAMPLE_RATE));
    expect(countLevel(out, 3.6, 5.6, BYSTANDER)).toBe(0);
    expect(decisions.some((decision) => decision.accepted)).toBe(true);
    expect(decisions.some((decision) => !decision.accepted)).toBe(true);
  });

  it('holds speech until a decision instead of leaking it early', async () => {
    const engine = new FakeEngine();
    const { gate, emitted } = startGate(engine);

    pushAll(gate, makeAudio([[BYSTANDER, 0.8]]));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(joined(emitted).some((sample) => sample === BYSTANDER)).toBe(false);

    await gate.finish();
    expect(joined(emitted).some((sample) => sample === BYSTANDER)).toBe(false);
    expect(joined(emitted).length).toBe(Math.round(0.8 * SPEAKER_GATE_SAMPLE_RATE));
  });

  it('fails open and passes the rest of the run through when the engine errors', async () => {
    const engine = new FakeEngine();
    engine.failEmbed = true;
    const { gate, emitted, passthrough } = startGate(engine);
    const audio = makeAudio([[BYSTANDER, 2], [0, 0.5]]);

    pushAll(gate, audio);
    await gate.finish();

    expect(passthrough).toEqual(['engine_error: model crashed']);
    expect(joined(emitted)).toEqual(audio);
  });

  it('bounds finish() when the engine hangs and releases held audio', async () => {
    const engine = new FakeEngine();
    engine.hangEmbed = true;
    const { gate, emitted, passthrough } = startGate(engine, {
      engineTimeoutMs: 10_000,
      finishTimeoutMs: 20,
    });
    const audio = makeAudio([[OWNER, 0.5]]);

    pushAll(gate, audio);
    await gate.finish();

    expect(passthrough).toEqual(['finish_timeout']);
    expect(joined(emitted)).toEqual(audio);
  });

  it('drops held audio on abort and never emits it into a later run', async () => {
    const engine = new FakeEngine();
    const { gate, emitted } = startGate(engine);
    pushAll(gate, makeAudio([[OWNER, 0.8]]));
    gate.abort();

    const second: Emitted[] = [];
    gate.begin((chunk, trace) => second.push({ samples: new Int16Array(chunk), trace }));
    pushAll(gate, makeAudio([[0, 1]]));
    await gate.finish();

    expect(joined(emitted).some((sample) => sample === OWNER)).toBe(false);
    expect(joined(second).length).toBe(SPEAKER_GATE_SAMPLE_RATE);
    expect(joined(second).every((sample) => sample === 0)).toBe(true);
  });
});

class FakeEnrollmentEngine implements SpeakerEnrollmentEngine {
  constructor(private readonly prints: Array<Float32Array | null>) {}
  private index = 0;

  async extractSpeech(samples: Float32Array): Promise<Float32Array> {
    return samples;
  }

  async embed(): Promise<Float32Array | null> {
    const print = this.prints[this.index];
    this.index += 1;
    return print;
  }
}

describe('buildSpeakerEnrollment', () => {
  const clip = (sec: number) => new Float32Array(Math.round(sec * SPEAKER_GATE_SAMPLE_RATE));

  it('averages consistent clips into one normalized voiceprint', async () => {
    const engine = new FakeEnrollmentEngine([
      new Float32Array([2, 0.2]),
      new Float32Array([1, 0]),
      new Float32Array([3, -0.3]),
    ]);
    const result = await buildSpeakerEnrollment(engine, [clip(3), clip(3), clip(3)]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const norm = Math.hypot(result.embedding[0], result.embedding[1]);
    expect(norm).toBeCloseTo(1, 5);
    expect(result.selfScore).toBeGreaterThan(0.9);
    expect(result.speechSec).toBeCloseTo(9, 5);
  });

  it('rejects a clip without enough speech', async () => {
    const engine = new FakeEnrollmentEngine([new Float32Array([1, 0]), new Float32Array([1, 0])]);
    const result = await buildSpeakerEnrollment(engine, [clip(3), clip(1)]);

    expect(result).toMatchObject({ ok: false, reason: 'too_short', clipIndex: 1 });
  });

  it('rejects clips that do not sound like one person', async () => {
    const engine = new FakeEnrollmentEngine([
      new Float32Array([1, 0]),
      new Float32Array([1, 0]),
      new Float32Array([-1, 0.1]),
    ]);
    const result = await buildSpeakerEnrollment(engine, [clip(3), clip(3), clip(3)]);

    expect(result).toMatchObject({ ok: false, reason: 'inconsistent', clipIndex: 2 });
  });

  it('reports a clip the model could not embed', async () => {
    const engine = new FakeEnrollmentEngine([null]);
    const result = await buildSpeakerEnrollment(engine, [clip(3)]);

    expect(result).toMatchObject({ ok: false, reason: 'no_embedding', clipIndex: 0 });
  });

  it.each([
    ['non-finite', new Float32Array([NaN, 1])],
    ['infinite', new Float32Array([Infinity, 1])],
    ['empty', new Float32Array(0)],
    ['zero', new Float32Array([0, 0])],
    ['wrong dimension', new Float32Array([1])],
  ])('rejects a %s embedding without accepting a broken voiceprint', async (_, invalid) => {
    const engine = new FakeEnrollmentEngine([OWNER_PRINT, invalid, OWNER_PRINT]);
    const result = await buildSpeakerEnrollment(engine, [clip(3), clip(3), clip(3)]);

    expect(result).toMatchObject({ ok: false, reason: 'no_embedding', clipIndex: 1 });
  });

  it('does not let a different speaker inflate their own enrollment match', async () => {
    const engine = new FakeEnrollmentEngine([
      new Float32Array([1, 0]),
      new Float32Array([1, 0]),
      new Float32Array([0.3, Math.sqrt(1 - 0.3 ** 2)]),
    ]);
    const result = await buildSpeakerEnrollment(engine, [clip(3), clip(3), clip(3)]);

    expect(result).toMatchObject({ ok: false, reason: 'inconsistent', clipIndex: 2 });
  });
});
