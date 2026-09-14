import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const featureRoot = path.resolve(__dirname, '..');

function botUiSources(): Array<{ file: string; source: string }> {
  return readdirSync(featureRoot)
    .filter((file) => file.endsWith('.tsx'))
    .map((file) => ({
      file,
      source: readFileSync(path.join(featureRoot, file), 'utf8'),
    }));
}

describe('Cindy Bots design contract', () => {
  it('keeps Bot surfaces on the shared radius, overlay, and zero-shadow system', () => {
    for (const { file, source } of botUiSources()) {
      expect(source, `${file} must use the 8px/12px/pill radius scale`).not.toMatch(
        /rounded-(?:md|2xl|3xl)/,
      );
      expect(source, `${file} must stay shadow-free`).not.toMatch(
        /(?:^|[\s"'])drop-shadow-|(?:^|[\s"'])shadow(?:-|[\s"'])/m,
      );
      expect(source, `${file} must use the themed modal overlay token`).not.toMatch(
        /bg-black\/|backdrop-blur/,
      );
    }
  });
});
