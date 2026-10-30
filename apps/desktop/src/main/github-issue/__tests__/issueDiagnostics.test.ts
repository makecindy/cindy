import { describe, expect, it } from 'vitest';

import { formatRelatedIssueLogs } from '../issueDiagnostics';
import type { UploadRecord } from '../../log-upload/types';

const NOW = Date.parse('2026-09-15T12:00:00.000+08:00');

function record(overrides: Partial<UploadRecord> = {}): UploadRecord {
  return {
    ts: '2026-09-15T11:30:00.000+08:00',
    level: 'error',
    src: 'main',
    scope: 'network',
    msg: 'request failed',
    ...overrides,
  };
}

describe('formatRelatedIssueLogs', () => {
  it('只保留最近两小时并生成固定的相关日志模块', () => {
    const result = formatRelatedIssueLogs(
      [
        record({ msg: 'recent' }),
        record({ ts: '2026-09-15T08:00:00.000+08:00', msg: 'old' }),
      ],
      NOW,
    );

    expect(result.recordCount).toBe(1);
    expect(result.section).toContain('## 相关日志');
    expect(result.section).toContain('recent');
    expect(result.section).not.toContain('old');
  });

  it('再次脱敏日志正文并压平多行内容', () => {
    const result = formatRelatedIssueLogs(
      [record({ msg: 'email a-person@example.com\npath /Users/alice/private' })],
      NOW,
    );

    expect(result.section).toContain('[REDACTED:email]');
    expect(result.section).toContain('↵');
    expect(result.section).not.toContain('/Users/alice');
  });
});
