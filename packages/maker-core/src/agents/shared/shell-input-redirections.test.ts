import { describe, expect, it } from 'vitest';

import { parseShellInputRedirections } from './shell-input-redirections.js';

describe('parseShellInputRedirections', () => {
  it.each([
    ['cat<.env', '.env', 'cat'],
    ['cat < ".env.local"', '.env.local', 'cat'],
    ['env -- cat 0<./.env.production', './.env.production', 'env -- cat 0'],
    ['cat<.e"nv"', '.env', 'cat'],
    ['cat<.e\\nv', '.env', 'cat'],
    ["cat <'$TARGET'", '$TARGET', 'cat'],
    ['cat <*.txt', '*.txt', 'cat'],
    ['cat <"innocent\\q"', 'innocent\\q', 'cat'],
  ])('extracts the static input target from %s', (command, target, stripped) => {
    const parsed = parseShellInputRedirections(command);
    expect(parsed.command.trim()).toBe(stripped);
    expect(parsed.targets).toEqual([target]);
    expect(parsed.targetPrefixes).toHaveLength(1);
    expect(parsed.targetMayExpand).toEqual([command === 'cat <*.txt']);
    expect(parsed.hasUnresolvedTarget).toBe(false);
  });

  it.each([
    'cat <$(printf .env)',
    'cat <$TARGET',
    'cat <"${TARGET}"',
    'cat <`printf .env`',
    'cat <>$TARGET',
    'cat 3<>$(printf .env)',
  ])('preserves dynamic input targets for fail-closed classification: %s', (command) => {
    expect(parseShellInputRedirections(command)).toEqual({
      command,
      targets: [],
      targetPrefixes: [],
      targetMayExpand: [],
      hasUnresolvedTarget: true,
    });
  });

  it('normalizes shell line continuations inside static targets', () => {
    const command = 'cat <.e\\' + '\n' + 'nv';
    expect(parseShellInputRedirections(command)).toEqual({
      command: 'cat  ',
      targets: ['.env'],
      targetPrefixes: ['cat '],
      targetMayExpand: [false],
      hasUnresolvedTarget: false,
    });
  });

  it('normalizes shell line continuations outside redirection targets', () => {
    const command = 'cat .e\\' + '\n' + 'nv';
    expect(parseShellInputRedirections(command)).toEqual({
      command: 'cat .env',
      targets: [],
      targetPrefixes: [],
      targetMayExpand: [],
      hasUnresolvedTarget: false,
    });
  });

  it('skips comments only through the current line and resumes target scanning', () => {
    const command = 'true # cat <$TARGET\ncat <.env';
    expect(parseShellInputRedirections(command)).toEqual({
      command: 'true \ncat  ',
      targets: ['.env'],
      targetPrefixes: ['true \ncat '],
      targetMayExpand: [false],
      hasUnresolvedTarget: false,
    });
  });

  it('leaves redirection-like text in comments out of the classified command', () => {
    const command = 'cat README.md # example: cat <$TARGET';
    expect(parseShellInputRedirections(command)).toEqual({
      command: 'cat README.md ',
      targets: [],
      targetPrefixes: [],
      targetMayExpand: [],
      hasUnresolvedTarget: false,
    });
  });

  it.each([
    ['cat <>created', 'created', 'cat ', 'cat'],
    ['cat<>.env', '.env', 'cat', 'cat'],
    ['cat 3<> ".env.local"', '.env.local', 'cat 3', 'cat'],
    ['cat 7 <>./.env.production', './.env.production', 'cat 7 ', 'cat 7'],
    ['3<>.env cat', '.env', '3', 'cat'],
    ['cat3<>.env.local', '.env.local', 'cat3', 'cat3'],
  ])('records the read target while preserving read-write syntax: %s', (command, target, prefix, inspection) => {
    expect(parseShellInputRedirections(command)).toEqual({
      command,
      targets: [target],
      targetPrefixes: [prefix],
      targetMayExpand: [false],
      hasUnresolvedTarget: false,
    });
    expect(parseShellInputRedirections(command, true).command.trim()).toBe(inspection);
  });

  it.each([
    "grep '<.env' data.txt",
    "cat '<.env'",
    'cat <<<.env',
    'cat <<EOF',
    'cat <&0',
    'cat <(printf x)',
    'cat \\<.env',
  ])('does not treat data or non-input-file syntax as a target: %s', (command) => {
    expect(parseShellInputRedirections(command)).toEqual({
      command,
      targets: [],
      targetPrefixes: [],
      targetMayExpand: [],
      hasUnresolvedTarget: false,
    });
  });
});
