import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(
  resolve(process.cwd(), 'app/devices/[deviceId].tsx'),
  'utf8',
);

describe('device detail project list Fabric lifecycle', () => {
  it('keeps Android clipping disabled for the swipeable project list', () => {
    const testIdIndex = source.indexOf('testID="deviceDetail.projectSessionList"');
    const listStart = source.lastIndexOf('<SectionList', testIdIndex);
    const listProps = source.slice(listStart, testIdIndex);

    expect(testIdIndex).toBeGreaterThan(0);
    expect(listStart).toBeGreaterThan(0);
    expect(listProps).toContain('removeClippedSubviews={false}');
  });
});
