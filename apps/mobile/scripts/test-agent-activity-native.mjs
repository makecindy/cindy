#!/usr/bin/env node
// Native integration: execute the production Codable schema and freshness policy.
// ActivityKit itself is unavailable on macOS; only its marker protocol is stubbed.
// This covers old APNs payloads without timestamps and mixed running/waiting tasks,
// which TS projection tests cannot detect. The widget is separately iOS-typechecked.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = mkdtempSync(join(tmpdir(), 'cindy-activity-native-'));
try {
  const stub = join(directory, 'ActivityKit.swift');
  writeFileSync(stub, 'public protocol ActivityAttributes: Codable { associatedtype ContentState: Codable, Hashable }');
  execFileSync('swiftc', ['-parse-as-library', '-emit-object', '-emit-module', '-module-name', 'ActivityKit',
    '-emit-module-path', join(directory, 'ActivityKit.swiftmodule'), stub, '-o', join(directory, 'ActivityKit.o')], { stdio: 'inherit' });
  const source = fileURLToPath(new URL('../modules/cindy-agent-activity/ios/CindyAgentActivityAttributes.swift', import.meta.url));
  const fixture = fileURLToPath(new URL('./fixtures/agent-activity-freshness.swift', import.meta.url));
  const executable = join(directory, 'activity-tests');
  execFileSync('swiftc', ['-I', directory, source, fixture, join(directory, 'ActivityKit.o'), '-o', executable], { stdio: 'inherit' });
  execFileSync(executable, [], { stdio: 'inherit' });
} finally {
  rmSync(directory, { recursive: true, force: true });
}
