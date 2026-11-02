import { describe, expect, it } from 'vitest';
import {
  redactSensitiveText,
  redactSensitiveTextDeep,
} from '../errorRedaction';

/**
 * Error rows reach other processes and devices as `content` of an `error`
 * message. Every string leaf of that structure must leave masked, whatever
 * branch stored it: the write path only masks `message` / `sdkError`, so
 * `reason` (and any future field) relies on this exit pass alone.
 */
describe('redactSensitiveTextDeep', () => {
  it('masks credentials in nested objects and arrays', () => {
    const input = {
      message: 'POST failed',
      sdkError: { output: 'api_key=sk-live-secretvalue123' },
      reason: ['upstream said api_key=sk-live-secretvalue123'],
    };

    const output = redactSensitiveTextDeep(input) as {
      message: string;
      sdkError: { output: string };
      reason: string[];
    };

    expect(output.sdkError.output).toContain('[REDACTED');
    expect(output.sdkError.output).not.toContain('sk-live-secretvalue123');
    expect(output.reason[0]).toContain('[REDACTED');
    expect(output.reason[0]).not.toContain('sk-live-secretvalue123');
    // The surrounding diagnostic context survives masking.
    expect(output.message).toBe('POST failed');
  });

  it('preserves keys and the shape of every non-string leaf', () => {
    const input = {
      status: 401,
      retriable: false,
      upstream: null,
      missing: undefined,
      attempts: [1, 2],
      note: 'token=sk-ant-secretvalue123',
    };

    const output = redactSensitiveTextDeep(input) as Record<string, unknown>;

    expect(Object.keys(output).sort()).toEqual(
      ['attempts', 'missing', 'note', 'retriable', 'status', 'upstream'].sort(),
    );
    expect(output.status).toBe(401);
    expect(output.retriable).toBe(false);
    expect(output.upstream).toBeNull();
    expect(output.missing).toBeUndefined();
    expect(output.attempts).toEqual([1, 2]);
    expect(output.note).toContain('[REDACTED');
  });

  it('does not mutate the input', () => {
    const input = { reason: 'api_key=sk-live-secretvalue123' };
    const snapshot = JSON.parse(JSON.stringify(input));

    redactSensitiveTextDeep(input);

    expect(input).toEqual(snapshot);
  });

  it('is idempotent so a second exit pass cannot grow the placeholder', () => {
    const input = { reason: 'aigw:user-42 jwt token=sk-live-secretvalue123' };

    const once = redactSensitiveTextDeep(input) as { reason: string };
    const twice = redactSensitiveTextDeep(once) as { reason: string };

    expect(twice.reason).toBe(once.reason);
    expect(twice.reason).toContain('[REDACTED');
    expect(twice.reason).toContain('aigw:[REDACTED]');
  });

  it('returns string, number, boolean, null and undefined leaves unchanged', () => {
    expect(redactSensitiveTextDeep('plain')).toBe('plain');
    expect(redactSensitiveTextDeep(7)).toBe(7);
    expect(redactSensitiveTextDeep(false)).toBe(false);
    expect(redactSensitiveTextDeep(null)).toBeNull();
    expect(redactSensitiveTextDeep(undefined)).toBeUndefined();
  });

  it('masks every element of a top-level array', () => {
    const output = redactSensitiveTextDeep([
      'api_key=sk-live-secretvalue123',
      'clean',
      { nested: 'api_key=sk-live-secretvalue123' },
    ]) as [string, string, { nested: string }];

    expect(output[0]).toContain('[REDACTED');
    expect(output[1]).toBe('clean');
    expect(output[2].nested).toContain('[REDACTED');
  });

  it('keeps the flat helper consistent with a single deep pass', () => {
    const line = 'Authorization: Bearer abcdef123456 and api_key=sk-live-secretvalue123';

    expect(redactSensitiveTextDeep(line)).toBe(redactSensitiveText(line));
  });
});
