import { describe, expect, it } from 'vitest';

import {
  holdStandaloneStopTokenDelta,
  isPossibleStandaloneStopPrefix,
  stableInternalWebCitationBoundary,
  stableLeakedSystemNotificationBoundary,
  stableStandaloneModelStopTokenBoundary,
  stripInternalWebCitations,
  stripLeakedSystemNotificationBlocks,
  stripStandaloneModelStopToken,
} from './internalCitation.js';

const source1 = '\uE200cite\uE202turn17search1\uE201';
const source2 = '\uE200cite\uE202turn17search1\uE202turn17search2\uE201';

describe('internal Web citation normalization', () => {
  it('strips single and multiple-source markers without changing punctuation', () => {
    expect(stripInternalWebCitations(`结论。${source1}`)).toBe('结论。');
    expect(stripInternalWebCitations(`A ${source1}；B ${source2}。`)).toBe('A ；B 。');
  });

  it('leaves ordinary cite text and unrelated private-use text untouched', () => {
    expect(stripInternalWebCitations('Please cite the source.')).toBe('Please cite the source.');
    expect(stripInternalWebCitations('ordinary \uE200 text')).toBe('ordinary \uE200 text');
  });

  it('is idempotent and strips unfinished final tails', () => {
    expect(stripInternalWebCitations(`done ${source1}`)).toBe('done ');
    expect(stripInternalWebCitations(stripInternalWebCitations(`done ${source1}`))).toBe('done ');
    expect(stripInternalWebCitations('done \uE200cite\uE202turn17sea')).toBe('done ');
    expect(stripInternalWebCitations('done \uE200ci')).toBe('done ');
  });

  it('holds split streaming prefixes and incomplete markers until they are complete', () => {
    expect(stableInternalWebCitationBoundary('done')).toBe(4);
    expect(stableInternalWebCitationBoundary('done \uE200ci')).toBe(5);
    expect(stableInternalWebCitationBoundary('done \uE200cite\uE202turn17sea')).toBe(5);
    expect(stableInternalWebCitationBoundary(`done ${source2}`)).toBe(`done ${source2}`.length);
  });
});

