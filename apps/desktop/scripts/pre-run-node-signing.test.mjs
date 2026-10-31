import { describe, expect, it } from 'vitest';
import path from 'node:path';
import process from 'node:process';
import { readFileSync } from 'node:fs';
import { signPreRunNode } from './ci/pre-run-node-signing.mjs';

describe('standalone pre-run Node signing contract', () => {
  it.each([['-', false], ['Developer ID Application: Test', true]])('signs and verifies with identity %s before executing the signed asset', (identity, timestamp) => {
    const calls = [];
    const tools = path.resolve('fixture', 'tools with spaces');
    const result = signPreRunNode(tools, process.arch, { identity, timestamp, run: (...args) => { calls.push(args); return ''; } });
    const node = path.join(tools, 'pre-run-node', 'darwin-' + process.arch, 'node');
    expect(calls[0][0]).toBe('/usr/bin/codesign');
    expect(calls[0][1]).toEqual(['--force', ...(timestamp ? ['--timestamp'] : []), '--options', 'runtime', '--sign', identity, '--entitlements', expect.any(String), node]);
    const plist = readFileSync(calls[0][1].at(-2), 'utf8');
    expect(plist).toContain('<key>com.apple.security.cs.allow-jit</key>');
    for (const forbidden of ['apple-events', 'keychain-access-groups', 'audio-input', 'disable-library-validation', 'allow-unsigned-executable-memory']) expect(plist).not.toContain(forbidden);
    expect(calls[1].slice(0, 2)).toEqual(['/usr/bin/codesign', ['--verify', '--strict', node]]);
    expect(calls[2][0]).toBe(node);
    expect(calls[2][2].env.NODE_OPTIONS).toBeUndefined();
    expect(calls[2][2].timeout).toBe(10_000);
    expect(result.executed).toBe(true);
  });

  it('fails closed on signing, verification or signed execution failure', () => {
    for (const failedCall of [0, 1, 2]) {
      let calls = 0;
      expect(() => signPreRunNode('tools', process.arch, { run: () => {
        if (calls++ === failedCall) throw new Error('asset rejected');
      } })).toThrow('asset rejected');
      expect(calls).toBe(failedCall + 1);
    }
  });

  it('verifies a cross architecture asset without claiming it ran', () => {
    const calls = [];
    const arch = process.arch === 'arm64' ? 'x64' : 'arm64';
    const result = signPreRunNode('tools', arch, { run: (...args) => { calls.push(args); } });
    expect(calls).toHaveLength(2);
    expect(result.executed).toBe(false);
  });
});
