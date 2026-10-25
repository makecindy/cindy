import { expect, it } from 'vitest';
import { completeSpeechPrefix, streamingSpeechText } from '../SpeechTextBuffer';

it('never reads an unfinished fenced code block, including nested Markdown blocks', () => {
  expect(streamingSpeechText('说明。\n```js\nsecret();\n', false)).toBe('说明。');
  expect(streamingSpeechText('说明。\n```js\nsecret();\n```\n结论。', true)).toBe('说明。 结论。');
  expect(streamingSpeechText('> ```js\n> secret();\n', false)).toBe('');
});

it.each(['[a sentence.', '[label](https://private.test', '`unfinished code.', '<unfinished'])(
  'holds unfinished inline syntax: %s',
  (tail) => {
    expect(streamingSpeechText(`First sentence. ${tail}`, false)).toBe('First sentence.');
  },
);

it('keeps readable link text, omits images and supports emphasis across snapshots', () => {
  expect(streamingSpeechText('**你好。', false)).toBe('你好。');
  expect(
    streamingSpeechText(
      '**你好。** [世界](https://example.test)。 ![图](https://private.test)',
      true,
    ),
  ).toBe('你好。 世界。');
});

it('finds CJK sentence ends, handles English decimals and holds an unfinished tail', () => {
  expect(completeSpeechPrefix('你好。再见！剩余')).toBe('你好。再见！');
  expect(completeSpeechPrefix('Version 3.14 is ready. Next')).toBe('Version 3.14 is ready.');
  expect(completeSpeechPrefix('Ask Dr. Smith')).toBe('');
  expect(completeSpeechPrefix('Incomplete')).toBe('');
});

it('bounds a long unfinished sentence at a word boundary', () => {
  const text = 'word '.repeat(150);
  const prefix = completeSpeechPrefix(text);
  expect(prefix.length).toBeLessThanOrEqual(500);
  expect(prefix.endsWith('word')).toBe(true);
  expect(text.startsWith(prefix)).toBe(true);
});
