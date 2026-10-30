import { describe, expect, it } from 'vitest';
import { parseCodexMicroGuardProcesses } from '../codexMicroGuardProcesses.js';

describe('Codex Micro process observation', () => {
  it('only selects supported desktop main executables, never CLI or helpers', () => {
    const date = 'Sun Sep  6 09:10:11 2026';
    const codex = '/Applications/Codex.app/Contents/MacOS/Codex';
    const chatgpt = '/Applications/ChatGPT.app/Contents/MacOS/ChatGPT';
    expect(
      parseCodexMicroGuardProcesses(
        [
          ` 101 ${date} ${codex}`,
          ` 102 ${date} ${chatgpt}`,
          ` 103 ${date} /usr/local/bin/codex`,
          ` 104 ${date} ${codex} Helper`,
          ` 105 ${date} /tmp/Codex.app/Contents/MacOS/Codex`,
          ` 0 ${date} ${codex}`,
          'malformed',
        ].join('\n'),
      ),
    ).toEqual([
      { pid: 101, startedAt: Date.parse('2026-09-06T09:10:11Z'), executable: codex },
      { pid: 102, startedAt: Date.parse('2026-09-06T09:10:11Z'), executable: chatgpt },
    ]);
  });
});