describe('leaked model stop tokens', () => {
  it('strips a whole-message Grok stop token to empty text', () => {
    expect(stripStandaloneModelStopToken('<|eos|>')).toBe('');
    expect(stripInternalWebCitations('  <|eos|>\n')).toBe('');
  });

  it('strips a whole-message run of stop tokens, including mixed tokens and blank lines', () => {
    expect(stripStandaloneModelStopToken('<|eos|><|eos|>')).toBe('');
    expect(stripInternalWebCitations('<|eos|>\n\n<|eos|>')).toBe('');
    expect(stripInternalWebCitations('  <|eos|> <|eot_id|>\n')).toBe('');
    expect(stripInternalWebCitations('<|eos|>answer')).toBe('<|eos|>answer');
  });

  it('leaves completed messages that start with a stop token but continue as prose', () => {
    expect(stripStandaloneModelStopToken('<|eos|>answer')).toBe('<|eos|>answer');
    expect(stripInternalWebCitations('<|endoftext|> The token is still here')).toBe(
      '<|endoftext|> The token is still here',
    );
  });

  it('leaves embedded stop-token prose intact', () => {
    expect(stripInternalWebCitations('The token is <|eos|>')).toBe('The token is <|eos|>');
    expect(stripInternalWebCitations('done<|eot_id|>')).toBe('done<|eot_id|>');
    expect(stripInternalWebCitations('use <|placeholder|> here')).toBe('use <|placeholder|> here');
  });

  it('holds an incomplete standalone prefix until the closer arrives', () => {
    expect(stableStandaloneModelStopTokenBoundary('hello')).toBe(5);
    expect(stableStandaloneModelStopTokenBoundary('<|eo')).toBe(0);
    expect(stableStandaloneModelStopTokenBoundary('  <|eo')).toBe(0);
    expect(stableStandaloneModelStopTokenBoundary('<|eos|>')).toBe(0);
    expect(stableStandaloneModelStopTokenBoundary('<|eos|><|eos|>')).toBe(0);
    expect(stableStandaloneModelStopTokenBoundary('<|eos|><|eo')).toBe(0);
    expect(stableStandaloneModelStopTokenBoundary('The token is <|eo')).toBe('The token is <|eo'.length);
    expect(isPossibleStandaloneStopPrefix('  <|eo')).toBe(true);
    expect(isPossibleStandaloneStopPrefix('<')).toBe(true);
    expect(isPossibleStandaloneStopPrefix('<|')).toBe(true);
    expect(isPossibleStandaloneStopPrefix(`${' '.repeat(23)}<|eos|>`)).toBe(true);
    expect(isPossibleStandaloneStopPrefix('<|eos|><|eos|>')).toBe(true);
    expect(isPossibleStandaloneStopPrefix('The token is <|eo')).toBe(false);
  });

  it('is idempotent', () => {
    expect(stripInternalWebCitations(stripInternalWebCitations('<|eos|>'))).toBe('');
    expect(stripInternalWebCitations(stripInternalWebCitations('<|eos|><|eos|>'))).toBe('');
    expect(stripInternalWebCitations(stripInternalWebCitations('The token is <|eos|>'))).toBe(
      'The token is <|eos|>',
    );
  });

  it('holds a split leftover on one stream without mixing another stream', () => {
    const a = { pending: '', emitted: false };
    const b = { pending: '', emitted: false };
    expect(holdStandaloneStopTokenDelta(a, '<|eo')).toBeNull();
    expect(holdStandaloneStopTokenDelta(b, 'answer')).toBe('answer');
    expect(holdStandaloneStopTokenDelta(a, 's|>')).toBeNull();
    expect(a).toEqual({ pending: '<|eos|>', emitted: false });
    expect(b).toEqual({ pending: '', emitted: true });
  });

  it('holds a long-padded leftover token until the closer arrives', () => {
    const buffer = { pending: '', emitted: false };
    const padded = `${' '.repeat(23)}<|eos|>`;
    expect(holdStandaloneStopTokenDelta(buffer, padded)).toBeNull();
    expect(buffer.emitted).toBe(false);
    expect(buffer.pending.endsWith('<|eos|>')).toBe(true);
  });

  it('holds whitespace-only deltas without releasing a later leftover token', () => {
    const buffer = { pending: '', emitted: false };
    expect(holdStandaloneStopTokenDelta(buffer, ' '.repeat(23))).toBeNull();
    expect(buffer.pending).toBe(' '.repeat(23));
    expect(holdStandaloneStopTokenDelta(buffer, '<|eos|>')).toBeNull();
    expect(buffer.emitted).toBe(false);
    expect(buffer.pending.trim()).toBe('<|eos|>');
  });

  it('keeps ordinary leading whitespace when later prose arrives', () => {
    const buffer = { pending: '', emitted: false };
    expect(holdStandaloneStopTokenDelta(buffer, '    ')).toBeNull();
    expect(holdStandaloneStopTokenDelta(buffer, 'code')).toBe('    code');
  });

  it('holds a one-character leftover prefix until the closer arrives', () => {
    const buffer = { pending: '', emitted: false };
    expect(holdStandaloneStopTokenDelta(buffer, '<')).toBeNull();
    expect(holdStandaloneStopTokenDelta(buffer, '|eos|>')).toBeNull();
    expect(buffer).toEqual({ pending: '<|eos|>', emitted: false });
  });

  it('keeps a split leftover so later prose reconstructs the original text', () => {
    const buffer = { pending: '', emitted: false };
    expect(holdStandaloneStopTokenDelta(buffer, '<|eos|>')).toBeNull();
    expect(holdStandaloneStopTokenDelta(buffer, 'answer')).toBe('<|eos|>answer');
  });

  it('drops a completed leftover so a second copy cannot flush it as prose', () => {
    const buffer = { pending: '', emitted: false };
    expect(holdStandaloneStopTokenDelta(buffer, '<|eos|>')).toBeNull();
    expect(holdStandaloneStopTokenDelta(buffer, '<|eos|>')).toBeNull();
    expect(buffer.emitted).toBe(false);
    expect(buffer.pending.trim()).toBe('<|eos|><|eos|>');
    expect(holdStandaloneStopTokenDelta(buffer, 'answer')).toBe('<|eos|><|eos|>answer');
  });

  it('still strips a split web citation after ordinary prose has been emitted', () => {
    const buffer = { pending: '', emitted: false };
    expect(holdStandaloneStopTokenDelta(buffer, '结论。')).toBe('结论。');
    expect(holdStandaloneStopTokenDelta(buffer, '\uE200ci')).toBeNull();
    expect(holdStandaloneStopTokenDelta(buffer, 'te\uE202turn17search1\uE201 后续')).toBe(' 后续');
    expect(buffer.emitted).toBe(true);
    expect(buffer.pending).toBe('');
  });

  it('keeps an embedded stop token after ordinary prose has been emitted', () => {
    const buffer = { pending: '', emitted: false };
    expect(holdStandaloneStopTokenDelta(buffer, 'The token is ')).toBe('The token is ');
    expect(holdStandaloneStopTokenDelta(buffer, '<|eos|>')).toBe('<|eos|>');
  });
});

