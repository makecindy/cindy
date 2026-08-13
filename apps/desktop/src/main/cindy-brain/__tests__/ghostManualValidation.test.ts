import { describe, expect, it } from 'vitest';

import {
  GHOST_MANUAL_LOGICAL_PATH_MAX_CHARS,
  ghostManualLogicalPathForEntry,
  parseGhostManualLogicalPath,
} from '../ghostManualValidation';

describe('ghostManualValidation · 三侧共用路径判据', () => {
  it('逻辑调用路径允许合法多层与 1024 边界，拒绝超限和不可移植分段', () => {
    expect(parseGhostManualLogicalPath('ops/references/deep/runbook.md')).toEqual([
      'ops',
      'references',
      'deep',
      'runbook.md',
    ]);
    expect(
      parseGhostManualLogicalPath('a'.repeat(GHOST_MANUAL_LOGICAL_PATH_MAX_CHARS)),
    ).not.toBeNull();
    expect(
      parseGhostManualLogicalPath('a'.repeat(GHOST_MANUAL_LOGICAL_PATH_MAX_CHARS + 1)),
    ).toBeNull();
    for (const invalid of [
      `ops/bad${String.fromCharCode(1)}name.md`,
      `ops/bad${String.fromCharCode(0x7f)}name.md`,
      'ops\\windows.md',
      'ops//empty.md',
      'ops/./dot.md',
      'ops/../parent.md',
    ]) {
      expect(parseGhostManualLogicalPath(invalid), invalid).toBeNull();
    }
  });

  it('文件和目录映射使用同一完整逻辑路径上限，入口映射为 item name', () => {
    const exactFile = `${'a/'.repeat(507)}x.md`;
    const tooLongFile = `${'a/'.repeat(507)}xx.md`;
    expect(ghostManualLogicalPathForEntry('guide', 'MANUAL.md', 'file')).toBe('guide');
    expect(ghostManualLogicalPathForEntry('guide', exactFile, 'file')).toHaveLength(1024);
    expect(ghostManualLogicalPathForEntry('guide', tooLongFile, 'file')).toBeNull();
    expect(ghostManualLogicalPathForEntry('guide', 'references/deep', 'directory')).toBe(
      'guide/references/deep',
    );
    expect(
      ghostManualLogicalPathForEntry('guide', `bad${String.fromCharCode(1)}dir`, 'directory'),
    ).toBeNull();
    expect(ghostManualLogicalPathForEntry('guide', 'references/data.json', 'file')).toBeNull();
  });
});
