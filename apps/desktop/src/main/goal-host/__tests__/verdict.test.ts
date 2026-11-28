import { describe, expect, it } from 'vitest';

import { parseVerdict } from '../verdict.js';

describe('parseVerdict', () => {
  it('parses a clean fenced json verdict', () => {
    const text = [
      'Did the work.',
      '```json',
      '{"goal_status":"continue","reason":"tests still failing"}',
      '```',
    ].join('\n');
    expect(parseVerdict(text)).toEqual({ status: 'continue', reason: 'tests still failing' });
  });

  it('accepts a fence without the json language tag', () => {
    const text = '```\n{"goal_status":"complete","reason":"all green"}\n```';
    expect(parseVerdict(text)).toEqual({ status: 'complete', reason: 'all green' });
  });

  it('parses a waiting verdict (no-work exit; 2026-10 token-idle incident)', () => {
    const text = [
      '无变化。待命。',
      '```json',
      '{"goal_status":"waiting","reason":"B3 与 D4a 交单前无事可做"}',
      '```',
    ].join('\n');
    expect(parseVerdict(text)).toEqual({ status: 'waiting', reason: 'B3 与 D4a 交单前无事可做' });
  });

  it('takes the LAST valid fenced block when multiple appear', () => {
    const text = [
      '```json',
      '{"goal_status":"continue","reason":"earlier"}',
      '```',
      'more work...',
      '```json',
      '{"goal_status":"complete","reason":"final"}',
      '```',
    ].join('\n');
    expect(parseVerdict(text)).toEqual({ status: 'complete', reason: 'final' });
  });

  it('falls back to a bare json object when there is no fence', () => {
    const text = 'I am stuck. {"goal_status":"blocked","reason":"need a prod credential"}';
    expect(parseVerdict(text)).toEqual({ status: 'blocked', reason: 'need a prod credential' });
  });

  it('defaults reason to empty string when missing', () => {
    const text = '```json\n{"goal_status":"continue"}\n```';
    expect(parseVerdict(text)).toEqual({ status: 'continue', reason: '' });
  });

  it('returns null for an invalid goal_status value', () => {
    const text = '```json\n{"goal_status":"done","reason":"x"}\n```';
    expect(parseVerdict(text)).toBeNull();
  });

  it('returns null when there is no verdict at all', () => {
    expect(parseVerdict('just some prose with no verdict block')).toBeNull();
  });

  it('returns null for malformed json in the fence', () => {
    const text = '```json\n{"goal_status":"continue", reason:}\n```';
    expect(parseVerdict(text)).toBeNull();
  });

  it('handles null / empty input', () => {
    expect(parseVerdict(null)).toBeNull();
    expect(parseVerdict(undefined)).toBeNull();
    expect(parseVerdict('')).toBeNull();
  });

  it('parses an optional refined_objective field (goal-rewrite channel)', () => {
    const text = '```json\n{"goal_status":"continue","reason":"clarified","refined_objective":"梳理当前工作:列出待办并标注优先级"}\n```';
    expect(parseVerdict(text)).toEqual({
      status: 'continue',
      reason: 'clarified',
      refinedObjective: '梳理当前工作:列出待办并标注优先级',
    });
  });

  it('omits refinedObjective when absent or blank', () => {
    expect(parseVerdict('```json\n{"goal_status":"continue","reason":"x"}\n```')).toEqual({
      status: 'continue',
      reason: 'x',
    });
    expect(parseVerdict('```json\n{"goal_status":"continue","reason":"x","refined_objective":"   "}\n```')).toEqual({
      status: 'continue',
      reason: 'x',
    });
  });
});
