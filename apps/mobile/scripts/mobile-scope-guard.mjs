#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = resolve(fileURLToPath(import.meta.url), '..');
const mobileRoot = resolve(scriptDir, '..');

// Feedback confirmation is supported on same-account phones when the host
// advertises remoteConfirmSupported. The old desktop-only exclusion is retired.
const contentRules = [
  {
    roots: ['app'],
    patterns: [
      'transcribeVoice(',
      'DEVICE_LINK_VOICE_TRANSCRIBE_CHANNEL',
      'device-link:voice:transcribe',
    ],
    reason: 'Mobile voice composer must use the realtime controller + managed Cindy voice service, not the legacy desktop transcription channel.',
  },
];

const failures = [];

for (const rule of contentRules) {
  const excluded = new Set(rule.exclude ?? []);
  for (const root of rule.roots) {
    const absoluteRoot = resolve(mobileRoot, root);
    for (const filePath of walk(absoluteRoot)) {
      const relativePath = toMobileRelative(filePath);
      if (excluded.has(relativePath) || !isTextFile(filePath)) continue;
      const content = readFileSync(filePath, 'utf8');
      for (const pattern of rule.patterns) {
        if (content.includes(pattern)) {
          failures.push({
            file: relativePath,
            pattern,
            reason: rule.reason,
          });
        }
      }
    }
  }
}

if (failures.length > 0) {
  console.error('mobile-scope-guard failed: unsupported mobile entry point.');
  for (const failure of failures) {
    const pattern = failure.pattern ? ` pattern="${failure.pattern}"` : '';
    console.error(`- ${failure.file}${pattern}: ${failure.reason}`);
  }
  process.exit(1);
}

console.log('mobile-scope-guard passed');

function* walk(root) {
  if (!existsSync(root)) return;
  const stat = statSync(root);
  if (stat.isFile()) {
    yield root;
    return;
  }
  if (!stat.isDirectory()) return;
  for (const entry of readdirSync(root)) {
    if (entry === 'node_modules' || entry === '.expo' || entry === '.git') continue;
    yield* walk(join(root, entry));
  }
}

function toMobileRelative(filePath) {
  return relative(mobileRoot, filePath).split('\\').join('/');
}

function isTextFile(filePath) {
  return /\.(json|mjs|js|ts|tsx|yaml|yml|md)$/.test(filePath);
}
