import { describe, expect, it } from 'vitest';

import {
  parseIssueEnvRegion,
  parseIssueSuggestedPublicName,
  parseIssueSubmissionIdentity,
} from '@/lib/issueConfirmPayload';

describe('parseIssueSubmissionIdentity', () => {
  it('保留 GitHub 用户和平台的实际 login', () => {
    expect(parseIssueSubmissionIdentity({ kind: 'github-user', login: ' octocat ' })).toEqual({
      kind: 'github-user',
      login: 'octocat',
    });
    expect(parseIssueSubmissionIdentity({ kind: 'platform', login: 'cindy-issue' })).toEqual({
      kind: 'platform',
      login: 'cindy-issue',
    });
  });

  it('拒绝缺失 login 或未知 kind', () => {
    expect(parseIssueSubmissionIdentity({ kind: 'github-user', login: '' })).toBeNull();
    expect(parseIssueSubmissionIdentity({ kind: 'other', login: 'someone' })).toBeNull();
    expect(parseIssueSubmissionIdentity(null)).toBeNull();
  });
});

describe('parseIssueEnvRegion', () => {
  it('保留三种合法构建区域', () => {
    expect(parseIssueEnvRegion('cn')).toBe('cn');
    expect(parseIssueEnvRegion('global')).toBe('global');
    expect(parseIssueEnvRegion('dev')).toBe('dev');
  });

  it('未知 / 缺失 / 非字符串一律 undefined,不猜区域', () => {
    // 猜错的代价是把中国版用户的反馈标成国际版,宁可不展示。
    expect(parseIssueEnvRegion('CN')).toBeUndefined();
    expect(parseIssueEnvRegion('china')).toBeUndefined();
    expect(parseIssueEnvRegion(undefined)).toBeUndefined();
    expect(parseIssueEnvRegion(null)).toBeUndefined();
    expect(parseIssueEnvRegion(1)).toBeUndefined();
  });
});

describe('parseIssueSuggestedPublicName', () => {
  it('trims a valid single-line public name', () => {
    expect(parseIssueSuggestedPublicName('  Cindy User  ')).toBe('Cindy User');
  });

  it('drops empty, over-long, control-character and line-separator values', () => {
    expect(parseIssueSuggestedPublicName('')).toBeUndefined();
    expect(parseIssueSuggestedPublicName('x'.repeat(101))).toBeUndefined();
    expect(parseIssueSuggestedPublicName('line 1\nline 2')).toBeUndefined();
    expect(parseIssueSuggestedPublicName('line 1\u0085line 2')).toBeUndefined();
    expect(parseIssueSuggestedPublicName('line 1\u009fline 2')).toBeUndefined();
    expect(parseIssueSuggestedPublicName('line 1\u2028line 2')).toBeUndefined();
    expect(parseIssueSuggestedPublicName('line 1\u2029line 2')).toBeUndefined();
  });
});
