import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { patchShareExtension } = require('../../plugins/with-incoming-share-files.js');
const template = readFileSync(join(dirname(require.resolve('expo-sharing/package.json')),
  'plugin/template-files/ios/ShareIntoViewController.swift'), 'utf8');

describe('incoming share native file ownership', () => {
  it('isolates both file-copy and raw-image paths without changing display names', () => {
    const patched = patchShareExtension(template);
    expect(patched.match(/"cindy-share-" \+ UUID\(\).uuidString/g)).toHaveLength(2);
    expect(patched.match(/createDirectory\(at: directory/g)).toHaveLength(2);
    expect(patched.match(/directory.appendingPathComponent\(fileName\)/g)).toHaveLength(2);
    expect(patched).not.toContain('removeItem(at: destinationURL)');
    expect(patched).toContain('guard !shareStarted else { return }');
    expect(patched).toContain('try IncomingShareSlot.write(encoded, group: appGroupId)');
    expect(patched).toContain('guard saveToUserDefaults(payload) else');
    expect(patched).toContain('enum IncomingShareSlot');
    expect(patched).not.toContain('userDefaults.set(encoded');
  });

  it('fails prebuild when upstream changes the copy contract', () => {
    expect(() => patchShareExtension(template.replaceAll('containerURL.appendingPathComponent(fileName)', 'newCopyStrategy()')))
      .toThrow('expo-sharing template changed');
  });
});