const LEAKED_NOTIFICATION_BODY = [
  '<system-reminder>',
  '[SYSTEM NOTIFICATION - NOT USER INPUT]',
  'This is an automated background-task event, NOT a message from the user.',
  '',
  '<task-notification>',
  '<task-id>task123</task-id>',
  '<status>completed</status>',
  '<summary>Background command completed (exit code 0)</summary>',
  '</task-notification>',
  '</system-reminder>',
].join('\n');

const LEAKED_NOTIFICATION_WITH_ROLE = `user\n${LEAKED_NOTIFICATION_BODY}`;

describe('leaked synthetic system notifications (#11696)', () => {
  it.each([
    ['trailing role + notification after prose', `已启动后台任务。\n${LEAKED_NOTIFICATION_WITH_ROLE}`, '已启动后台任务。'],
    ['CRLF line endings and trailing blank line', `Done.\r\n\r\nuser\r\n${LEAKED_NOTIFICATION_BODY.replace(/\n/g, '\r\n')}\r\n`, 'Done.'],
    ['direct <system-reminder> without user line', `Done.\n${LEAKED_NOTIFICATION_BODY}`, 'Done.'],
    ['standalone leaked notification', LEAKED_NOTIFICATION_WITH_ROLE, ''],
    ['two consecutive leaked notifications', `Done.\n${LEAKED_NOTIFICATION_WITH_ROLE}\n${LEAKED_NOTIFICATION_WITH_ROLE}`, 'Done.'],
    ['leading leaked notification before prose', `${LEAKED_NOTIFICATION_WITH_ROLE}\nActual answer.`, 'Actual answer.'],
    ['truncated block after confirmed marker', 'Done.\nuser\n<system-reminder>\n[SYSTEM NOTIFICATION - NOT USER INPUT]\n<task-notification><task-id>t1', 'Done.'],
  ])('strips %s and remains idempotent', (_label, input, expected) => {
    expect(stripLeakedSystemNotificationBlocks(input)).toBe(expected);
    expect(stripInternalWebCitations(input)).toBe(expected);
    expect(stripInternalWebCitations(stripInternalWebCitations(input))).toBe(expected);
  });

  it.each([
    [
      'fenced backtick code block',
      `Example:\n\`\`\`xml\n${LEAKED_NOTIFICATION_WITH_ROLE}\n\`\`\`\nDone.`,
    ],
    [
      'fenced tilde code block',
      `Example:\n~~~\n${LEAKED_NOTIFICATION_WITH_ROLE}\n~~~`,
    ],
    [
      'ordinary <system-reminder> without synthetic-notification marker',
      'Note:\n<system-reminder>\nNormal example content\n</system-reminder>',
    ],
    [
      'inline mention in prose',
      'Watch out for `user\\n<system-reminder>\\n[SYSTEM NOTIFICATION - NOT USER INPUT]` in logs.',
    ],
    [
      'ordinary user line and incomplete prefix',
      'Done.\nuser\nhello',
    ],
    [
      'bare trailing user line',
      'Done.\nuser',
    ],
  ])('preserves %s untouched', (_label, input) => {
    expect(stripInternalWebCitations(input)).toBe(input);
  });

  it('keeps fenced example intact while stripping a leaked block after the closing fence', () => {
    const fenced = `\`\`\`xml\n${LEAKED_NOTIFICATION_WITH_ROLE}\n\`\`\``;
    expect(stripInternalWebCitations(`${fenced}\n${LEAKED_NOTIFICATION_WITH_ROLE}`)).toBe(fenced);
  });

  it('holds incomplete line-start prefixes during streaming without delaying ordinary newlines', () => {
    expect(stableLeakedSystemNotificationBoundary('Done.\n')).toBe(6);
    expect(stableLeakedSystemNotificationBoundary('Done.\nuser')).toBe(6);
    expect(stableLeakedSystemNotificationBoundary('Done.\nuser\n<system-rem')).toBe(6);
    expect(
      stableLeakedSystemNotificationBoundary(
        'Done.\nuser\n<system-reminder>\n[SYSTEM NOTIFICATION - NOT USER INPUT]\n<task-notification>',
      ),
    ).toBe(6);
    expect(
      stableLeakedSystemNotificationBoundary(`Done.\n${LEAKED_NOTIFICATION_WITH_ROLE}`),
    ).toBe(`Done.\n${LEAKED_NOTIFICATION_WITH_ROLE}`.length);
  });

  it('suppresses split leaked notification deltas during streaming and releases false alarms', () => {
    const leaked = { pending: '', emitted: false };
    const emittedLeaked: string[] = [];
    for (const chunk of [
      '已启动后台任务。',
      '\n',
      'us',
      'er\n<system-',
      'reminder>\n[SYSTEM NOTIFICATION',
      ' - NOT USER INPUT]\n<task-notification><task-id>t1</task-id></task-notification>\n</system-reminder>',
    ]) {
      const out = holdStandaloneStopTokenDelta(leaked, chunk);
      if (out) emittedLeaked.push(out);
    }
    expect(emittedLeaked.join('')).toBe('已启动后台任务。\n');
    expect(leaked.pending).toBe('');

    const falseAlarm = { pending: '', emitted: false };
    const emittedProse: string[] = [];
    for (const chunk of ['Hello\n', 'user', 'name\n', 'user\n', 'world']) {
      const out = holdStandaloneStopTokenDelta(falseAlarm, chunk);
      if (out) emittedProse.push(out);
    }
    expect(emittedProse.join('')).toBe('Hello\nusername\nuser\nworld');
    expect(falseAlarm.pending).toBe('');
  });

  it('preserves a split fenced code block during streaming and strips a leaked tail after it closes', () => {
    const buffer = { pending: '', emitted: false };
    const emitted: string[] = [];
    for (const chunk of [
      '`',
      '``xml\n',
      `${LEAKED_NOTIFICATION_WITH_ROLE}\n`,
      '```',
      `\n${LEAKED_NOTIFICATION_WITH_ROLE}`,
    ]) {
      const out = holdStandaloneStopTokenDelta(buffer, chunk);
      if (out) emitted.push(out);
    }
    expect(emitted.join('')).toBe(`\`\`\`xml\n${LEAKED_NOTIFICATION_WITH_ROLE}\n\`\`\``);
    expect(buffer.pending).toBe('');
  });
});
